// Process external (pump.fun) fee-router sub-wallets.
//
// Each external token has a deterministic sub-wallet (same HMAC derivation as
// internal tokens). Creators set that address as their pump.fun creator-fee
// receiver. SOL drips in over time. Each tick, per router:
//
//   1. Read on-chain SOL balance. If < SWEEP_THRESHOLD_USD, skip.
//   2. Split only the new claim/route-wallet capital into three capped legs:
//        50% -> perp position on the underlying (long/short, leverage)
//        25% -> buyback + burn the external_mint (pump.fun token)
//        25% -> transferred to master treasury
//   3. Each leg is independent: a failure in one does NOT abort the others.
//   4. Each leg reports a treasury_event row via external-sweep-report.
//
// Master treasury pays nothing here; the sub-wallet signs and pays all fees
// from its own balance.

import { config } from './config.js';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { loadKeypair, deriveSubKeypair } from './wallet.js';
import { burnExistingTokenBalance, buybackAndBurn } from './buyback.js';
import {
  openPosition,
  increasePosition,
  readPerpPosition,
  SUPPORTED_SYMBOLS,
} from './jupiterPerps.js';
import { isSupportedMarket as isImperialSupportedMarket, authenticate as imperialAuthenticate, MIN_COLLATERAL_USD as IMPERIAL_MIN_USD } from './imperial.js';
import { depositToImperialProfile } from './imperialDeposit.js';

// Router-aware support check. Mirrors loop.js so HYPE and other Imperial-only
// markets are not skipped when an external router (e.g. pump.fun) is wired
// to an Imperial-routed token.
function isUnderlyingSupportedForRouter(router, sym) {
  const u = String(sym ?? '').toUpperCase();
  if (!u) return false;
  const routerKind = String(router?.router ?? 'imperial').toLowerCase();
  if (routerKind === 'imperial') return isImperialSupportedMarket(u);
  return SUPPORTED_SYMBOLS.has(u);
}
import { getUsdPriceFor } from './prices.js';
import { claimPumpFunCreatorFees, claimPumpAmmCoinCreatorFees } from './pumpfunClaim.js';
import { withRetry } from './rateLimiter.js';

export const SWEEP_THRESHOLD_USD = Number(process.env.EXTERNAL_SWEEP_THRESHOLD_USD ?? 25);
const FALLBACK_SWEEP_THRESHOLD_SOL = Number(process.env.EXTERNAL_SWEEP_THRESHOLD_SOL ?? 0.1);
// Reserve left in the sub-wallet so it stays rent-exempt and can sign future
// txs. Kept above the top-up floor so we do not need repeated master top-ups.
const SUB_RESERVE_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);
const TX_FEE_LAMPORTS = 5_000;

// Master auto-tops-up the sub-wallet to this floor before attempting a
// pump.fun creator-fee claim, so the first claim has gas + WSOL ATA rent.
// Master recoups the advance via the treasury leg after the claim succeeds.
// Kept to the bare minimum (rent + ~3 tx fees) so dead/empty routers can
// never bleed more than a few cents from master per top-up.
const SUB_TOPUP_FLOOR_LAMPORTS = Math.floor(0.002 * LAMPORTS_PER_SOL);
const SUB_TOPUP_AMOUNT_LAMPORTS = Math.floor(0.003 * LAMPORTS_PER_SOL);

function spendableFromLamports(lamports, legFeeCount = 3) {
  return Math.max(0, lamports - SUB_RESERVE_LAMPORTS - TX_FEE_LAMPORTS * legFeeCount);
}

async function ensureSubFunded({ sub, master, label, currentLamports = null }) {
  const c = conn();
  let have = currentLamports == null ? await withRetry(() => c.getBalance(sub.publicKey, 'confirmed')) : Number(currentLamports);
  if (have >= SUB_TOPUP_FLOOR_LAMPORTS) return;
  const need = SUB_TOPUP_AMOUNT_LAMPORTS - have;
  if (need <= 0) return;
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: master.publicKey,
      toPubkey: sub.publicKey,
      lamports: need,
    }));
    const sig = await sendAndConfirmTransaction(c, tx, [master], { commitment: 'confirmed' });
    have += need;
    console.log(`[externalRouters] ${label} topped up sub-wallet +${(need / LAMPORTS_PER_SOL).toFixed(6)} SOL sig=${sig.slice(0, 16)}…`);
  } catch (e) {
    console.warn(`[externalRouters] ${label} top-up failed: ${e.message}`);
  }
  return have;
}

// Minimums per leg to avoid wasting tx fees on dust.
const MIN_PERP_COLLATERAL_USD = Number(process.env.EXTERNAL_MIN_PERP_USD ?? 5);
const MIN_BUYBACK_SOL = Number(process.env.EXTERNAL_MIN_BUYBACK_SOL ?? 0.001);
const MIN_BUYBACK_USD = Number(process.env.EXTERNAL_MIN_BUYBACK_USD ?? 10);
const MIN_TREASURY_SOL = Number(process.env.EXTERNAL_MIN_TREASURY_SOL ?? 0.0005);

// Split ratios (must sum to <= 1; remainder stays in sub-wallet).
const PERP_RATIO = Number(process.env.EXTERNAL_PERP_RATIO ?? 0.5);
const BUYBACK_RATIO = Number(process.env.EXTERNAL_BUYBACK_RATIO ?? 0.25);
const TREASURY_RATIO = Number(process.env.EXTERNAL_TREASURY_RATIO ?? 0.25);

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

let _treasury = null;
function tre() {
  if (!_treasury) _treasury = loadKeypair(config.treasuryKey);
  return _treasury;
}

let _sweepRunning = false;
let _lastSweepStatus = { lastRun: null, lastError: null, lastResult: null };
const IDLE_LOG_INTERVAL_MS = Number(process.env.EXTERNAL_IDLE_LOG_INTERVAL_SEC ?? 300) * 1000;
const STRANDED_BURN_INTERVAL_MS = Number(process.env.EXTERNAL_STRANDED_BURN_INTERVAL_SEC ?? 300) * 1000;
const _lastIdleLogAt = new Map();
const _lastStrandedBurnProbeAt = new Map();

export function getExternalSweepStatus() {
  return _lastSweepStatus;
}

async function listExternalRouters() {
  const res = await fetch(`${config.perpadBaseUrl}/api/public/keeper/external-routers`, {
    headers: { 'x-keeper-secret': config.keeperSecret },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    throw new Error(`external-routers ${res.status}: ${json.error ?? text}`);
  }
  return json.routers ?? [];
}

async function reportEvents(events) {
  if (!events.length) return { ok: true, inserted: 0 };
  const res = await fetch(`${config.perpadBaseUrl}/api/public/keeper/external-sweep-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-keeper-secret': config.keeperSecret,
    },
    body: JSON.stringify({ sweeps: events }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    throw new Error(`external-sweep-report ${res.status}: ${json.error ?? text}`);
  }
  return json;
}

// Tells the site to stamp first_fee_routed_at for tokens whose sub-wallet
// has non-zero SOL, so they appear in the public token list immediately
// instead of waiting for the $100 sweep gate.
async function reportSeenRouters(tokenIds) {
  if (!tokenIds.length) return;
  try {
    const res = await fetch(`${config.perpadBaseUrl}/api/public/keeper/external-router-seen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-keeper-secret': config.keeperSecret,
      },
      body: JSON.stringify({ token_ids: tokenIds }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[externalRouters] external-router-seen ${res.status}: ${text}`);
    }
  } catch (e) {
    console.warn('[externalRouters] external-router-seen post failed:', e.message);
  }
}

function shouldRunEvery(map, key, intervalMs) {
  const now = Date.now();
  const last = map.get(key) ?? 0;
  if (now - last < intervalMs) return false;
  map.set(key, now);
  return true;
}

async function prefetchLamports(addresses) {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = new Map();
  const chunkSize = 100;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    try {
      const infos = await withRetry(() => conn().getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), 'confirmed'));
      infos.forEach((info, idx) => out.set(chunk[idx], Number(info?.lamports ?? 0)));
    } catch (e) {
      console.warn(`[externalRouters] balance prefetch failed: ${e.message}`);
      break;
    }
  }
  return out;
}

// ---- legs ----


async function legPerp({ router, sub, perpSol, maxSpendLamports, events }) {
  if (perpSol <= 0) return false;
  const sym = String(router.underlying ?? '').toUpperCase();
  if (!isUnderlyingSupportedForRouter(router, sym)) {
    const routerKind = String(router?.router ?? 'imperial').toLowerCase();
    console.warn(`[externalRouters] ${router.id} unsupported underlying=${router.underlying} for router=${routerKind}, skipping perp leg`);
    return false;
  }
  const side = router.direction === 'short' ? 'short' : 'long';
  const lev = Math.max(1, Math.min(Number(router.leverage ?? 1), 100));

  let solPx;
  try { solPx = await getUsdPriceFor('SOL'); } catch (e) {
    console.warn(`[externalRouters] perp: SOL price fetch failed: ${e.message}`);
    return false;
  }
  if (!Number.isFinite(solPx) || solPx <= 0) return false;

  const collateralUsd = perpSol * solPx;
  if (collateralUsd < MIN_PERP_COLLATERAL_USD) {
    console.log(`[externalRouters] ${sym} ${side} ${lev}x: collateral $${collateralUsd.toFixed(2)} < min $${MIN_PERP_COLLATERAL_USD}, skipping perp leg`);
    return false;
  }
  const sizeUsd = collateralUsd * lev;

  // open vs increase
  let existing = null;
  try { existing = await readPerpPosition({ symbol: sym, side, kp: sub }); }
  catch (e) { console.warn(`[externalRouters] readPerpPosition failed: ${e.message}`); }

  try {
    const beforeLamports = await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed'));
    const maxSpendSol = Math.max(0, maxSpendLamports) / LAMPORTS_PER_SOL;
    let res;
    if (existing) {
      res = await increasePosition({
        symbol: sym, side,
        addSizeUsd: sizeUsd,
        addCollateralUsd: collateralUsd,
        kp: sub,
      });
    } else {
      res = await openPosition({
        symbol: sym, side,
        collateralUsd, sizeUsd,
        kp: sub,
      });
    }
    const sig = res?.signature ?? null;
    events.push({
      token_id: router.id,
      kind: 'external_perp',
      swept_sol: perpSol,
      tx_sig: sig,
      note: `${existing ? 'increase' : 'open'} ${sym} ${side} ${lev}x: +$${sizeUsd.toFixed(2)} size, +$${collateralUsd.toFixed(2)} collateral (${perpSol.toFixed(6)} SOL)${res?.simulated ? ' [sim]' : ''}`,
    });
    console.log(`[externalRouters] perp ${router.ticker ?? router.id.slice(0,6)} ${sym} ${side} ${lev}x size=$${sizeUsd.toFixed(2)} sig=${sig?.slice(0,16) ?? 'null'}…`);
    const afterLamports = await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed'));
    const spentSol = Math.max(0, beforeLamports - afterLamports) / LAMPORTS_PER_SOL;
    if (spentSol > maxSpendSol + 0.01) {
      console.warn(`[externalRouters] perp ${router.ticker ?? router.id.slice(0,6)} overspent split cap: spent=${spentSol.toFixed(6)} SOL cap=${maxSpendSol.toFixed(6)} SOL`);
    }
    return true;
  } catch (e) {
    console.warn(`[externalRouters] perp leg failed token=${router.id}: ${e.message}`);
    return false;
  }
}

// Imperial-routed tokens deposit their perp slice straight into the Imperial
// profile as USDC. Replaces legPerp for any router with router='imperial'.
// Auto-accumulates: if the wallet currently holds more SOL than the current
// claim's perp slice (because prior ticks deposited too little to meet the
// $10 Imperial minimum), the entire spendable USD is deposited so the profile
// fills up and loop.js can fire its open / top-up branch.
async function legImperialDeposit({ router, sub, perpSol, solUsd, events }) {
  if (!(perpSol > 0)) return false;
  if (!(solUsd > 0)) return false;
  if (router.imperial_profile_index == null) {
    console.warn(`[externalRouters] ${router.ticker ?? router.id.slice(0, 6)} imperial deposit skipped: no profile index`);
    return false;
  }
  const sym = String(router.underlying ?? '').toUpperCase();
  if (!isImperialSupportedMarket(sym)) {
    console.warn(`[externalRouters] ${router.ticker ?? router.id.slice(0, 6)} imperial deposit skipped: ${sym} not an Imperial market`);
    return false;
  }

  // Spendable SOL = full wallet minus rent reserve minus tx fees (already
  // accounts for the master treasury + buyback legs that ran before us).
  let lamports;
  try { lamports = await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed')); }
  catch (e) {
    console.warn(`[externalRouters] imperial deposit balance read failed token=${router.id}: ${e.message}`);
    return false;
  }
  const spendableLamports = spendableFromLamports(lamports, 4);
  const spendableSol = spendableLamports / LAMPORTS_PER_SOL;
  // Deposit budget is strictly the perp slice (50% of the claim by default).
  // We intentionally do NOT drain leftover wallet SOL here — it belongs to the
  // 25% buyback and 25% treasury legs that run alongside us. Stranded dust
  // below the Imperial $10 floor accumulates in the sub-wallet and is picked
  // up by the next sweep's perp slice.
  const perpBudgetSol = Math.min(spendableSol, Math.max(0, perpSol));
  const usdBudget = perpBudgetSol * solUsd;

  if (usdBudget < IMPERIAL_MIN_USD) {
    console.log(`[externalRouters] ${router.ticker ?? router.id.slice(0, 6)} imperial deposit defer: $${usdBudget.toFixed(2)} < imperial min $${IMPERIAL_MIN_USD} (accumulating perp slice only, leaving buyback/treasury legs untouched)`);
    return false;
  }

  let authToken;
  try {
    const auth = await imperialAuthenticate(sub);
    authToken = auth.token;
  } catch (e) {
    console.warn(`[externalRouters] ${router.ticker ?? router.id.slice(0, 6)} imperial auth failed: ${e.message}`);
    return false;
  }

  try {
    const r = await depositToImperialProfile({
      authToken,
      kp: sub,
      profileIndex: router.imperial_profile_index,
      usdAmount: usdBudget,
      solUsd,
      rpcUrl: config.rpcUrl,
    });
    events.push({
      token_id: router.id,
      kind: 'external_perp',
      swept_sol: perpSol,
      tx_sig: r.signature,
      note: `imperial deposit: +$${r.depositedUsd.toFixed(2)} to profile ${router.imperial_profile_index}`,
    });
    console.log(`[externalRouters] ${router.ticker ?? router.id.slice(0, 6)} imperial deposit $${r.depositedUsd.toFixed(2)} -> profile ${router.imperial_profile_index} sig=${r.signature.slice(0, 16)}…`);
    if (r.prep?.swapSig) {
      events.push({
        token_id: router.id,
        kind: 'external_perp',
        swept_sol: r.prep.solSpent ?? 0,
        tx_sig: r.prep.swapSig,
        note: `imperial pre-deposit swap: ${r.prep.solSpent?.toFixed(4) ?? '?'} SOL -> $${r.prep.usdcReceived?.toFixed(2) ?? '?'} USDC`,
      });
    }
    return true;
  } catch (e) {
    console.warn(`[externalRouters] imperial deposit failed token=${router.id}: ${e.message}`);
    return false;
  }
}


async function legBuyback({ router, sub, buybackSol, solUsd, events }) {
  if (!router.external_mint) {
    console.warn(`[externalRouters] ${router.id} has no external_mint, skipping buyback leg`);
    return false;
  }
  try {
    const stranded = await burnExistingTokenBalance({
      mintAddress: router.external_mint,
      kp: sub,
    });
    if (stranded?.tokensBurned > 0) {
      events.push({
        token_id: router.id,
        kind: 'external_buyback',
        swept_sol: 0,
        tokens_amount: stranded.tokensBurned,
        tx_sig: stranded.burnSig,
        note: `burned stranded ${stranded.tokensBurned} units of ${router.external_mint.slice(0,6)}… from an earlier buyback`,
      });
      console.log(`[externalRouters] buyback ${router.ticker ?? router.id.slice(0,6)} burned stranded ${stranded.tokensBurned} burn=${stranded.burnSig?.slice(0,16)}…`);
    }
  } catch (e) {
    console.warn(`[externalRouters] stranded burn failed token=${router.id}: ${e.message}`);
  }
  if (buybackSol < MIN_BUYBACK_SOL) return false;
  const buybackUsd = buybackSol * (Number(solUsd) || 0);
  if (buybackUsd < MIN_BUYBACK_USD) {
    console.log(`[externalRouters] ${router.ticker ?? router.id.slice(0,6)} buyback defer: $${buybackUsd.toFixed(2)} < min $${MIN_BUYBACK_USD} (accumulating)`);
    return false;
  }
  try {
    const res = await buybackAndBurn({
      mintAddress: router.external_mint,
      solAmount: buybackSol,
      kp: sub,
    });
    events.push({
      token_id: router.id,
      kind: 'external_buyback',
      swept_sol: buybackSol,
      tokens_amount: res.tokensBurned,
      tx_sig: res.burnSig ?? res.swapSig ?? null,
      note: `bought + burned ${res.tokensBurned} units of ${router.external_mint.slice(0,6)}… with ${buybackSol.toFixed(6)} SOL`,
    });
    console.log(`[externalRouters] buyback ${router.ticker ?? router.id.slice(0,6)} burned ${res.tokensBurned} swap=${res.swapSig?.slice(0,16)}… burn=${res.burnSig?.slice(0,16)}…`);
    return true;
  } catch (e) {
    console.warn(`[externalRouters] buyback leg failed token=${router.id}: ${e.message}`);
    return false;
  }
}

async function legTreasury({ router, sub, master, treasurySol, maxSpendLamports, events }) {
  // Re-read live balance (previous legs consumed unknown amounts of SOL on
  // swaps + tx fees). Send everything above SUB_RESERVE + TX_FEE.
  let lamports;
  try { lamports = await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed')); }
  catch (e) {
    console.warn(`[externalRouters] treasury leg balance read failed: ${e.message}`);
    return false;
  }
  const sendable = Math.min(
    lamports - SUB_RESERVE_LAMPORTS - TX_FEE_LAMPORTS,
    Math.floor(Math.max(0, treasurySol) * LAMPORTS_PER_SOL),
    Math.max(0, maxSpendLamports),
  );
  if (sendable <= 0) return false;
  const sendableSol = sendable / LAMPORTS_PER_SOL;
  if (sendableSol < MIN_TREASURY_SOL) return false;

  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: sub.publicKey,
      toPubkey: master.publicKey,
      lamports: sendable,
    }));
    const sig = await sendAndConfirmTransaction(conn(), tx, [sub], { commitment: 'confirmed' });
    events.push({
      token_id: router.id,
      kind: 'external_split_treasury',
      swept_sol: sendableSol,
      tx_sig: sig,
      note: `treasury leg: ${sendableSol.toFixed(6)} SOL -> master from sub-wallet ${sub.publicKey.toBase58().slice(0,6)}…`,
    });
    console.log(`[externalRouters] treasury ${router.ticker ?? router.id.slice(0,6)} sent ${sendableSol.toFixed(6)} SOL sig=${sig.slice(0,16)}…`);
    return true;
  } catch (e) {
    console.warn(`[externalRouters] treasury leg failed token=${router.id}: ${e.message}`);
    return false;
  }
}

export async function sweepExternalRouters() {
  if (_sweepRunning) return { scanned: 0, processed: 0, totalSol: 0, skipped: 'already-running' };
  _sweepRunning = true;
  let routers;
  try { routers = await listExternalRouters(); }
  catch (e) {
    console.warn('[externalRouters] list failed:', e.message);
    _lastSweepStatus = { lastRun: new Date().toISOString(), lastError: e.message, lastResult: null };
    _sweepRunning = false;
    return { scanned: 0, processed: 0, totalSol: 0 };
  }
  if (!routers.length) {
    const empty = { scanned: 0, processed: 0, totalSol: 0 };
    _lastSweepStatus = { lastRun: new Date().toISOString(), lastError: null, lastResult: empty };
    _sweepRunning = false;
    return empty;
  }

  const master = tre();
  const events = [];
  let processed = 0;
  let scanned = 0;
  let totalSol = 0;
  const seenTokenIds = [];
  const derivedRouters = [];

  // Fetch SOL price once per sweep so the pump.fun USD gate can evaluate.
  let solUsd = 0;
  try { solUsd = await getUsdPriceFor('SOL'); }
  catch (e) { console.warn(`[externalRouters] SOL price fetch failed: ${e.message}`); }

  for (const r of routers) {
    try {
      const sub = deriveSubKeypair(master, r.id);
      const subAddr = sub.publicKey.toBase58();
      if (subAddr !== r.treasury_wallet_address) {
        console.warn(`[externalRouters] derived mismatch token=${r.id} derived=${subAddr} stored=${r.treasury_wallet_address}`);
        continue;
      }
      derivedRouters.push({ r, sub, subAddr });
    } catch (e) {
      console.warn(`[externalRouters] token=${r.id} derive failed: ${e.message}`);
    }
  }
  const prefetchedLamports = await prefetchLamports(derivedRouters.map((x) => x.subAddr));

  for (const { r, sub, subAddr } of derivedRouters) {
    scanned++;
    try {
      // STEP 0: pump.fun creator-fee claim. The sub-wallet is set as the
      // pump.fun coin creator, so accrued creator fees live in the
      // creator_vault PDA — not in the sub-wallet itself. Drain it first
      // so the balance read below sees the freshly-claimed SOL.
      // Skip when the router has no mint linked yet (pending pre-routed
      // wallet waiting for the user to come back and bind their fresh mint).
      let beforeClaimLamports = prefetchedLamports.get(subAddr) ?? 0;
      let claimedLamports = 0;
      // Creator-vault balance observed during the claim probe, even when it's
      // below the $100 claim gate. Used as a visibility signal so a routed token
      // shows on the site as soon as fees accrue. See plan/EXTERNAL_ROUTER_VISIBILITY.md.
      let vaultClaimableSol = 0;
      if (r.external_platform === 'pump_fun' && r.external_mint && !r.mint_pending) {
        // Make sure the sub-wallet has enough SOL to pay tx fees + WSOL ATA
        // rent for the claim. Master fronts a small advance and gets it back
        // via the treasury leg after the claim succeeds.
        const fundedLamports = await ensureSubFunded({
          sub,
          master,
          label: r.ticker ?? r.id.slice(0, 6),
          currentLamports: beforeClaimLamports,
        });
        beforeClaimLamports = fundedLamports == null
          ? beforeClaimLamports
          : Number(fundedLamports);
        const routeWalletSol = beforeClaimLamports / LAMPORTS_PER_SOL;
        try {
          const claim = await claimPumpFunCreatorFees({
            kp: sub,
            mint: r.external_mint,
            label: r.ticker ?? r.id.slice(0, 6),
            solUsd,
            routeWalletSol,
          });
          if (claim && claim.vaultSol > 0) vaultClaimableSol = Math.max(vaultClaimableSol, claim.vaultSol);
          if (claim && claim.solClaimed > 0) {
            claimedLamports = Math.max(claimedLamports, Math.floor(claim.solClaimed * LAMPORTS_PER_SOL));
            events.push({
              token_id: r.id,
              kind: 'external_sweep',
              swept_sol: claim.solClaimed,
              tx_sig: claim.signature,
              note: `pump.fun creator-fee claim: +${claim.solClaimed.toFixed(6)} SOL`,
            });
          }
        } catch (e) {
          console.warn(`[externalRouters] pumpfun claim failed token=${r.id}: ${e.message}`);
        }

        // STEP 0b: pump-amm coin-creator-fee claim (post-graduation stream).
        // Sub-wallet is the coin_creator; fees accumulate in a WSOL ATA on a
        // pump-amm PDA. Claim drains them to native SOL on the sub-wallet so
        // the existing 50/25/25 split below picks them up.
        try {
          const ammClaim = await claimPumpAmmCoinCreatorFees({
            kp: sub,
            label: r.ticker ?? r.id.slice(0, 6),
            solUsd,
            routeWalletSol: (await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed'))) / LAMPORTS_PER_SOL,
          });
          if (ammClaim && ammClaim.vaultSol > 0) vaultClaimableSol = Math.max(vaultClaimableSol, ammClaim.vaultSol);
          if (ammClaim && ammClaim.solClaimed > 0) {
            claimedLamports += Math.floor(ammClaim.solClaimed * LAMPORTS_PER_SOL);
            events.push({
              token_id: r.id,
              kind: 'external_sweep',
              swept_sol: ammClaim.solClaimed,
              tx_sig: ammClaim.signature,
              note: `pump-amm coin-creator-fee claim: +${ammClaim.solClaimed.toFixed(6)} SOL`,
            });
          }
        } catch (e) {
          console.warn(`[externalRouters] pump-amm claim failed token=${r.id}: ${e.message}`);
        }
      }

      // Always clear bought-but-not-burned tokens, even when the SOL balance
      // is now below the next sweep gate after a previous partial run.
      if (r.external_mint && !r.mint_pending && shouldRunEvery(_lastStrandedBurnProbeAt, r.id, STRANDED_BURN_INTERVAL_MS)) {
        await legBuyback({ router: r, sub, buybackSol: 0, solUsd, events });
      }


      const lamports = await withRetry(() => conn().getBalance(sub.publicKey, 'confirmed'));
      const observedIncomingLamports = Math.max(0, lamports - beforeClaimLamports);
      claimedLamports = Math.max(claimedLamports, observedIncomingLamports);
      const solUi = lamports / LAMPORTS_PER_SOL;
      const walletUsd = solUsd > 0 ? solUi * solUsd : 0;

      // Stamp first_fee_routed_at as soon as fees are routing to this token —
      // either SOL already in the sub-wallet OR a non-zero creator-vault balance
      // observed during the claim probe (fees accrued but still below the $100
      // claim gate). Keying off only the claimed sub-wallet balance left routed
      // tokens hidden until $100 accrued. See plan/EXTERNAL_ROUTER_VISIBILITY.md.
      if (lamports > 0 || vaultClaimableSol > 0) seenTokenIds.push(r.id);


      if (solUsd > 0) {
        if (walletUsd < SWEEP_THRESHOLD_USD) {
          if (solUi > 0.001 && shouldRunEvery(_lastIdleLogAt, r.id, IDLE_LOG_INTERVAL_MS)) {
            const note = `route wallet=${solUi.toFixed(6)} SOL ($${walletUsd.toFixed(2)}) < sweep min $${SWEEP_THRESHOLD_USD}`;
            console.log(`[externalRouters] ${r.ticker ?? r.id.slice(0, 6)} skip: ${note}`);
            events.push({
              token_id: r.id,
              kind: 'external_sweep',
              swept_sol: 0,
              tx_sig: null,
              note: `external sweep deferred: ${note}`,
            });
          }
          continue;
        }
      } else if (solUi < FALLBACK_SWEEP_THRESHOLD_SOL) {
        continue;
      }

      const sendable = spendableFromLamports(lamports, 3);
      const splitBudget = claimedLamports > 0
        ? Math.min(sendable, claimedLamports)
        : sendable;
      if (splitBudget <= 0) continue;
      const splitBudgetSol = splitBudget / LAMPORTS_PER_SOL;

      const perpSol = splitBudgetSol * PERP_RATIO;
      const buybackSol = splitBudgetSol * BUYBACK_RATIO;
      const treasurySol = splitBudgetSol * TREASURY_RATIO;

      // Treasury runs first so the master receives its fixed 25% before any
      // Jupiter swap/position request can consume more SOL than quoted.
      await legTreasury({
        router: r,
        sub,
        master,
        treasurySol,
        maxSpendLamports: Math.floor(splitBudget * TREASURY_RATIO),
        events,
      });
      // Fix 2a runtime fallback: if the market can't be routed by Imperial
      // (not in SUPPORTED_MARKETS), don't strand the perp slice forever. Fold
      // it into the buyback so fees still burn, and flag the token
      // market_unsupported instead of silently no-opening the perp leg every
      // sweep. See KEEPER_P1_FIXES.md Fix 2a.
      const sym = String(r.underlying ?? '').toUpperCase();
      const marketSupported = isUnderlyingSupportedForRouter(r, sym);

      // Buyback runs before the perp/deposit leg so Imperial deposits cannot
      // consume the token's 25% buyback slice. The deposit helper intentionally
      // drains accumulated spendable SOL, so it must be the last spender. When
      // the market is unsupported the perp slice is redirected into the buyback.
      await legBuyback({
        router: r,
        sub,
        buybackSol: marketSupported ? buybackSol : buybackSol + perpSol,
        solUsd,
        events,
      });

      if (!marketSupported) {
        events.push({
          token_id: r.id,
          kind: 'external_sweep',
          swept_sol: 0,
          tx_sig: null,
          note: `market_unsupported: ${sym || 'unknown'} unavailable for Imperial routing — perp slice redirected to buyback`,
        });
      } else {
        // Perp leg: Imperial-routed tokens deposit straight to their profile
        // (Jupiter can't trade HYPE/PUMP/DOGE/ZEC/WLD/NVDA). Legacy Jupiter
        // routers keep the old openPosition flow.
        const routerKind = String(r.router ?? 'imperial').toLowerCase();
        if (routerKind === 'imperial') {
          await legImperialDeposit({ router: r, sub, perpSol, solUsd, events });
        } else {
          await legPerp({
            router: r,
            sub,
            perpSol,
            maxSpendLamports: Math.floor(splitBudget * PERP_RATIO),
            events,
          });
        }
      }

      processed++;
      totalSol += splitBudgetSol;
    } catch (e) {
      console.warn(`[externalRouters] token=${r.id} failed:`, e.message);
    }
  }

  if (events.length) {
    try { await reportEvents(events); }
    catch (e) { console.warn('[externalRouters] report failed:', e.message); }
  }

  // Surface tokens that have received any SOL so the UI list updates fast.
  await reportSeenRouters(seenTokenIds);

  const result = { scanned, processed, totalSol, events: events.length };
  _lastSweepStatus = { lastRun: new Date().toISOString(), lastError: null, lastResult: result };
  _sweepRunning = false;
  return result;
}
