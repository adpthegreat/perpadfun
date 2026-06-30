// Pending-burn sweeper + (optional) buyback queue.
//
// Problem this solves:
//   buybackAndBurn() runs swap -> poll ATA -> burn. If the swap confirms but
//   the burn fails (RPC flake, ATA poll timeout, etc.) the tokens sit in the
//   treasury/sub-wallet ATA forever. There was no retry. Result: $HYPU buy
//   confirmed but never burned.
//
// Fix: a dedicated tick scans every managed token's owning-wallet ATA. Any
// nonzero balance is treated as a stranded buyback and burned via
// burnExistingTokenBalance. Idempotent: if the ATA is already empty (already
// burned), the call returns null and nothing happens.
//
// Safety: we ONLY scan tokens we manage (rows returned by
// /api/public/keeper/tokens), and we ONLY scan their canonical mint
// (mint_address for perpad-native, external_mint for external). We never
// burn arbitrary tokens that happen to be in a wallet.

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { config } from './config.js';
import { burnExistingTokenBalance } from './buyback.js';
import { loadKeypair, walletForToken, deriveSubKeypair } from './wallet.js';
import { listActiveTokens, sendReport } from './perpad.js';
import { intentHash, tickBucket, buildTxLogEntry } from './idempotency.js';
import { keeperLog } from './workflow.js';

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

let _master = null;
function master() {
  if (!_master) _master = loadKeypair(config.treasuryKey);
  return _master;
}

// Stats for /status
let _lastRunAt = null;
let _lastBurns = 0;
let _lastErrors = 0;
let _totalBurnsAllTime = 0;
let _running = false;
let _pendingMintsLastScan = 0;

export function getBurnSweepStatus() {
  return {
    enabled: config.burnSweepEnabled,
    tickMs: config.burnSweepTickMs,
    running: _running,
    lastRunAt: _lastRunAt,
    lastBurns: _lastBurns,
    lastErrors: _lastErrors,
    totalBurnsAllTime: _totalBurnsAllTime,
    pendingMintsLastScan: _pendingMintsLastScan,
  };
}

// Resolve which kp owns the buyback ATA for a given token.
//   - perpad-native (source='perpspad'): treasury wallet (master OR per-token
//     sub-wallet, picked by walletForToken).
//   - external (source='external'):  the external sub-wallet, which is the
//     same sub-wallet derived from the master keypair using the token id.
//     externalRouters.js does buyback from `sub = deriveSubKeypair(master, r.id)`.
function ownerKpForToken(t) {
  if (t.source === 'external') {
    if (!t.id) return null;
    return deriveSubKeypair(master(), t.id);
  }
  return walletForToken(master(), t);
}

function mintForToken(t) {
  if (t.source === 'external') return t.external_mint || null;
  return t.mint_address || null;
}

// Cheap pre-check: is the wallet's ATA for this mint nonzero?
// Skips the full burn machinery + tx prep for the 99% empty case.
async function ataHasBalance(mintAddr, ownerPk) {
  try {
    const mint = new PublicKey(mintAddr);
    const info = await conn().getAccountInfo(mint, 'confirmed');
    if (!info) return false;
    const programs = info.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]
      : info.owner.equals(TOKEN_PROGRAM_ID)
        ? [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
        : [];
    for (const p of programs) {
      try {
        const ata = await getAssociatedTokenAddress(mint, ownerPk, true, p);
        const acct = await getAccount(conn(), ata, 'confirmed', p);
        if (acct.amount > 0n) return true;
      } catch { /* keep trying */ }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Run a single burn-sweep tick.
 *   1. List all managed tokens.
 *   2. For each, check the owning wallet's ATA for nonzero balance.
 *   3. If nonzero, burn it via burnExistingTokenBalance.
 *   4. Batch-report all burns to perpad so tokens_burned counters update.
 *
 * Returns { scanned, pending, burned, errors }.
 */
export async function runBurnSweepTick() {
  if (!config.burnSweepEnabled) return { scanned: 0, pending: 0, burned: 0, errors: 0, skipped: 'disabled' };
  if (_running) return { scanned: 0, pending: 0, burned: 0, errors: 0, skipped: 'already-running' };
  _running = true;
  const startedAt = Date.now();
  let tokens = [];
  let burned = 0;
  let errors = 0;
  let pending = 0;
  const reports = [];

  try {
    try {
      tokens = await listActiveTokens();
    } catch (e) {
      keeperLog(null, "warn", `[burn-sweep] listActiveTokens failed: ${e.message}`);
      return { scanned: 0, pending: 0, burned: 0, errors: 1 };
    }

    const bucket = tickBucket();

    for (const t of tokens) {
      const mintAddr = mintForToken(t);
      if (!mintAddr) continue;
      let kp;
      try {
        kp = ownerKpForToken(t);
      } catch (e) {
        // sub-wallet mismatch etc; skip without spamming
        continue;
      }
      if (!kp) continue;

      // Cheap balance probe first.
      const hasBal = await ataHasBalance(mintAddr, kp.publicKey);
      if (!hasBal) continue;
      pending++;

      try {
        const r = await burnExistingTokenBalance({ mintAddress: mintAddr, kp });
        if (r && r.tokensBurned > 0) {
          burned++;
          _totalBurnsAllTime++;
          const intent = intentHash([t.id, 'burn_sweep', bucket, r.burnSig ?? '']);
          reports.push({
            token_id: t.id,
            tokens_burned_delta: r.tokensBurned,
            tx_log: [
              buildTxLogEntry({
                kind: 'burn',
                intent,
                status: 'confirmed',
                signature: r.burnSig,
                amountTokens: r.tokensBurned,
              }),
            ],
            events: [
              {
                kind: 'burn',
                tokens_amount: r.tokensBurned,
                tx_sig: r.burnSig,
                note: `[burn-sweep] burned ${r.tokensBurned} stranded units of ${mintAddr.slice(0, 6)}…`,
              },
            ],
          });
          keeperLog(
            t,
            "info",
            `[burn-sweep] ${t.ticker ?? t.id.slice(0, 6)} burned stranded ${r.tokensBurned} units mint=${mintAddr.slice(0, 8)}… sig=${r.burnSig?.slice(0, 16)}…`,
          );
        }
      } catch (e) {
        errors++;
        keeperLog(t, "warn", `[burn-sweep] ${t.ticker ?? t.id.slice(0, 6)} burn failed: ${e.message}`);
      }
    }

    if (reports.length) {
      try {
        await sendReport(reports);
      } catch (e) {
        keeperLog(null, "warn", `[burn-sweep] sendReport failed: ${e.message}`); //add current token
        errors++;
      }
    }
  } finally {
    _running = false;
    _lastRunAt = new Date().toISOString();
    _lastBurns = burned;
    _lastErrors = errors;
    _pendingMintsLastScan = pending;
    const ms = Date.now() - startedAt;
    if (burned > 0 || pending > 0 || errors > 0) {
      keeperLog(null, "info", `[burn-sweep] done scanned=${tokens.length} pending=${pending} burned=${burned} errors=${errors} ms=${ms}`);
    }
  }
  return { scanned: tokens.length, pending, burned, errors };
}
