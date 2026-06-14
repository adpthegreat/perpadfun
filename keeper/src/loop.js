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
  SUPPORTED_SYMBOLS,
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
import { pickEntryMid, captureMarkAsEntry, computePnlFromEntry } from "./pnl.js";
import {
  gateImperialFunding,
  depositToImperialProfile,
  getWalletCapacityUsd,
} from "./imperialDeposit.js";
import {
  authenticate as imperialAuthenticate,
  isSupportedMarket as isImperialSupportedMarket,
  getProfile as imperialGetProfile,
  getPositions as imperialGetPositions,
  getMarkPriceUi as imperialGetMarkPriceUi,
  MIN_COLLATERAL_USD as IMPERIAL_MIN_COLLATERAL_USD,
  SUPPORTED_MARKETS as IMPERIAL_SUPPORTED_MARKETS,
} from "./imperial.js";

// Router-aware underlying gate. Jupiter Perps only supports SOL/ETH/BTC,
// but Imperial supports a much wider set (HYPE, SUI, AVAX, etc.).
// Gating purely on Jupiter's whitelist incorrectly skips Imperial-routed
// tokens. Always check support against the router the token actually uses.
function isUnderlyingSupportedForToken(token, underlying) {
  const sym = String(underlying ?? "").toUpperCase();
  if (!sym) return false;
  const routerId = String(token?.router ?? "imperial").toLowerCase();
  if (routerId === "imperial") return isImperialSupportedMarket(sym);
  // jupiter (or any unknown id) falls back to the Jupiter whitelist
  return SUPPORTED_SYMBOLS.has(sym);
}
import {
  imperialReadPosition,
  imperialOpenPosition,
  imperialIncreasePosition,
  imperialAddCollateralToPosition,
  imperialTopUpMargin,
  imperialPartialClose,
  imperialWithdrawCollateral,
} from "./imperialPerps.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_BUYBACK_USD = 1;

function closeSizeForRealizedPnl({ desiredPnlUsd, pnlUsd, sizeUsd }) {
  const desired = Number(desiredPnlUsd);
  const pnl = Number(pnlUsd);
  const size = Number(sizeUsd);
  if (!(desired > 0) || !(pnl > 0) || !(size > 0)) return 0;
  return Math.min(size, (desired / pnl) * size);
}

function isRealSolanaSignature(signature) {
  return typeof signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature);
}

const IMPERIAL_MAX_LEVERAGE = Number(process.env.IMPERIAL_MAX_LEVERAGE ?? 9.5);
const IMPERIAL_LEVERAGE_SAFETY_MARGIN = Number(process.env.IMPERIAL_LEVERAGE_SAFETY_MARGIN ?? 0.5);
function clampImperialLeverage(label, requested, symbol) {
  const req = Number(requested);
  if (!Number.isFinite(req) || req <= 0) return req;
  const sym = String(symbol || "").toUpperCase();
  const marketCap = sym && IMPERIAL_SUPPORTED_MARKETS[sym]?.maxLeverage;
  const ceiling = Number.isFinite(marketCap) && marketCap > 0
    ? Math.max(1, marketCap - IMPERIAL_LEVERAGE_SAFETY_MARGIN)
    : IMPERIAL_MAX_LEVERAGE;
  if (req <= ceiling) return req;
  const clamped = ceiling;
  console.log(`[${label}] leverage clamped ${req}x -> ${clamped}x (cap=${marketCap ?? "global"}, margin=${IMPERIAL_LEVERAGE_SAFETY_MARGIN})`);
  return clamped;
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

// Cache Imperial auth tokens per sub-wallet. Each token operates from its
// own dedicated sub-wallet, which is its own Imperial account (with its own
// "Main" profile at index 0). Keying the cache by pubkey lets us serve every
// token's loop branch without re-authenticating each tick.
const _imperialAuthByWallet = new Map(); // base58 pubkey -> { token, expiresAt }
async function getImperialTokenFor(kp) {
  if (!kp) throw new Error("getImperialTokenFor: kp required");
  const key = kp.publicKey.toBase58();
  const now = Date.now();
  const cached = _imperialAuthByWallet.get(key);
  if (cached && (!cached.expiresAt || cached.expiresAt - now > 30 * 60_000)) {
    return cached.token;
  }
  const r = await imperialAuthenticate(kp);
  _imperialAuthByWallet.set(key, { token: r.token, expiresAt: r.expiresAt ?? null });
  return r.token;
}

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

// Read profile free USDC (UI units) from the on-chain profile ATA first, with
// API as a fallback when the ATA is unavailable.
// Used to verify that an Imperial open/topup actually drained collateral
// instead of being refunded by the venue in the same tx.
async function readImperialProfileUsdcUi({ profileIndex, authToken, profilePda }) {
  let ui = 0;
  let pda = profilePda || null;
  try {
    const prof = await imperialGetProfile({ profileIndex, token: authToken });
    ui = Number(prof?.usdcUi || 0);
    if (prof?.profilePda) pda = prof.profilePda;
  } catch {
    // Fall through to the cached profile PDA on-chain read below.
  }
  if (pda) {
    try {
      const pdaPk = new PublicKey(pda);
      const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), pdaPk, true);
      const bal = await withRetry(() => conn().getTokenAccountBalance(ata, "confirmed"));
      const onChain = Number(bal?.value?.uiAmount ?? 0);
      if (Number.isFinite(onChain)) ui = onChain;
    } catch {
      /* ATA may not exist */
    }
  }
  return ui;
}

async function readVerifiedImperialPosition({
  profileIndex,
  symbol,
  side,
  authToken,
  wallet,
  attempts = 13,
  delayMs = 1500,
}) {
  for (let i = 0; i < attempts; i++) {
    const pos = await imperialReadPosition({
      profileIndex,
      symbol,
      side,
      token: authToken,
      wallet,
    });
    if (pos && Number(pos.sizeUsd) > 0) return pos;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // Diagnostic: dump the raw /positions payload so we can see what Imperial
  // is actually returning for this wallet. Helps confirm whether positions
  // live under a different wallet namespace (e.g. API-key wallet vs sub).
  try {
    const raw = await imperialGetPositions(wallet, { token: authToken });
    const list = Array.isArray(raw?.dataList) ? raw.dataList : Array.isArray(raw) ? raw : [];
    const summary = list.slice(0, 8).map((p) => ({
      profile: p?.profileIndex ?? p?.profileIdx ?? p?.profile,
      symbol: p?.symbol ?? p?.asset ?? p?.marketSymbol ?? p?.baseSymbol,
      side: p?.side ?? p?.direction ?? p?.positionSide,
      sizeUsd: p?.sizeUsd ?? p?.notionalUsd ?? p?.size,
    }));
    console.warn(
      `[imperial:readPos] DIAG no match for wallet=${wallet} profile=${profileIndex} ${String(symbol).toUpperCase()} ${String(side).toLowerCase()} after ${attempts} tries. /positions returned ${list.length} entries: ${JSON.stringify(summary)}`,
    );
  } catch (e) {
    console.warn(`[imperial:readPos] DIAG getPositions dump failed: ${e.message}`);
  }
  return null;
}

async function resolveImperialEntryPrice({ verifiedPos, symbol, venue, token }) {
  const picked = pickEntryMid({
    venueEntry: verifiedPos?.entryPriceUsd,
    venueMark: verifiedPos?.markPriceUsd,
    existingMid: token?.launch_mid,
  });
  if (picked.price) return picked;
  try {
    const markPrice = await imperialGetMarkPriceUi(symbol, venue);
    if (markPrice) return { price: Number(markPrice), source: "perpad_entry_mid" };
  } catch (e) {
    console.warn(`[imperial:entry] ${symbol} mark fallback failed:`, e.message);
  }
  return { price: null, source: null };
}

async function readImperialLiveMarkUsd(symbol, venue) {
  try {
    const mark = Number(await imperialGetMarkPriceUi(symbol, venue));
    return Number.isFinite(mark) && mark > 0 ? mark : null;
  } catch (e) {
    console.warn(`[imperial:mark] ${symbol} live mark failed:`, e.message);
    return null;
  }
}

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

export async function tick() {
  const tickId = newTickId();
  const tickStartedAt = Date.now();
  let tickErrors = 0;
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
      const targetLev = clampImperialLeverage(
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
  const perTokenInflowUsd = 0;
  _lastTreasurySol = treasurySolNow;

  for (const t of tokens) {
    const tStart = Date.now();
    const events = [];
    const txLog = [];
    const patch = { token_id: t.id };
    let treasurySolDelta = 0;
    let tokensBurnedDelta = 0;
    let feesAccruedDelta = 0;
    let reserveDelta = 0;

    try {
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
        reports.push(sanitizeReportPatch(patch));
        processed++;
        continue;
      }
      const isSubWallet = !kp.publicKey.equals(tre().publicKey);
      // PERPAD is the project's namesake token and the master treasury IS its
      // wallet by design. Whitelist it so fee claims, PnL ticks, and buyback
      // drain still run when KEEPER_LEGACY_MASTER_SPEND_ENABLED=false (which
      // is intended to gate ad-hoc Imperial top-ups for OTHER legacy tokens,
      // not freeze PERPAD itself).
      const isPerpadFlagship = String(t.ticker ?? "").toUpperCase() === "PERPAD";
      if (!isSubWallet && !config.legacyMasterSpendEnabled && !isPerpadFlagship) {
        const note = "legacy master-token spend disabled by KEEPER_LEGACY_MASTER_SPEND_ENABLED=false";
        keeperLog(t, "info", "master outbound skipped", { tick_id: tickId });
        events.push({ kind: "tick", note });
        patch.events = events;
        reports.push(sanitizeReportPatch(patch));
        processed++;
        continue;
      }
      // NOTE: do NOT pre-emptively top up every sub-wallet every tick.
      // With 100+ idle pending tokens that drains the master ~0.0325 SOL each.
      // Top-ups happen lazily at the buyback site (see ensureSubWalletSol
      // call right before the swap), which is the only place we actually
      // need on-chain SOL on a sub-wallet.

      let isGraduated = t.migration_status === "graduated";
      const isExternal = String(t.source ?? "") === "external";
      const buybackMint = isExternal ? t.external_mint : t.mint_address;
      const wasOpen = !!t.position_opened_at;
      const underlying = String(t.underlying ?? "").toUpperCase();
      const side = String(t.direction ?? "long").toLowerCase() === "short" ? "short" : "long";
      const leverage = clampImperialLeverage(
        `loop:${t.ticker ?? t.id} ${String(t.underlying ?? "").toUpperCase()}`,
        Math.max(1, Number(t.leverage ?? 2)),
        String(t.underlying ?? "").toUpperCase(),
      );
      const feesBefore = Number(t.fees_accrued_usd ?? 0);
      // Imperial routing flags. Computed once per token so every branch
      // (pre-read, open, top-up, pnl-read, withdraw, partial-close) makes
      // the same decision. `imperialTradeEnabled` gates the trade primitives
      // (open/topup/withdraw/partial-close); deposit logic has its own gate.
      const isImperialRouted = String(t.router || "").toLowerCase() === "imperial";
      const imperialTradeEnabled =
        isImperialRouted &&
        config.imperial.enabled &&
        t.imperial_profile_index != null &&
        ["open-only", "full"].includes(config.imperial.positionMode);
      const imperialFullTrade = imperialTradeEnabled && config.imperial.positionMode === "full";
      let imperialAuthTokenCached = null;
      const ensureImperialAuth = async () => {
        if (!imperialAuthTokenCached) imperialAuthTokenCached = await getImperialTokenFor(kp);
        return imperialAuthTokenCached;
      };
      let imperialDepositedThisTickUsd = 0;
      let imperialFundingSource = "none";
      let optimisticImperialPositionState = false;
      let freshPerpFeesUsd = 0;
      // Only profile USDC that is actually parked/deposited this tick may fund
      // a new Imperial order. Never use DB collateral as available funds here:
      // stale optimistic rows were the source of the UI doubling bug.
      const getImperialAvailableUsd = () => Math.max(0, Number(imperialDepositedThisTickUsd || 0));

      // ---- Backfill imperial_profile_pda unconditionally for imperial-routed
      // tokens. The PDA is the on-chain account that actually holds the perp
      // position, so the site needs it to render a working "view position"
      // link (solscan defi activities). Runs every tick when missing; once
      // set, the cheap /mobile/balances call is skipped.
      if (
        isImperialRouted &&
        config.imperial.enabled &&
        t.imperial_profile_index != null &&
        !t.imperial_profile_pda
      ) {
        try {
          const authToken = await ensureImperialAuth();
          const prof = await imperialGetProfile({
            profileIndex: t.imperial_profile_index,
            token: authToken,
          });
          if (prof?.profilePda) {
            patch.imperial_profile_pda = prof.profilePda;
            t.imperial_profile_pda = prof.profilePda;
          }
        } catch (e) {
          keeperLog(t, "warn", "phoenix pda backfill failed", { error: e.message, tick_id: tickId });
        }
      }

      // ---- 0. graduation detector ----
      // If the token isn't marked graduated yet, poll DBC pool state. When
      // migrationProgress crosses into "CreatedPool" we derive the DAMM v2
      // pool address and flip the row so future ticks use the AMM claim path.
      if (!isGraduated && t.dbc_pool_address && t.dbc_config_address && t.mint_address) {
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
            patch.migration_status = "graduated";
            patch.graduated_pool_address = det.graduatedPoolAddress;
            // Mutate local view so the rest of this tick uses the new pool.
            t.migration_status = "graduated";
            t.graduated_pool_address = det.graduatedPoolAddress;
            isGraduated = true;
            events.push({
              kind: "graduation",
              note: `bonding curve graduated. DAMM v2 pool ${det.graduatedPoolAddress}`,
            });
          }
        } catch (e) {
          keeperLog(t, "warn", "graduation detect failed", { error: e.message, tick_id: tickId });
        }
      }

      if (!isUnderlyingSupportedForToken(t, underlying)) {
        const routerId = String(t?.router ?? "imperial").toLowerCase();
        // Fix 2a runtime fallback: terminal market_unsupported classification.
        // These tokens can never open a perp on this keeper, so flag them with a
        // distinct reason (for a creator remap) and a long re-check backoff
        // rather than retrying every tick. Native tokens bail before the claim
        // step, so there is no perp slice to redirect here (unlike the external
        // sweep path). See KEEPER_P1_FIXES.md Fix 2a.
        events.push({
          kind: "tick",
          note: `market_unsupported: ${underlying || "unknown"} not routable by router ${routerId}, skipping hedge`,
        });
        patch.events = events;
        patch.tx_log = txLog;
        queueBlocked(t, `market_unsupported: ${underlying || "unknown"} (router ${routerId})`, {
          patch,
          nextRetryAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        });
        reports.push(sanitizeReportPatch(patch));
        processed++;
        continue;
      }

      // ---- 1. confirm pending perp request from prior tick ----
      let pendingSig = t.pending_drift_sig ?? null;
      const wfBeforePendingCheck = workflowStateFromToken(t);
      if (pendingSig && wasOpen && wfBeforePendingCheck?.state === State.POSITION_OPEN) {
        patch.pending_drift_sig = null;
        console.warn(
          `[loop] ${t.ticker} clearing stale pending sig ${pendingSig.slice(0, 16)}… because workflow and DB both show a live open position`,
        );
        events.push({
          kind: "tick",
          note: `cleared stale pending sig; live position is already open`,
        });
        pendingSig = null;
      }
      if (pendingSig) {
        const status = await checkSig(pendingSig);
        if (status === "confirmed" || status === "failed" || status === "dropped") {
          patch.pending_drift_sig = null;
          txLog.push(
            buildTxLogEntry({
              kind: "drift_adjust",
              intent: pendingSig.slice(0, 32),
              status: status === "dropped" ? "failed" : status,
              signature: pendingSig,
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
              `[loop] ${t.ticker} pending sig ${pendingSig.slice(0, 16)}… dropped (not found on-chain); cleared to unblock topups`,
            );
          }
          pendingSig = null;
        }
      }

      // ---- 2. claim fees (always run regardless of position state) ----
      let claimedSolUsd = 0;
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
              kp,
              // USDC pools accrue fees in USDC; the claim helper converts to SOL.
              quoteMint: t.quote_token === "USDC" ? USDC_MINT : undefined,
            });
            if (claim) {
              const usd = claim.solClaimed * solUsd;
              totalClaimedSol += claim.solClaimed;
              lastSig = claim.signature;
              txLog.push(
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
          if (isGraduated && t.graduated_pool_address) {
            const intent = intentHash([t.id, "fee_claim_amm", bucket, t.graduated_pool_address]);
            const claim = await claimAmmFees({
              graduatedPoolAddress: t.graduated_pool_address,
              mintAddress: t.mint_address,
              lpPositionAddress: t.lp_position_address,
              solUsd,
              kp,
              quoteMint: t.quote_token === "USDC" ? USDC_MINT : undefined,
            });

            if (claim) {
              const usd = claim.solClaimed * solUsd;
              totalClaimedSol += claim.solClaimed;
              lastSig = claim.signature;
              txLog.push(
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
                patch.lp_position_address = claim.lpPositionAddress;
              }
            }
          }

          if (totalClaimedSol > 0) {
            claimedSolUsd = totalClaimedSol * solUsd;
            patch.last_fee_claim_at = new Date().toISOString();
            patch.last_fee_claim_signature = lastSig;
          }
        } catch (e) {
          keeperLog(t, "warn", "fee claim failed", { error: e.message, tick_id: tickId });
          events.push({ kind: "tick", note: `fee claim error: ${e.message.slice(0, 200)}` });
        }
      }

      if (claimedSolUsd > 0) {
        freshPerpFeesUsd = claimedSolUsd * config.perpMarginRatio;
        feesAccruedDelta = freshPerpFeesUsd;
        // SOL the sub-wallet still owes to swap+deposit: previously accrued
        // perp fees + this claim's perp slice + earmarked buyback reserve.
        // Skim holds back enough SOL to cover this before sending master its share.
        const pendingObligationUsd =
          Number(feesBefore || 0) +
          feesAccruedDelta +
          Number(t.buyback_reserve_usd || 0) +
          (config.buybackFromFeesRatio > 0 ? claimedSolUsd * config.buybackFromFeesRatio : 0);
        const skim = await skimTreasuryShare({
          claimedSolUsd,
          solUsd,
          isSubWallet,
          kp,
          ticker: t.ticker,
          events,
          pendingObligationUsd,
        });
        treasurySolDelta += skim.treasurySolDelta;
        const lastClaimSig = patch.last_fee_claim_signature ?? null;
        events.push({
          kind: "claim",
          sol_amount: claimedSolUsd / solUsd,
          note: `claimed $${claimedSolUsd.toFixed(2)} in trading fees. Split: $${feesAccruedDelta.toFixed(2)} perp, $${(claimedSolUsd * config.buybackFromFeesRatio).toFixed(2)} buyback, $${(claimedSolUsd * config.treasuryHoldRatio).toFixed(2)} treasury`,
          tx_sig: lastClaimSig ?? undefined,
        });
      }

      // ---- 2b. BUYBACK ACCRUAL + DRAIN ----
      // Each tick we earmark a slice of claimed fees into buyback_reserve_usd.
      // Accrual runs for both curve and graduated tokens so pre-grad fees
      // (ZRALLY, pre-grad DEGEN) build up a reserve that drains the moment
      // the token graduates and Jupiter can route through DAMM v2. Spending
      // is still gated below by canRouteBuyback (isExternal || isGraduated).
      if (config.buybackFromFeesRatio > 0 && claimedSolUsd > 0 && (t.mint_address || t.external_mint)) {
        const earmarkUsd = claimedSolUsd * config.buybackFromFeesRatio;
        reserveDelta += earmarkUsd;
        console.log(
          `[buyback] accrue token=${t.ticker} +$${earmarkUsd.toFixed(4)} (ratio=${config.buybackFromFeesRatio}, graduated=${isGraduated})`,
        );
      }

      // Drain reserve when it crosses the USD floor. Cap per-tick spend
      // so any backlog (e.g. from a code switch) bleeds down gradually
      // instead of one giant swap.
      const currentReserveSnapshot = Math.max(0, Number(t.buyback_reserve_usd ?? 0));
      const projectedReserve = currentReserveSnapshot + reserveDelta;
      const maxPerTickUsd = Number(config.maxBuybackPerTickUsd ?? 25);
      const canRouteBuyback = !!buybackMint && (isExternal || isGraduated);
      if (projectedReserve >= config.minBuybackUsd && !pendingSig && canRouteBuyback) {
        let spendUsd = Math.min(projectedReserve, maxPerTickUsd);
        let wantSol = spendUsd / solUsd;
        // External tokens (TOLY etc.) AND imperial-routed tokens realize PnL
        // as USDC in their sub-wallet, not SOL. Probe USDC balance and prefer
        // it as the swap input so we don't try to spend SOL the wallet
        // doesn't have.
        let payMint = null;
        let payAmountBaseUnits = null;
        let payNote = `${wantSol.toFixed(6)} SOL`;
        if (isExternal || isImperialRouted) {
          try {
            const usdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), kp.publicKey);
            const usdcBal = await withRetry(() => conn().getTokenAccountBalance(usdcAta, "confirmed"))
              .catch(() => null);
            let usdcUi = Number(usdcBal?.value?.uiAmount ?? 0);
            if (usdcUi < spendUsd && isImperialRouted && imperialFullTrade && t.imperial_profile_index != null) {
              const authToken = await ensureImperialAuth();
              const profileUsdc = await readImperialProfileUsdcUi({
                profileIndex: t.imperial_profile_index,
                authToken,
                profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
              });
              const lockedColl = Math.max(0, Number(patch.position_collateral_usd ?? t.position_collateral_usd ?? 0));
              const profileFreeUsd = Math.max(0, profileUsdc - lockedColl);
              if (profileFreeUsd >= spendUsd) {
                const w = await imperialWithdrawCollateral({
                  authToken,
                  kp,
                  profileIndex: t.imperial_profile_index,
                  withdrawUsd: spendUsd,
                  rpcUrl: config.rpcUrl,
                });
                if (!w.error && w.signature) {
                  events.push({
                    kind: "tick",
                    note: `phoenix profit withdrawal: $${spendUsd.toFixed(2)} profile USDC → sub-wallet for buyback`,
                    tx_sig: w.signature,
                  });
                  await new Promise((r) => setTimeout(r, 2000));
                  const afterBal = await withRetry(() => conn().getTokenAccountBalance(usdcAta, "confirmed"))
                    .catch(() => null);
                  usdcUi = Number(afterBal?.value?.uiAmount ?? 0);
                } else {
                  events.push({
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
            keeperLog(t, "warn", "buyback USDC probe failed", { error: e.message, tick_id: tickId });
          }
        }
        if (!isSubWallet && !payMint) {
          const masterSpendBudgetUsd = Math.max(0, reserveDelta);
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
        if (isSubWallet && !payMint) {
          const walletLamports = await withRetry(() => conn().getBalance(kp.publicKey, "confirmed"));
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
            if (isSubWallet) {
              try { await ensureSubWalletSol(kp); } catch (e) {
                console.warn("[loop] ensureSubWalletSol(buyback):", e.message);
              }
            }
            try {
              await unwrapWsol(kp);
            } catch (e) {
              console.warn("[loop] unwrapWsol:", e.message);
            }
            const r = await buybackAndBurn({
              mintAddress: buybackMint,
              solAmount: payMint ? undefined : wantSol,
              payMint: payMint ?? undefined,
              payAmountBaseUnits: payAmountBaseUnits ?? undefined,
              kp,
            });

            const actualSpendUsd = payMint ? spendUsd : Number(r.solSpent ?? wantSol) * solUsd;
            const actualSolSpent = payMint ? 0 : Number(r.solSpent ?? wantSol);
            if (!payMint) treasurySolDelta -= actualSolSpent;
            tokensBurnedDelta += r.tokensBurned;
            reserveDelta -= actualSpendUsd; // subtract only what we actually spent
            txLog.push(
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
            txLog.push(
              buildTxLogEntry({
                kind: "burn",
                intent,
                status: "confirmed",
                signature: r.burnSig,
                amountTokens: r.tokensBurned,
              }),
            );
            events.push({
              kind: "buyback",
              sol_amount: actualSolSpent,
              tokens_amount: r.tokensBurned,
              note: `buyback drain: $${actualSpendUsd.toFixed(2)} of $${projectedReserve.toFixed(2)} reserve (${payNote}) -> burned ${r.tokensBurned} tokens`,
              tx_sig: r.swapSig,
            });
            events.push({
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
                tick_id: tickId,
              });
              events.push({ kind: "tick", note: `buyback skip (low SOL): ${e.message.slice(0, 160)}` });
            } else if (e?.code === "EXCESSIVE_PRICE_IMPACT") {
              // Pool is too thin for the current spend size. Carry reserve;
              // it will re-attempt next tick. If the pool stays thin forever,
              // operator can lower MAX_BUYBACK_PER_TICK_USD so each slice
              // fits, or raise MAX_BUYBACK_PRICE_IMPACT_PCT if intentional.
              keeperLog(t, "info", "buyback drain skipped (price impact too high)", {
                error: e.message,
                tick_id: tickId,
              });
              events.push({ kind: "tick", note: `buyback skip (impact): ${e.message.slice(0, 200)}` });
            } else {
              keeperLog(t, "warn", "buyback drain failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `buyback drain err: ${e.message.slice(0, 200)}` });
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
        feesAccruedDelta += perTokenInflowUsd;
        events.push({
          kind: "tick",
          note: `+$${perTokenInflowUsd.toFixed(2)} curve fees from treasury inflow`,
        });
      }

      let feesAccruedAfter = feesBefore + feesAccruedDelta;
      // Master-wallet tokens share the real master treasury address, so their
      // historic DB fee ledger is not spendable cash. If the operator manually
      // refills master SOL, do not convert that principal into token collateral.
      // Only sub-wallet tokens may spend their accumulated ledger balance.
      const perpFundingBudgetUsd = isSubWallet
        ? feesAccruedAfter
        : Math.max(0, freshPerpFeesUsd);
      const currentReserve = Math.max(0, Number(t.buyback_reserve_usd ?? 0));
      const openedColl = Number(t.opened_collateral_usd ?? 0);
      const currentColl = Number(t.position_collateral_usd ?? 0);
      let chainPos = null;
      let hasLivePosition = wasOpen;
      let externallyClosed = false;

      if ((wasOpen || isExternal || isImperialRouted) && !pendingSig) {
        try {
          if (isImperialRouted) {
            // Imperial-routed: read from /positions filtered by profile BEFORE
            // checking parked profile USDC. Imperial balance endpoints can
            // include locked collateral, so this live read prevents counting
            // existing collateral as reusable free margin on every tick.
            chainPos = await imperialReadPosition({
              profileIndex: t.imperial_profile_index,
              symbol: underlying,
              side,
              token: await ensureImperialAuth().catch(() => null),
              wallet: kp.publicKey.toBase58(),
            });
          } else {
            chainPos = await readPerpPosition({ symbol: underlying, side, kp });
          }
          if (chainPos) {
            hasLivePosition = true;
            if (!wasOpen) patch.position_opened = true;
            if (isImperialRouted) {
              const liveMark = await readImperialLiveMarkUsd(underlying);
              if (liveMark) chainPos.markPriceUsd = liveMark;
            }
            if (Number.isFinite(Number(chainPos.collateralUsd)))
              patch.position_collateral_usd = Number(chainPos.collateralUsd);
            if (Number.isFinite(Number(chainPos.sizeUsd)))
              patch.position_size_usd = Number(chainPos.sizeUsd);
            if (
              isImperialRouted &&
              !(Number(t.launch_mid ?? 0) > 0) &&
              Number.isFinite(Number(chainPos.entryPriceUsd)) &&
              Number(chainPos.entryPriceUsd) > 0
            ) {
              patch.launch_mid = Number(chainPos.entryPriceUsd);
            } else if (isImperialRouted) {
              // Imperial often returns no entry price, which left launch_mid null
              // and forced the fragile client-side coll=$X tick replay. Right after
              // open, mark ~ entry, so capture the mark as our durable entry basis;
              // captureMarkAsEntry's window guard never adopts the mark for an aged
              // position (which would erase its real PnL). See KEEPER_PNL.md.
              const captured = captureMarkAsEntry({
                existingMid: t.launch_mid,
                mark: chainPos.markPriceUsd,
                openedAt: t.position_opened_at,
                now: Date.now(),
                windowMs: ENTRY_CAPTURE_WINDOW_MS,
              });
              if (captured != null) patch.launch_mid = captured;
            }
            if (!openedColl && Number.isFinite(Number(chainPos.collateralUsd)))
              patch.opened_collateral_usd = Number(chainPos.collateralUsd);
          } else if (wasOpen) {
            if (isImperialRouted) {
              // Imperial/Phoenix /positions can miss an otherwise-live position
              // for a tick, especially around WTIOIL/OIL aliasing and indexing
              // lag. A miss is not proof of an on-chain close. Preserve the DB
              // position so the card stays live and fee top-ups can keep trying.
              hasLivePosition = true;
              events.push({
                kind: "tick",
                note: "phoenix position read missed; preserving recorded position and continuing top-ups",
              });
            } else {
              hasLivePosition = false;
              externallyClosed = true;
              patch.position_opened = false;
              patch.position_size_usd = 0;
              patch.position_collateral_usd = 0;
              patch.opened_collateral_usd = 0;
              patch.launch_mid = null;
              patch.treasury_pnl_usd = 0;
              patch.pnl_high_water_usd = 0;
              events.push({
                kind: "close",
                note: "position closed/liquidated on chain. Reset state; will re-open at next fee gate.",
              });
            }
          }
        } catch (e) {
          keeperLog(t, "warn", "pre-read position failed", { error: e.message, tick_id: tickId });
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

      // Fast-path skip: for tokens with no live position, no accrued fees
      // anywhere near the open gate, and no known funded profile PDA, the
      // pre-check call to imperialGetProfile cannot produce any action this
      // tick. Skipping these saves an Imperial API call + RPC hit per token,
      // which on idle PEND-* tokens was consuming most of the tick budget
      // and starving live vaults like TREMP before the 240s watchdog fired.
      const canActThisTick =
        hasLivePosition ||
        patch.position_opened ||
        !!t.imperial_profile_pda ||
        perpFundingBudgetUsd >= Number(config.feeGateUsd ?? 50) * 0.5;

      if (
        isImperialRouted &&
        config.imperial.enabled &&
        config.imperial.depositMode !== "off" &&
        t.imperial_profile_index != null &&
        canActThisTick
      ) {
        const kind = hasLivePosition || patch.position_opened ? "topup" : "open";
        // For topup, deposit ALL accrued fees in one shot (capped at a sane
        // ceiling) instead of trickling config.topUpCollateralUsd per tick.
        // Otherwise tokens like HYPU with $354 in fees take ~17 ticks to
        // deploy. Open still uses openCollateralUsd as the target (the
        // partial-open path will cap by what's actually in the wallet).
        const topupTarget = Math.max(
          Number(config.topUpCollateralUsd) || 0,
          Number(perpFundingBudgetUsd) || 0,
        );
        const requestedUsd = kind === "open" ? config.openCollateralUsd : topupTarget;

        // ---- Pre-check: profile already has parked USDC from a prior tick.
        // If so, treat it as deposited-this-tick and skip the SOL->USDC swap +
        // /deposit/build-tx call. This recovers tokens where a previous tick
        // deposited but placeOrder failed (e.g. HYPU, PAMP) without waiting
        // for new fees to re-trigger the gate.
        try {
          const authToken = await ensureImperialAuth();
          const prof = await imperialGetProfile({
            profileIndex: t.imperial_profile_index,
            token: authToken,
          });
          if (prof?.profilePda && !t.imperial_profile_pda) {
            patch.imperial_profile_pda = prof.profilePda;
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
            imperialDepositedThisTickUsd = Math.floor(budgetedParkedUsd * 100) / 100;
            imperialFundingSource = "parked";
            console.log(
              `[imperial:deposit] ${t.ticker} ${kind} reuse parked $${imperialDepositedThisTickUsd.toFixed(2)} of $${reusableParkedUsd.toFixed(2)} in profile ${t.imperial_profile_index} (src=${parkedSource}); skipping deposit`,
            );
            events.push({
              kind: "tick",
              note: `imperial ${kind}: reuse $${imperialDepositedThisTickUsd.toFixed(2)} parked in profile ${t.imperial_profile_index} (src=${parkedSource})`,
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
          keeperLog(t, "warn", "phoenix profile pre-check failed", { error: e.message, tick_id: tickId });
        }
      }

      if (
        isImperialRouted &&
        config.imperial.enabled &&
        config.imperial.depositMode !== "off" &&
        t.imperial_profile_index != null &&
        imperialDepositedThisTickUsd === 0
      ) {
        const kind = hasLivePosition || patch.position_opened ? "topup" : "open";
        // Same scale-up rule as the pre-check above: when topping up, request
        // the full accrued fees instead of the small per-tick increment.
        const topupTarget = Math.max(
          Number(config.topUpCollateralUsd) || 0,
          Number(perpFundingBudgetUsd) || 0,
        );
        const requestedUsd = kind === "open" ? config.openCollateralUsd : topupTarget;

        // Use spendable fee budget so a brand-new claim can fund immediately,
        // but master-wallet tokens cannot spend manually-added treasury SOL.
        const gateToken = { ...t, fees_accrued_usd: perpFundingBudgetUsd };
        const gate = gateImperialFunding({ token: gateToken, kind, requestedUsd });
        if (!gate.allow) {
          console.log(`[imperial:deposit] ${t.ticker} ${kind} skip: ${gate.reason}`);
        } else if (config.imperial.depositMode === "shadow") {
          console.log(
            `[imperial:deposit:shadow] ${t.ticker} ${kind} would deposit $${gate.allowedUsd.toFixed(2)} -> profile ${t.imperial_profile_index}`,
          );
          events.push({
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
            let capacityUsd = await getWalletCapacityUsd({ kp, solUsd, rpcUrl: config.rpcUrl });
            // If on-paper fees clear the gate but the wallet is short on cash
            // (long-tail / small-fee tokens whose claimed SOL never accumulated
            // enough), advance SOL from master so the deposit can actually fund.
            // Bounded by DEPOSIT_TOPUP_MAX_USD and capped by gate.allowedUsd.
            if (capacityUsd < finalUsd) {
              const toppedUp = await topupSubForDeposit({
                kp,
                currentCapacityUsd: capacityUsd,
                targetUsd: finalUsd,
                solUsd,
                ticker: t.ticker,
              });
              if (toppedUp) {
                capacityUsd = await getWalletCapacityUsd({ kp, solUsd, rpcUrl: config.rpcUrl });
              }
            }
            if (capacityUsd < finalUsd) {
              if (capacityUsd < floor) {
                console.log(
                  `[imperial:deposit] ${t.ticker} ${kind} skip: wallet capacity $${capacityUsd.toFixed(2)} < floor $${floor} (fees $${gate.fees.toFixed(2)})`,
                );
                events.push({
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
            keeperLog(t, "warn", "phoenix wallet capacity check failed", { error: e.message, tick_id: tickId });
          }
          if (finalUsd <= 0) {
            // already logged & skipped above
          } else
            try {
              const authToken = await ensureImperialAuth();
              const r = await depositToImperialProfile({
                authToken,
                kp,
                profileIndex: t.imperial_profile_index,
                usdAmount: finalUsd,
                solUsd,
                rpcUrl: config.rpcUrl,
              });
              imperialDepositedThisTickUsd = r.depositedUsd;
              imperialFundingSource = "fresh";
              console.log(
                `[imperial:deposit] ${t.ticker} ${kind} deposited $${r.depositedUsd.toFixed(2)} -> profile ${t.imperial_profile_index} sig=${r.signature.slice(0, 16)}…`,
              );
              txLog.push(
                buildTxLogEntry({
                  kind: "imperial_deposit",
                  intent: intentHash([t.id, "imperial_deposit", bucket, finalUsd.toFixed(2)]),
                  status: "confirmed",
                  signature: r.signature,
                  amountUsd: r.depositedUsd,
                }),
              );
              events.push({
                kind: "tick",
                note: `imperial ${kind}: deposited $${r.depositedUsd.toFixed(2)} to profile ${t.imperial_profile_index}`,
                tx_sig: r.signature,
              });
              if (r.prep?.swapSig) {
                events.push({
                  kind: "tick",
                  note: `imperial pre-deposit swap: ${r.prep.solSpent?.toFixed(4) ?? "?"} SOL -> $${r.prep.usdcReceived?.toFixed(2) ?? "?"} USDC`,
                  tx_sig: r.prep.swapSig,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", `phoenix deposit ${kind} failed`, { error: e.message, tick_id: tickId, kind });
              events.push({
                kind: "tick",
                note: `phoenix deposit issue: ${e.message.slice(0, 200)}`,
              });
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
      const wfRow = workflowStateFromToken(t);
      const wfState = wfRow?.state ?? null;
      const blocksOpen = workflowBlocksOpen({
        state: wfState,
        nextRetryAt: wfRow?.next_retry_at,
        hasLivePosition,
      });
      if (blocksOpen) {
        events.push({
          kind: "tick",
          note: `open held: workflow=${wfState} (anti-double-open) — awaiting /positions index or reconcile`,
        });
      }
      if (
        !hasLivePosition &&
        !pendingSig &&
        !externallyClosed &&
        !blocksOpen &&
        (perpFundingBudgetUsd >= config.feeGateUsd || imperialFundingSource === "parked")
      ) {
        const requestedOpenColl = config.openCollateralUsd;
        // For imperial-routed tokens, deploy the ENTIRE parked balance on open
        // (not just openCollateralUsd). Funds are already inside the profile;
        // capping at $50 means high-fee attention launches (FARTCOIN, NVDA,
        // WLD) sit on $300+ of idle parked USDC while only $50 backs the
        // position. Floor by the configured open size so we still respect the
        // minimum trade size.
        const imperialAvail = isImperialRouted
          ? Math.floor(getImperialAvailableUsd() * 100) / 100
          : 0;
        const openColl = isImperialRouted
          ? (imperialAvail >= IMPERIAL_MIN_COLLATERAL_USD
              ? imperialAvail
              : Math.min(requestedOpenColl, imperialAvail))
          : requestedOpenColl;
        const sizeUsd = openColl * leverage;

        // --------- IMPERIAL OPEN BRANCH ---------
        // For imperial-routed tokens we DO NOT need wallet USDC: collateral
        // lives inside the Imperial profile. The deposit was queued in
        // step 2d above. We require an actual live deposit to have happened
        // this tick (shadow/off mode skips the open too).
        if (imperialTradeEnabled) {
          if (openColl < IMPERIAL_MIN_COLLATERAL_USD) {
            events.push({
              kind: "tick",
              note: `phoenix open deferred: available $${getImperialAvailableUsd().toFixed(2)} < min $${IMPERIAL_MIN_COLLATERAL_USD} (mode=${config.imperial.depositMode})`,
            });
          } else {
            try {
              const authToken = await ensureImperialAuth();
              const quote = await imperialQuoteIfEnabled({
                symbol: underlying,
                side,
                collateralUsd: openColl,
                leverage,
                context: "open",
              });
              // Snapshot profile USDC BEFORE the order so we can verify the
              // collateral actually attached (gmtrade refund-in-same-tx bug).
              const preUsdcUi = await readImperialProfileUsdcUi({
                profileIndex: t.imperial_profile_index,
                authToken,
                profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
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
                kp,
                profileIndex: t.imperial_profile_index,
                symbol: underlying,
                side,
                collateralUsd: openColl,
                leverage,
                venue: quote?.venue ?? undefined,
              });
              if (res.signature) {
                patch.pending_drift_sig = res.signature;
                const intent = intentHash([
                  t.id,
                  "imperial_open",
                  bucket,
                  openColl.toFixed(2),
                  side,
                  leverage,
                ]);
                txLog.push(
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
                  profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
                });
                const drained = Math.max(0, preUsdcUi - postUsdcUi);
                verifiedAttached = drained >= openColl * 0.5;
                if (!verifiedAttached) {
                  console.warn(
                    `[imperial:open] ${t.ticker} REFUND DETECTED: profile USDC ${preUsdcUi.toFixed(2)} -> ${postUsdcUi.toFixed(2)} (expected drain ~$${openColl.toFixed(2)}, got $${drained.toFixed(2)}). Order signed but venue refunded; NOT writing optimistic state. sig=${res.signature?.slice(0, 16)}…`,
                  );
                  events.push({
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
                    symbol: underlying,
                    side,
                    authToken,
                    wallet: kp.publicKey.toBase58(),
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
                  patch.position_opened = true;
                  hasLivePosition = true;
                  patch.position_size_usd = liveSize;
                  patch.position_collateral_usd = liveColl;
                  patch.opened_collateral_usd = liveColl;
                  // Let high-fee attention-market launches deploy the rest of
                  // their already-parked Imperial USDC immediately instead of
                  // waiting another keeper cycle after the first small open.
                  imperialDepositedThisTickUsd = Math.max(
                    0,
                    Math.floor((Number(imperialDepositedThisTickUsd || 0) - liveColl) * 100) / 100,
                  );
                  const entry = await resolveImperialEntryPrice({
                    verifiedPos,
                    symbol: underlying,
                    venue: quote?.venue,
                    token: t,
                  });
                  if (entry.price) patch.launch_mid = entry.price;
                  if (imperialFundingSource === "fresh" || imperialFundingSource === "parked") {
                    feesAccruedDelta -= openColl;
                  }
                  events.push({
                    kind: "open",
                    note: `[phoenix] ${config.hedgeMode}: opened ${side} ${underlying} ${leverage}x coll=$${liveColl.toFixed(2)} size=$${liveSize.toFixed(2)} profile=${t.imperial_profile_index}${verifiedPos ? "" : " (optimistic, awaiting readback)"}`,
                  });
                }
              } else if (!orderTookEffect) {
                events.push({
                  kind: "tick",
                  note: `phoenix open: ${res.error ? res.error.slice(0, 200) : "no signature returned"}`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "phoenix open failed", { error: e.message, tick_id: tickId });
              events.push({
                kind: "tick",
                note: `phoenix open issue: ${e.message.slice(0, 200)}`,
              });
            }
          }
        } else if (isExternal) {
          // External jupiter coins: externalRouters opens the position from
          // the pump.fun creator-fee sweep. Don't run the legacy loop open
          // path (it would try to swap from an empty sub-wallet and spam).
        } else {
          // --------- JUPITER (legacy) OPEN BRANCH ---------
          const freeUsdc = await getFreeCollateralUsd(kp);
          if (freeUsdc < openColl) {
            // Try to top up USDC by swapping the SOL fees sitting in the wallet.
            const rawNeed = openColl - freeUsdc + 0.5; // small buffer for slippage rounding
            const need = isSubWallet ? rawNeed : Math.min(rawNeed, Math.max(0, perpFundingBudgetUsd));
            if (!isSubWallet && need < rawNeed) {
              console.warn(
                `[loop] ${t.ticker} legacy master SOL->USDC open swap capped: $${rawNeed.toFixed(2)} -> $${need.toFixed(2)} (accrued fees only)`,
              );
            }
            try {
              const sw = await swapSolToUsdc({ wantUsdc: need, solUsd, kp });
              if (sw) {
                events.push({
                  kind: "tick",
                  note: `swapped ${sw.solSpent.toFixed(4)} SOL -> $${sw.usdcReceived.toFixed(2)} USDC for perp open (sig ${sw.swapSig.slice(0, 16)}..)`,
                  tx_sig: sw.swapSig,
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `OPEN gate hit ($${feesAccruedAfter.toFixed(2)}) but wallet USDC $${freeUsdc.toFixed(2)} < $${openColl} and insufficient SOL to swap`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "SOL->USDC swap failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `SOL->USDC swap err: ${e.message.slice(0, 200)}` });
            }
            // Defer the actual open to the next tick so the USDC balance is
            // fully visible to Jupiter perps before we sign the open tx.
          } else {
            try {
              // [imperial:shadow] log-only quote; never blocks or alters the open.
              await imperialQuoteIfEnabled({
                symbol: underlying,
                side,
                collateralUsd: openColl,
                leverage,
                context: "open",
              });
              const res = await openPosition({
                symbol: underlying,
                side,
                collateralUsd: openColl,
                sizeUsd,
                kp,
              });

              const openAccepted = !res.error && (res.signature || config.hedgeMode === "simulate");
              if (res.signature) {
                patch.pending_drift_sig = res.signature;
                const intent = intentHash([
                  t.id,
                  "perp_open",
                  bucket,
                  openColl.toFixed(2),
                  side,
                  leverage,
                ]);
                txLog.push(
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
                patch.position_opened = true;
                patch.position_size_usd = sizeUsd;
                patch.position_collateral_usd = openColl;
                patch.opened_collateral_usd = openColl;
                feesAccruedDelta -= openColl;
                events.push({
                  kind: "open",
                  note:
                    `${config.hedgeMode}: opened ${side} ${underlying} ${leverage}x coll=$${openColl} size=$${sizeUsd.toFixed(2)}` +
                    (res.simulated && !res.signature ? " [SIMULATED]" : ""),
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `open attempt failed: ${res.error ? res.error.slice(0, 200) : "no signature returned"}`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "open failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `open error: ${e.message.slice(0, 200)}` });
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
      const topupGate = config.topUpFeeGateUsd;
      // Topup fires when EITHER new fees clear the gate, there's parked
      // collateral already deposited into the profile this tick, OR the live
      // Imperial position has drifted materially below the intended leverage.
      // The last case repairs tokens where collateral attached but the size-add
      // leg failed, leaving vaults like ZCRASH at ~2x instead of ~9.5x.
      const hasParkedTopup =
        imperialTradeEnabled &&
        imperialDepositedThisTickUsd > 0 &&
        imperialDepositedThisTickUsd >= IMPERIAL_MIN_COLLATERAL_USD;
      const sizeUsdForTopupCheck = Number(patch.position_size_usd ?? t.position_size_usd ?? 0);
      const collateralUsdForTopupCheck = Number(patch.position_collateral_usd ?? t.position_collateral_usd ?? 0);
      const targetLeverageForTopupCheck = imperialTradeEnabled
        ? clampImperialLeverage(`loop:${t.ticker} ${underlying}`, Math.max(1, leverage), underlying)
        : Math.max(1, leverage);
      const currentLeverageForTopupCheck = collateralUsdForTopupCheck > 0 && sizeUsdForTopupCheck > 0
        ? sizeUsdForTopupCheck / collateralUsdForTopupCheck
        : targetLeverageForTopupCheck;
      const needsImperialSizeRepair =
        imperialTradeEnabled &&
        collateralUsdForTopupCheck >= IMPERIAL_MIN_COLLATERAL_USD &&
        sizeUsdForTopupCheck > 0 &&
        currentLeverageForTopupCheck < targetLeverageForTopupCheck - 0.25;
      if ((hasLivePosition || patch.position_opened) && !pendingSig && (perpFundingBudgetUsd >= topupGate || hasParkedTopup || needsImperialSizeRepair)) {
        const sizeUsdNow = Number(patch.position_size_usd ?? t.position_size_usd ?? 0);
        const collateralUsdNow = Number(
          patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
        );
        const targetLeverage = Math.max(1, leverage);
        const currentLeverage = collateralUsdNow > 0 && sizeUsdNow > 0
          ? Math.max(1, sizeUsdNow / collateralUsdNow)
          : targetLeverage;
        // Always pull toward the configured target leverage so add-margin
        // top-ups grow size proportionally and effective leverage doesn't
        // drift down over time (the old min(target,current) capped baseLev
        // at the depressed level and let leverage decay forever). The venue
        // cap clamp inside imperialIncreasePosition still protects us from
        // exceeding Phoenix/Flash limits on assets like HYPE.
        const baseLeverage = imperialTradeEnabled
          ? clampImperialLeverage(`loop:${t.ticker} ${underlying}`, targetLeverage, underlying)
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
        if (imperialTradeEnabled && t.imperial_profile_index != null) {
          try {
            const repairAuthToken = await ensureImperialAuth();
            liveImperialProfileUsdcUsd = await readImperialProfileUsdcUi({
              profileIndex: t.imperial_profile_index,
              authToken: repairAuthToken,
              profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
            });
            // `readImperialProfileUsdcUi` reads the profile's free USDC balance,
            // not total position margin. Deposits shown on Solscan at the profile
            // PDA are parked free USDC until an order attaches them. Do not
            // subtract already-attached collateral here, or parked top-ups like
            // LIFE's $230 never get picked up after the deposit tick.
            liveImperialFreeTopupUsd = Math.max(0, liveImperialProfileUsdcUsd);
          } catch {
            liveImperialProfileUsdcUsd = 0;
            liveImperialFreeTopupUsd = 0;
          }
        }
        const availableImperialTopupUsd = Math.floor(Math.max(
          Number(imperialDepositedThisTickUsd || 0),
          Number(liveImperialFreeTopupUsd || 0),
        ) * 100) / 100;
        console.log(
          `[imperial:topup] ${t.ticker} availableImperialTopup=$${availableImperialTopupUsd.toFixed(2)} depositedThisTick=$${Number(imperialDepositedThisTickUsd || 0).toFixed(2)} liveProfileUsdc=$${liveImperialProfileUsdcUsd.toFixed(2)} freeProfileUsdc=$${liveImperialFreeTopupUsd.toFixed(2)} repair=${needsImperialSizeRepair ? "yes" : "no"}`,
        );
        // If the live position has drifted below target leverage, DO NOT
        // attach more collateral. That is exactly how LIFE got stuck at
        // ~1x: collateral kept landing while the size leg failed. Repair
        // size first against existing venue collateral; parked USDC stays
        // parked until leverage is healthy again.
        const sizeRepairForceOnly =
          imperialTradeEnabled &&
          needsImperialSizeRepair &&
          collateralUsdNow >= IMPERIAL_MIN_COLLATERAL_USD;
        // Size-only repair: when the existing margin already covers more
        // notional at the target leverage than what's currently open, we can
        // grow size against the existing cushion (collateralAmount=0).
        // This recovers tokens like OIL where a previous topup attached
        // collateral but the size leg refunded, leaving leverage stuck low
        // with no parked USDC to fund the next repair attempt.
        const sizeOnlyRepairAvailable =
          imperialTradeEnabled &&
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
        const rawAddColl = imperialTradeEnabled
          ? (sizeRepairForceOnly ? repairAtomicAddColl : availableImperialTopupUsd)
          : Number(config.topUpCollateralUsd) || 0;
        const noDecayLeverageFloor = collateralUsdNow > 0 && sizeUsdNow > 0
          ? Math.max(1, sizeUsdNow / collateralUsdNow)
          : baseLeverage;
        const collateralCapForLeverage = (sizeRepairForceOnly ? noDecayLeverageFloor : baseLeverage) > 0
          ? SIZE_ADD_MAX_PER_TICK_USD / (sizeRepairForceOnly ? noDecayLeverageFloor : baseLeverage)
          : rawAddColl;
        const addColl = imperialTradeEnabled
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
            `[imperial:repair] ${t.ticker} ${underlying} ${side} targetGap=$${rawAddSize.toFixed(2)} cappedAddSize=$${addSize.toFixed(2)} addColl=$${addColl.toFixed(2)} leverage=${baseLeverage.toFixed(2)}x sizeOnly=${sizeOnlyRepairMode ? "yes" : "no"}`,
          );
        }
        const isAboveTarget =
          collateralUsdNow > 0 && sizeUsdNow / collateralUsdNow > baseLeverage + 0.05;


        // --------- IMPERIAL TOP-UP BRANCH ---------
        if (imperialTradeEnabled) {
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
                `[imperial:repair] ${t.ticker} ${underlying} ${side} DEFERRED: need parked USDC >= $${IMPERIAL_MIN_COLLATERAL_USD.toFixed(2)} or size cushion (have parked $${availableImperialTopupUsd.toFixed(2)}, cushion gap $${Math.max(0, collateralUsdNow * baseLeverage - sizeUsdNow).toFixed(2)}).`,
              );
            }
            events.push({
              kind: "tick",
              note: `phoenix top-up deferred: available $${availableImperialTopupUsd.toFixed(2)} < min $${IMPERIAL_MIN_COLLATERAL_USD.toFixed(2)} (mode=${config.imperial.depositMode})`,
            });
          } else {

            try {
              const authToken = await ensureImperialAuth();
              if (addColl > 0) {
                await imperialQuoteIfEnabled({
                  symbol: underlying,
                  side,
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
                profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
              });
              let res = isAboveTarget
                ? await imperialAddCollateralToPosition({
                    authToken,
                    kp,
                    profileIndex: t.imperial_profile_index,
                    symbol: underlying,
                    side,
                    addCollateralUsd: addColl,
                  })
                : await imperialIncreasePosition({
                    authToken,
                    kp,
                    profileIndex: t.imperial_profile_index,
                    symbol: underlying,
                    side,
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
                  events.push({
                    kind: "tick",
                    note: `phoenix top-up retry: sizing from current ${relaxedLeverage.toFixed(2)}x leverage after target-size rejection`,
                  });
                  res = await imperialIncreasePosition({
                    authToken,
                    kp,
                    profileIndex: t.imperial_profile_index,
                    symbol: underlying,
                    side,
                    addSizeUsd: relaxedAddSize,
                    addCollateralUsd: 0,
                    orderCollateralUsd: addColl,
                    attachCollateralBeforeSize: false,
                    leverage: relaxedLeverage,
                  });
                }
              }
              if (res.signature && !res.error) patch.pending_drift_sig = res.signature;
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
                  profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
                });
                const drained = Math.max(0, preUsdcUi - postUsdcUi);
                verifiedAttached = drained >= addColl * 0.5;
                if (!verifiedAttached) {
                  console.warn(
                    `[imperial:topup] ${t.ticker} REFUND DETECTED: profile USDC ${preUsdcUi.toFixed(2)} -> ${postUsdcUi.toFixed(2)} (expected drain ~$${addColl.toFixed(2)}, got $${drained.toFixed(2)}). Order signed but venue refunded; NOT writing optimistic state. sig=${res.signature?.slice(0, 16)}…`,
                  );
                  events.push({
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
                    symbol: underlying,
                    side,
                    authToken,
                    wallet: kp.publicKey.toBase58(),
                  });
                }
                if (false && !(Number(verifiedPos?.sizeUsd ?? 0) > sizeUsdNow + 0.01)) {
                  console.warn(
                    `[imperial:topup] ${t.ticker} size repair signed but size did not increase yet; NOT writing optimistic size. sig=${res.signature?.slice(0, 16)}…`,
                  );
                  events.push({
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
                  patch.position_size_usd = newSize;
                  patch.position_collateral_usd = newColl;
                  const entry = await resolveImperialEntryPrice({
                    verifiedPos,
                    symbol: underlying,
                    token: t,
                  });
                  if (!(Number(t.launch_mid ?? 0) > 0) && entry.price) patch.launch_mid = entry.price;
                  optimisticImperialPositionState = true;
                  if (imperialFundingSource === "fresh" || imperialFundingSource === "parked") {
                    const consumed = Math.min(addColl, Math.max(0, feesAccruedAfter));
                    feesAccruedDelta -= consumed;
                  }
                  events.push({
                    kind: "tick",
                    note: `[phoenix] top-up ${side} ${underlying}: ${verifiedPos ? "live" : "optimistic"} coll=$${newColl.toFixed(2)}, size=$${newSize.toFixed(2)} @${baseLeverage.toFixed(1)}x (src=${imperialFundingSource}${res.sizeDeferred ? ", size deferred" : ""})`,
                  });
                }
              } else if (res.error) {
                events.push({
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
                if (
                  !isAboveTarget &&
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
                      kp,
                      profileIndex: t.imperial_profile_index,
                      symbol: underlying,
                      side,
                      addCollateralUsd: fallbackBindUsd,
                    });
                    if (bindRes?.signature && !bindRes?.error) {
                      await new Promise((r) => setTimeout(r, 2500));
                      const postBindUi = await readImperialProfileUsdcUi({
                        profileIndex: t.imperial_profile_index,
                        authToken,
                        profilePda: patch.imperial_profile_pda ?? t.imperial_profile_pda,
                      });
                      const bindDrained = Math.max(0, preBindUi - postBindUi);
                      if (bindDrained >= fallbackBindUsd * 0.5) {
                        patch.position_collateral_usd = collateralUsdNow + bindDrained;
                        patch.pending_drift_sig = bindRes.signature;
                        optimisticImperialPositionState = true;
                        if (imperialFundingSource === "fresh" || imperialFundingSource === "parked") {
                          const consumed = Math.min(bindDrained, Math.max(0, feesAccruedAfter));
                          feesAccruedDelta -= consumed;
                        }
                        events.push({
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
                      events.push({
                        kind: "tick",
                        note: `phoenix attach-only fallback failed: ${String(bindRes.error).slice(0, 160)}`,
                      });
                    }
                  } catch (bindErr) {
                    keeperLog(t, "warn", "phoenix attach-only fallback threw", {
                      error: bindErr.message,
                      tick_id: tickId,
                    });
                  }
                }
              }
            } catch (e) {
              keeperLog(t, "warn", "phoenix top-up failed", { error: e.message, tick_id: tickId });
              events.push({
                kind: "tick",
                note: `phoenix top-up issue: ${e.message.slice(0, 200)}`,
              });
            }
          }
        } else if (isExternal) {
          // External (pump.fun) tokens on jupiter route are funded directly
          // by externalRouters at sweep time (external_perp leg). The legacy
          // jupiter top-up gate below would just spam "insufficient SOL"
          // every tick because the sub-wallet is intentionally drained after
          // each split. Skip silently.
        } else {
          // --------- JUPITER (legacy) TOP-UP BRANCH ---------
          const freeUsdc = await getFreeCollateralUsd(kp);
          if (freeUsdc < addColl) {
            const rawNeed = addColl - freeUsdc + 0.5;
            const need = isSubWallet ? rawNeed : Math.min(rawNeed, Math.max(0, perpFundingBudgetUsd));
            if (!isSubWallet && need < rawNeed) {
              console.warn(
                `[loop] ${t.ticker} legacy master SOL->USDC top-up swap capped: $${rawNeed.toFixed(2)} -> $${need.toFixed(2)} (accrued fees only)`,
              );
            }
            try {
              const sw = await swapSolToUsdc({ wantUsdc: need, solUsd, kp });
              if (sw) {
                events.push({
                  kind: "tick",
                  note: `swapped ${sw.solSpent.toFixed(4)} SOL -> $${sw.usdcReceived.toFixed(2)} USDC for perp top-up (sig ${sw.swapSig.slice(0, 16)}..)`,
                  tx_sig: sw.swapSig,
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `top-up gate hit ($${feesAccruedAfter.toFixed(2)}/${topupGate}) but wallet USDC $${freeUsdc.toFixed(2)} < $${addColl.toFixed(2)} and insufficient SOL to swap`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "top-up SOL->USDC swap failed", { error: e.message, tick_id: tickId });
              events.push({
                kind: "tick",
                note: `top-up SOL->USDC swap err: ${e.message.slice(0, 200)}`,
              });
            }
          } else {
            try {
              await imperialQuoteIfEnabled({
                symbol: underlying,
                side,
                collateralUsd: addColl,
                leverage: baseLeverage,
                context: "topup",
              });
              const res = isAboveTarget
                ? await topUpCollateral({ symbol: underlying, side, addCollateralUsd: addColl, kp })
                : await increasePosition({
                    symbol: underlying,
                    side,
                    addSizeUsd: addSize,
                    addCollateralUsd: addColl,
                    kp,
                  });

              const topUpAccepted =
                !res.error && (res.signature || config.hedgeMode === "simulate");
              if (res.signature) patch.pending_drift_sig = res.signature;
              if (topUpAccepted) {
                const newSize = sizeUsdNow + addSize;
                const newColl = currentColl + addColl;
                patch.position_size_usd = newSize;
                patch.position_collateral_usd = newColl;
                feesAccruedDelta -= topupGate;
                reserveDelta += Math.max(0, topupGate - addColl);
                events.push({
                  kind: "tick",
                  note: isAboveTarget
                    ? `deleveraging top-up ${side} ${underlying}: +$${addColl.toFixed(2)} coll, +$0.00 size until back to ${baseLeverage.toFixed(1)}x`
                    : `top-up ${side} ${underlying}: +$${addColl.toFixed(2)} coll, +$${addSize.toFixed(2)} size @${baseLeverage.toFixed(1)}x` +
                      (res.simulated && !res.signature ? " [SIMULATED]" : "") +
                      (res.error ? ` ERR: ${res.error.slice(0, 150)}` : ""),
                });
              } else if (res.error) {
                events.push({ kind: "tick", note: `top-up err: ${res.error.slice(0, 200)}` });
              }
            } catch (e) {
              keeperLog(t, "warn", "top-up failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `top-up error: ${e.message.slice(0, 200)}` });
            }
          }
        }
      }

      // ---- 5. PnL trigger + buyback+burn ----
      let pnlNow = Number(t.treasury_pnl_usd ?? 0);
      let newHighWater = Number(t.pnl_high_water_usd ?? 0);
      let collAfter = patch.position_collateral_usd ?? currentColl;

      if ((hasLivePosition || patch.position_opened) && !pendingSig) {
        let pos = chainPos;
        if (!pos && patch.position_opened) {
          try {
            if (isImperialRouted) {
              pos = await imperialReadPosition({
                profileIndex: t.imperial_profile_index,
                symbol: underlying,
                side,
                token: await ensureImperialAuth().catch(() => null),
                wallet: kp.publicKey.toBase58(),
              });
            } else {
              pos = await readPerpPosition({ symbol: underlying, side, kp });
            }
          } catch (e) {
            keeperLog(t, "warn", "readPos failed", { error: e.message, tick_id: tickId });
          }
        }

        if (pos) {
          if (isImperialRouted) {
            const liveMark = await readImperialLiveMarkUsd(underlying);
            if (liveMark) pos.markPriceUsd = liveMark;
          }
          const cAfter = Number(pos.collateralUsd);
          if (Number.isFinite(cAfter) && !optimisticImperialPositionState) {
            collAfter = cAfter;
            patch.position_collateral_usd = collAfter;
          }
          const sUsd = Number(pos.sizeUsd);
          if (Number.isFinite(sUsd) && !optimisticImperialPositionState)
            patch.position_size_usd = sUsd;

          // Imperial blends avgEntryPrice on every add-margin/add-size which collapses
          // their reported unrealizedPnlUsd toward zero. We preserve the ORIGINAL entry
          // in launch_mid (never overwrite after open) and compute PnL ourselves from
          // mark vs original entry. This matches what Imperial's UI actually displays.
          const origEntry = Number(t.launch_mid ?? 0);
          const markPx = Number(pos.markPriceUsd);
          const sizeForPnl = Number.isFinite(sUsd) && sUsd > 0 ? sUsd : Number(t.position_size_usd ?? 0);
          if (isImperialRouted && origEntry > 0 && Number.isFinite(markPx) && markPx > 0 && sizeForPnl > 0) {
            const dirSign = side === "short" ? -1 : 1;
            pnlNow = ((markPx - origEntry) / origEntry) * sizeForPnl * dirSign;
          } else if (Number.isFinite(Number(pos.unrealizedPnlUsd))) {
            pnlNow = Number(pos.unrealizedPnlUsd);
          }

          // Set launch_mid ONLY on first open (when we have no entry yet)
          if (isImperialRouted && !(origEntry > 0) && Number.isFinite(Number(pos.entryPriceUsd)) && Number(pos.entryPriceUsd) > 0) {
            patch.launch_mid = Number(pos.entryPriceUsd);
          }
        }
        if (!Number.isFinite(pnlNow)) pnlNow = Number(t.treasury_pnl_usd ?? 0) || 0;
        const gainAboveHigh = pnlNow - newHighWater;
        const prevPnl = Number(t.treasury_pnl_usd ?? 0) || 0;
        const pnlDelta = Number.isFinite(pnlNow - prevPnl) ? pnlNow - prevPnl : 0;
        events.push({
          kind: "tick",
          mid:
            pos && Number.isFinite(Number(pos.markPriceUsd)) ? Number(pos.markPriceUsd) : undefined,
          pnl_delta_usd: pnlDelta,
          note: `pnl=$${pnlNow.toFixed(2)} hw=$${newHighWater.toFixed(2)} coll=$${collAfter.toFixed(2)} reserve=$${(currentReserve + reserveDelta).toFixed(2)}`,
        });

        // ─── BACKSTOP TP (safety patch — see plan/KEEPER_TP_SAFETY_PATCH.md) ───
        // Fires when the regular TP path has fallen behind and PnL has grown
        // past backstopRatio × collateral. Always uses partial-close (Mode A)
        // because the regular path likely failed due to a withdraw bug —
        // falling back to the same withdraw path here would also fail.
        let backstopFired = false;
        const backstopPnlRatio = collAfter > 0 ? pnlNow / collAfter : 0;
        if (pnlNow > 0 && backstopPnlRatio >= config.backstopRatio) {
          // TP policy: realize 50% of current unrealized PnL, snapped to $5.
          // No per-tick cap here: a cap silently turns a real +$5k winner into
          // a tiny $500 shave and fails the vault's stated 50% profit-slice rule.
          let backstopSlice = pnlNow * 0.5;
          backstopSlice = Math.floor(backstopSlice / 5) * 5; // snap to $5
          if (backstopSlice >= config.pnlTriggerUsd) {
            const sizeUsd = patch.position_size_usd ?? Number(t.position_size_usd ?? 0);
            const closeSizeUsd = closeSizeForRealizedPnl({
              desiredPnlUsd: backstopSlice,
              pnlUsd: pnlNow,
              sizeUsd,
            });
            const realizedPnlUsd = sizeUsd > 0 ? pnlNow * (closeSizeUsd / sizeUsd) : 0;
            try {
              const res = imperialFullTrade
                ? await imperialPartialClose({
                    authToken: await ensureImperialAuth(),
                    kp,
                    profileIndex: t.imperial_profile_index,
                    symbol: underlying,
                    side,
                    reduceSizeUsd: closeSizeUsd,
                    currentSizeUsd: sizeUsd,
                    positionId: pos?.positionPda || t.imperial_profile_pda || undefined,
                  })
                : imperialTradeEnabled
                  ? {
                      signature: null,
                      simulated: false,
                      error: `imperial backstop blocked: positionMode=${config.imperial.positionMode}`,
                    }
                  : await partialClose({
                      symbol: underlying,
                      side,
                      reduceSizeUsd: closeSizeUsd,
                      kp,
                    });
              const realSignature = isRealSolanaSignature(res.signature);
              const accepted = !res.error && (config.hedgeMode !== "live" || realSignature || res.verifiedVia === "positions");
              if (realSignature) {
                patch.pending_drift_sig = res.signature;
                txLog.push(
                  buildTxLogEntry({
                    kind: "drift_adjust",
                    intent: intentHash([t.id, "backstop_tp", bucket, backstopSlice.toFixed(2)]),
                    status: "pending",
                    signature: res.signature,
                    amountUsd: realizedPnlUsd,
                  }),
                );
              }
              if (accepted) {
                const actualCloseSizeUsd = Number(res.appliedReduceSizeUsd ?? closeSizeUsd);
                patch.position_size_usd = Math.max(0, sizeUsd - actualCloseSizeUsd);
                const frac = sizeUsd > 0 ? actualCloseSizeUsd / sizeUsd : 0;
                patch.position_collateral_usd = collAfter * (1 - frac);
                // ratchet high-water forward to post-close PnL so regular TP
                // doesn't immediately re-fire on the residual gain
                newHighWater = pnlNow * (1 - frac);
                // Profit split (mirror regular TP): 75% -> buyback reserve,
                // 25% -> master treasury via USDC->SOL swap.
                let backstopMasterShareUsd = 0;
                if (config.hedgeMode === "live" && buybackMint) {
                  backstopMasterShareUsd = Math.max(0, realizedPnlUsd * 0.25);
                  const backstopBuybackShareUsd = Math.max(0, realizedPnlUsd - backstopMasterShareUsd);
                  reserveDelta += backstopBuybackShareUsd;
                  events.push({
                    kind: "buyback",
                    pnl_delta_usd: realizedPnlUsd,
                    note: `backstop split: $${backstopBuybackShareUsd.toFixed(2)} (75%) -> buyback reserve, $${backstopMasterShareUsd.toFixed(2)} (25%) -> master treasury`,
                  });
                  if (backstopMasterShareUsd >= 1) {
                    try {
                      // imperial partial-close settles inside the profile; non-imperial
                      // partial-close settles in the sub-wallet. Withdraw only for imperial.
                      if (imperialFullTrade) {
                        await imperialWithdrawCollateral({
                          authToken: await ensureImperialAuth(),
                          kp,
                          profileIndex: t.imperial_profile_index,
                          withdrawUsd: backstopMasterShareUsd,
                          rpcUrl: config.rpcUrl,
                        });
                      }
                      const sw = await swapUsdcToSol({ wantUsd: backstopMasterShareUsd, solUsd, kp });
                      if (sw && sw.solReceived > 0) {
                        const lamports = Math.floor(sw.solReceived * 1e9) - 5_000;
                        if (lamports > 0) {
                          const tx = new Transaction().add(
                            SystemProgram.transfer({
                              fromPubkey: kp.publicKey,
                              toPubkey: tre().publicKey,
                              lamports,
                            }),
                          );
                          const sig = await sendAndConfirmTransaction(conn(), tx, [kp], {
                            commitment: "confirmed",
                          });
                          const sentSol = lamports / 1e9;
                          events.push({
                            kind: "skim",
                            sol_amount: sentSol,
                            tx_sig: sig,
                            pnl_delta_usd: backstopMasterShareUsd,
                            note: `backstop profit split: ${sentSol.toFixed(6)} SOL ($${backstopMasterShareUsd.toFixed(2)}) -> master treasury`,
                          });
                        }
                      }
                    } catch (e) {
                      keeperLog(t, "warn", "backstop master-share route", {
                        error: e.message,
                        tick_id: tickId,
                      });
                      events.push({
                        kind: "tick",
                        note: `backstop master-share pending: ${e.message.slice(0, 160)}`,
                      });
                    }
                  }
                }
                backstopFired = true;
                keeperLog(t, "info", "backstop_tp fired", {
                  pnl_now: pnlNow,
                  coll_after: collAfter,
                  pnl_ratio: backstopPnlRatio,
                  desired_pnl_usd: backstopSlice,
                  close_size_usd: closeSizeUsd,
                  realized_pnl_usd: realizedPnlUsd,
                  tick_id: tickId,
                });
                events.push({
                  kind: "buyback",
                  pnl_delta_usd: realizedPnlUsd,
                  note:
                    `${imperialFullTrade ? "[imperial] " : ""}BACKSTOP TP realize $${realizedPnlUsd.toFixed(2)} by closing $${closeSizeUsd.toFixed(2)} size ` +
                    `(pnl=$${pnlNow.toFixed(0)} / coll=$${collAfter.toFixed(0)} = ${(backstopPnlRatio * 100).toFixed(0)}%)` +
                    (res.simulated && !res.signature ? " [SIMULATED]" : ""),
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `backstop_tp not accepted: ${res.error ? res.error.slice(0, 150) : "no signature returned"}`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "backstop_tp failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `backstop_tp err: ${e.message.slice(0, 150)}` });
            }
          }
        }
        // ─── end backstop TP ───

        if (!backstopFired && gainAboveHigh >= config.pnlTriggerUsd) {
          const sizeUsd = patch.position_size_usd ?? Number(t.position_size_usd ?? 0);
          // Anchor cap to creator's chosen leverage (NOT sizeNow/openedColl,
          // which compounds with every top-up and effectively disables the cap).
          const baseLeverage = Math.max(1, leverage);
          const levCap = baseLeverage * config.leverageCapMult;
          // Maximum collateral we can pull while keeping effective lev <= cap.
          const minCollAtCap = levCap > 0 ? sizeUsd / levCap : 0;
          const maxWithdrawByLev = Math.max(0, collAfter - minCollAtCap);
          // TP policy: realize at most 50% of current unrealized PnL per fire.
          // The leverage/withdraw caps below further restrict, but we never
          // exceed 50% even if the backlog (gainAboveHigh) is larger.
          const halfPnl = Math.max(0, pnlNow * 0.5);
          const realizeRaw = Math.min(gainAboveHigh, halfPnl, maxWithdrawByLev, config.pnlRealizeMaxUsd);
          let realizeUsd = Math.floor(realizeRaw / 5) * 5;
          // Floor at pnlTriggerUsd so the partial-close branch below still fires
          // when lev cap is already breached (realizeRaw < trigger via lev path).
          if (realizeUsd < config.pnlTriggerUsd) realizeUsd = config.pnlTriggerUsd;
          const wouldBeColl = collAfter - realizeUsd;
          const wouldBeLev = wouldBeColl > 0 ? sizeUsd / wouldBeColl : Infinity;

          let realized = false;
          if (!imperialFullTrade && wouldBeLev <= levCap && wouldBeColl > 0) {
            // (b) collateral withdrawal path — keeps size
            try {
              const res = imperialFullTrade
                ? await imperialWithdrawCollateral({
                    authToken: await ensureImperialAuth(),
                    kp,
                    profileIndex: t.imperial_profile_index,
                    withdrawUsd: realizeUsd,
                    rpcUrl: config.rpcUrl,
                  })
                : imperialTradeEnabled
                  ? {
                      signature: null,
                      simulated: false,
                      error: `phoenix withdraw paused: positionMode=${config.imperial.positionMode}`,
                    }
                  : await withdrawCollateral({
                      symbol: underlying,
                      side,
                      withdrawUsd: realizeUsd,
                      kp,
                    });
              const realSignature = isRealSolanaSignature(res.signature);
              const accepted = !res.error && (config.hedgeMode !== "live" || realSignature || res.verifiedVia === "positions");
              if (realSignature) {
                patch.pending_drift_sig = res.signature;
                txLog.push(
                  buildTxLogEntry({
                    kind: "drift_adjust",
                    intent: intentHash([t.id, "pnl_withdraw", bucket, realizeUsd.toFixed(2)]),
                    status: "pending",
                    signature: res.signature,
                    amountUsd: realizeUsd,
                  }),
                );
              }
              if (accepted) {
                patch.position_collateral_usd = wouldBeColl;
                realized = true;
                events.push({
                  kind: "tick",
                  note:
                    `${imperialFullTrade ? "[imperial] " : ""}withdraw $${realizeUsd} collateral (lev ${(sizeUsd / wouldBeColl).toFixed(1)}x within cap ${levCap.toFixed(1)}x)` +
                    (res.simulated && !res.signature ? " [SIMULATED]" : ""),
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `withdraw not accepted: ${res.error ? res.error.slice(0, 150) : "no signature returned"}`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "withdraw failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `withdraw err: ${e.message.slice(0, 150)}` });
            }
          } else {
            // (a) partial-close path — leverage cap reached
            const closeSizeUsd = closeSizeForRealizedPnl({
              desiredPnlUsd: realizeUsd,
              pnlUsd: pnlNow,
              sizeUsd,
            });
            const realizedPnlUsd = sizeUsd > 0 ? pnlNow * (closeSizeUsd / sizeUsd) : 0;
            try {
              const res = imperialFullTrade
                ? await imperialPartialClose({
                    authToken: await ensureImperialAuth(),
                    kp,
                    profileIndex: t.imperial_profile_index,
                    symbol: underlying,
                    side,
                    reduceSizeUsd: closeSizeUsd,
                    currentSizeUsd: sizeUsd, // needed so full-close snaps notional exactly
                    positionId: pos?.positionPda || t.imperial_profile_pda || undefined,
                  })
                : imperialTradeEnabled
                  ? {
                      signature: null,
                      simulated: false,
                      error: `imperial partial-close blocked: positionMode=${config.imperial.positionMode}`,
                    }
                  : await partialClose({ symbol: underlying, side, reduceSizeUsd: closeSizeUsd, kp });
              const realSignature = isRealSolanaSignature(res.signature);
              const accepted = !res.error && (config.hedgeMode !== "live" || realSignature || res.verifiedVia === "positions");
              if (realSignature) {
                patch.pending_drift_sig = res.signature;
                txLog.push(
                  buildTxLogEntry({
                    kind: "drift_adjust",
                    intent: intentHash([t.id, "pnl_partial_close", bucket, realizeUsd.toFixed(2)]),
                    status: "pending",
                    signature: res.signature,
                    amountUsd: realizedPnlUsd,
                  }),
                );
              }
              if (accepted) {
                const actualCloseSizeUsd = Number(res.appliedReduceSizeUsd ?? closeSizeUsd);
                patch.position_size_usd = Math.max(0, sizeUsd - actualCloseSizeUsd);
                // Imperial reduces collateral proportionally on partial close.
                // Mirror that in the patch so effective leverage stays at target
                // and next tick's repair check doesn't see a fake low-lev gap
                // before the venue read reconciles.
                const frac = sizeUsd > 0 ? actualCloseSizeUsd / sizeUsd : 0;
                patch.position_collateral_usd = collAfter * (1 - frac);
                realizeUsd = realizedPnlUsd;
                realized = true;
                events.push({
                  kind: "tick",
                  note:
                    `${imperialFullTrade ? "[imperial] " : ""}partial-close $${closeSizeUsd.toFixed(2)} size to realize $${realizedPnlUsd.toFixed(2)} (lev guard: would be ${wouldBeLev.toFixed(1)}x > cap ${levCap.toFixed(1)}x)` +
                    (res.simulated && !res.signature ? " [SIMULATED]" : ""),
                });
              } else {
                events.push({
                  kind: "tick",
                  note: `partial-close not accepted: ${res.error ? res.error.slice(0, 150) : "no signature returned"}`,
                });
              }
            } catch (e) {
              keeperLog(t, "warn", "partial close failed", { error: e.message, tick_id: tickId });
              events.push({ kind: "tick", note: `partial close err: ${e.message.slice(0, 150)}` });
            }
          }

          // Profit split (TP path only): 75% to buyback+burn reserve,
          // 25% routed to the master treasury wallet as SOL.
          // Master share flow: ensure USDC is in sub-wallet (withdraw if
          // partial-close path settled inside imperial profile), swap
          // USDC -> SOL via Jupiter, transfer SOL to master.
          if (realized && buybackMint) {
            if (config.hedgeMode === "live") {
              const masterShareUsd = Math.max(0, realizeUsd * 0.25);
              const buybackShareUsd = Math.max(0, realizeUsd - masterShareUsd);
              reserveDelta += buybackShareUsd;
              newHighWater = pnlNow;
              events.push({
                kind: "buyback",
                pnl_delta_usd: gainAboveHigh,
                note: `queued realized $${buybackShareUsd.toFixed(2)} (75%) for buyback+burn, $${masterShareUsd.toFixed(2)} (25%) -> master treasury`,
              });

              if (masterShareUsd >= 1) {
                try {
                  // Partial-close path settles USDC inside imperial profile,
                  // so withdraw the master share to the sub-wallet first.
                  // (Withdraw path already deposited the full realizeUsd into
                  // the sub-wallet, so no extra withdraw is needed there.)
                  const realizedInSubWallet = !imperialFullTrade && wouldBeLev <= levCap && wouldBeColl > 0;
                  if (!realizedInSubWallet) {
                    await imperialWithdrawCollateral({
                      authToken: await ensureImperialAuth(),
                      kp,
                      profileIndex: t.imperial_profile_index,
                      withdrawUsd: masterShareUsd,
                      rpcUrl: config.rpcUrl,
                    });
                  }
                  const sw = await swapUsdcToSol({ wantUsd: masterShareUsd, solUsd, kp });
                  if (sw && sw.solReceived > 0) {
                    const lamports = Math.floor(sw.solReceived * 1e9) - 5_000; // leave gas
                    if (lamports > 0) {
                      const tx = new Transaction().add(
                        SystemProgram.transfer({
                          fromPubkey: kp.publicKey,
                          toPubkey: tre().publicKey,
                          lamports,
                        }),
                      );
                      const sig = await sendAndConfirmTransaction(conn(), tx, [kp], {
                        commitment: "confirmed",
                      });
                      const sentSol = lamports / 1e9;
                      events.push({
                        kind: "skim",
                        sol_amount: sentSol,
                        tx_sig: sig,
                        pnl_delta_usd: masterShareUsd,
                        note: `tp profit split: ${sentSol.toFixed(6)} SOL ($${masterShareUsd.toFixed(2)}) -> master treasury`,
                      });
                    }
                  }
                } catch (e) {
                  keeperLog(t, "warn", "tp master-share route", {
                    error: e.message,
                    tick_id: tickId,
                  });
                  events.push({
                    kind: "tick",
                    note: `tp master-share pending: ${e.message.slice(0, 160)}`,
                  });
                }
              }
            } else {
              events.push({
                kind: "tick",
                note: `[${config.hedgeMode}] would buyback+burn $${realizeUsd} (skipped: hedge mode not live)`,
              });
              newHighWater = pnlNow; // advance high-water to avoid retrigger loop in sim
            }
          }
        }
      }

      // ---- 6. (removed) graduation drain ----
      // Previously this drained buyback_reserve_usd via buyback+burn after
      // graduation. Removed: buybacks should only come from realized PnL on
      // the perp position (step 5). Any accumulated reserve stays parked.
      const reserveAfter = Math.max(0, currentReserve + reserveDelta);
      const reserveDrainDelta = 0;
      void reserveAfter;

      // ---- accrue not-yet-at-gate report ----
      if (!wasOpen && !patch.position_opened && feesAccruedDelta > 0) {
        events.push({
          kind: "tick",
          note: `accruing $${feesAccruedAfter.toFixed(2)}/${config.feeGateUsd} to gate`,
        });
      }

      patch.treasury_pnl_usd = Number.isFinite(pnlNow) ? pnlNow : 0;
      patch.pnl_high_water_usd = Number.isFinite(newHighWater) ? newHighWater : 0;
      patch.fees_accrued_usd_delta = feesAccruedDelta || undefined;
      patch.buyback_reserve_usd_delta = reserveDelta + reserveDrainDelta || undefined;
      patch.treasury_sol_delta = treasurySolDelta || undefined;
      patch.tokens_burned_delta = tokensBurnedDelta || undefined;
      patch.events = events;
      patch.tx_log = txLog;
      const blockedReason = blockedReasonFromEvents(events);
      const wfPatch = workflowPatch(t, patch, {
        blockedReason,
        claimedFeesUsd: claimedSolUsd,
        feesAccruedAfter: feesBefore + feesAccruedDelta,
        buybackReserveUsd: Number(t.buyback_reserve_usd ?? 0) + reserveDelta,
        imperialDepositedThisTickUsd,
        imperialDepositedUsd: patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
        positionEntryPrice: patch.launch_mid ?? t.launch_mid ?? undefined,
        positionEntrySource: patch.launch_mid ? "imperial" : t.launch_mid ? "reconciled" : null,
        positionSizeUsd: patch.position_size_usd ?? t.position_size_usd ?? 0,
        positionCollateralUsd: patch.position_collateral_usd ?? t.position_collateral_usd ?? 0,
      });
      queueWorkflow(wfPatch);
      if (blockedReason) {
        tokenLog(t, "workflow", "token blocked by keeper gate", {
          blocked_reason: blockedReason,
        });
      }
      tickClaimedUsd += claimedSolUsd || 0;
      // One structured per-token record for the whole tick (KEEPER_OBSERVABILITY.md).
      tokenTickSummary(tickId, t, {
        state: wfPatch?.state ?? null,
        actions: txLog.map((x) => x.kind),
        claimed_usd: num2(claimedSolUsd),
        reserve_delta_usd: num2(reserveDelta),
        tokens_burned_delta: tokensBurnedDelta || 0,
        treasury_delta_sol: num2(treasurySolDelta, 6),
        blocked_reason: blockedReason ?? null,
        entry_mid: num2(patch.launch_mid ?? t.launch_mid, 8) || null,
        events: events.length,
        duration_ms: Date.now() - tStart,
      });
      reports.push(sanitizeReportPatch(patch));
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
