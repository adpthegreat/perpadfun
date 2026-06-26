// Main keeper loop. Per-token state machine for the perpad flywheel.
//
// Lifecycle per token (per tick):
//   1. Confirm any pending perp request from prior tick.
//   2. Claim trading fees (DBC pre-grad, DAMM v2 post-grad). All SOL goes
//      to fees_accrued_usd. NO immediate split.
//   3. If no live position yet AND fees_accrued_usd >= FEE_GATE_USD:
//        open position with OPEN_COLLATERAL_USD collateral, size = coll * leverage,
//        side = creator's chosen direction. Anything above OPEN_COLLATERAL goes
//        to buyback_reserve_usd.
//   4. If position is live AND new fees accrued this tick: top up collateral
//      with the newly claimed amount (keeps effective leverage near creator's pick).
//   5. Read live PnL. If unrealizedPnL >= pnl_high_water_usd + PNL_TRIGGER_USD:
//        - if effective leverage < cap: withdraw $PNL_TRIGGER from collateral
//        - else: partial-close $PNL_TRIGGER of size (leverage guard)
//        Then SOL->token buyback + SPL burn of the realized USDC -> SOL leg.
//   6. On graduation: drain remaining buyback_reserve via real buyback+burn.

import { config } from "./config.js";
import os from "node:os";
import {
  getJupPerps,
  getFreeCollateralUsd,
  openPosition,
  increasePosition,
  topUpCollateral,
  withdrawCollateral,
  partialClose,
  unwrapWsol,
  readPerpPosition,
  closePerp,
} from "./jupiterPerps.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { listActiveTokens, sendReport } from "./perpad.js";
import { getSolUsd } from "./prices.js";
import { claimDbcFees, claimAmmFees, detectGraduation } from "./fees.js";
import {
  BUYBACK_BASE_FLOOR_LAMPORTS,
  SUB_BUYBACK_OPERATING_RESERVE_LAMPORTS,
  buybackAndBurn,
  buybackSpendableLamports,
} from "./buyback.js";
import { swapSolToUsdc, swapUsdcToSol, MIN_VIABLE_USDC } from "./swap.js";
import { withRetry } from "./rateLimiter.js";
import { backOff } from "./backoff.js";
import { intentHash, tickBucket, buildTxLogEntry } from "./idempotency.js";
import { loadKeypair, walletForToken } from "./wallet.js";
import { quoteIfEnabled as imperialQuoteIfEnabled } from "./imperialRouter.js";
import {
  claimWorkflowLocks,
  queueBlocked,
  queueWorkflow,
  workflowPatch,
  setWorkflowStateSync,
  workflowStateFromToken,
  workflowBlocksOpen,
  keeperLog,
  State,
} from "./workflow.js";
import { tokenLog, newTickId, tickSummary, tokenTickSummary, logInfo, logError } from "./structuredLog.js";
import { captureMarkAsEntry, computePnlFromEntry } from "./pnl.js";
import {
  gateImperialFunding,
  depositToImperialProfile,
  getWalletCapacityUsd,
} from "./imperialDeposit.js";
import {
  getAuthToken,
  getProfile as imperialGetProfile,
  getMarkPriceUiSafe as readImperialLiveMarkUsd,
  MIN_COLLATERAL_USD as IMPERIAL_MIN_COLLATERAL_USD,
} from "./imperial.js";

import {
  imperialReadPosition,
  imperialOpenPosition,
  imperialIncreasePosition,
  imperialAddCollateralToPosition,
  imperialTopUpMargin,
  imperialPartialClose,
  imperialWithdrawCollateral,
  clampLeverage,
  readVerifiedImperialPosition,
  resolveImperialEntryPrice,
  readImperialProfileUsdcUi,
  isUnderlyingSupportedForToken,
} from "./imperialPerps.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_BUYBACK_USD = 1;

// Transient (pre-response) failure signature: a 429 / 503 / network blip /
// dropped connection that means the request most likely never reached the venue,
// so a retry is safe. Mirrors rateLimiter.withRetry's own predicate.
const TP_TRANSIENT_RE = /\b429\b|rate.?limit|too many requests|\b503\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up/i;

// Retry a venue mutation (TP close / withdraw / swap) on TRANSIENT errors only,
// with exponential backoff (via withRetry), before giving up and letting the
// caller emit an error + carry to the next tick. Business rejections (blocked /
// invalid / insufficient) are returned/raised immediately — they won't succeed
// on retry. Some venue fns CATCH their own exceptions and return `{ error }`, so
// we re-throw a transient one to trigger the backoff; non-transient errors pass
// straight through. We only retry pre-response transient failures, so a retry
// should not double-execute in the common case; the per-token pending_drift_sig
// + next-tick reconciliation is the backstop for the rare "landed but response
// lost" window.
const TP_MAX_ATTEMPTS = 2;
async function withVenueRetry(label, ctx, fn) {
  return backOff(
    async () => {
      const res = await fn();
      if (res && res.error && TP_TRANSIENT_RE.test(String(res.error))) {
        throw new Error(String(res.error));
      }
      return res;
    },
    {
      numOfAttempts: TP_MAX_ATTEMPTS,
      startingDelay: 500,
      timeMultiple: 2,
      maxDelay: 4000,
      jitter: "full",
      // Called on each failed attempt. Only transient errors retry; on a retry
      // that will actually happen, log + emit an event so retries are visible
      // (keeper_logs + treasury_events). The final failure is logged by the
      // caller's catch, so we don't double-log it here.
      retry: (e, attempt) => {
        const transient = TP_TRANSIENT_RE.test(String(e?.message ?? ""));
        if (transient && attempt < TP_MAX_ATTEMPTS) {
          const fullErr = String(e?.message ?? "");
          // keeper_logs is unlimited (message text, fields jsonb) — keep the FULL
          // error for debugging. Only the UI-facing treasury_events note is
          // shortened (the full error is in keeper_logs).
          keeperLog(ctx.t, "warn", `${label} retry ${attempt}/${TP_MAX_ATTEMPTS}`, {
            attempt,
            of: TP_MAX_ATTEMPTS,
            error: fullErr,
            tick_id: ctx.tickId,
          });
          ctx.events.push({
            kind: "tick",
            note: `${label} retry ${attempt}/${TP_MAX_ATTEMPTS} after transient err: ${fullErr.slice(0, 140)}`,
          });
        }
        return transient;
      },
    },
  );
}

function isRealSolanaSignature(signature) {
  return typeof signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature);
}

// F5: gate token written to pending_drift_sig after an accepted TP close that has
// no real on-chain signature (Imperial verified-via-positions). It defers TP/
// top-up/buyback for exactly one tick (confirmPendingSigStep clears it), so TP
// can't re-fire on a lagging position read before the reduced size is observed.
const TP_SETTLE_SENTINEL = "tp-settle";

// ── Pure take-profit decision (no I/O) — unit-tested in test/keeper/tp.test.ts ──
// Should TP fire, and how much to close? Trigger basis is the CURRENT collateral
// (collAfter): fire when floating profit has grown by tpTriggerRatio × collAfter
// above the last lock-in (highWater). Returns { fire, frac, closeSizeUsd,
// realizedPnlUsd, trigger }.
export function planTakeProfit({ pnlNow, highWater, collAfter, sizeUsd, cfg }) {
  const trigger = collAfter > 0 ? cfg.tpTriggerRatio * collAfter : Infinity;
  if (!(collAfter > 0 && pnlNow > 0 && pnlNow - highWater >= trigger)) {
    return { fire: false, trigger };
  }
  const frac = Math.min(0.95, Math.max(0, cfg.tpCloseFraction));
  const closeSizeUsd = sizeUsd * frac;
  const realizedPnlUsd = pnlNow * frac;
  if (closeSizeUsd < cfg.tpMinCloseUsd || realizedPnlUsd < cfg.tpMinRealizeUsd) {
    return { fire: false, trigger };
  }
  return { fire: true, frac, closeSizeUsd, realizedPnlUsd, trigger };
}

// Pure post-close reducer. Given the actually-applied close size, returns the
// next position state + the 75/25 profit split. F1: nextPnlNow is the RESIDUAL
// unrealized PnL (not the stale pre-close value), so it can be persisted safely.
export function applyTakeProfit({ pnlNow, sizeUsd, collAfter, actualCloseSizeUsd, cfg }) {
  const appliedFrac = sizeUsd > 0 ? Math.min(1, actualCloseSizeUsd / sizeUsd) : 0;
  const realizedActual = pnlNow * appliedFrac;
  const masterShareUsd = Math.max(0, realizedActual * cfg.tpMasterShareRatio);
  const buybackShareUsd = Math.max(0, realizedActual - masterShareUsd);
  return {
    appliedFrac,
    realizedActual,
    nextSize: Math.max(0, sizeUsd - actualCloseSizeUsd),
    nextColl: collAfter * (1 - appliedFrac),
    nextHighWater: pnlNow * (1 - appliedFrac),
    nextPnlNow: pnlNow * (1 - appliedFrac),
    masterShareUsd,
    buybackShareUsd,
  };
}


// Fix 3a: how long a position_open_pending workflow row may block a re-open
// before it's treated as stale (the open likely never landed) and a retry is
// allowed. Bounds the anti-double-open guard so a stuck pending can't stall a
// token forever before 3c reconciles. See OPEN_CHAIN_REFACTOR_V2.md.
const OPEN_PENDING_STALE_MS = Number(process.env.OPEN_PENDING_STALE_MS ?? 300_000);

// PnL fix: how long after open we may adopt the current mark as our entry basis
// when the venue never returned an entry price. Inside this window mark ≈ entry,
// so it's accurate; past it we never touch launch_mid from mark (that would
// erase a moved position's real PnL). See KEEPER_PNL.md.
const ENTRY_CAPTURE_WINDOW_MS = Number(process.env.ENTRY_CAPTURE_WINDOW_MS ?? 180_000);

// --- 4b: hot/warm/cold tick cadence (cause J) ---------------------------------
// Most tokens at any moment are idle (no reserve, no position, nothing pending)
// yet were probed every tick, so idle PEND-* spam dominated the per-tick RPC
// budget. A "cold" token is processed only every COLD_PROBE_INTERVAL_MS instead
// of every tick; that probe still runs (to catch newly-arrived fees), just not
// 60x/hour. Tokens with real work (live position, pending sig, fees near the
// open gate, or any mid-flow workflow state) are NEVER throttled. See
// KEEPER_RATE_LIMIT_REFACTOR.md (4b).
export const COLD_PROBE_INTERVAL_MS = Number(process.env.COLD_PROBE_INTERVAL_MS ?? 300_000);
// In-memory per-token last-probe clock. Bounded by token count; resets on
// restart (which just probes every cold token once on the first tick — fine).
const _coldLastProbe = new Map();

// Test-only: clear the probe clock so a suite can simulate ticks deterministically.
export function _resetColdProbe() {
  _coldLastProbe.clear();
}

// Round a number for structured-log metric fields; non-finite -> 0.
const num2 = (n, d = 2) => (Number.isFinite(Number(n)) ? Number(Number(n).toFixed(d)) : 0);

// A token has work that must run every tick (so it can never be cold-throttled).
export function tokenHasWork(t) {
  if (t.pending_drift_sig) return true; // must clear an in-flight open/topup sig
  if (t.position_opened_at) return true; // live position: PnL reads / topups / close
  if (Number(t.fees_accrued_usd ?? 0) >= Number(config.feeGateUsd ?? 20)) return true; // at/near open gate
  // Reserve already funded above the buyback floor: drain+burn is real work
  // even when the upstream sweep is deferred (e.g. low route-wallet balance).
  if (Number(t.buyback_reserve_usd ?? 0) >= Number(config.minBuybackUsd ?? 10)) return true;
  const st = workflowStateFromToken(t)?.state;
  // Any state other than idle/blocked/error means a flow is mid-progress.
  if (st && ![State.IDLE, State.BLOCKED, State.ERROR].includes(st)) return true;
  return false;
}

// True => skip this token on this tick. Cold tokens are probed at most once per
// COLD_PROBE_INTERVAL_MS; tokens explicitly deferred via next_retry_at are
// skipped until that time. Side effect: stamps the probe clock when it decides
// to probe a cold token, so the NEXT call within the window skips it.
export function shouldSkipColdTick(t, now) {
  const wf = workflowStateFromToken(t);
  const retryAt = wf?.next_retry_at ? new Date(wf.next_retry_at).getTime() : null;
  if (retryAt && now < retryAt) return true; // explicit "come back later"
  if (tokenHasWork(t)) return false; // hot/warm: always process
  const last = _coldLastProbe.get(t.id) ?? 0; // cold: throttle probes
  if (now - last < COLD_PROBE_INTERVAL_MS) return true;
  _coldLastProbe.set(t.id, now);
  return false;
}

// Startup banner so logs prove the keeper deployed the normalized 50/25/25 split
// build plus master-principal protection.
console.log(
  `[loop] loaded fee-split-v6 normalized-50-25-25 master-principal-protected buybackRatio=${config.buybackFromFeesRatio} treasuryHoldRatio=${config.treasuryHoldRatio} perpMarginRatio=${config.perpMarginRatio} minBuybackUsd=$${config.minBuybackUsd} minBuybackSol=${config.minBuybackSol}`,
);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeReportPatch(patch) {
  for (const key of [
    "position_size_usd",
    "position_collateral_usd",
    "opened_collateral_usd",
    "treasury_pnl_usd",
    "pnl_high_water_usd",
    "treasury_sol_delta",
    "tokens_burned_delta",
    "fees_accrued_usd_delta",
    "buyback_reserve_usd_delta",
    "last_sol_raised_seen",
  ]) {
    if (patch[key] !== undefined) patch[key] = finiteNumber(patch[key], 0);
  }

  patch.events = (patch.events ?? []).map((event) => {
    const clean = { ...event };
    for (const key of ["mid", "pnl_delta_usd", "sol_amount", "tokens_amount"]) {
      if (clean[key] !== undefined) clean[key] = finiteNumber(clean[key], 0);
    }
    return clean;
  });

  return patch;
}

export function blockedReasonFromEvents(events) {
  const notes = [...(events ?? [])]
    .reverse()
    .map((event) => event?.note)
    .filter(Boolean);
  return notes.find((note) =>
    /\b(skip|defer|deferred|failed|err|error|below|unsupported|capacity|unavailable|refunded|dropped)\b/i.test(note),
  ) ?? null;
}

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, "confirmed");
  return _conn;
}

let _treasury = null;
function tre() {
  if (!_treasury) _treasury = loadKeypair(config.treasuryKey);
  return _treasury;
}

// Imperial auth tokens are cached per sub-wallet inside imperial.js
// (authenticate()'s own _authCache). getAuthToken() is the thin string-returning
// wrapper; no second cache layer is needed here.

async function treasuryUsdcUi() {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), tre().publicKey);
    const bal = await withRetry(() => conn().getTokenAccountBalance(ata, "confirmed"));
    return Number(bal.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

async function treasurySolUi() {
  try {
    const lamports = await withRetry(() => conn().getBalance(tre().publicKey, "confirmed"));
    return lamports / 1_000_000_000;
  } catch {
    return 0;
  }
}

async function solUiFor(pubkey) {
  try {
    const lamports = await withRetry(() => conn().getBalance(pubkey, "confirmed"));
    return lamports / 1_000_000_000;
  } catch {
    return 0;
  }
}

// Ensure a sub-wallet has the bare minimum SOL to sign a few txs. This is
// rent-exemption (~0.00089 SOL) + a handful of tx fees (5000 lamports each).
// We deliberately keep this tiny so master treasury never advances more than
// a few cents per sub-wallet. Real fee-claim inflows above swap.js's
// MIN_SOL_RESERVE (0.08 SOL) are what fund perp collateral/buybacks.
// Token-2022 ATA rent is ~0.00207 SOL on its own. We need headroom for that
// plus 2 tx fees + priority fee, otherwise the buyback swap dies mid-flight
// with "Transfer: insufficient lamports" inside Jupiter's instruction.
// Default OFF: sub-wallets must self-sustain from their own routed fees. If an
// operator explicitly enables this env var, top-ups are still only attempted at
// the buyback site, never during idle token scans.
const MASTER_SUBWALLET_TOPUPS_ENABLED = String(process.env.MASTER_SUBWALLET_TOPUPS_ENABLED ?? "false").toLowerCase() === "true";
const MIN_SUB_SOL = (BUYBACK_BASE_FLOOR_LAMPORTS + SUB_BUYBACK_OPERATING_RESERVE_LAMPORTS + 1_000_000) / 1_000_000_000;
const TARGET_SUB_SOL = MIN_SUB_SOL + 0.003;
async function ensureSubWalletSol(kp) {
  if (!MASTER_SUBWALLET_TOPUPS_ENABLED) return;
  if (!kp || kp.publicKey.equals(tre().publicKey)) return;
  const sol = await solUiFor(kp.publicKey);
  if (sol >= MIN_SUB_SOL) return;
  const topUp = TARGET_SUB_SOL - sol;
  const lamports = Math.ceil(topUp * 1_000_000_000);
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: tre().publicKey,
        toPubkey: kp.publicKey,
        lamports,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn(), tx, [tre()], { commitment: "confirmed" });
    console.log(
      `[sub-topup] ${kp.publicKey.toBase58()} +${topUp.toFixed(4)} SOL sig=${sig.slice(0, 16)}…`,
    );
  } catch (e) {
    console.warn(`[sub-topup] failed ${kp.publicKey.toBase58()}:`, e.message);
  }
}

// Emergency bridge from master -> sub-wallet for Imperial deposits.
// DEFAULT OFF. When this was on by default, master subsidized every sub-wallet
// that fell short of the deposit gate. With 50+ active tokens each tick that
// drains master fast (operator observed ~0.1-0.2 SOL/min leaving 9Kxfhk...).
// Now opt-in via env. Even when on, we only bridge for sub-wallets that are
// genuinely wedged: state == topup_pending AND blocked > 1h (stateReconcile
// escalates these). Per-token cap stays at $5, master keeps a 0.05 SOL reserve.
const DEPOSIT_TOPUP_ENABLED = String(process.env.DEPOSIT_TOPUP_ENABLED ?? "false").toLowerCase() === "true";
const DEPOSIT_TOPUP_MAX_USD = DEPOSIT_TOPUP_ENABLED
  ? Math.max(0, Number(process.env.DEPOSIT_TOPUP_MAX_USD ?? 5))
  : 0;

const DEPOSIT_TOPUP_BUFFER_USD = 1.5; // covers Jupiter slippage + reserve
async function topupSubForDeposit({ kp, currentCapacityUsd, targetUsd, solUsd, ticker }) {
  if (!DEPOSIT_TOPUP_ENABLED || DEPOSIT_TOPUP_MAX_USD <= 0) {
    console.warn(`[deposit-topup] ${ticker} skip: disabled`);
    return false;
  }
  if (!kp) { console.warn(`[deposit-topup] ${ticker} skip: no sub-wallet kp`); return false; }
  if (kp.publicKey.equals(tre().publicKey)) { console.warn(`[deposit-topup] ${ticker} skip: kp == master`); return false; }
  if (!Number(solUsd) || solUsd <= 0) { console.warn(`[deposit-topup] ${ticker} skip: solUsd=${solUsd}`); return false; }
  const needUsd = Math.max(0, targetUsd + DEPOSIT_TOPUP_BUFFER_USD - currentCapacityUsd);
  console.log(`[deposit-topup] ${ticker} consider: cap=$${currentCapacityUsd.toFixed(2)} target=$${targetUsd.toFixed(2)} need=$${needUsd.toFixed(2)} cap=$${DEPOSIT_TOPUP_MAX_USD}`);
  if (needUsd <= 0) return true;
  const sendUsd = Math.min(needUsd, DEPOSIT_TOPUP_MAX_USD);
  const sendSol = sendUsd / solUsd;
  const lamports = Math.ceil(sendSol * 1_000_000_000);
  // Make sure master has it (leave 0.05 SOL master reserve for fees/rent).
  const masterSol = await solUiFor(tre().publicKey);
  if (masterSol - sendSol < 0.05) {
    console.warn(`[deposit-topup] ${ticker} master SOL ${masterSol.toFixed(4)} too low to send ${sendSol.toFixed(4)}`);
    return false;
  }

  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: tre().publicKey,
        toPubkey: kp.publicKey,
        lamports,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn(), tx, [tre()], { commitment: "confirmed" });
    console.log(
      `[deposit-topup] ${ticker} master -> sub +${sendSol.toFixed(4)} SOL ($${sendUsd.toFixed(2)}) sig=${sig.slice(0, 16)}…`,
    );
    return true;
  } catch (e) {
    console.warn(`[deposit-topup] ${ticker} failed:`, e.message);
    return false;
  }
}


// Skim claimed-fee SOL from a sub-wallet to master.
//
// Reserve-based (option B): we never skim SOL that the sub-wallet still needs
// to fund pending obligations (un-deposited perp fees + buyback reserve).
// Master eventually receives its full ratio of fees, but only the SURPLUS over
// the operating reserve is sent on any given tick. This stops sub-wallets like
// HYPE/HYPU from being drained to ~$5 while sitting on $300+ of perp fees they
// still need to swap to USDC and deposit into Imperial.
async function skimTreasuryShare({
  claimedSolUsd,
  solUsd,
  isSubWallet,
  kp,
  ticker,
  events,
  pendingObligationUsd = 0,
}) {
  if (!(config.treasuryHoldRatio > 0) || !(claimedSolUsd > 0) || !(solUsd > 0)) {
    return { done: false, treasurySolDelta: 0 };
  }

  const holdUsd = claimedSolUsd * config.treasuryHoldRatio;
  const holdSol = holdUsd / solUsd;
  if (!isSubWallet) {
    events.push({
      kind: "skim",
      sol_amount: holdSol,
      note: `treasury skim: $${holdUsd.toFixed(2)} (legacy, already in master)`,
    });
    return { done: true, treasurySolDelta: 0 };
  }

  try {
    const SUB_RESERVE_LAMPORTS = Math.floor(
      Math.max(0.005, Number(config.walletSolReserve ?? 0.01)) * 1e9,
    );
    const TX_FEE_LAMPORTS = 5_000;
    // Hold back enough SOL to cover pending swap-and-deposit obligations.
    // pendingObligationUsd = unspent perp-margin fees + buyback reserve.
    const obligationSol = Math.max(0, Number(pendingObligationUsd) || 0) / solUsd;
    const OBLIGATION_LAMPORTS = Math.floor(obligationSol * 1e9);
    // OPERATING FLOOR: whenever the sub-wallet still owes a deposit, keep
    // enough SOL on hand to actually fund one viable Jupiter SOL->USDC swap.
    // Without this, tiny per-tick claims ($0.5-$1) get partly skimmed before
    // they can ever stack up to the swap floor (~$2-$3), and the sub-wallet
    // never recovers from a historical over-skim (e.g. ZRALLY: $107 in
    // fees_accrued, 0.01 SOL on chain, treasury_sol=-3.02).
    // Only enforced when there's actually a pending obligation, so tokens with
    // a clean ledger still skim normally.
    const SWAP_FLOOR_USD = Math.max(
      Number(config.minDepositUsd ?? 2),
      Number(process.env.SWAP_MIN_VIABLE_USDC ?? 0) || 0,
    );
    const OPERATING_FLOOR_USD = pendingObligationUsd > 0
      ? SWAP_FLOOR_USD * 1.5 // 50% cushion for Jupiter slippage + priority fees
      : 0;
    const OPERATING_FLOOR_LAMPORTS = Math.floor((OPERATING_FLOOR_USD / solUsd) * 1e9);
    const lamports = await withRetry(() => conn().getBalance(kp.publicKey, "confirmed"));
    const wantLamports = Math.floor(holdSol * 1e9);
    const sendable = Math.min(
      wantLamports,
      Math.max(
        0,
        lamports
          - SUB_RESERVE_LAMPORTS
          - TX_FEE_LAMPORTS
          - OBLIGATION_LAMPORTS
          - OPERATING_FLOOR_LAMPORTS,
      ),
    );
    const MIN_SKIM_LAMPORTS = 300_000;
    if (sendable >= MIN_SKIM_LAMPORTS) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: tre().publicKey,
          lamports: sendable,
        }),
      );
      const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: "confirmed" });
      const sentSol = sendable / 1e9;
      const sentUsd = sentSol * solUsd;
      console.log(
        `[treasury-skim] ${ticker} sent ${sentSol.toFixed(6)} SOL ($${sentUsd.toFixed(2)}) -> master sig=${sig.slice(0, 16)}… (reserved $${pendingObligationUsd.toFixed(2)} for pending deposits)`,
      );
      events.push({
        kind: "skim",
        sol_amount: sentSol,
        tx_sig: sig,
        note: `treasury skim: ${sentSol.toFixed(6)} SOL ($${sentUsd.toFixed(2)}) -> master (reserved $${pendingObligationUsd.toFixed(2)})`,
      });
      return { done: true, treasurySolDelta: -sentSol };
    }

    console.log(
      `[treasury-skim] ${ticker} skip: sendable ${(sendable / 1e9).toFixed(6)} SOL < min (want $${holdUsd.toFixed(2)}, sub balance ${(lamports / 1e9).toFixed(6)} SOL, reserved $${pendingObligationUsd.toFixed(2)} obligation + $${OPERATING_FLOOR_USD.toFixed(2)} operating floor)`,
    );
  } catch (e) {
    console.warn(`[treasury-skim] ${ticker} failed:`, e.message);
    events.push({ kind: "tick", note: `treasury skim err: ${e.message.slice(0, 160)}` });
  }

  return { done: true, treasurySolDelta: 0 };
}

// Track treasury SOL across ticks so we can attribute on-curve fee inflow
// (which lands directly in the treasury wallet without an SDK claim) to
// fees_accrued_usd. Persists for the life of the keeper process.
let _lastTreasurySol = null;

// DISABLED 2026-05-28: curve-fee inflow attribution is off (hard zero). Kept as
// a module constant so the (unreachable) inflow branch in readPositionPreState
// references a defined value. Re-enabling requires on-chain reconciliation.
const perTokenInflowUsd = 0;

// readImperialProfileUsdcUi / readVerifiedImperialPosition /
// resolveImperialEntryPrice moved to imperialPerps.js;
// readImperialLiveMarkUsd -> imperial.js getMarkPriceUiSafe (imported above).

async function checkSig(sig) {
  if (!sig) return null;
  try {
    // checkSig gates open/top-up progression, so give it a wider retry budget
    // than a plain read (but not a confirmation-poll budget — it runs per-token
    // per-tick, so a huge backoff could eat the tick watchdog).
    const s = await withRetry(
      () => conn().getSignatureStatus(sig, { searchTransactionHistory: true }),
      { numOfAttempts: 5, maxDelay: 2000 },
    );
    const v = s?.value;
    // With searchTransactionHistory:true, a null value means the tx is not in
    // the live status cache AND not in the recent ledger history — it was
    // dropped (never landed). Treat as failed so we don't block topups
    // forever on a vanished pending sig.
    if (!v) return "dropped";
    if (v.err) return "failed";
    if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")
      return "confirmed";
    return "pending";
  } catch {
    return "pending";
  }
}

// Allowlist of mints the keeper is allowed to touch. If set (comma-separated),
// only matching tokens get fee claims, perp activity, and buyback+burn. All
// others are silently skipped. IMPORTANT: there is intentionally NO hardcoded
// default here. If the Fly secret is not set, the keeper processes every token.
const KEEPER_MINT_ALLOWLIST = (process.env.KEEPER_MINT_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Per-token pipeline steps extracted from tick(). Each receives the shared
// per-token context object `ctx` built by initTokenCtx and mutates it in place.
// ZERO behavior change: every line is the original tick() body with bare locals
// rebased onto ctx.<field>. See plan/LOOP_TICK_REFACTOR.md.
// ---------------------------------------------------------------------------

// Per-token setup. Builds and returns the ctx object, or a {skip:true, report}
// sentinel for the two early-continue cases (wallet-resolve-fail, legacy-master
// skip). Never throws.
function initTokenCtx(t, { solUsd, bucket, tickId }) {
  const events = [];
  const txLog = [];
  const patch = { token_id: t.id };

  // skip sentinel: caller does reports.push + processed++ + continue
  const skipWith = (report) => ({ skip: true, report });

  // Per-token kp: sub-wallet for new launches (treasury_wallet_address set),
  // master treasury for legacy tokens. If derivation mismatches stored
  // address (rotated key), walletForToken throws and we skip the token.
  let kp;
  try {
    kp = walletForToken(tre(), t);
  } catch (e) {
    keeperLog(t, "error", "wallet resolve failed", { error: e.message, tick_id: tickId });
    events.push({ kind: "tick", note: `wallet resolve err: ${e.message.slice(0, 200)}` });
    patch.events = events;
    queueBlocked(t, `wallet resolve err: ${e.message.slice(0, 200)}`, { patch });
    return skipWith(patch);
  }
  const isSubWallet = !kp.publicKey.equals(tre().publicKey);
  // PERPSPAD is the project's namesake token and the master treasury IS its
  // wallet by design. Whitelist it so fee claims, PnL ticks, and buyback
  // drain still run when KEEPER_LEGACY_MASTER_SPEND_ENABLED=false (which
  // is intended to gate ad-hoc Imperial top-ups for OTHER legacy tokens,
  // not freeze PERPAD itself).
  const isPerpadFlagship = String(t.ticker ?? "").toUpperCase() === "PERPSPAD";
  if (!isSubWallet && !config.legacyMasterSpendEnabled && !isPerpadFlagship) {
    const note = "legacy master-token spend disabled by KEEPER_LEGACY_MASTER_SPEND_ENABLED=false";
    keeperLog(t, "info", "master outbound skipped", { tick_id: tickId });
    events.push({ kind: "tick", note });
    patch.events = events;
    return skipWith(patch);
  }
  // NOTE: do NOT pre-emptively top up every sub-wallet every tick.
  // With 100+ idle pending tokens that drains the master ~0.0325 SOL each.
  // Top-ups happen lazily at the buyback site (see ensureSubWalletSol
  // call right before the swap), which is the only place we actually
  // need on-chain SOL on a sub-wallet.

  const ctx = {
    t, kp, isSubWallet, isPerpadFlagship,
    solUsd, bucket, tickId, tStart: Date.now(),
    // accumulators
    events, txLog, patch,
    treasurySolDelta: 0, tokensBurnedDelta: 0, feesAccruedDelta: 0, reserveDelta: 0,
    // derived inputs
    isGraduated: t.migration_status === "graduated",
    isExternal: String(t.source ?? "") === "external",
    buybackMint: String(t.source ?? "") === "external" ? t.external_mint : t.mint_address,
    wasOpen: !!t.position_opened_at,
    underlying: String(t.underlying ?? "").toUpperCase(),
    side: String(t.direction ?? "long").toLowerCase() === "short" ? "short" : "long",
    leverage: clampLeverage(
      `loop:${t.ticker ?? t.id} ${String(t.underlying ?? "").toUpperCase()}`,
      Math.max(1, Number(t.leverage ?? 2)),
      String(t.underlying ?? "").toUpperCase(),
    ),
    feesBefore: Number(t.fees_accrued_usd ?? 0),
    // Imperial routing flags. Computed once per token so every branch
    // (pre-read, open, top-up, pnl-read, withdraw, partial-close) makes
    // the same decision. `imperialTradeEnabled` gates the trade primitives
    // (open/topup/withdraw/partial-close); deposit logic has its own gate.
    isImperialRouted: String(t.router || "").toLowerCase() === "imperial",
    // step-spanning locals (written later)
    imperialDepositedThisTickUsd: 0,
    imperialFundingSource: "none",
    optimisticImperialPositionState: false,
    freshPerpFeesUsd: 0,
    _authToken: null,
  };
  ctx.imperialTradeEnabled =
    ctx.isImperialRouted &&
    config.imperial.enabled &&
    t.imperial_profile_index != null &&
    ["open-only", "full"].includes(config.imperial.positionMode);
  ctx.imperialFullTrade = ctx.imperialTradeEnabled && config.imperial.positionMode === "full";
  ctx.ensureAuth = async () => {
    if (!ctx._authToken) ctx._authToken = await getAuthToken(ctx.kp);
    return ctx._authToken;
  };
  // Only profile USDC that is actually parked/deposited this tick may fund
  // a new Imperial order. Never use DB collateral as available funds here:
  // stale optimistic rows were the source of the UI doubling bug.
  ctx.availableUsd = () => Math.max(0, Number(ctx.imperialDepositedThisTickUsd || 0));
  return ctx;
}

// ---- Backfill imperial_profile_pda unconditionally for imperial-routed
// tokens. The PDA is the on-chain account that actually holds the perp
// position, so the site needs it to render a working "view position"
// link (solscan defi activities). Runs every tick when missing; once
// set, the cheap /mobile/balances call is skipped.
async function backfillProfilePda(ctx) {
  const { t } = ctx;
  if (
    !(ctx.isImperialRouted &&
      config.imperial.enabled &&
      t.imperial_profile_index != null &&
      !t.imperial_profile_pda)
  ) return;
  try {
    const authToken = await ctx.ensureAuth();
    const prof = await imperialGetProfile({
      profileIndex: t.imperial_profile_index,
      token: authToken,
    });
    if (prof?.profilePda) {
      ctx.patch.imperial_profile_pda = prof.profilePda;
      t.imperial_profile_pda = prof.profilePda;
    }
  } catch (e) {
    keeperLog(t, "warn", "phoenix pda backfill failed", { error: e.message, tick_id: ctx.tickId });
  }
}

// ---- 0. graduation detector ----
// If the token isn't marked graduated yet, poll DBC pool state. When
// migrationProgress crosses into "CreatedPool" we derive the DAMM v2
// pool address and flip the row so future ticks use the AMM claim path.
async function detectGraduationStep(ctx) {
  const { t } = ctx;
  if (!(!ctx.isGraduated && t.dbc_pool_address && t.dbc_config_address && t.mint_address)) return;
  try {
    const det = await detectGraduation({
      dbcPoolAddress: t.dbc_pool_address,
      dbcConfigAddress: t.dbc_config_address,
      baseMintAddress: t.mint_address,
      // USDC-quoted pools graduate to a token/USDC DAMM v2 pool; the
      // derived pool address keys off the quote mint. Defaults to SOL.
      quoteMintAddress: t.quote_token === "USDC" ? USDC_MINT : null,
    });
    if (det?.graduated && det.graduatedPoolAddress) {
      console.log(
        `[graduation] ${t.ticker} migrated. damm=${det.graduatedPoolAddress} progress=${det.progress}`,
      );
      ctx.patch.migration_status = "graduated";
      ctx.patch.graduated_pool_address = det.graduatedPoolAddress;
      // Mutate local view so the rest of this tick uses the new pool.
      t.migration_status = "graduated";
      t.graduated_pool_address = det.graduatedPoolAddress;
      ctx.isGraduated = true;
      ctx.events.push({
        kind: "graduation",
        note: `bonding curve graduated. DAMM v2 pool ${det.graduatedPoolAddress}`,
      });
    }
  } catch (e) {
    keeperLog(t, "warn", "graduation detect failed", { error: e.message, tick_id: ctx.tickId });
  }
}

// Returns true (skip) when the underlying is unsupported; caller finalizes
// the report and continues.
function marketSupportGate(ctx) {
  const { t } = ctx;
  if (isUnderlyingSupportedForToken(t, ctx.underlying)) return false;
  const routerId = String(t?.router ?? "imperial").toLowerCase();
  // Fix 2a runtime fallback: terminal market_unsupported classification.
  // These tokens can never open a perp on this keeper, so flag them with a
  // distinct reason (for a creator remap) and a long re-check backoff
  // rather than retrying every tick. Native tokens bail before the claim
  // step, so there is no perp slice to redirect here (unlike the external
  // sweep path). See KEEPER_P1_FIXES.md Fix 2a.
  ctx.events.push({
    kind: "tick",
    note: `market_unsupported: ${ctx.underlying || "unknown"} not routable by router ${routerId}, skipping hedge`,
  });
  ctx.patch.events = ctx.events;
  ctx.patch.tx_log = ctx.txLog;
  queueBlocked(t, `market_unsupported: ${ctx.underlying || "unknown"} (router ${routerId})`, {
    patch: ctx.patch,
    nextRetryAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  });
  return true;
}

// ---- 1. confirm pending perp request from prior tick ----
export async function confirmPendingSigStep(ctx) {
  const { t } = ctx;
  ctx.pendingSig = t.pending_drift_sig ?? null;
  // F5: a TP close that was accepted without a real on-chain signature (Imperial
  // verified-via-positions) parks this sentinel. It is NOT a real signature — do
  // not poll checkSig (which returns "pending" forever for non-sigs and would gate
  // the token permanently). Clear it from the DB now (so it lasts exactly one
  // tick) but keep ctx.pendingSig truthy so this tick's TP/top-up still defer,
  // giving the venue one cycle to settle the reduced size before we read it again.
  if (ctx.pendingSig === TP_SETTLE_SENTINEL) {
    ctx.patch.pending_drift_sig = null;
    ctx.events.push({ kind: "tick", note: "tp settle: deferring one tick for venue to reflect reduced size" });
    return;
  }
  const wfBeforePendingCheck = workflowStateFromToken(t);
  if (ctx.pendingSig && ctx.wasOpen && wfBeforePendingCheck?.state === State.POSITION_OPEN) {
    ctx.patch.pending_drift_sig = null;
    console.warn(
      `[loop] ${t.ticker} clearing stale pending sig ${ctx.pendingSig.slice(0, 16)}… because workflow and DB both show a live open position`,
    );
    ctx.events.push({
      kind: "tick",
      note: `cleared stale pending sig; live position is already open`,
    });
    ctx.pendingSig = null;
  }
  if (ctx.pendingSig) {
    const status = await checkSig(ctx.pendingSig);
    if (status === "confirmed" || status === "failed" || status === "dropped") {
      ctx.patch.pending_drift_sig = null;
      ctx.txLog.push(
        buildTxLogEntry({
          kind: "drift_adjust",
          intent: ctx.pendingSig.slice(0, 32),
          status: status === "dropped" ? "failed" : status,
          signature: ctx.pendingSig,
          error:
            status === "failed"
              ? "tx failed on-chain"
              : status === "dropped"
                ? "tx dropped (never landed); clearing pending sig"
                : undefined,
        }),
      );
      if (status === "dropped") {
        console.warn(
          `[loop] ${t.ticker} pending sig ${ctx.pendingSig.slice(0, 16)}… dropped (not found on-chain); cleared to unblock topups`,
        );
      }
      ctx.pendingSig = null;
    }
  }
}

// ---- 2. claim fees (always run regardless of position state) ----
async function claimAndSplitFeesStep(ctx) {
  const { t, solUsd, bucket } = ctx;
  ctx.claimedSolUsd = 0;
  if (t.mint_address && (t.dbc_pool_address || t.graduated_pool_address)) {
    try {
      let totalClaimedSol = 0;
      let lastSig = null;

      // DBC claim: always attempt while a DBC pool exists. Partner trading
      // fees accrued pre-graduation are still claimable after migration,
      // and the SDK no-ops cleanly when there's nothing to claim.
      if (t.dbc_pool_address) {
        const intent = intentHash([t.id, "fee_claim_dbc", bucket, t.dbc_pool_address]);
        const claim = await claimDbcFees({
          dbcPoolAddress: t.dbc_pool_address,
          solUsd,
          kp: ctx.kp,
          // USDC pools accrue fees in USDC; the claim helper converts to SOL.
          quoteMint: t.quote_token === "USDC" ? USDC_MINT : undefined,
        });
        if (claim) {
          const usd = claim.solClaimed * solUsd;
          totalClaimedSol += claim.solClaimed;
          lastSig = claim.signature;
          ctx.txLog.push(
            buildTxLogEntry({
              kind: "fee_claim_dbc",
              intent,
              status: "confirmed",
              signature: claim.signature,
              amountSol: claim.solClaimed,
              amountUsd: usd,
            }),
          );
        }
      }

      // DAMM v2 claim: once we know the graduated pool address.
      if (ctx.isGraduated && t.graduated_pool_address) {
        const intent = intentHash([t.id, "fee_claim_amm", bucket, t.graduated_pool_address]);
        const claim = await claimAmmFees({
          graduatedPoolAddress: t.graduated_pool_address,
          mintAddress: t.mint_address,
          lpPositionAddress: t.lp_position_address,
          solUsd,
          kp: ctx.kp,
          quoteMint: t.quote_token === "USDC" ? USDC_MINT : undefined,
        });

        if (claim) {
          const usd = claim.solClaimed * solUsd;
          totalClaimedSol += claim.solClaimed;
          lastSig = claim.signature;
          ctx.txLog.push(
            buildTxLogEntry({
              kind: "fee_claim_amm",
              intent,
              status: "confirmed",
              signature: claim.signature,
              amountSol: claim.solClaimed,
              amountUsd: usd,
            }),
          );
          if (claim.lpPositionAddress && claim.lpPositionAddress !== t.lp_position_address) {
            ctx.patch.lp_position_address = claim.lpPositionAddress;
          }
        }
      }

      if (totalClaimedSol > 0) {
        ctx.claimedSolUsd = totalClaimedSol * solUsd;
        ctx.patch.last_fee_claim_at = new Date().toISOString();
        ctx.patch.last_fee_claim_signature = lastSig;
      }
    } catch (e) {
      keeperLog(t, "warn", "fee claim failed", { error: e.message, tick_id: ctx.tickId });
      ctx.events.push({ kind: "tick", note: `fee claim error: ${e.message.slice(0, 200)}` });
    }
  }

  if (ctx.claimedSolUsd > 0) {
    ctx.freshPerpFeesUsd = ctx.claimedSolUsd * config.perpMarginRatio;
    ctx.feesAccruedDelta = ctx.freshPerpFeesUsd;
    // SOL the sub-wallet still owes to swap+deposit: previously accrued
    // perp fees + this claim's perp slice + earmarked buyback reserve.
    // Skim holds back enough SOL to cover this before sending master its share.
    const pendingObligationUsd =
      Number(ctx.feesBefore || 0) +
      ctx.feesAccruedDelta +
      Number(t.buyback_reserve_usd || 0) +
      (config.buybackFromFeesRatio > 0 ? ctx.claimedSolUsd * config.buybackFromFeesRatio : 0);
    const skim = await skimTreasuryShare({
      claimedSolUsd: ctx.claimedSolUsd,
      solUsd,
      isSubWallet: ctx.isSubWallet,
      kp: ctx.kp,
      ticker: t.ticker,
      events: ctx.events,
      pendingObligationUsd,
    });
    ctx.treasurySolDelta += skim.treasurySolDelta;
    const lastClaimSig = ctx.patch.last_fee_claim_signature ?? null;
    ctx.events.push({
      kind: "claim",
      sol_amount: ctx.claimedSolUsd / solUsd,
      note: `claimed $${ctx.claimedSolUsd.toFixed(2)} in trading fees. Split: $${ctx.feesAccruedDelta.toFixed(2)} perp, $${(ctx.claimedSolUsd * config.buybackFromFeesRatio).toFixed(2)} buyback, $${(ctx.claimedSolUsd * config.treasuryHoldRatio).toFixed(2)} treasury`,
      tx_sig: lastClaimSig ?? undefined,
    });
  }
}

// ---- 2b. BUYBACK ACCRUAL + DRAIN ----
// Each tick we earmark a slice of claimed fees into buyback_reserve_usd.
// Accrual runs for both curve and graduated tokens so pre-grad fees
// (ZRALLY, pre-grad DEGEN) build up a reserve that drains the moment
// the token graduates and Jupiter can route through DAMM v2. Spending
// is still gated below by canRouteBuyback (isExternal || isGraduated).
async function buybackDrainStep(ctx) {
  const { t, solUsd, bucket } = ctx;
  if (config.buybackFromFeesRatio > 0 && ctx.claimedSolUsd > 0 && (t.mint_address || t.external_mint)) {
    const earmarkUsd = ctx.claimedSolUsd * config.buybackFromFeesRatio;
    ctx.reserveDelta += earmarkUsd;
    console.log(
      `[buyback] accrue token=${t.ticker} +$${earmarkUsd.toFixed(4)} (ratio=${config.buybackFromFeesRatio}, graduated=${ctx.isGraduated})`,
    );
  }

  // Drain reserve when it crosses the USD floor. Cap per-tick spend
  // so any backlog (e.g. from a code switch) bleeds down gradually
  // instead of one giant swap.
  const currentReserveSnapshot = Math.max(0, Number(t.buyback_reserve_usd ?? 0));
  const projectedReserve = currentReserveSnapshot + ctx.reserveDelta;
  const maxPerTickUsd = Number(config.maxBuybackPerTickUsd ?? 25);
  const canRouteBuyback = !!ctx.buybackMint && (ctx.isExternal || ctx.isGraduated);
  if (projectedReserve >= config.minBuybackUsd && !ctx.pendingSig && canRouteBuyback) {
    let spendUsd = Math.min(projectedReserve, maxPerTickUsd);
    let wantSol = spendUsd / solUsd;
    // External tokens (TOLY etc.) AND imperial-routed tokens realize PnL
    // as USDC in their sub-wallet, not SOL. Probe USDC balance and prefer
    // it as the swap input so we don't try to spend SOL the wallet
    // doesn't have.
    let payMint = null;
    let payAmountBaseUnits = null;
    let payNote = `${wantSol.toFixed(6)} SOL`;
    if (ctx.isExternal || ctx.isImperialRouted) {
      try {
        const usdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), ctx.kp.publicKey);
        const usdcBal = await withRetry(() => conn().getTokenAccountBalance(usdcAta, "confirmed"))
          .catch(() => null);
        let usdcUi = Number(usdcBal?.value?.uiAmount ?? 0);
        if (usdcUi < spendUsd && ctx.isImperialRouted && ctx.imperialFullTrade && t.imperial_profile_index != null) {
          const authToken = await ctx.ensureAuth();
          const profileUsdc = await readImperialProfileUsdcUi({
            profileIndex: t.imperial_profile_index,
            authToken,
            profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
          });
          // F2.2: readImperialProfileUsdcUi already returns the FREE (withdrawable)
          // profile USDC — locked collateral is NOT included — so it must not be
          // netted against position_collateral_usd again (that double-counted the
          // lock and starved buyback withdrawals).
          const profileFreeUsd = Math.max(0, profileUsdc);
          if (profileFreeUsd >= spendUsd) {
            // F6: withdraw can hit transient venue/RPC errors — retry like the TP path.
            const w = await withVenueRetry("buyback withdraw", ctx, async () =>
              imperialWithdrawCollateral({
                authToken,
                kp: ctx.kp,
                profileIndex: t.imperial_profile_index,
                withdrawUsd: spendUsd,
                rpcUrl: config.rpcUrl,
              }));
            if (!w.error && w.signature) {
              ctx.events.push({
                kind: "tick",
                note: `phoenix profit withdrawal: $${spendUsd.toFixed(2)} profile USDC → sub-wallet for buyback`,
                tx_sig: w.signature,
              });
              await new Promise((r) => setTimeout(r, 2000));
              const afterBal = await withRetry(() => conn().getTokenAccountBalance(usdcAta, "confirmed"))
                .catch(() => null);
              usdcUi = Number(afterBal?.value?.uiAmount ?? 0);
            } else {
              ctx.events.push({
                kind: "tick",
                note: `phoenix profit withdrawal: ${String(w.error ?? "no signature returned").slice(0, 150)}`,
              });
            }
          }
        }
        if (usdcUi >= spendUsd) {
          payMint = USDC_MINT;
          payAmountBaseUnits = Math.floor(spendUsd * 1_000_000);
          payNote = `${spendUsd.toFixed(2)} USDC`;
        } else {
          console.log(
            `[buyback] ${t.ticker} USDC balance $${usdcUi.toFixed(2)} < spend $${spendUsd.toFixed(2)}, falling back to SOL path`,
          );
        }
      } catch (e) {
        keeperLog(t, "warn", "buyback USDC probe failed", { error: e.message, tick_id: ctx.tickId });
      }
    }
    if (!ctx.isSubWallet && !payMint) {
      const masterSpendBudgetUsd = Math.max(0, ctx.reserveDelta);
      if (spendUsd > masterSpendBudgetUsd) {
        const cappedSpendUsd = Math.min(spendUsd, masterSpendBudgetUsd);
        console.warn(
          `[buyback] ${t.ticker} legacy master SOL spend capped: $${spendUsd.toFixed(2)} -> $${cappedSpendUsd.toFixed(2)} (new reserve only)`,
        );
        spendUsd = cappedSpendUsd;
        wantSol = spendUsd / solUsd;
        payNote = `${wantSol.toFixed(6)} SOL`;
      }
    }
    if (ctx.isSubWallet && !payMint) {
      const walletLamports = await withRetry(() => conn().getBalance(ctx.kp.publicKey, "confirmed"));
      const spendableLamports = buybackSpendableLamports({ walletLamports, isMaster: false });
      const spendableUsd = (spendableLamports / 1_000_000_000) * solUsd;
      if (spendUsd > spendableUsd) {
        const cappedSpendUsd = Math.max(0, spendableUsd);
        console.warn(
          `[buyback] ${t.ticker} sub-wallet SOL spend capped: $${spendUsd.toFixed(2)} -> $${cappedSpendUsd.toFixed(2)} (keeps ${(MIN_SUB_SOL).toFixed(3)} SOL floor)`,
        );
        spendUsd = cappedSpendUsd;
        wantSol = spendUsd / solUsd;
        payNote = `${wantSol.toFixed(6)} SOL`;
      }
    }
    // Re-check the USD floor after any clamping above. Without this, the
    // master-wallet "new reserve only" cap can shrink spendUsd down to a
    // few cents and still send a swap. Skip and let the reserve carry to
    // the next tick until it crosses the floor again.
    if (spendUsd < config.minBuybackUsd) {
      console.log(
        `[buyback] ${t.ticker} skip: spend $${spendUsd.toFixed(2)} below minBuybackUsd $${config.minBuybackUsd} after clamp; carrying reserve`,
      );
    } else {
      console.log(
        `[buyback] drain token=${t.ticker} reserve=$${projectedReserve.toFixed(2)} spend=$${spendUsd.toFixed(2)} (cap=$${maxPerTickUsd}) input=${payNote}`,
      );
    }
    const okToSwap = spendUsd >= config.minBuybackUsd && (payMint ? true : wantSol >= config.minBuybackSol);
    if (okToSwap) {
      const intent = intentHash([t.id, "fee_buyback", bucket, spendUsd.toFixed(4)]);
      try {
        // Ensure sub-wallet has the SOL floor (rent + tx fees) before the
        // swap. Otherwise Jupiter's ATA-create instruction fails mid-tx
        // with "Transfer: insufficient lamports" and the reserve never
        // drains. Cheap (~0.012 SOL max) and idempotent.
        if (ctx.isSubWallet) {
          try { await ensureSubWalletSol(ctx.kp); } catch (e) {
            console.warn("[loop] ensureSubWalletSol(buyback):", e.message);
          }
        }
        try {
          await unwrapWsol(ctx.kp);
        } catch (e) {
          console.warn("[loop] unwrapWsol:", e.message);
        }
        const r = await buybackAndBurn({
          mintAddress: ctx.buybackMint,
          solAmount: payMint ? undefined : wantSol,
          payMint: payMint ?? undefined,
          payAmountBaseUnits: payAmountBaseUnits ?? undefined,
          kp: ctx.kp,
        });

        const actualSpendUsd = payMint ? spendUsd : Number(r.solSpent ?? wantSol) * solUsd;
        const actualSolSpent = payMint ? 0 : Number(r.solSpent ?? wantSol);
        if (!payMint) ctx.treasurySolDelta -= actualSolSpent;
        ctx.tokensBurnedDelta += r.tokensBurned;
        ctx.reserveDelta -= actualSpendUsd; // subtract only what we actually spent
        ctx.txLog.push(
          buildTxLogEntry({
            kind: "swap",
            intent,
            status: "confirmed",
            signature: r.swapSig,
            amountSol: actualSolSpent,
            amountUsd: actualSpendUsd,
            amountTokens: r.tokensBought,
          }),
        );
        ctx.txLog.push(
          buildTxLogEntry({
            kind: "burn",
            intent,
            status: "confirmed",
            signature: r.burnSig,
            amountTokens: r.tokensBurned,
          }),
        );
        ctx.events.push({
          kind: "buyback",
          sol_amount: actualSolSpent,
          tokens_amount: r.tokensBurned,
          note: `buyback drain: $${actualSpendUsd.toFixed(2)} of $${projectedReserve.toFixed(2)} reserve (${payNote}) -> burned ${r.tokensBurned} tokens`,
          tx_sig: r.swapSig,
        });
        ctx.events.push({
          kind: "burn",
          tokens_amount: r.tokensBurned,
          tx_sig: r.burnSig,
          note: `burned ${r.tokensBurned} tokens`,
        });
        console.log(
          `[buyback] executed token=${t.ticker} input=${payNote} tokens=${r.tokensBurned} swap=${r.swapSig} burn=${r.burnSig}`,
        );
      } catch (e) {
        if (e?.code === "INSUFFICIENT_FUNDS") {
          // Sub-wallet is temporarily short on SOL for ATA rent / fees.
          // ensureSubWalletSol will refill it on a subsequent tick; just
          // carry the reserve and note it (no warn-spam).
          keeperLog(t, "info", "buyback drain skipped (sub-wallet low SOL)", {
            error: e.message,
            tick_id: ctx.tickId,
          });
          ctx.events.push({ kind: "tick", note: `buyback skip (low SOL): ${e.message.slice(0, 160)}` });
        } else if (e?.code === "EXCESSIVE_PRICE_IMPACT") {
          // Pool is too thin for the current spend size. Carry reserve;
          // it will re-attempt next tick. If the pool stays thin forever,
          // operator can lower MAX_BUYBACK_PER_TICK_USD so each slice
          // fits, or raise MAX_BUYBACK_PRICE_IMPACT_PCT if intentional.
          keeperLog(t, "info", "buyback drain skipped (price impact too high)", {
            error: e.message,
            tick_id: ctx.tickId,
          });
          ctx.events.push({ kind: "tick", note: `buyback skip (impact): ${e.message.slice(0, 200)}` });
        } else {
          keeperLog(t, "warn", "buyback drain failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({ kind: "tick", note: `buyback drain err: ${e.message.slice(0, 200)}` });
        }
      }
    }
  }

  // DISABLED 2026-05-28: see comment above near _lastTreasurySol.
  // Bonding-curve fees that bypass the SDK claim are NOT credited to
  // fees_accrued_usd anymore. If we want to capture them, do it via
  // an explicit on-chain reconciliation that also reserves the SOL,
  // not by attributing wallet deltas.
  const eligibleForInflow = !!t.mint_address && t.migration_status !== "graduated";
  if (eligibleForInflow && perTokenInflowUsd > 0) {
    // unreachable while perTokenInflowUsd is hard-zero, kept for shape
    ctx.feesAccruedDelta += perTokenInflowUsd;
    ctx.events.push({
      kind: "tick",
      note: `+$${perTokenInflowUsd.toFixed(2)} curve fees from treasury inflow`,
    });
  }
}

// ---- pre-read live position state (feeds 2d/3/4/5) ----
async function readPositionPreState(ctx) {
  const { t, solUsd } = ctx;
  ctx.feesAccruedAfter = ctx.feesBefore + ctx.feesAccruedDelta;
  // Master-wallet tokens share the real master treasury address, so their
  // historic DB fee ledger is not spendable cash. If the operator manually
  // refills master SOL, do not convert that principal into token collateral.
  // Only sub-wallet tokens may spend their accumulated ledger balance.
  ctx.perpFundingBudgetUsd = ctx.isSubWallet
    ? ctx.feesAccruedAfter
    : Math.max(0, ctx.freshPerpFeesUsd);
  ctx.currentReserve = Math.max(0, Number(t.buyback_reserve_usd ?? 0));
  ctx.openedColl = Number(t.opened_collateral_usd ?? 0);
  ctx.currentColl = Number(t.position_collateral_usd ?? 0);
  ctx.chainPos = null;
  ctx.hasLivePosition = ctx.wasOpen;
  ctx.externallyClosed = false;

  if ((ctx.wasOpen || ctx.isExternal || ctx.isImperialRouted) && !ctx.pendingSig) {
    try {
      if (ctx.isImperialRouted) {
        // Imperial-routed: read from /positions filtered by profile BEFORE
        // checking parked profile USDC. Imperial balance endpoints can
        // include locked collateral, so this live read prevents counting
        // existing collateral as reusable free margin on every tick.
        ctx.chainPos = await imperialReadPosition({
          profileIndex: t.imperial_profile_index,
          symbol: ctx.underlying,
          side: ctx.side,
          token: await ctx.ensureAuth().catch(() => null),
          wallet: ctx.kp.publicKey.toBase58(),
        });
      } else {
        ctx.chainPos = await readPerpPosition({ symbol: ctx.underlying, side: ctx.side, kp: ctx.kp });
      }
      if (ctx.chainPos) {
        ctx.hasLivePosition = true;
        if (!ctx.wasOpen) ctx.patch.position_opened = true;
        if (ctx.isImperialRouted) {
          const liveMark = await readImperialLiveMarkUsd(ctx.underlying);
          if (liveMark) ctx.chainPos.markPriceUsd = liveMark;
        }
        if (Number.isFinite(Number(ctx.chainPos.collateralUsd)))
          ctx.patch.position_collateral_usd = Number(ctx.chainPos.collateralUsd);
        if (Number.isFinite(Number(ctx.chainPos.sizeUsd)))
          ctx.patch.position_size_usd = Number(ctx.chainPos.sizeUsd);
        if (
          ctx.isImperialRouted &&
          !(Number(t.launch_mid ?? 0) > 0) &&
          Number.isFinite(Number(ctx.chainPos.entryPriceUsd)) &&
          Number(ctx.chainPos.entryPriceUsd) > 0
        ) {
          ctx.patch.launch_mid = Number(ctx.chainPos.entryPriceUsd);
        } else if (ctx.isImperialRouted) {
          // Imperial often returns no entry price, which left launch_mid null
          // and forced the fragile client-side coll=$X tick replay. Right after
          // open, mark ~ entry, so capture the mark as our durable entry basis;
          // captureMarkAsEntry's window guard never adopts the mark for an aged
          // position (which would erase its real PnL). See KEEPER_PNL.md.
          const captured = captureMarkAsEntry({
            existingMid: t.launch_mid,
            mark: ctx.chainPos.markPriceUsd,
            openedAt: t.position_opened_at,
            now: Date.now(),
            windowMs: ENTRY_CAPTURE_WINDOW_MS,
          });
          if (captured != null) ctx.patch.launch_mid = captured;
        }
        if (!ctx.openedColl && Number.isFinite(Number(ctx.chainPos.collateralUsd)))
          ctx.patch.opened_collateral_usd = Number(ctx.chainPos.collateralUsd);
      } else if (ctx.wasOpen) {
        if (ctx.isImperialRouted) {
          // Imperial/Phoenix /positions can miss an otherwise-live position
          // for a tick, especially around WTIOIL/OIL aliasing and indexing
          // lag. A miss is not proof of an on-chain close. Preserve the DB
          // position so the card stays live and fee top-ups can keep trying.
          ctx.hasLivePosition = true;
          ctx.events.push({
            kind: "tick",
            note: "phoenix position read missed; preserving recorded position and continuing top-ups",
          });
        } else {
          ctx.hasLivePosition = false;
          ctx.externallyClosed = true;
          ctx.patch.position_opened = false;
          ctx.patch.position_size_usd = 0;
          ctx.patch.position_collateral_usd = 0;
          ctx.patch.opened_collateral_usd = 0;
          ctx.patch.launch_mid = null;
          ctx.patch.treasury_pnl_usd = 0;
          ctx.patch.pnl_high_water_usd = 0;
          ctx.events.push({
            kind: "close",
            note: "position closed/liquidated on chain. Reset state; will re-open at next fee gate.",
          });
        }
      }
    } catch (e) {
      keeperLog(t, "warn", "pre-read position failed", { error: e.message, tick_id: ctx.tickId });
    }
  }
}

// ---- 2d. IMPERIAL DEPOSIT (side-by-side with Jupiter perps) ----
// Off / shadow / live, gated by IMPERIAL_DEPOSIT_MODE. Only fires when
// the token has an assigned imperial_profile_index. In `live` we sign
// and submit /deposit/build-tx (auto-swapping SOL->USDC if needed).
// In `shadow` we just log what would happen. Either way we DO NOT
// mutate feesAccruedDelta here — Jupiter's open/topup gate below still
// owns the fee accounting, so this step is purely additive plumbing
// until we flip the perp open path itself over to Imperial.
// (Imperial routing flags are declared once at the top of the per-token
// block so every branch agrees. See `isImperialRouted` / `imperialTradeEnabled`
// above.)
async function imperialDepositStep(ctx) {
  const { t, solUsd, bucket } = ctx;
  // Fast-path skip: for tokens with no live position, no accrued fees
  // anywhere near the open gate, and no known funded profile PDA, the
  // pre-check call to imperialGetProfile cannot produce any action this
  // tick. Skipping these saves an Imperial API call + RPC hit per token,
  // which on idle PEND-* tokens was consuming most of the tick budget
  // and starving live vaults like TREMP before the 240s watchdog fired.
  const canActThisTick =
    ctx.hasLivePosition ||
    ctx.patch.position_opened ||
    !!t.imperial_profile_pda ||
    ctx.perpFundingBudgetUsd >= Number(config.feeGateUsd ?? 50) * 0.5;

  if (
    ctx.isImperialRouted &&
    config.imperial.enabled &&
    config.imperial.depositMode !== "off" &&
    t.imperial_profile_index != null &&
    canActThisTick
  ) {
    const kind = ctx.hasLivePosition || ctx.patch.position_opened ? "topup" : "open";
    // For topup, deposit ALL accrued fees in one shot (capped at a sane
    // ceiling) instead of trickling config.topUpCollateralUsd per tick.
    // Otherwise tokens like HYPU with $354 in fees take ~17 ticks to
    // deploy. Open still uses openCollateralUsd as the target (the
    // partial-open path will cap by what's actually in the wallet).
    const topupTarget = Math.max(
      Number(config.topUpCollateralUsd) || 0,
      Number(ctx.perpFundingBudgetUsd) || 0,
    );
    const requestedUsd = kind === "open" ? config.openCollateralUsd : topupTarget;

    // ---- Pre-check: profile already has parked USDC from a prior tick.
    // If so, treat it as deposited-this-tick and skip the SOL->USDC swap +
    // /deposit/build-tx call. This recovers tokens where a previous tick
    // deposited but placeOrder failed (e.g. HYPU, PAMP) without waiting
    // for new fees to re-trigger the gate.
    try {
      const authToken = await ctx.ensureAuth();
      const prof = await imperialGetProfile({
        profileIndex: t.imperial_profile_index,
        token: authToken,
      });
      if (prof?.profilePda && !t.imperial_profile_pda) {
        ctx.patch.imperial_profile_pda = prof.profilePda;
      }
      // Imperial's /mobile/balances can lag or mix accounting surfaces.
      // The profile PDA's USDC ATA is the free parked balance that top-ups
      // can attach, so prefer it when available and use the API as fallback.
      let parkedUi = Number(prof.usdcUi || 0);
      let parkedSource = "api";
      if (prof.profilePda) {
        try {
          const pdaPk = new PublicKey(prof.profilePda);
          const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), pdaPk, true);
          const bal = await withRetry(() => conn().getTokenAccountBalance(ata, "confirmed"));
          const onChainUi = Number(bal?.value?.uiAmount ?? 0);
          if (Number.isFinite(onChainUi)) {
            parkedUi = onChainUi;
            parkedSource = "on-chain";
          }
        } catch (e) {
          // ATA may not exist; that's fine, just leave parkedUi as-is.
        }
      }
      const reusableParkedUsd = parkedUi;
      // Parked USDC is ALREADY in the profile (deposited via the 50% perp
      // leg of external sweeps). It is NOT metered by feesAccruedAfter --
      // that counter only tracks DBC claim fees. Deploying the full
      // reusable parked balance lets external tokens (pump.fun) actually
      // grow collateral instead of being stuck at the open size.
      const budgetedParkedUsd = Math.min(
        reusableParkedUsd,
        Math.max(reusableParkedUsd, Number(requestedUsd) || 0),
      );
      if (budgetedParkedUsd >= IMPERIAL_MIN_COLLATERAL_USD) {
        ctx.imperialDepositedThisTickUsd = Math.floor(budgetedParkedUsd * 100) / 100;
        ctx.imperialFundingSource = "parked";
        console.log(
          `[imperial:deposit] ${t.ticker} ${kind} reuse parked $${ctx.imperialDepositedThisTickUsd.toFixed(2)} of $${reusableParkedUsd.toFixed(2)} in profile ${t.imperial_profile_index} (src=${parkedSource}); skipping deposit`,
        );
        ctx.events.push({
          kind: "tick",
          note: `imperial ${kind}: reuse $${ctx.imperialDepositedThisTickUsd.toFixed(2)} parked in profile ${t.imperial_profile_index} (src=${parkedSource})`,
        });
      } else {
        // Louder diagnostic: log what Imperial reports vs what the keeper
        // wants, so stuck profiles (e.g. HYPU pyHh1Y... with $3k on-chain
        // but $0 reported) are visible at [info] level.
        console.log(
          `[imperial:deposit] ${t.ticker} pre-check: profile ${t.imperial_profile_index} pda=${prof.profilePda ?? "?"} reports $${prof.usdcUi.toFixed(4)} api+on-chain=$${parkedUi.toFixed(4)} (need $${requestedUsd.toFixed(2)})`,
        );
      }
    } catch (e) {
      keeperLog(t, "warn", "phoenix profile pre-check failed", { error: e.message, tick_id: ctx.tickId });
    }
  }

  if (
    ctx.isImperialRouted &&
    config.imperial.enabled &&
    config.imperial.depositMode !== "off" &&
    t.imperial_profile_index != null &&
    ctx.imperialDepositedThisTickUsd === 0
  ) {
    const kind = ctx.hasLivePosition || ctx.patch.position_opened ? "topup" : "open";
    // Same scale-up rule as the pre-check above: when topping up, request
    // the full accrued fees instead of the small per-tick increment.
    const topupTarget = Math.max(
      Number(config.topUpCollateralUsd) || 0,
      Number(ctx.perpFundingBudgetUsd) || 0,
    );
    const requestedUsd = kind === "open" ? config.openCollateralUsd : topupTarget;

    // Use spendable fee budget so a brand-new claim can fund immediately,
    // but master-wallet tokens cannot spend manually-added treasury SOL.
    const gateToken = { ...t, fees_accrued_usd: ctx.perpFundingBudgetUsd };
    const gate = gateImperialFunding({ token: gateToken, kind, requestedUsd });
    if (!gate.allow) {
      console.log(`[imperial:deposit] ${t.ticker} ${kind} skip: ${gate.reason}`);
    } else if (config.imperial.depositMode === "shadow") {
      console.log(
        `[imperial:deposit:shadow] ${t.ticker} ${kind} would deposit $${gate.allowedUsd.toFixed(2)} -> profile ${t.imperial_profile_index}`,
      );
      ctx.events.push({
        kind: "tick",
        note: `[imperial:shadow] would deposit $${gate.allowedUsd.toFixed(2)} to profile ${t.imperial_profile_index}`,
      });
    } else {
      // live: re-cap by actual wallet capacity so we don't burn Jupiter
      // slippage on a swap that can't reach the target amount.
      // Fix 1d: same floors as the funding gate (gateImperialFunding). The
      // viable-swap floor applies always; an OPEN additionally requires
      // Imperial's minimum collateral so we never partial-deposit below the
      // size that can actually open a position. Below the floor the SOL
      // stays in the wallet to accumulate toward the next viable deposit.
      const floor = Math.max(
        1,
        Number(config.minDepositUsd ?? 5),
        Number(MIN_VIABLE_USDC) || 0,
        kind === "open" ? Number(IMPERIAL_MIN_COLLATERAL_USD) || 0 : 0,
      );
      let finalUsd = gate.allowedUsd;
      try {
        let capacityUsd = await getWalletCapacityUsd({ kp: ctx.kp, solUsd, rpcUrl: config.rpcUrl });
        // If on-paper fees clear the gate but the wallet is short on cash
        // (long-tail / small-fee tokens whose claimed SOL never accumulated
        // enough), advance SOL from master so the deposit can actually fund.
        // Bounded by DEPOSIT_TOPUP_MAX_USD and capped by gate.allowedUsd.
        if (capacityUsd < finalUsd) {
          const toppedUp = await topupSubForDeposit({
            kp: ctx.kp,
            currentCapacityUsd: capacityUsd,
            targetUsd: finalUsd,
            solUsd,
            ticker: t.ticker,
          });
          if (toppedUp) {
            capacityUsd = await getWalletCapacityUsd({ kp: ctx.kp, solUsd, rpcUrl: config.rpcUrl });
          }
        }
        if (capacityUsd < finalUsd) {
          if (capacityUsd < floor) {
            console.log(
              `[imperial:deposit] ${t.ticker} ${kind} skip: wallet capacity $${capacityUsd.toFixed(2)} < floor $${floor} (fees $${gate.fees.toFixed(2)})`,
            );
            ctx.events.push({
              kind: "tick",
              note: `imperial ${kind} skip: awaiting_swap_size — wallet capacity $${capacityUsd.toFixed(2)} below viable floor $${floor} (reserve accumulating)`,
            });
            finalUsd = 0;
          } else {
            console.log(
              `[imperial:deposit] ${t.ticker} ${kind} partial: cap $${finalUsd.toFixed(2)} -> wallet capacity $${capacityUsd.toFixed(2)}`,
            );
            finalUsd = Math.floor(capacityUsd * 100) / 100;
          }
        }

      } catch (e) {
        keeperLog(t, "warn", "phoenix wallet capacity check failed", { error: e.message, tick_id: ctx.tickId });
      }
      if (finalUsd <= 0) {
        // already logged & skipped above
      } else
        try {
          const authToken = await ctx.ensureAuth();
          const r = await depositToImperialProfile({
            authToken,
            kp: ctx.kp,
            profileIndex: t.imperial_profile_index,
            usdAmount: finalUsd,
            solUsd,
            rpcUrl: config.rpcUrl,
          });
          ctx.imperialDepositedThisTickUsd = r.depositedUsd;
          ctx.imperialFundingSource = "fresh";
          console.log(
            `[imperial:deposit] ${t.ticker} ${kind} deposited $${r.depositedUsd.toFixed(2)} -> profile ${t.imperial_profile_index} sig=${r.signature.slice(0, 16)}…`,
          );
          ctx.txLog.push(
            buildTxLogEntry({
              kind: "imperial_deposit",
              intent: intentHash([t.id, "imperial_deposit", bucket, finalUsd.toFixed(2)]),
              status: "confirmed",
              signature: r.signature,
              amountUsd: r.depositedUsd,
            }),
          );
          ctx.events.push({
            kind: "tick",
            note: `imperial ${kind}: deposited $${r.depositedUsd.toFixed(2)} to profile ${t.imperial_profile_index}`,
            tx_sig: r.signature,
          });
          if (r.prep?.swapSig) {
            ctx.events.push({
              kind: "tick",
              note: `imperial pre-deposit swap: ${r.prep.solSpent?.toFixed(4) ?? "?"} SOL -> $${r.prep.usdcReceived?.toFixed(2) ?? "?"} USDC`,
              tx_sig: r.prep.swapSig,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", `phoenix deposit ${kind} failed`, { error: e.message, tick_id: ctx.tickId, kind });
          ctx.events.push({
            kind: "tick",
            note: `phoenix deposit issue: ${e.message.slice(0, 200)}`,
          });
        }
    }
  }
}

// ---- 3. OPEN GATE ----
// Open with OPEN_COLLATERAL_USD as collateral, size = coll * leverage.
// Any extra fees stay in fees_accrued and feed the next top-up — they
// do NOT spill into buyback_reserve. That keeps 100% of the perp slice
// (configurable via the 50/25/25 split) actually backing the position.
// Fix 3a: lag-immune double-open guard. The durable workflow state (set
// synchronously before the prior open's send by 3b) is authoritative even
// when Imperial's /positions read lags. If it says a position is live — or
// pending and not yet past its retry deadline — hold off rather than send
// a duplicate leveraged order. Additive: in the normal case a live
// position already has hasLivePosition=true (so the open gate is closed),
// and a missing/idle workflow row disables the guard. See
// OPEN_CHAIN_REFACTOR_V2.md.
async function openPositionStep(ctx) {
  const { t, solUsd, bucket } = ctx;
  const wfRow = workflowStateFromToken(t);
  const wfState = wfRow?.state ?? null;
  const blocksOpen = workflowBlocksOpen({
    state: wfState,
    nextRetryAt: wfRow?.next_retry_at,
    hasLivePosition: ctx.hasLivePosition,
  });
  if (blocksOpen) {
    ctx.events.push({
      kind: "tick",
      note: `open held: workflow=${wfState} (anti-double-open) — awaiting /positions index or reconcile`,
    });
  }
  if (
    !ctx.hasLivePosition &&
    !ctx.pendingSig &&
    !ctx.externallyClosed &&
    !blocksOpen &&
    (ctx.perpFundingBudgetUsd >= config.feeGateUsd || ctx.imperialFundingSource === "parked")
  ) {
    const requestedOpenColl = config.openCollateralUsd;
    // For imperial-routed tokens, deploy the ENTIRE parked balance on open
    // (not just openCollateralUsd). Funds are already inside the profile;
    // capping at $50 means high-fee attention launches (FARTCOIN, NVDA,
    // WLD) sit on $300+ of idle parked USDC while only $50 backs the
    // position. Floor by the configured open size so we still respect the
    // minimum trade size.
    const imperialAvail = ctx.isImperialRouted
      ? Math.floor(ctx.availableUsd() * 100) / 100
      : 0;
    const openColl = ctx.isImperialRouted
      ? (imperialAvail >= IMPERIAL_MIN_COLLATERAL_USD
          ? imperialAvail
          : Math.min(requestedOpenColl, imperialAvail))
      : requestedOpenColl;
    const sizeUsd = openColl * ctx.leverage;

    // --------- IMPERIAL OPEN BRANCH ---------
    // For imperial-routed tokens we DO NOT need wallet USDC: collateral
    // lives inside the Imperial profile. The deposit was queued in
    // step 2d above. We require an actual live deposit to have happened
    // this tick (shadow/off mode skips the open too).
    if (ctx.imperialTradeEnabled) {
      if (openColl < IMPERIAL_MIN_COLLATERAL_USD) {
        ctx.events.push({
          kind: "tick",
          note: `phoenix open deferred: available $${ctx.availableUsd().toFixed(2)} < min $${IMPERIAL_MIN_COLLATERAL_USD} (mode=${config.imperial.depositMode})`,
        });
      } else {
        try {
          const authToken = await ctx.ensureAuth();
          const quote = await imperialQuoteIfEnabled({
            symbol: ctx.underlying,
            side: ctx.side,
            collateralUsd: openColl,
            leverage: ctx.leverage,
            context: "open",
          });
          // Snapshot profile USDC BEFORE the order so we can verify the
          // collateral actually attached (gmtrade refund-in-same-tx bug).
          const preUsdcUi = await readImperialProfileUsdcUi({
            profileIndex: t.imperial_profile_index,
            authToken,
            profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
          });
          // Fix 3b: write a durable position_open_pending marker (with a
          // retry deadline) BEFORE the send, so a crash / 240s watchdog right
          // after the order lands still leaves a marker that next tick's 3a
          // guard honors. Best-effort: on failure we proceed (degrade to the
          // /positions-only guard) rather than blocking the open.
          try {
            await setWorkflowStateSync(t.id, State.POSITION_OPEN_PENDING, {
              next_retry_at: new Date(Date.now() + OPEN_PENDING_STALE_MS).toISOString(),
            });
          } catch (e) {
            console.warn(
              `[3b] ${t.ticker} pre-open pending marker failed (proceeding): ${e.message}`,
            );
          }
          const res = await imperialOpenPosition({
            authToken,
            kp: ctx.kp,
            profileIndex: t.imperial_profile_index,
            symbol: ctx.underlying,
            side: ctx.side,
            collateralUsd: openColl,
            leverage: ctx.leverage,
            venue: quote?.venue ?? undefined,
          });
          if (res.signature) {
            ctx.patch.pending_drift_sig = res.signature;
            const intent = intentHash([
              t.id,
              "imperial_open",
              bucket,
              openColl.toFixed(2),
              ctx.side,
              ctx.leverage,
            ]);
            ctx.txLog.push(
              buildTxLogEntry({
                kind: "drift_adjust",
                intent,
                status: "pending",
                signature: res.signature,
                amountUsd: sizeUsd,
              }),
            );
          }
          // Verify: profile USDC must drop by >= half the collateral we
          // asked the venue to lock. If it didn't, the order round-tripped
          // and refunded (gmtrade "Failed to place order" + refund tx).
          // Optimistically writing in this case caused HYPU/PAMP/etc. to
          // compound ghost collateral to $24k / $613k size.
          const orderTookEffect = !res.error && !!res.signature;
          let verifiedAttached = orderTookEffect && config.hedgeMode === "simulate";
          let postUsdcUi = preUsdcUi;
          if (orderTookEffect && config.hedgeMode !== "simulate") {
            await new Promise((r) => setTimeout(r, 2500));
            postUsdcUi = await readImperialProfileUsdcUi({
              profileIndex: t.imperial_profile_index,
              authToken,
              profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
            });
            const drained = Math.max(0, preUsdcUi - postUsdcUi);
            verifiedAttached = drained >= openColl * 0.5;
            if (!verifiedAttached) {
              console.warn(
                `[imperial:open] ${t.ticker} REFUND DETECTED: profile USDC ${preUsdcUi.toFixed(2)} -> ${postUsdcUi.toFixed(2)} (expected drain ~$${openColl.toFixed(2)}, got $${drained.toFixed(2)}). Order signed but venue refunded; NOT writing optimistic state. sig=${res.signature?.slice(0, 16)}…`,
              );
              ctx.events.push({
                kind: "tick",
                note: `phoenix open refunded by venue (profile USDC unchanged); skipping optimistic DB write`,
                tx_sig: res.signature,
              });
            }
          }
          if (verifiedAttached) {
            let verifiedPos = null;
            if (config.hedgeMode !== "simulate") {
              verifiedPos = await readVerifiedImperialPosition({
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                authToken,
                wallet: ctx.kp.publicKey.toBase58(),
              });
            }
            {
              // Drain was verified by USDC delta + signed tx, so the
              // collateral IS on-venue regardless of whether Imperial's
              // /positions has indexed it yet. Always write optimistic
              // state (live values when present, requested values as
              // fallback). Next tick reconciles from the live readback
              // once Imperial surfaces the position.
              if (!verifiedPos && config.hedgeMode !== "simulate") {
                console.warn(
                  `[imperial:open] ${t.ticker} OPTIMISTIC WRITE: drain verified ($${(preUsdcUi - postUsdcUi).toFixed(2)}) but /positions not indexed yet; writing requested coll=$${openColl.toFixed(2)} size=$${sizeUsd.toFixed(2)}. sig=${res.signature?.slice(0, 16)}…`,
                );
              }
              const liveColl = verifiedPos ? Number(verifiedPos.collateralUsd) : openColl;
              const liveSize = verifiedPos ? Number(verifiedPos.sizeUsd) : sizeUsd;
              ctx.patch.position_opened = true;
              ctx.hasLivePosition = true;
              ctx.patch.position_size_usd = liveSize;
              ctx.patch.position_collateral_usd = liveColl;
              ctx.patch.opened_collateral_usd = liveColl;
              // Let high-fee attention-market launches deploy the rest of
              // their already-parked Imperial USDC immediately instead of
              // waiting another keeper cycle after the first small open.
              ctx.imperialDepositedThisTickUsd = Math.max(
                0,
                Math.floor((Number(ctx.imperialDepositedThisTickUsd || 0) - liveColl) * 100) / 100,
              );
              const entry = await resolveImperialEntryPrice({
                verifiedPos,
                symbol: ctx.underlying,
                venue: quote?.venue,
                token: t,
              });
              if (entry.price) ctx.patch.launch_mid = entry.price;
              if (ctx.imperialFundingSource === "fresh" || ctx.imperialFundingSource === "parked") {
                ctx.feesAccruedDelta -= openColl;
              }
              ctx.events.push({
                kind: "open",
                note: `[phoenix] ${config.hedgeMode}: opened ${ctx.side} ${ctx.underlying} ${ctx.leverage}x coll=$${liveColl.toFixed(2)} size=$${liveSize.toFixed(2)} profile=${t.imperial_profile_index}${verifiedPos ? "" : " (optimistic, awaiting readback)"}`,
              });
            }
          } else if (!orderTookEffect) {
            ctx.events.push({
              kind: "tick",
              note: `phoenix open: ${res.error ? res.error.slice(0, 200) : "no signature returned"}`,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", "phoenix open failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({
            kind: "tick",
            note: `phoenix open issue: ${e.message.slice(0, 200)}`,
          });
        }
      }
    } else if (ctx.isExternal) {
      // External jupiter coins: externalRouters opens the position from
      // the pump.fun creator-fee sweep. Don't run the legacy loop open
      // path (it would try to swap from an empty sub-wallet and spam).
    } else {
      // --------- JUPITER (legacy) OPEN BRANCH ---------
      const freeUsdc = await getFreeCollateralUsd(ctx.kp);
      if (freeUsdc < openColl) {
        // Try to top up USDC by swapping the SOL fees sitting in the wallet.
        const rawNeed = openColl - freeUsdc + 0.5; // small buffer for slippage rounding
        const need = ctx.isSubWallet ? rawNeed : Math.min(rawNeed, Math.max(0, ctx.perpFundingBudgetUsd));
        if (!ctx.isSubWallet && need < rawNeed) {
          console.warn(
            `[loop] ${t.ticker} legacy master SOL->USDC open swap capped: $${rawNeed.toFixed(2)} -> $${need.toFixed(2)} (accrued fees only)`,
          );
        }
        try {
          const sw = await swapSolToUsdc({ wantUsdc: need, solUsd, kp: ctx.kp });
          if (sw) {
            ctx.events.push({
              kind: "tick",
              note: `swapped ${sw.solSpent.toFixed(4)} SOL -> $${sw.usdcReceived.toFixed(2)} USDC for perp open (sig ${sw.swapSig.slice(0, 16)}..)`,
              tx_sig: sw.swapSig,
            });
          } else {
            ctx.events.push({
              kind: "tick",
              note: `OPEN gate hit ($${ctx.feesAccruedAfter.toFixed(2)}) but wallet USDC $${freeUsdc.toFixed(2)} < $${openColl} and insufficient SOL to swap`,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", "SOL->USDC swap failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({ kind: "tick", note: `SOL->USDC swap err: ${e.message.slice(0, 200)}` });
        }
        // Defer the actual open to the next tick so the USDC balance is
        // fully visible to Jupiter perps before we sign the open tx.
      } else {
        try {
          // [imperial:shadow] log-only quote; never blocks or alters the open.
          await imperialQuoteIfEnabled({
            symbol: ctx.underlying,
            side: ctx.side,
            collateralUsd: openColl,
            leverage: ctx.leverage,
            context: "open",
          });
          const res = await openPosition({
            symbol: ctx.underlying,
            side: ctx.side,
            collateralUsd: openColl,
            sizeUsd,
            kp: ctx.kp,
          });

          const openAccepted = !res.error && (res.signature || config.hedgeMode === "simulate");
          if (res.signature) {
            ctx.patch.pending_drift_sig = res.signature;
            const intent = intentHash([
              t.id,
              "perp_open",
              bucket,
              openColl.toFixed(2),
              ctx.side,
              ctx.leverage,
            ]);
            ctx.txLog.push(
              buildTxLogEntry({
                kind: "drift_adjust",
                intent,
                status: "pending",
                signature: res.signature,
                amountUsd: sizeUsd,
              }),
            );
          }
          if (openAccepted) {
            ctx.patch.position_opened = true;
            ctx.patch.position_size_usd = sizeUsd;
            ctx.patch.position_collateral_usd = openColl;
            ctx.patch.opened_collateral_usd = openColl;
            ctx.feesAccruedDelta -= openColl;
            ctx.events.push({
              kind: "open",
              note:
                `${config.hedgeMode}: opened ${ctx.side} ${ctx.underlying} ${ctx.leverage}x coll=$${openColl} size=$${sizeUsd.toFixed(2)}` +
                (res.simulated && !res.signature ? " [SIMULATED]" : ""),
            });
          } else {
            ctx.events.push({
              kind: "tick",
              note: `open attempt failed: ${res.error ? res.error.slice(0, 200) : "no signature returned"}`,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", "open failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({ kind: "tick", note: `open error: ${e.message.slice(0, 200)}` });
        }
      }
    }
  }
}

// ---- 4. TOP-UP ----
// Every TOPUP_FEE_GATE_USD of accrued perp-slice fees becomes
// collateral added to the live position. addColl = full gate amount;
// addSize = addColl * baseLeverage, so leverage stays flat and the
// entire slice backs the position. Works for 1x, 2x, 3x — and either
// direction (long/short) because we just pass `side` through.
export async function topUpAndRepairStep(ctx) {
  const { t, solUsd } = ctx;
  const topupGate = config.topUpFeeGateUsd;
  // Topup fires when EITHER new fees clear the gate, there's parked
  // collateral already deposited into the profile this tick, OR the live
  // Imperial position has drifted materially below the intended leverage.
  // The last case repairs tokens where collateral attached but the size-add
  // leg failed, leaving vaults like ZCRASH at ~2x instead of ~9.5x.
  const hasParkedTopup =
    ctx.imperialTradeEnabled &&
    ctx.imperialDepositedThisTickUsd > 0 &&
    ctx.imperialDepositedThisTickUsd >= IMPERIAL_MIN_COLLATERAL_USD;
  const sizeUsdForTopupCheck = Number(ctx.patch.position_size_usd ?? t.position_size_usd ?? 0);
  const collateralUsdForTopupCheck = Number(ctx.patch.position_collateral_usd ?? t.position_collateral_usd ?? 0);
  const targetLeverageForTopupCheck = ctx.imperialTradeEnabled
    ? clampLeverage(`loop:${t.ticker} ${ctx.underlying}`, Math.max(1, ctx.leverage), ctx.underlying)
    : Math.max(1, ctx.leverage);
  const currentLeverageForTopupCheck = collateralUsdForTopupCheck > 0 && sizeUsdForTopupCheck > 0
    ? sizeUsdForTopupCheck / collateralUsdForTopupCheck
    : targetLeverageForTopupCheck;
  const needsImperialSizeRepair =
    ctx.imperialTradeEnabled &&
    collateralUsdForTopupCheck >= IMPERIAL_MIN_COLLATERAL_USD &&
    sizeUsdForTopupCheck > 0 &&
    currentLeverageForTopupCheck < targetLeverageForTopupCheck - 0.25;
  if ((ctx.hasLivePosition || ctx.patch.position_opened) && !ctx.pendingSig && (ctx.perpFundingBudgetUsd >= topupGate || hasParkedTopup || needsImperialSizeRepair)) {
    const sizeUsdNow = Number(ctx.patch.position_size_usd ?? t.position_size_usd ?? 0);
    const collateralUsdNow = Number(
      ctx.patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
    );
    const targetLeverage = Math.max(1, ctx.leverage);
    const currentLeverage = collateralUsdNow > 0 && sizeUsdNow > 0
      ? Math.max(1, sizeUsdNow / collateralUsdNow)
      : targetLeverage;
    // Always pull toward the configured target leverage so add-margin
    // top-ups grow size proportionally and effective leverage doesn't
    // drift down over time (the old min(target,current) capped baseLev
    // at the depressed level and let leverage decay forever). The venue
    // cap clamp inside imperialIncreasePosition still protects us from
    // exceeding Phoenix/Flash limits on assets like HYPE.
    const baseLeverage = ctx.imperialTradeEnabled
      ? clampLeverage(`loop:${t.ticker} ${ctx.underlying}`, targetLeverage, ctx.underlying)
      : targetLeverage;
    // For imperial topup we deploy the entire deposited/parked balance in
    // a single tick instead of metering by config.topUpCollateralUsd.
    // Leverage stays flat because addSize = baseLeverage * (currentColl + addColl) - sizeUsd.
    // For imperial: deploy the entire deposited/parked balance, ignoring
    // feesAccruedAfter (which only tracks DBC-claim fees, not the perp
    // slice that external sweeps deposited directly into the profile).
    // During repair, funds may have been parked in a prior tick, so read
    // the live profile balance instead of trusting this tick's deposit var.
    let liveImperialProfileUsdcUsd = 0;
    let liveImperialFreeTopupUsd = 0;
    if (ctx.imperialTradeEnabled && t.imperial_profile_index != null) {
      try {
        const repairAuthToken = await ctx.ensureAuth();
        liveImperialProfileUsdcUsd = await readImperialProfileUsdcUi({
          profileIndex: t.imperial_profile_index,
          authToken: repairAuthToken,
          profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
        });
        // `readImperialProfileUsdcUi` reads the profile's free USDC balance,
        // not total position margin. Deposits shown on Solscan at the profile
        // PDA are parked free USDC until an order attaches them. Do not
        // subtract already-attached collateral here, or parked top-ups like
        // LIFE's $230 never get picked up after the deposit tick.
        // F2 (defense-in-depth, plan §11): realized profit earmarked for buyback
        // must never be redeployed as collateral. Reserve the outstanding buyback
        // balance (persisted buyback_reserve_usd + this tick's reserveDelta) out of
        // the free profile USDC the top-up may attach.
        const buybackReservedUsd = Math.max(0, Number(t.buyback_reserve_usd ?? 0) + Number(ctx.reserveDelta || 0));
        liveImperialFreeTopupUsd = Math.max(0, liveImperialProfileUsdcUsd - buybackReservedUsd);
      } catch {
        liveImperialProfileUsdcUsd = 0;
        liveImperialFreeTopupUsd = 0;
      }
    }
    const availableImperialTopupUsd = Math.floor(Math.max(
      Number(ctx.imperialDepositedThisTickUsd || 0),
      Number(liveImperialFreeTopupUsd || 0),
    ) * 100) / 100;
    console.log(
      `[imperial:topup] ${t.ticker} availableImperialTopup=$${availableImperialTopupUsd.toFixed(2)} depositedThisTick=$${Number(ctx.imperialDepositedThisTickUsd || 0).toFixed(2)} liveProfileUsdc=$${liveImperialProfileUsdcUsd.toFixed(2)} freeProfileUsdc=$${liveImperialFreeTopupUsd.toFixed(2)} repair=${needsImperialSizeRepair ? "yes" : "no"}`,
    );
    // If the live position has drifted below target leverage, DO NOT
    // attach more collateral. That is exactly how LIFE got stuck at
    // ~1x: collateral kept landing while the size leg failed. Repair
    // size first against existing venue collateral; parked USDC stays
    // parked until leverage is healthy again.
    const sizeRepairForceOnly =
      ctx.imperialTradeEnabled &&
      needsImperialSizeRepair &&
      collateralUsdNow >= IMPERIAL_MIN_COLLATERAL_USD;
    // Size-only repair: when the existing margin already covers more
    // notional at the target leverage than what's currently open, we can
    // grow size against the existing cushion (collateralAmount=0).
    // This recovers tokens like OIL where a previous topup attached
    // collateral but the size leg refunded, leaving leverage stuck low
    // with no parked USDC to fund the next repair attempt.
    const sizeOnlyRepairAvailable =
      ctx.imperialTradeEnabled &&
      needsImperialSizeRepair &&
      collateralUsdNow * baseLeverage > sizeUsdNow + IMPERIAL_MIN_COLLATERAL_USD;
    const isLifeRepair = String(t.ticker ?? "").toUpperCase() === "LIFE";
    const repairAtomicAddColl = sizeRepairForceOnly && availableImperialTopupUsd >= IMPERIAL_MIN_COLLATERAL_USD
      ? (isLifeRepair ? Math.min(Math.max(IMPERIAL_MIN_COLLATERAL_USD, 75), availableImperialTopupUsd) : availableImperialTopupUsd)
      : 0;
    const RAW_SIZE_ADD_MAX_PER_TICK_USD = String(t.ticker ?? "").toUpperCase() === "LIFE" ? 400 : 1000;
    const SIZE_ADD_MAX_PER_TICK_USD = Math.max(
      RAW_SIZE_ADD_MAX_PER_TICK_USD,
      IMPERIAL_MIN_COLLATERAL_USD * baseLeverage,
    );
    const rawAddColl = ctx.imperialTradeEnabled
      ? (sizeRepairForceOnly ? repairAtomicAddColl : availableImperialTopupUsd)
      : Number(config.topUpCollateralUsd) || 0;
    const noDecayLeverageFloor = collateralUsdNow > 0 && sizeUsdNow > 0
      ? Math.max(1, sizeUsdNow / collateralUsdNow)
      : baseLeverage;
    const collateralCapForLeverage = (sizeRepairForceOnly ? noDecayLeverageFloor : baseLeverage) > 0
      ? SIZE_ADD_MAX_PER_TICK_USD / (sizeRepairForceOnly ? noDecayLeverageFloor : baseLeverage)
      : rawAddColl;
    const addColl = ctx.imperialTradeEnabled
      ? Math.min(rawAddColl, collateralCapForLeverage)
      : rawAddColl;
    const targetSizeAfter = baseLeverage * (collateralUsdNow + addColl);
    const rawAddSize = Math.max(0, targetSizeAfter - sizeUsdNow);
    const atomicCollateralSizeCap = sizeRepairForceOnly && addColl > 0
      ? addColl * baseLeverage
      : Infinity;
    const sizeOnlyRepairMode =
      sizeOnlyRepairAvailable && addColl <= 0 && rawAddSize > 1;
    const sizeOnlyRepairAddSize = sizeOnlyRepairMode
      ? Math.min(
          rawAddSize,
          SIZE_ADD_MAX_PER_TICK_USD,
          Math.max(0, collateralUsdNow * baseLeverage - sizeUsdNow),
        )
      : 0;
    const addSize = sizeOnlyRepairMode
      ? sizeOnlyRepairAddSize
      : (sizeRepairForceOnly && addColl <= 0
          ? 0
          : Math.min(rawAddSize, SIZE_ADD_MAX_PER_TICK_USD, atomicCollateralSizeCap));
    if ((sizeRepairForceOnly || sizeOnlyRepairMode) && rawAddSize > addSize + 0.01) {
      console.log(
        `[imperial:repair] ${t.ticker} ${ctx.underlying} ${ctx.side} targetGap=$${rawAddSize.toFixed(2)} cappedAddSize=$${addSize.toFixed(2)} addColl=$${addColl.toFixed(2)} leverage=${baseLeverage.toFixed(2)}x sizeOnly=${sizeOnlyRepairMode ? "yes" : "no"}`,
      );
    }
    const isAboveTarget =
      collateralUsdNow > 0 && sizeUsdNow / collateralUsdNow > baseLeverage + 0.05;


    // --------- IMPERIAL TOP-UP BRANCH ---------
    if (ctx.imperialTradeEnabled) {
      // Two acceptable paths:
      //   (a) paired collateral+size top-up (addColl >= MIN, matching parked USDC)
      //   (b) size-only repair against existing margin cushion (addColl=0, addSize>0)
      // Anything else defers.
      const canPairedTopup =
        addColl >= IMPERIAL_MIN_COLLATERAL_USD && availableImperialTopupUsd >= addColl;
      const canSizeOnlyRepair = sizeOnlyRepairMode && addSize > 0;
      if (!canPairedTopup && !canSizeOnlyRepair) {
        if (needsImperialSizeRepair) {
          console.log(
            `[imperial:repair] ${t.ticker} ${ctx.underlying} ${ctx.side} DEFERRED: need parked USDC >= $${IMPERIAL_MIN_COLLATERAL_USD.toFixed(2)} or size cushion (have parked $${availableImperialTopupUsd.toFixed(2)}, cushion gap $${Math.max(0, collateralUsdNow * baseLeverage - sizeUsdNow).toFixed(2)}).`,
          );
        }
        ctx.events.push({
          kind: "tick",
          note: `phoenix top-up deferred: available $${availableImperialTopupUsd.toFixed(2)} < min $${IMPERIAL_MIN_COLLATERAL_USD.toFixed(2)} (mode=${config.imperial.depositMode})`,
        });
      } else {

        try {
          const authToken = await ctx.ensureAuth();
          if (addColl > 0) {
            await imperialQuoteIfEnabled({
              symbol: ctx.underlying,
              side: ctx.side,
              collateralUsd: addColl,
              leverage: baseLeverage,
              context: "topup",
            });
          }
          // Snapshot profile USDC BEFORE the order so we can verify the
          // collateral actually attached. Without this check, gmtrade's
          // refund-in-same-tx behavior (order signed + refunded in one
          // tx) caused HYPU/PAMP to compound ghost collateral every tick
          // ($446 -> $24k coll, $613k size, etc.).
          const preUsdcUi = await readImperialProfileUsdcUi({
            profileIndex: t.imperial_profile_index,
            authToken,
            profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
          });
          let res = isAboveTarget
            ? await imperialAddCollateralToPosition({
                authToken,
                kp: ctx.kp,
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                addCollateralUsd: addColl,
              })
            : await imperialIncreasePosition({
                authToken,
                kp: ctx.kp,
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                addSizeUsd: addSize,
                addCollateralUsd: 0, // already deposited / parked in profile
                orderCollateralUsd: addColl,
                // Atomic is safer for every top-up: if Imperial rejects the
                // size leg, no standalone collateral add lands and leverage
                // cannot slowly decay from collateral-only fills.
                attachCollateralBeforeSize: false,
                leverage: baseLeverage,
              });
          if ((!res?.signature || res?.error) && addSize > 0.01) {
            const relaxedLeverage = Math.max(1, currentLeverage);
            const relaxedTargetSizeAfter = relaxedLeverage * (collateralUsdNow + addColl);
            const relaxedAddSize = Math.max(0, relaxedTargetSizeAfter - sizeUsdNow);
            if (relaxedAddSize > 0.01 && relaxedAddSize < addSize - 0.01) {
              ctx.events.push({
                kind: "tick",
                note: `phoenix top-up retry: sizing from current ${relaxedLeverage.toFixed(2)}x leverage after target-size rejection`,
              });
              res = await imperialIncreasePosition({
                authToken,
                kp: ctx.kp,
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                addSizeUsd: relaxedAddSize,
                addCollateralUsd: 0,
                orderCollateralUsd: addColl,
                attachCollateralBeforeSize: false,
                leverage: relaxedLeverage,
              });
            }
          }
          if (res.signature && !res.error) ctx.patch.pending_drift_sig = res.signature;
          const orderTookEffect = !res.error && !!res.signature;
          // Only write optimistic state if profile USDC actually drained.
          // A signed-but-refunded tx leaves preUsdc == postUsdc and means
          // the venue rejected the fill (e.g. gmtrade leverage cap, market
          // close, refund-in-same-tx). Without this guard the parked USDC
          // gets counted again next tick -> ghost collateral compounding.
          let verifiedAttached = orderTookEffect && config.hedgeMode === "simulate";
          let postUsdcUi = preUsdcUi;
          if (orderTookEffect && config.hedgeMode !== "simulate") {
            await new Promise((r) => setTimeout(r, 2500));
            postUsdcUi = await readImperialProfileUsdcUi({
              profileIndex: t.imperial_profile_index,
              authToken,
              profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
            });
            const drained = Math.max(0, preUsdcUi - postUsdcUi);
            verifiedAttached = drained >= addColl * 0.5;
            if (!verifiedAttached) {
              console.warn(
                `[imperial:topup] ${t.ticker} REFUND DETECTED: profile USDC ${preUsdcUi.toFixed(2)} -> ${postUsdcUi.toFixed(2)} (expected drain ~$${addColl.toFixed(2)}, got $${drained.toFixed(2)}). Order signed but venue refunded; NOT writing optimistic state. sig=${res.signature?.slice(0, 16)}…`,
              );
              ctx.events.push({
                kind: "tick",
                note: `phoenix top-up refunded by venue (profile USDC unchanged); skipping optimistic DB write`,
                tx_sig: res.signature,
              });
            }
          }
          if (verifiedAttached) {
            let verifiedPos = null;
            if (config.hedgeMode !== "simulate") {
              verifiedPos = await readVerifiedImperialPosition({
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                authToken,
                wallet: ctx.kp.publicKey.toBase58(),
              });
            }
            if (false && !(Number(verifiedPos?.sizeUsd ?? 0) > sizeUsdNow + 0.01)) {
              console.warn(
                `[imperial:topup] ${t.ticker} size repair signed but size did not increase yet; NOT writing optimistic size. sig=${res.signature?.slice(0, 16)}…`,
              );
              ctx.events.push({
                kind: "tick",
                note: `phoenix size-repair pending readback; skipping optimistic DB write`,
                tx_sig: res.signature,
              });
            } else {
              // Same logic as the open branch: drain is the source of
              // truth. Always write optimistic state and reconcile next
              // tick from the live readback.
              if (!verifiedPos && config.hedgeMode !== "simulate") {
                console.warn(
                  `[imperial:topup] ${t.ticker} OPTIMISTIC WRITE: drain verified ($${(preUsdcUi - postUsdcUi).toFixed(2)}) but /positions not indexed yet; writing addColl=$${addColl.toFixed(2)} addSize=$${addSize.toFixed(2)}. sig=${res.signature?.slice(0, 16)}…`,
                );
              }
              const appliedAddSize = Number.isFinite(Number(res.appliedAddSizeUsd))
                ? Number(res.appliedAddSizeUsd)
                : addSize;
              const appliedAddColl = Number.isFinite(Number(res.appliedAddCollateralUsd))
                ? Number(res.appliedAddCollateralUsd)
                : addColl;
              const newSize = verifiedPos ? Number(verifiedPos.sizeUsd) : sizeUsdNow + appliedAddSize;
              const newColl = verifiedPos
                ? Number(verifiedPos.collateralUsd)
                : collateralUsdNow + appliedAddColl;
              ctx.patch.position_size_usd = newSize;
              ctx.patch.position_collateral_usd = newColl;
              const entry = await resolveImperialEntryPrice({
                verifiedPos,
                symbol: ctx.underlying,
                token: t,
              });
              if (!(Number(t.launch_mid ?? 0) > 0) && entry.price) ctx.patch.launch_mid = entry.price;
              ctx.optimisticImperialPositionState = true;
              if (ctx.imperialFundingSource === "fresh" || ctx.imperialFundingSource === "parked") {
                const consumed = Math.min(addColl, Math.max(0, ctx.feesAccruedAfter));
                ctx.feesAccruedDelta -= consumed;
              }
              ctx.events.push({
                kind: "tick",
                note: `[phoenix] top-up ${ctx.side} ${ctx.underlying}: ${verifiedPos ? "live" : "optimistic"} coll=$${newColl.toFixed(2)}, size=$${newSize.toFixed(2)} @${baseLeverage.toFixed(1)}x (src=${ctx.imperialFundingSource}${res.sizeDeferred ? ", size deferred" : ""})`,
              });
            }
          } else if (res.error) {
            ctx.events.push({
              kind: "tick",
              note: `phoenix top-up: ${res.error.slice(0, 200)}`,
            });
            // Fallback: atomic size+coll order keeps getting rejected by
            // Phoenix (generic "Failed to place order"). If there's
            // meaningful parked USDC in the profile, bind it as pure
            // collateral via /mobile/orders/collateral so funds stop
            // piling up in the profile PDA. The size leg will catch up
            // on subsequent ticks once leverage has cushion. Skip when
            // we already used the collateral-only path (isAboveTarget).
            // F3: also skip during a size repair — attaching more collateral while
            // the size leg is behind is exactly how LIFE got pinned at ~1x. Repair
            // size against the existing margin first; parked USDC stays parked.
            if (
              !isAboveTarget &&
              !needsImperialSizeRepair &&
              addColl >= IMPERIAL_MIN_COLLATERAL_USD &&
              liveImperialFreeTopupUsd >= IMPERIAL_MIN_COLLATERAL_USD &&
              config.hedgeMode !== "simulate"
            ) {
              try {
                const fallbackBindUsd = Math.min(
                  addColl,
                  liveImperialFreeTopupUsd,
                );
                const preBindUi = preUsdcUi;
                const bindRes = await imperialAddCollateralToPosition({
                  authToken,
                  kp: ctx.kp,
                  profileIndex: t.imperial_profile_index,
                  symbol: ctx.underlying,
                  side: ctx.side,
                  addCollateralUsd: fallbackBindUsd,
                });
                if (bindRes?.signature && !bindRes?.error) {
                  await new Promise((r) => setTimeout(r, 2500));
                  const postBindUi = await readImperialProfileUsdcUi({
                    profileIndex: t.imperial_profile_index,
                    authToken,
                    profilePda: ctx.patch.imperial_profile_pda ?? t.imperial_profile_pda,
                  });
                  const bindDrained = Math.max(0, preBindUi - postBindUi);
                  if (bindDrained >= fallbackBindUsd * 0.5) {
                    ctx.patch.position_collateral_usd = collateralUsdNow + bindDrained;
                    ctx.patch.pending_drift_sig = bindRes.signature;
                    ctx.optimisticImperialPositionState = true;
                    if (ctx.imperialFundingSource === "fresh" || ctx.imperialFundingSource === "parked") {
                      const consumed = Math.min(bindDrained, Math.max(0, ctx.feesAccruedAfter));
                      ctx.feesAccruedDelta -= consumed;
                    }
                    ctx.events.push({
                      kind: "tick",
                      note: `[phoenix] size rejected; bound $${bindDrained.toFixed(2)} parked USDC as collateral (size will retry next tick)`,
                      tx_sig: bindRes.signature,
                    });
                  } else {
                    console.warn(
                      `[imperial:topup] ${t.ticker} attach-only fallback signed but profile USDC unchanged (${preBindUi.toFixed(2)} -> ${postBindUi.toFixed(2)}); venue refunded.`,
                    );
                  }
                } else if (bindRes?.error) {
                  ctx.events.push({
                    kind: "tick",
                    note: `phoenix attach-only fallback failed: ${String(bindRes.error).slice(0, 160)}`,
                  });
                }
              } catch (bindErr) {
                keeperLog(t, "warn", "phoenix attach-only fallback threw", {
                  error: bindErr.message,
                  tick_id: ctx.tickId,
                });
              }
            }
          }
        } catch (e) {
          keeperLog(t, "warn", "phoenix top-up failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({
            kind: "tick",
            note: `phoenix top-up issue: ${e.message.slice(0, 200)}`,
          });
        }
      }
    } else if (ctx.isExternal) {
      // External (pump.fun) tokens on jupiter route are funded directly
      // by externalRouters at sweep time (external_perp leg). The legacy
      // jupiter top-up gate below would just spam "insufficient SOL"
      // every tick because the sub-wallet is intentionally drained after
      // each split. Skip silently.
    } else {
      // --------- JUPITER (legacy) TOP-UP BRANCH ---------
      const freeUsdc = await getFreeCollateralUsd(ctx.kp);
      if (freeUsdc < addColl) {
        const rawNeed = addColl - freeUsdc + 0.5;
        const need = ctx.isSubWallet ? rawNeed : Math.min(rawNeed, Math.max(0, ctx.perpFundingBudgetUsd));
        if (!ctx.isSubWallet && need < rawNeed) {
          console.warn(
            `[loop] ${t.ticker} legacy master SOL->USDC top-up swap capped: $${rawNeed.toFixed(2)} -> $${need.toFixed(2)} (accrued fees only)`,
          );
        }
        try {
          const sw = await swapSolToUsdc({ wantUsdc: need, solUsd, kp: ctx.kp });
          if (sw) {
            ctx.events.push({
              kind: "tick",
              note: `swapped ${sw.solSpent.toFixed(4)} SOL -> $${sw.usdcReceived.toFixed(2)} USDC for perp top-up (sig ${sw.swapSig.slice(0, 16)}..)`,
              tx_sig: sw.swapSig,
            });
          } else {
            ctx.events.push({
              kind: "tick",
              note: `top-up gate hit ($${ctx.feesAccruedAfter.toFixed(2)}/${topupGate}) but wallet USDC $${freeUsdc.toFixed(2)} < $${addColl.toFixed(2)} and insufficient SOL to swap`,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", "top-up SOL->USDC swap failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({
            kind: "tick",
            note: `top-up SOL->USDC swap err: ${e.message.slice(0, 200)}`,
          });
        }
      } else {
        try {
          await imperialQuoteIfEnabled({
            symbol: ctx.underlying,
            side: ctx.side,
            collateralUsd: addColl,
            leverage: baseLeverage,
            context: "topup",
          });
          const res = isAboveTarget
            ? await topUpCollateral({ symbol: ctx.underlying, side: ctx.side, addCollateralUsd: addColl, kp: ctx.kp })
            : await increasePosition({
                symbol: ctx.underlying,
                side: ctx.side,
                addSizeUsd: addSize,
                addCollateralUsd: addColl,
                kp: ctx.kp,
              });

          const topUpAccepted =
            !res.error && (res.signature || config.hedgeMode === "simulate");
          if (res.signature) ctx.patch.pending_drift_sig = res.signature;
          if (topUpAccepted) {
            const newSize = sizeUsdNow + addSize;
            const newColl = ctx.currentColl + addColl;
            ctx.patch.position_size_usd = newSize;
            ctx.patch.position_collateral_usd = newColl;
            ctx.feesAccruedDelta -= topupGate;
            ctx.reserveDelta += Math.max(0, topupGate - addColl);
            ctx.events.push({
              kind: "tick",
              note: isAboveTarget
                ? `deleveraging top-up ${ctx.side} ${ctx.underlying}: +$${addColl.toFixed(2)} coll, +$0.00 size until back to ${baseLeverage.toFixed(1)}x`
                : `top-up ${ctx.side} ${ctx.underlying}: +$${addColl.toFixed(2)} coll, +$${addSize.toFixed(2)} size @${baseLeverage.toFixed(1)}x` +
                  (res.simulated && !res.signature ? " [SIMULATED]" : "") +
                  (res.error ? ` ERR: ${res.error.slice(0, 150)}` : ""),
            });
          } else if (res.error) {
            ctx.events.push({ kind: "tick", note: `top-up err: ${res.error.slice(0, 200)}` });
          }
        } catch (e) {
          keeperLog(t, "warn", "top-up failed", { error: e.message, tick_id: ctx.tickId });
          ctx.events.push({ kind: "tick", note: `top-up error: ${e.message.slice(0, 200)}` });
        }
      }
    }
  }
}

// Step 5 — read live PnL and take profit (proportional, incremental).
// See plan/KEEPER_TP_REWRITE.md. Sets ctx.pnlNow / ctx.newHighWater for the report.
export async function pnlAndTakeProfitStep(ctx) {
  const { t, bucket, tickId, solUsd } = ctx;
  // ---- 5. PnL trigger + buyback+burn ----
  ctx.pnlNow = Number(t.treasury_pnl_usd ?? 0);
  ctx.newHighWater = Number(t.pnl_high_water_usd ?? 0);
  let collAfter = ctx.patch.position_collateral_usd ?? ctx.currentColl;

  if ((ctx.hasLivePosition || ctx.patch.position_opened) && !ctx.pendingSig) {
    let pos = ctx.chainPos;
    if (!pos && ctx.patch.position_opened) {
      try {
        if (ctx.isImperialRouted) {
          pos = await imperialReadPosition({
            profileIndex: t.imperial_profile_index,
            symbol: ctx.underlying,
            side: ctx.side,

            token: await ctx.ensureAuth().catch(() => null),
            wallet: ctx.kp.publicKey.toBase58(),
          });
        } else {
          pos = await readPerpPosition({ symbol: ctx.underlying, side: ctx.side, kp: ctx.kp });
        }
      } catch (e) {
        keeperLog(t, "warn", "readPos failed", { error: e.message, tick_id: tickId });
      }
    }

    if (pos) {
      if (ctx.isImperialRouted) {
        const liveMark = await readImperialLiveMarkUsd(ctx.underlying);
        if (liveMark) pos.markPriceUsd = liveMark;
      }
      const cAfter = Number(pos.collateralUsd);
      if (Number.isFinite(cAfter) && !ctx.optimisticImperialPositionState) {
        collAfter = cAfter;
        ctx.patch.position_collateral_usd = collAfter;
      }
      const sUsd = Number(pos.sizeUsd);
      if (Number.isFinite(sUsd) && !ctx.optimisticImperialPositionState)
        ctx.patch.position_size_usd = sUsd;

      // Imperial blends avgEntryPrice on every add-margin/add-size which collapses
      // their reported unrealizedPnlUsd toward zero. We preserve the ORIGINAL entry
      // in launch_mid (never overwrite after open) and compute PnL ourselves from
      // mark vs original entry. This matches what Imperial's UI actually displays.
      const origEntry = Number(t.launch_mid ?? 0);
      const markPx = Number(pos.markPriceUsd);
      const sizeForPnl = Number.isFinite(sUsd) && sUsd > 0 ? sUsd : Number(t.position_size_usd ?? 0);
      if (ctx.isImperialRouted && origEntry > 0 && Number.isFinite(markPx) && markPx > 0 && sizeForPnl > 0) {
        const dirSign = ctx.side === "short" ? -1 : 1;
        ctx.pnlNow = ((markPx - origEntry) / origEntry) * sizeForPnl * dirSign;
      } else if (Number.isFinite(Number(pos.unrealizedPnlUsd))) {
        ctx.pnlNow = Number(pos.unrealizedPnlUsd);
      }

      // Set launch_mid ONLY on first open (when we have no entry yet)
      if (ctx.isImperialRouted && !(origEntry > 0) && Number.isFinite(Number(pos.entryPriceUsd)) && Number(pos.entryPriceUsd) > 0) {
        ctx.patch.launch_mid = Number(pos.entryPriceUsd);
      }
    }
    if (!Number.isFinite(ctx.pnlNow)) ctx.pnlNow = Number(t.treasury_pnl_usd ?? 0) || 0;
    const prevPnl = Number(t.treasury_pnl_usd ?? 0) || 0;
    const pnlDelta = Number.isFinite(ctx.pnlNow - prevPnl) ? ctx.pnlNow - prevPnl : 0;
    ctx.events.push({
      kind: "tick",
      mid:
        pos && Number.isFinite(Number(pos.markPriceUsd)) ? Number(pos.markPriceUsd) : undefined,
      pnl_delta_usd: pnlDelta,
      note: `pnl=$${ctx.pnlNow.toFixed(2)} hw=$${ctx.newHighWater.toFixed(2)} coll=$${collAfter.toFixed(2)} reserve=$${(ctx.currentReserve + ctx.reserveDelta).toFixed(2)}`,
    });

    // ─── TAKE PROFIT (proportional, incremental — see plan/KEEPER_TP_REWRITE.md) ───
    // Each time floating profit grows by tpTriggerRatio × the CURRENT collateral
    // above the last lock-in, close tpCloseFraction of the position. Size,
    // collateral and realized profit scale by the same fraction, so nominal
    // leverage (size/collateral) is preserved without a repair add. Realized
    // profit: 75% -> buyback reserve, 25% -> master.
    //
    // Basis = collAfter (current, post-top-up collateral), so the gate scales
    // with the position as it grows via fees and self-corrects if a redeposit
    // fails: the transient post-close dip is already restored by
    // topUpAndRepairStep (which runs before this step), and if it genuinely
    // can't be restored, the smaller basis is correct for the smaller position.
    const tp = planTakeProfit({
      pnlNow: ctx.pnlNow,
      highWater: ctx.newHighWater,
      collAfter,
      sizeUsd: ctx.patch.position_size_usd ?? Number(t.position_size_usd ?? 0),
      cfg: config,
    });
    if (tp.fire) {
      const sizeUsd = ctx.patch.position_size_usd ?? Number(t.position_size_usd ?? 0);
      const { closeSizeUsd, realizedPnlUsd, trigger } = tp;
      try {
        const res = await withVenueRetry("tp close", ctx, async () =>
          ctx.imperialFullTrade
            ? await imperialPartialClose({
                authToken: await ctx.ensureAuth(),
                kp: ctx.kp,
                profileIndex: t.imperial_profile_index,
                symbol: ctx.underlying,
                side: ctx.side,
                reduceSizeUsd: closeSizeUsd,
                currentSizeUsd: sizeUsd,
                positionId: pos?.positionPda || t.imperial_profile_pda || undefined,
              })
            : ctx.imperialTradeEnabled
              ? {
                  signature: null,
                  simulated: false,
                  error: `imperial tp blocked: positionMode=${config.imperial.positionMode}`,
                }
              : await partialClose({ symbol: ctx.underlying, side: ctx.side, reduceSizeUsd: closeSizeUsd, kp: ctx.kp }));
        const realSignature = isRealSolanaSignature(res.signature);
        const accepted = !res.error && (config.hedgeMode !== "live" || realSignature || res.verifiedVia === "positions");
        if (realSignature) {
          ctx.patch.pending_drift_sig = res.signature;
          ctx.txLog.push(
            buildTxLogEntry({
              kind: "drift_adjust",
              intent: intentHash([t.id, "tp_close", bucket, realizedPnlUsd.toFixed(2)]),
              status: "pending",
              signature: res.signature,
              amountUsd: realizedPnlUsd,
            }),
          );
        }
        if (accepted) {
          const prePnl = ctx.pnlNow; // pnl at fire time (for logging)
          const actualCloseSizeUsd = Number(res.appliedReduceSizeUsd ?? closeSizeUsd);
          const applied = applyTakeProfit({ pnlNow: prePnl, sizeUsd, collAfter, actualCloseSizeUsd, cfg: config });
          ctx.patch.position_size_usd = applied.nextSize;
          // Proportional: collateral scales with size, so nominal leverage is preserved.
          ctx.patch.position_collateral_usd = applied.nextColl;
          ctx.newHighWater = applied.nextHighWater;
          // F1: persist the RESIDUAL pnl (not the stale pre-close value) so a read
          // miss next tick can't re-fire TP without fresh price movement.
          ctx.pnlNow = applied.nextPnlNow;
          // F5: an accepted close with no real signature (verified-via-positions)
          // must still gate the next tick (one-tick settle) so TP can't re-fire on
          // a lagging size read; confirmPendingSigStep clears this sentinel.
          if (!realSignature) ctx.patch.pending_drift_sig = TP_SETTLE_SENTINEL;
          keeperLog(t, "info", "tp fired", {
            pnl_now: prePnl,
            applied_frac: applied.appliedFrac,
            realized_usd: applied.realizedActual,
            close_size_usd: actualCloseSizeUsd,
            trigger_usd: trigger,
            tick_id: tickId,
          });
          ctx.events.push({
            kind: "tick",
            mid: pos && Number.isFinite(Number(pos.markPriceUsd)) ? Number(pos.markPriceUsd) : undefined,
            pnl_delta_usd: applied.realizedActual,
            note:
              `${ctx.imperialFullTrade ? "[imperial] " : ""}TP: closed ${(applied.appliedFrac * 100).toFixed(0)}% ($${actualCloseSizeUsd.toFixed(2)} size) realizing $${applied.realizedActual.toFixed(2)} ` +
              `(pnl=$${prePnl.toFixed(0)}/coll=$${collAfter.toFixed(0)}, fire>=$${trigger.toFixed(2)})` +
              (res.simulated && !res.signature ? " [SIMULATED]" : ""),
          });
          // Profit split: 75% buyback reserve, 25% master treasury (USDC->SOL).
          if (config.hedgeMode === "live" && ctx.buybackMint) {
            const { masterShareUsd, buybackShareUsd } = applied;
            try {
              // Recycle guard (plan §11): withdraw the realized profit OUT of the
              // imperial profile to the sub-wallet so the next tick's top-up can't
              // redeploy it as collateral. Non-imperial partial-close already
              // settles in the sub-wallet, so no withdraw is needed there.
              if (ctx.imperialFullTrade) {
                const withdrawUsd = masterShareUsd + buybackShareUsd;
                if (withdrawUsd >= 1) {
                  await withVenueRetry("tp withdraw", ctx, async () =>
                    imperialWithdrawCollateral({
                      authToken: await ctx.ensureAuth(),
                      kp: ctx.kp,
                      profileIndex: t.imperial_profile_index,
                      withdrawUsd,
                      rpcUrl: config.rpcUrl,
                    }));
                }
              }
              // F2: credit the buyback reserve ONLY after the profit is actually
              // out of the profile (withdrawn above, or settled in the sub-wallet
              // for non-imperial). A failed withdraw throws -> caught below -> the
              // reserve is NOT credited and the profit is not double-counted.
              ctx.reserveDelta += buybackShareUsd;
              ctx.events.push({
                kind: "buyback",
                pnl_delta_usd: applied.realizedActual,
                note: `tp split: $${buybackShareUsd.toFixed(2)} (75%) -> buyback reserve, $${masterShareUsd.toFixed(2)} (25%) -> master treasury`,
              });
              if (masterShareUsd >= 1) {
                const sw = await withVenueRetry("tp swap", ctx, () => swapUsdcToSol({ wantUsd: masterShareUsd, solUsd, kp: ctx.kp }));
                if (sw && sw.solReceived > 0) {
                  const lamports = Math.floor(sw.solReceived * 1e9) - 5_000; // leave gas
                  if (lamports > 0) {
                    const tx = new Transaction().add(
                      SystemProgram.transfer({
                        fromPubkey: ctx.kp.publicKey,
                        toPubkey: tre().publicKey,
                        lamports,
                      }),
                    );
                    const sig = await sendAndConfirmTransaction(conn(), tx, [ctx.kp], {
                      commitment: "confirmed",
                    });
                    const sentSol = lamports / 1e9;
                    ctx.events.push({
                      kind: "skim",
                      sol_amount: sentSol,
                      tx_sig: sig,
                      pnl_delta_usd: masterShareUsd,
                      note: `tp profit split: ${sentSol.toFixed(6)} SOL ($${masterShareUsd.toFixed(2)}) -> master treasury`,
                    });
                  }
                }
              }
            } catch (e) {
              keeperLog(t, "warn", "tp profit-route", { error: e.message, tick_id: tickId });
              ctx.events.push({ kind: "tick", note: `tp profit-route pending: ${e.message.slice(0, 160)}` });
            }
          } else if (config.hedgeMode !== "live") {
            ctx.events.push({
              kind: "tick",
              note: `[${config.hedgeMode}] would TP+buyback $${applied.realizedActual.toFixed(2)} (skipped: hedge mode not live)`,
            });
          }
        } else {
          ctx.events.push({
            kind: "tick",
            note: `tp not accepted: ${res.error ? res.error.slice(0, 150) : "no signature returned"}`,
          });
        }
      } catch (e) {
        keeperLog(t, "warn", "tp failed", { error: e.message, tick_id: tickId });
        ctx.events.push({ kind: "tick", note: `tp err: ${e.message.slice(0, 150)}` });
      }
    }
  }
}

export async function tick() {
  const tickId = newTickId();
  const tickStartedAt = Date.now();
  let tickErrors = 0;

  // Server-owned launch reconciliation: promote public `launching` rows to `live`
  // once their pool is on-chain, or expire stale ones. Guarantees every paid public
  // launch becomes a managed token without depending on a client callback. Best-effort.
  try {
    await fetch(`${config.perpadBaseUrl}/api/admin/reconcile-launches`, {
      method: "POST",
      headers: { "x-keeper-secret": config.keeperSecret },
    });
  } catch (e) {
    console.warn(`[loop] reconcile-launches failed: ${e.message}`);
  }

  let tickClaimedUsd = 0;
  const all = await listActiveTokens();
  let tokens = KEEPER_MINT_ALLOWLIST.length
    ? all.filter((t) => {
        const tokenMint = t.mint_address || t.external_mint;
        return tokenMint && KEEPER_MINT_ALLOWLIST.includes(tokenMint);
      })
    : all;
  if (KEEPER_MINT_ALLOWLIST.length) {
    const skipped = all.length - tokens.length;
    if (skipped > 0)
      console.log(
        `[loop] allowlist active: processing ${tokens.length}/${all.length} tokens (skipped ${skipped})`,
      );
  }
  if (!tokens.length) return { processed: 0 };

  // 4b: drop cold tokens that don't need a tick right now. Done BEFORE claiming
  // locks / sorting so cold tokens cost zero RPC and zero lock churn. Hot tokens
  // (live position, pending sig, near-gate fees, mid-flow state) are never
  // dropped; deferred tokens (next_retry_at) are skipped until their time.
  {
    const nowMs = Date.now();
    const beforeCadence = tokens.length;
    tokens = tokens.filter((t) => !shouldSkipColdTick(t, nowMs));
    const skipped = beforeCadence - tokens.length;
    if (skipped > 0)
      console.log(`[loop] cadence: skipped ${skipped} cold/deferred token(s), processing ${tokens.length}`);
    if (!tokens.length) return { processed: 0, skipped: "all_tokens_cold" };
  }

  const lockOwner = process.env.FLY_ALLOC_ID || `${os.hostname()}:${process.pid}`;
  try {
    const locked = await claimWorkflowLocks(tokens.map((t) => t.id), lockOwner);
    const before = tokens.length;
    tokens = tokens.filter((t) => locked.has(t.id));
    if (tokens.length < before) {
      console.log(`[loop] workflow locks: processing ${tokens.length}/${before} tokens owner=${lockOwner}`);
    }
    if (!tokens.length) return { processed: 0, skipped: "all_tokens_locked" };
  } catch (e) {
    console.warn(`[loop] workflow lock acquisition failed; continuing without locks: ${e.message}`);
  }

  // Cold/idle tokens were already dropped by the 4b cadence filter above, so
  // this sorts only the hot/warm survivors. It does NOT reduce call volume
  // (that's 4b's job) — it just orders the survivors so a slow tick (RPC 429s,
  // 4a backoff waits, long imperial calls) services the highest-value vaults (tokens)
  // before the 240s watchdog can cut the tick off. Order:
  //   1. tokens with a stuck pending_drift_sig (must clear it to unblock)
  //   2. tokens with a live position AND a funded imperial profile (topups)
  //   3. tokens with a live position (PnL reads / partial close)
  //   4. tokens with accrued fees >= open gate
  //   5. everything else (e.g. split_reserved accruing below gate)
  tokens.sort((a, b) => {
    const score = (t) => {
      let s = 0;
      if (t.pending_drift_sig) s += 1000;
      const live = !!t.position_opened_at;
      const funded = !!t.imperial_profile_pda;
      const targetLev = clampLeverage(
        `sort:${t.ticker ?? t.id} ${String(t.underlying ?? "").toUpperCase()}`,
        Math.max(1, Number(t.leverage ?? 2)),
      );
      const size = Number(t.position_size_usd ?? 0);
      const coll = Number(t.position_collateral_usd ?? 0);
      const lev = coll > 0 && size > 0 ? size / coll : targetLev;
      const repairGap = live && funded ? Math.max(0, targetLev - lev) : 0;
      if (repairGap > 0.25) s += 2000 + repairGap * 100;
      if (live && funded) s += 500;
      else if (live) s += 300;
      else if (Number(t.fees_accrued_usd ?? 0) >= 25) s += 100;
      return s;
    };
    return score(b) - score(a);
  });

  await getJupPerps();

  let solUsd;
  try {
    solUsd = await getSolUsd();
  } catch (e) {
    console.error("[loop] SOL price unavailable, skipping tick:", e.message);
    return { processed: 0, error: "no_sol_price" };
  }

  const reports = [];
  let processed = 0;
  const bucket = tickBucket(new Date(), 1);

  // DISABLED 2026-05-28: treasury SOL inflow attribution was crediting
  // fees_accrued_usd from any wallet movement (gas refunds, sub-wallet
  // top-backs, manual transfers), inflating the fee ledger without backing
  // SOL. Real fee accrual must come exclusively from claimDbcFees /
  // claimExternalFees results. We still track _lastTreasurySol for diagnostic
  // logs but never credit fees from it.
  const treasurySolNow = await treasurySolUi();
  const _treasuryDeltaSol = _lastTreasurySol === null ? 0 : treasurySolNow - _lastTreasurySol;
  if (Math.abs(_treasuryDeltaSol) > 0.0001) {
    console.log(
      `[loop] treasury SOL delta ${_treasuryDeltaSol.toFixed(6)} SOL (` +
        `$${(_treasuryDeltaSol * solUsd).toFixed(2)}) - NOT credited to fees`,
    );
  }
  _lastTreasurySol = treasurySolNow;

  for (const t of tokens) {
    const ctx = initTokenCtx(t, { solUsd, bucket, tickId });
    if (ctx.skip) {
      reports.push(sanitizeReportPatch(ctx.report));
      processed++;
      continue;
    }
    const { tStart } = ctx;

    try {
      await backfillProfilePda(ctx);
      await detectGraduationStep(ctx);
      if (marketSupportGate(ctx)) {
        reports.push(sanitizeReportPatch(ctx.patch));
        processed++;
        continue;
      }
      await confirmPendingSigStep(ctx);
      await claimAndSplitFeesStep(ctx);
      await buybackDrainStep(ctx);
      await readPositionPreState(ctx);
      await imperialDepositStep(ctx);
      await openPositionStep(ctx);
      await topUpAndRepairStep(ctx);
      await pnlAndTakeProfitStep(ctx);

      // ---- 6. (removed) graduation drain ----
      // Previously this drained buyback_reserve_usd via buyback+burn after
      // graduation. Removed: buybacks should only come from realized PnL on
      // the perp position (step 5). Any accumulated reserve stays parked.
      const reserveAfter = Math.max(0, ctx.currentReserve + ctx.reserveDelta);
      const reserveDrainDelta = 0;
      void reserveAfter;

      // ---- accrue not-yet-at-gate report ----
      if (!ctx.wasOpen && !ctx.patch.position_opened && ctx.feesAccruedDelta > 0) {
        ctx.events.push({
          kind: "tick",
          note: `accruing $${ctx.feesAccruedAfter.toFixed(2)}/${config.feeGateUsd} to gate`,
        });
      }

      ctx.patch.treasury_pnl_usd = Number.isFinite(ctx.pnlNow) ? ctx.pnlNow : 0;
      ctx.patch.pnl_high_water_usd = Number.isFinite(ctx.newHighWater) ? ctx.newHighWater : 0;
      ctx.patch.fees_accrued_usd_delta = ctx.feesAccruedDelta || undefined;
      ctx.patch.buyback_reserve_usd_delta = ctx.reserveDelta + reserveDrainDelta || undefined;
      ctx.patch.treasury_sol_delta = ctx.treasurySolDelta || undefined;
      ctx.patch.tokens_burned_delta = ctx.tokensBurnedDelta || undefined;
      ctx.patch.events = ctx.events;
      ctx.patch.tx_log = ctx.txLog;
      const blockedReason = blockedReasonFromEvents(ctx.events);
      const wfPatch = workflowPatch(t, ctx.patch, {
        blockedReason,
        claimedFeesUsd: ctx.claimedSolUsd,
        feesAccruedAfter: ctx.feesBefore + ctx.feesAccruedDelta,
        buybackReserveUsd: Number(t.buyback_reserve_usd ?? 0) + ctx.reserveDelta,
        imperialDepositedThisTickUsd: ctx.imperialDepositedThisTickUsd,

        imperialDepositedUsd: ctx.patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
        positionEntryPrice: ctx.patch.launch_mid ?? t.launch_mid ?? undefined,
        positionEntrySource: ctx.patch.launch_mid ? "imperial" : t.launch_mid ? "reconciled" : null,
        positionSizeUsd: ctx.patch.position_size_usd ?? t.position_size_usd ?? 0,
        positionCollateralUsd: ctx.patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
      });
      queueWorkflow(wfPatch);
      if (blockedReason) {
        tokenLog(t, "workflow", "token blocked by keeper gate", {
          blocked_reason: blockedReason,
        });
      }
      tickClaimedUsd += ctx.claimedSolUsd || 0;
      // One structured per-token record for the whole tick (KEEPER_OBSERVABILITY.md).
      tokenTickSummary(tickId, t, {
        state: wfPatch?.state ?? null,
        actions: ctx.txLog.map((x) => x.kind),
        claimed_usd: num2(ctx.claimedSolUsd),
        reserve_delta_usd: num2(ctx.reserveDelta),
        tokens_burned_delta: ctx.tokensBurnedDelta || 0,
        treasury_delta_sol: num2(ctx.treasurySolDelta, 6),
        blocked_reason: blockedReason ?? null,
        entry_mid: num2(ctx.patch.launch_mid ?? t.launch_mid, 8) || null,
        events: ctx.events.length,
        duration_ms: Date.now() - tStart,
      });
      reports.push(sanitizeReportPatch(ctx.patch));
      processed++;
    } catch (err) {
      tickErrors++;
      logError("token tick failed", {
        event: "token_tick",
        tick_id: tickId,
        token_id: t.id,
        ticker: t.ticker,
        error: err.message,
        duration_ms: Date.now() - tStart,
      });
      queueBlocked(t, `loop error: ${err.message.slice(0, 200)}`, { error: err.message });
    }
  }

  try {
    const r = await sendReport(reports);
    logInfo("tick reported", {
      event: "tick_report",
      tick_id: tickId,
      processed,
      tokens_updated: r.tokens_updated,
      events_inserted: r.events_inserted,
      tx_log_inserted: r.tx_log_inserted ?? 0,
    });
  } catch (err) {
    logError("tick report failed", { event: "tick_report", tick_id: tickId, error: err.message });
  }

  tickSummary(tickId, {
    tokens: tokens.length,
    processed,
    errors: tickErrors,
    claimed_usd: num2(tickClaimedUsd),
    sol_usd: solUsd,
    duration_ms: Date.now() - tickStartedAt,
  });

  return { processed };
}

// Manual emergency close for /admin/close-hedge.
export async function adminCloseHedge(tokenId) {
  const tokens = await listActiveTokens();
  const t = tokens.find((x) => x.id === tokenId);
  if (!t) throw new Error(`token ${tokenId} not found in active list`);
  const underlying = String(t.underlying ?? "").toUpperCase();
  const side = String(t.direction ?? "long").toLowerCase() === "short" ? "short" : "long";
  const kp = walletForToken(tre(), t);
  const pos = await readPerpPosition({ symbol: underlying, side, kp });
  if (!pos) return { ok: true, note: "no live position to close" };
  const res = await closePerp({
    symbol: underlying,
    side,
    sizeUsd: pos.sizeUsd,
    collateralUsd: pos.collateralUsd,
    kp,
  });

  return {
    ok: true,
    mode: config.hedgeMode,
    sig: res.signature,
    simulated: res.simulated,
    error: res.error,
  };
}

// Manual one-shot open for /admin/force-open. Bypasses the fee gate and opens
// a position at OPEN_COLLATERAL_USD with the token's configured side+leverage.
// Reports the open back to perpad so DB state stays in sync with chain.
export async function adminForceOpen(tokenId, overrides = {}) {
  const tokens = await listActiveTokens();
  const t = tokens.find((x) => x.id === tokenId);
  if (!t) throw new Error(`token ${tokenId} not found in active list`);
  if (t.position_opened_at) return { ok: false, error: "position already open" };

  const underlying = String(t.underlying ?? "").toUpperCase();
  const side = String(t.direction ?? "long").toLowerCase() === "short" ? "short" : "long";
  const leverage = Math.max(1, Number(overrides.leverage ?? t.leverage ?? 2));
  const collateralUsd = Number(overrides.collateralUsd ?? config.openCollateralUsd);
  const sizeUsd = Number(overrides.sizeUsd ?? collateralUsd * leverage);

  if (!isUnderlyingSupportedForToken(t, underlying)) {
    const routerId = String(t?.router ?? "imperial").toLowerCase();
    throw new Error(`unsupported underlying ${underlying} for router ${routerId}`);
  }

  const kp = walletForToken(tre(), t);
  const freeUsdc = await getFreeCollateralUsd(kp);
  if (freeUsdc < collateralUsd) {
    return { ok: false, error: `wallet USDC $${freeUsdc.toFixed(2)} < required $${collateralUsd}` };
  }

  await getJupPerps();
  const res = await openPosition({ symbol: underlying, side, collateralUsd, sizeUsd, kp });

  // Mirror the loop's accounting so the UI immediately reflects the open.
  const patch = {
    token_id: t.id,
    position_opened: true,
    position_size_usd: sizeUsd,
    position_collateral_usd: collateralUsd,
    opened_collateral_usd: collateralUsd,
    pending_drift_sig: res.signature ?? undefined,
    events: [
      {
        kind: "open",
        note:
          `[force-open] ${config.hedgeMode}: opened ${side} ${underlying} ${leverage}x coll=$${collateralUsd} size=$${sizeUsd}` +
          (res.signature ? ` sig=${res.signature.slice(0, 16)}…` : "") +
          (res.error ? ` ERR: ${res.error.slice(0, 150)}` : ""),
      },
    ],
  };
  try {
    await sendReport([patch]);
  } catch (e) {
    console.warn("[force-open] report failed:", e.message);
  }

  return {
    ok: !res.error,
    mode: config.hedgeMode,
    sig: res.signature ?? null,
    simulated: !!res.simulated,
    error: res.error ?? null,
    symbol: underlying,
    side,
    leverage,
    collateralUsd,
    sizeUsd,
  };
}
