// Imperial Exchange trade primitives.
//
// Mirrors the public surface of jupiterPerps.js so loop.js can branch on
// `t.router === 'imperial'` with a one-line swap per call site:
//
//   imperialReadPosition({ profileIndex, symbol, side, token, wallet })
//     -> { sizeUsd, collateralUsd, side, entryPriceUsd, markPriceUsd, unrealizedPnlUsd, raw }
//
//   imperialOpenPosition({ authToken, kp, profileIndex, symbol, side, collateralUsd, leverage, slippageBps })
//     -> { signature, simulated, error }     (matches Jupiter shape)
//
//   imperialIncreasePosition({ authToken, kp, profileIndex, symbol, side, addSizeUsd, addCollateralUsd, leverage, slippageBps, solUsd, rpcUrl })
//     -> { signature, simulated, error, depositPrep? }
//   imperialTopUpMargin({ authToken, kp, profileIndex, addCollateralUsd, solUsd, rpcUrl })
//     -> { signature, simulated, error }     (pure deposit, no size change)
//
//   imperialPartialClose({ authToken, kp, profileIndex, symbol, side, reduceSizeUsd, slippageBps })
//     -> { signature, simulated, error }     (reduce-only opposite-side order)
//
//   imperialWithdrawCollateral({ authToken, kp, profileIndex, withdrawUsd, rpcUrl })
//     -> { signature, simulated, error }     (sends USDC back to sub-wallet)
//
// IMPORTANT — verified surfaces vs. assumptions:
//
//   VERIFIED (already in imperial.js / imperialDeposit.js):
//     - /mobile/balances        -> profile USDC balance
//     - /positions?walletAddress -> open positions across profiles
//     - /deposit/build-tx { mode: 'deposit' } -> deposit USDC to profile
//     - /mobile/orders          -> place order via placeOrder()
//
//   ASSUMED (best-effort, marked _TODO_VERIFY_):
//     - /deposit/build-tx { mode: 'withdraw' } parallels the deposit shape.
//       If Imperial uses a different path (e.g. /withdraw/build-tx), change
//       WITHDRAW_PATH + WITHDRAW_MODE below.
//     - /mobile/orders accepts { reduceOnly: true } for partial-close.
//     - /positions dataList entries expose sizeUsd / collateralUsd / pnlUsd /
//       markPrice / entryPrice / side / symbol / profileIndex. We do
//       defensive multi-key lookup so minor field-name differences don't break
//       reads.
//
// Trade actions are gated by config.imperial.positionMode:
//   'off'       -> every fn throws (loop.js should not call us)
//   'open-only' -> open + topup margin allowed; withdraw/partial-close throw
//   'full'      -> all actions allowed

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { config } from './config.js';
import {
  getPositions,
  getProfile,
  placeOrder,
  resolveMarket,
  getMarkPrice,
  getMarkPriceUi,
  marketSymbol,
  isSupportedMarket,
  MIN_COLLATERAL_USD,
  SUPPORTED_MARKETS,
  ensurePhoenixRegistered,
} from './imperial.js';
import { ensureUsdcForDeposit, depositToImperialProfile } from './imperialDeposit.js';
import { SUPPORTED_SYMBOLS } from './jupiterPerps.js';
import { pickEntryMid } from './pnl.js';
import { withRetry } from './rateLimiter.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

// _TODO_VERIFY_: confirm withdraw endpoint + mode token with Imperial team.
// Current best guess parallels /deposit/build-tx { mode: 'deposit' }.
const WITHDRAW_PATH = '/deposit/build-tx';
const WITHDRAW_MODE = 'withdraw';

function usdToBase(usd) {
  return Math.max(0, Math.round(Number(usd) * 10 ** USDC_DECIMALS));
}

function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function num(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePositionSide(value) {
  if (value === 0 || value === '0') return 'long';
  if (value === 1 || value === '1') return 'short';
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'long' || raw === 'buy') return 'long';
  if (raw === 'short' || raw === 'sell') return 'short';
  return raw;
}

function assertTradeMode(action) {
  const mode = config.imperial.positionMode;
  if (mode === 'off') {
    throw new Error(`phoenix trade blocked: positionMode=off (action=${action})`);
  }
  if (mode === 'open-only' && (action === 'withdraw' || action === 'partial_close')) {
    throw new Error(`phoenix trade blocked: positionMode=open-only forbids ${action}`);
  }
  if (!['open-only', 'full'].includes(mode)) {
    throw new Error(`phoenix trade blocked: positionMode=${mode}`);
  }
}

// --- Leverage clamp ---
//
// Imperial/Phoenix rejects orders with desiredLeverage at or above each
// market's hard cap (e.g. ZEC ~9.96x). The keeper's configured leverage
// (often 10x) is just a target; we MUST shave it under the venue cap or
// /mobile/orders fails with "Leverage 10x exceeds Phoenix cap of 9.96x".
//
// Default ceiling is 9.5. Phoenix accepts "10x" markets only below the hard
// cap, and keeping every 10x Imperial order at 9.5x prevents leverage drift.
// Override with env IMPERIAL_MAX_LEVERAGE if a venue allows more.
// Global fallback for unknown markets. Per-market caps come from
// SUPPORTED_MARKETS at call sites that pass `symbol`.
const IMPERIAL_MAX_LEVERAGE = Number(process.env.IMPERIAL_MAX_LEVERAGE ?? 9.5);
// Always stay this far below the venue cap. Phoenix returns floats like
// 9.96x for a nominal "10x" market and rejects orders at-or-above the cap,
// so we shave a fixed margin off the per-market max to guarantee fills
// (and equally important, guarantee that close/partial-close passes the
// same cap check later).
const IMPERIAL_LEVERAGE_SAFETY_MARGIN = Number(process.env.IMPERIAL_LEVERAGE_SAFETY_MARGIN ?? 0.5);
export function clampLeverage(label, requested, symbol) {
  const req = Number(requested);
  if (!Number.isFinite(req) || req <= 0) return req;
  const sym = String(symbol || '').toUpperCase();
  const marketCap = sym && SUPPORTED_MARKETS[sym]?.maxLeverage;
  const ceiling = Number.isFinite(marketCap) && marketCap > 0
    ? Math.max(1, marketCap - IMPERIAL_LEVERAGE_SAFETY_MARGIN)
    : IMPERIAL_MAX_LEVERAGE;
  if (req <= ceiling) return req;
  console.log(`[${label}] leverage clamped ${req}x -> ${ceiling}x (cap=${marketCap ?? 'global'}, margin=${IMPERIAL_LEVERAGE_SAFETY_MARGIN})`);
  return ceiling;
}



// Canonical /mobile/orders response shape (per Imperial dev, mobile.rs:436-453):
//   { success: bool, signature: Option<String>, order_pda: Option<String>, error: Option<String> }
// Rules from Imperial:
//   - Always check `success` before `signature`.
//   - `success: true` with `signature: null` is a contract bug, not a normal path.
//   - When `signature` is null, `error` is the authoritative reason; log it.
// Earlier code looked at signature directly and silently swallowed
//   { success: false, error: "..." } responses. This helper makes that impossible.
function readPlaceOrderResult(label, res) {
  const success = res?.success === true;
  const signature = typeof res?.signature === 'string' && res.signature.length > 0
    ? res.signature
    : typeof res?.txSignature === 'string' && res.txSignature.length > 0
      ? res.txSignature
      : typeof res?.tx_sig === 'string' && res.tx_sig.length > 0
        ? res.tx_sig
        : null;
  const orderPda = typeof res?.order_pda === 'string' && res.order_pda.length > 0 ? res.order_pda : null;
  const errorMsg = typeof res?.error === 'string' && res.error.length > 0 ? res.error : null;

  if (!success) {
    const msg = errorMsg || `placeOrder success=false (no error field): ${JSON.stringify(res).slice(0, 400)}`;
    console.warn(`[${label}] placeOrder rejected: ${msg}`);
    return { signature: null, orderPda, error: msg, raw: res };
  }
  if (!signature && !orderPda) {
    const msg = `placeOrder success=true but signature AND order_pda are null (upstream bug): ${JSON.stringify(res).slice(0, 400)}`;
    console.warn(`[${label}] ${msg}`);
    return { signature: null, orderPda: null, error: msg, raw: res };
  }
  return { signature, orderPda, error: null, raw: res };
}

function listImperialPositions(raw) {
  return Array.isArray(raw?.dataList)
    ? raw.dataList
    : Array.isArray(raw)
      ? raw
      : (raw?.positions || raw?.data || []);
}

function findImperialPosition(raw, { profileIndex, sym, sd }) {
  return listImperialPositions(raw).find((p) => {
    const pi = Number(pick(p, ['profileIndex', 'profileIdx', 'profile_id', 'profile']));
    if (Number.isFinite(pi) && pi !== Number(profileIndex)) return false;
    const psym = String(pick(p, ['symbol', 'asset', 'marketSymbol', 'baseSymbol', 'underlying', 'market']) || '').toUpperCase();
    if (psym && psym !== sym) return false;
    const pside = normalizePositionSide(pick(p, ['side', 'direction', 'positionSide']));
    if (pside && pside !== sd) return false;
    return true;
  }) || null;
}

async function pollVerifiedSizeIncrease({ authToken, wallet, profileIndex, sym, sd, sizeBefore, label }) {
  if (!(Number(sizeBefore) > 0)) return null;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    let raw;
    try { raw = await getPositions(wallet, { token: authToken }); }
    catch (e) { console.warn(`[${label}] poll ${i + 1}/4 getPositions failed: ${e.message}`); continue; }
    const hit = findImperialPosition(raw, { profileIndex, sym, sd });
    const liveSize = num(pick(hit, ['sizeUsd', 'positionSizeUsd', 'notionalUsd', 'notional', 'size', 'size_usd']), 0);
    if (liveSize > Number(sizeBefore) + 0.01) {
      return { position: hit, liveSize, appliedAddSizeUsd: liveSize - Number(sizeBefore) };
    }
  }
  return null;
}

async function pollVerifiedSizeDecrease({ authToken, wallet, profileIndex, sym, sd, sizeBefore, reduceSizeUsd, label }) {
  const before = Number(sizeBefore);
  if (!(before > 0)) return null;
  const requestedReduce = Number(reduceSizeUsd);
  const expectsFullClose = Number.isFinite(requestedReduce) && requestedReduce >= before - 0.01;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    let raw;
    try { raw = await getPositions(wallet, { token: authToken }); }
    catch (e) { console.warn(`[${label}] poll ${i + 1}/8 getPositions failed: ${e.message}`); continue; }
    const hit = findImperialPosition(raw, { profileIndex, sym, sd });
    if (!hit && expectsFullClose) {
      return { closed: true, liveSize: 0, appliedReduceSizeUsd: before };
    }
    const liveSize = num(pick(hit, ['sizeUsd', 'positionSizeUsd', 'notionalUsd', 'notional', 'size', 'size_usd']), NaN);
    if (Number.isFinite(liveSize) && liveSize < before - 0.01) {
      return { closed: liveSize <= 0.01, liveSize, appliedReduceSizeUsd: before - liveSize };
    }
  }
  return null;
}

function isPhoenixMarginCapacityError(error) {
  const msg = String(error ?? '').toLowerCase();
  return (
    msg.includes('failed to place order') ||
    msg.includes('reduce size') ||
    msg.includes('add collateral') ||
    msg.includes('insufficient collateral') ||
    msg.includes('margin') ||
    msg.includes('maintenance')
  );
}

function extractTransactionBase64(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of ['transaction', 'tx', 'signedTransaction', 'serializedTransaction']) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 100) return value;
  }
  for (const key of ['data', 'result']) {
    const nested = raw[key];
    if (nested && typeof nested === 'object') {
      const value = extractTransactionBase64(nested);
      if (value) return value;
    }
  }
  return null;
}

// --- Read position ---
//
// Imperial's /positions is keyed by wallet, so we filter the returned list
// down to (profileIndex, symbol, side). Defensive across minor field-name
// drift: tries several common keys.
export async function imperialReadPosition({
  profileIndex,
  symbol,
  side,
  token,
  wallet,
}) {
  if (!wallet) throw new Error('imperialReadPosition: wallet required');
  if (!symbol) throw new Error('imperialReadPosition: symbol required');
  if (profileIndex == null) throw new Error('imperialReadPosition: profileIndex required');
  const sym = marketSymbol(symbol);
  const sd = String(side || 'long').toLowerCase();

  let raw;
  try {
    raw = await getPositions(wallet, { token });
  } catch (e) {
    console.warn(`[phoenix] ${sym} ${sd} position read: ${e.message}`);
    return null;
  }
  // Filter to this profile + market + side. Be liberal in matching: Imperial
  // entries may key symbol as `symbol`, `asset`, `marketSymbol`, or
  // `baseSymbol`. profileIndex may be a number or string.
  const matched = findImperialPosition(raw, { profileIndex, sym, sd });
  if (!matched) return null;

  const sizeUsd = num(pick(matched, ['sizeUsd', 'positionSizeUsd', 'notionalUsd', 'notional', 'size', 'size_usd']));
  if (!(sizeUsd > 0)) return null;
  const collateralUsd = num(pick(matched, ['collateralUsd', 'marginUsd', 'collateral', 'collateral_usd', 'margin']));
  const apiPnlUsd = num(
    pick(matched, ['unrealizedPnlUsd', 'pnlUsd', 'pnl', 'unrealizedPnl']),
    0,
  );
  const markPriceUsd = num(pick(matched, ['markPriceUsd', 'markPrice', 'indexPrice', 'price']));
  const entryPriceUsd = num(pick(matched, ['entryPriceUsd', 'entryPrice', 'avgEntryPrice']));

  // Prefer Imperial's live unrealized PnL when it is present. Older gmtrade
  // reads sometimes under-reported by ~30x, so only replace it with computed
  // price-diff PnL when the API number is missing or clearly broken.
  let unrealizedPnlUsd = apiPnlUsd;
  if (
    Number.isFinite(entryPriceUsd) && entryPriceUsd > 0 &&
    Number.isFinite(markPriceUsd) && markPriceUsd > 0 &&
    sizeUsd > 0
  ) {
    const dir = sd === 'short' ? -1 : 1;
    const computed = ((markPriceUsd - entryPriceUsd) / entryPriceUsd) * sizeUsd * dir;
    const apiLooksBroken = !Number.isFinite(apiPnlUsd) || (
      Math.abs(computed) > 50 && Math.abs(apiPnlUsd) > 0 && Math.abs(computed / apiPnlUsd) > 5
    );
    if (Number.isFinite(computed) && apiLooksBroken) unrealizedPnlUsd = computed;
  }

  // Position identifier required by Imperial close on flash_trade venue
  // (silently rejected otherwise). Surface whichever key the API uses.
  const positionPda = pick(matched, ['positionPda', 'positionId', 'position_pda', 'position_id', 'pda']);

  return {
    sizeUsd,
    collateralUsd: Number.isFinite(collateralUsd) ? collateralUsd : 0,
    side: sd,
    entryPriceUsd: Number.isFinite(entryPriceUsd) ? entryPriceUsd : undefined,
    markPriceUsd: Number.isFinite(markPriceUsd) ? markPriceUsd : undefined,
    unrealizedPnlUsd,
    positionPda: positionPda || undefined,
    raw: matched,
  };
}

// --- Open ---
//
// Imperial open is two on-chain actions:
//   1. deposit USDC into the profile (already done by loop.js step 2d via
//      depositToImperialProfile) — caller MUST have already deposited at
//      least `collateralUsd` to the profile before invoking this.
//   2. place a market order via /mobile/orders.
//
// We do NOT re-deposit here. The caller (loop.js) is responsible for the
// deposit step via the existing imperial:deposit pipeline, then immediately
// calls this to open. That keeps the deposit gate (gateImperialFunding)
// authoritative over how much can be posted as collateral.
export async function imperialOpenPosition({
  authToken,
  kp,
  profileIndex,
  symbol,
  side,
  collateralUsd,
  leverage,
  slippageBps,
  venue,
}) {
  assertTradeMode('open');
  if (!authToken) throw new Error('imperialOpenPosition: authToken required');
  if (!kp) throw new Error('imperialOpenPosition: kp required');
  if (profileIndex == null) throw new Error('imperialOpenPosition: profileIndex required');
  if (!(collateralUsd > 0)) throw new Error('imperialOpenPosition: collateralUsd must be > 0');
  if (!(leverage > 0)) throw new Error('imperialOpenPosition: leverage must be > 0');
  if (collateralUsd < MIN_COLLATERAL_USD) {
    return { signature: null, simulated: false, error: `coll $${collateralUsd} < min $${MIN_COLLATERAL_USD}` };
  }
  const sym = marketSymbol(symbol);
  if (!isSupportedMarket(sym)) {
    return { signature: null, simulated: false, error: `unsupported imperial market ${sym}` };
  }
  // Venue gate. Phoenix-only after KEEPER_PHOENIX_LOCK.md Phase A.
  //
  //   1. phoenix     -- ONLY supported venue for new opens
  //   2. flash_trade -- deferred; partial-close polling still flaky
  //   3. jupiter     -- legacy fallback only
  //   4. gmtrade     -- DISABLED; keeper-lag, see KEEPER_GMTRADE_REMOVAL.md
  //
  // Operator can flip back with IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix,flash_trade,jupiter
  // if Phoenix has an outage and recovery requires another venue.
  // Catalog wins over the upstream /route hint: Imperial's router may suggest
  // gmtrade/jupiter for markets we've explicitly Phoenix-locked (see
  // KEEPER_PHOENIX_LOCK.md). Only fall back to the quote's venue when the
  // catalog has no entry for this symbol.
  const resolvedVenue = SUPPORTED_MARKETS[sym]?.venue || venue;
  const SUPPORTED_OPEN_VENUES = new Set(
    (process.env.IMPERIAL_SUPPORTED_OPEN_VENUES ?? 'phoenix')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (!SUPPORTED_OPEN_VENUES.has(resolvedVenue)) {
    console.log(
      `[imperial:open] ${sym} skip: venue=${resolvedVenue} not in SUPPORTED_OPEN_VENUES ` +
      `(${Array.from(SUPPORTED_OPEN_VENUES).join(',')}). Phoenix is the default; ` +
      `set IMPERIAL_SUPPORTED_OPEN_VENUES env to override.`,
    );
    return { signature: null, simulated: false, error: `venue ${resolvedVenue} not in supported list` };
  }
  const sd = String(side).toLowerCase() === 'short' ? 'short' : 'long';
  const lev = clampLeverage(`imperial:open ${sym} ${sd}`, leverage, sym);
  const notionalUsd = Number(collateralUsd) * Number(lev);

  const wallet = kp.publicKey.toBase58();

  // Phase C: pre-activate phoenix profile (idempotent, cached). Best-effort —
  // Imperial says /mobile/orders auto-activates on first use, so a register
  // failure here doesn't abort the open.
  if (resolvedVenue === 'phoenix') {
    await ensurePhoenixRegistered({ wallet, profileIndex });
  }

  const order = {
    symbol: sym,
    side: sd,
    venue: resolvedVenue,
    profileIndex,
    wallet,
    collateralAsset: USDC_MINT,
    collateralAmount: usdToBase(collateralUsd),
    notional: notionalUsd.toFixed(6),
    desiredLeverage: String(lev),
    slippageBps: Number(slippageBps ?? config.slippageBps ?? 100),
    reduceOnly: false,
  };

  const tOpen = Math.floor(Date.now() / 1000) - 10; // accept positions opened in the last 10s
  try {
    const res = await placeOrder(authToken, order);
    const parsed = readPlaceOrderResult(`imperial:open ${sym} ${sd}`, res);
    if (parsed.signature) {
      return { signature: parsed.signature, simulated: false, raw: res };
    }
    // Imperial's /mobile/orders is unreliable: it often returns
    // { success:false, error:"Failed to place order" } even when the order
    // actually fills on-chain. Verify by polling /positions for a freshly
    // opened position before declaring failure (matches imperial-order-probe.mjs).
    console.warn(`[imperial:open] ${sym} ${sd} upstream success=false, polling /positions to verify...`);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      let raw;
      try { raw = await getPositions(wallet, { token: authToken }); }
      catch (e) { console.warn(`[imperial:open] poll ${i + 1} getPositions failed: ${e.message}`); continue; }
      const list = Array.isArray(raw?.dataList) ? raw.dataList : Array.isArray(raw) ? raw : (raw?.positions || raw?.data || []);
      const hit = list.find((p) => {
        const pi = Number(p?.profileIndex ?? p?.profile);
        if (Number.isFinite(pi) && pi !== Number(profileIndex)) return false;
        const psym = String(p?.symbol || p?.asset || p?.market || '').toUpperCase();
        if (psym !== sym) return false;
        const pside = normalizePositionSide(p?.side ?? p?.direction ?? p?.positionSide);
        if (pside && pside !== sd) return false;
        if (p?.source && p.source !== 'imperial') return false;
        if (p?.status && p.status !== 'open') return false;
        const openedAt = Number(p?.openedAt ?? p?.opened_at ?? 0);
        if (openedAt && openedAt < tOpen) return false;
        return true;
      });
      console.log(`[imperial:open] poll ${i + 1}/15: fresh ${sym} ${sd} match=${hit ? 'YES' : 'no'}`);
      if (hit) {
        const sig = hit.openTxSignature || hit.signature || hit.txSignature || 'verified-via-positions';
        return { signature: sig, simulated: false, raw: res, verifiedVia: 'positions' };
      }
    }
    return { signature: null, simulated: false, error: parsed.error || 'placeOrder success=false and no fresh position appeared within 30s', raw: res };
  } catch (e) {
    console.warn(`[imperial:open] ${sym} ${sd} placeOrder threw: ${e.message}`);
    return { signature: null, simulated: false, error: e.message };
  }
}

// --- Increase position size (with optional new collateral) ---
//
// Imperial is profile-scoped, so adding collateral is a deposit, and adding
// size is another /mobile/orders call on the same (symbol, side). We do both
// when addCollateralUsd > 0 AND addSizeUsd > 0. Either may be 0.
export async function imperialIncreasePosition({
  authToken,
  kp,
  profileIndex,
  symbol,
  side,
  addSizeUsd = 0,
  addCollateralUsd = 0,
  orderCollateralUsd = addCollateralUsd,
  attachCollateralBeforeSize = true,
  leverage,
  slippageBps,
  solUsd,
  rpcUrl,
  venue,
}) {
  assertTradeMode('increase');
  const sym = marketSymbol(symbol);
  const sd = String(side).toLowerCase() === 'short' ? 'short' : 'long';
  const wallet = kp.publicKey.toBase58();
  const resolvedVenue = SUPPORTED_MARKETS[sym]?.venue || venue;

  // Leg 0 (optional): deposit fresh USDC into the profile.
  let depositPrep = null;
  if (addCollateralUsd > 0) {
    const depRes = await depositToImperialProfile({
      authToken, kp, profileIndex,
      usdAmount: addCollateralUsd,
      solUsd, rpcUrl,
    });
    depositPrep = depRes;
  }

  // Leg 1: attach parked USDC to the existing position via
  // /mobile/orders/collateral BEFORE the size-add. Phoenix evaluates the
  // same-side increase order against the position's *currently-attached*
  // margin — a deposit alone doesn't count. Without this, an unrealized
  // loss makes Phoenix return 400 "reduce size or add collateral first"
  // AND strands the deposited USDC as ghost free margin (DEGEN/ZCRASH).
  // By binding the collateral first we (a) satisfy the margin check and
  // (b) guarantee no USDC gets stranded even if leg 2 still fails.
  let collateralAttachRes = null;
  const collToAttach = Math.max(0, Number(orderCollateralUsd ?? 0));
  if (collToAttach > 0 && attachCollateralBeforeSize) {
    try {
      collateralAttachRes = await imperialAddCollateralToPosition({
        authToken, kp, profileIndex,
        symbol: sym, side: sd,
        addCollateralUsd: collToAttach,
        slippageBps, venue: resolvedVenue,
      });
      if (collateralAttachRes?.error) {
        console.warn(
          `[phoenix] ${sym} ${sd} margin boost failed: ${String(collateralAttachRes.error).slice(0, 200)}`,
        );
        return {
          signature: depositPrep?.signature ?? null,
          simulated: false,
          depositPrep,
          collateralAttachRes,
          error: collateralAttachRes.error,
          appliedAddSizeUsd: 0,
          appliedAddCollateralUsd: 0,
        };
      }
    } catch (e) {
      console.warn(`[phoenix] ${sym} ${sd} margin boost issue: ${e.message}`);
      collateralAttachRes = { signature: null, error: e.message };
      return {
        signature: depositPrep?.signature ?? null,
        simulated: false,
        depositPrep,
        collateralAttachRes,
        error: e.message,
        appliedAddSizeUsd: 0,
        appliedAddCollateralUsd: 0,
      };
    }
  }

  if (!(addSizeUsd > 0)) {
    return {
      signature: collateralAttachRes?.signature ?? depositPrep?.signature ?? null,
      simulated: false,
      depositPrep,
      collateralAttachRes,
      appliedAddSizeUsd: 0,
      appliedAddCollateralUsd: collToAttach,
    };
  }

  // Leg 2: size-only same-side order. Collateral is already bound to the
  // position (leg 1), so we send collateralAmount=0. Phoenix accepts a
  // pure size increase as long as the existing margin supports the new
  // notional at the requested leverage.
  if (resolvedVenue === 'phoenix') {
    await ensurePhoenixRegistered({ wallet, profileIndex });
  }
  const lev = clampLeverage(`imperial:increase ${sym} ${sd}`, leverage || 1, sym);
  const posBeforeRaw = await getPositions(wallet, { token: authToken }).catch(() => null);
  const posBefore = findImperialPosition(posBeforeRaw, { profileIndex, sym, sd });
  const sizeBefore = num(pick(posBefore, ['sizeUsd', 'positionSizeUsd', 'notionalUsd', 'notional', 'size', 'size_usd']), 0);
  const order = {
    symbol: sym,
    side: sd,
    venue: resolvedVenue,
    profileIndex,
    wallet,
    collateralAsset: USDC_MINT,
    collateralAmount: attachCollateralBeforeSize ? 0 : usdToBase(collToAttach),
    notional: Number(addSizeUsd).toFixed(6),
    desiredLeverage: String(lev || 1),
    slippageBps: Number(slippageBps ?? config.slippageBps ?? 100),
    reduceOnly: false,
    ...(posBefore ? { positionId: pick(posBefore, ['positionPda', 'positionId', 'position_pda', 'position_id', 'pda']) } : {}),
  };
  const requestedAddSizeUsd = Number(addSizeUsd);
  const fractions = [1, 0.85, 0.7, 0.55, 0.4, 0.25, 0.15, 0.08, 0.05, 0.02];
  let lastError = null;
  let lastRaw = null;
  const tried = new Set();

  for (const frac of fractions) {
    const trialAddSizeUsd = Math.floor(requestedAddSizeUsd * frac * 100) / 100;
    if (!(trialAddSizeUsd > 0.01) || tried.has(trialAddSizeUsd)) continue;
    tried.add(trialAddSizeUsd);
    order.notional = trialAddSizeUsd.toFixed(6);
    try {
      const res = await placeOrder(authToken, order);
      const parsed = readPlaceOrderResult(`imperial:increase ${sym} ${sd} $${trialAddSizeUsd.toFixed(2)}`, res);
      lastRaw = res;
      const verified = await pollVerifiedSizeIncrease({
        authToken,
        wallet,
        profileIndex,
        sym,
        sd,
        sizeBefore,
        label: `imperial:increase ${sym} ${sd} $${trialAddSizeUsd.toFixed(2)}`,
      });
      if (parsed.signature || verified) {
        if (trialAddSizeUsd < requestedAddSizeUsd - 0.01) {
          console.log(
            `[phoenix] ${sym} ${sd} sizing down $${requestedAddSizeUsd.toFixed(2)} → $${trialAddSizeUsd.toFixed(2)} to fit available margin`,
          );
        }
        return {
          signature: parsed.signature || 'verified-via-positions',
          simulated: false,
          depositPrep,
          collateralAttachRes,
          error: undefined,
          raw: res,
          requestedAddSizeUsd,
          appliedAddSizeUsd: verified?.appliedAddSizeUsd ?? trialAddSizeUsd,
          appliedAddCollateralUsd: collToAttach,
        };
      }
      lastError = parsed.error || 'placeOrder rejected without error';
      if (!isPhoenixMarginCapacityError(lastError)) {
        return {
          signature: collateralAttachRes?.signature || null,
          simulated: false,
          depositPrep,
          collateralAttachRes,
          error: lastError,
          raw: res,
          requestedAddSizeUsd,
          appliedAddSizeUsd: 0,
          appliedAddCollateralUsd: collateralAttachRes?.signature ? collToAttach : 0,
        };
      }
    } catch (e) {
      lastError = e.message;
      if (!isPhoenixMarginCapacityError(lastError)) {
        return {
          signature: collateralAttachRes?.signature || null,
          simulated: false,
          depositPrep,
          collateralAttachRes,
          error: e.message,
          requestedAddSizeUsd,
          appliedAddSizeUsd: 0,
          appliedAddCollateralUsd: collateralAttachRes?.signature ? collToAttach : 0,
        };
      }
    }
  }

  if (collateralAttachRes?.signature) {
    console.warn(
      `[phoenix] ${sym} ${sd} margin added but size failed. Marking top-up failed so DB/reconcile will not treat this as healthy. last=${String(lastError ?? 'unknown').slice(0, 160)}`,
    );
    return {
      signature: collateralAttachRes.signature,
      simulated: false,
      depositPrep,
      collateralAttachRes,
      raw: lastRaw,
      requestedAddSizeUsd,
      appliedAddSizeUsd: 0,
      appliedAddCollateralUsd: collToAttach,
      sizeDeferred: true,
      error: lastError || 'size increase failed after collateral attach',
      lastSizeError: lastError,
    };
  }

  return {
    signature: null,
    simulated: false,
    depositPrep,
    collateralAttachRes,
    error: lastError || 'size increase failed',
    raw: lastRaw,
    requestedAddSizeUsd,
    appliedAddSizeUsd: 0,
    appliedAddCollateralUsd: collateralAttachRes?.signature ? collToAttach : 0,
  };
}


// --- Top up margin only (no size change) ---
//
// Pure deposit. Wraps depositToImperialProfile so loop.js doesn't have to
// import that separately on the imperial path.
export async function imperialTopUpMargin({
  authToken,
  kp,
  profileIndex,
  addCollateralUsd,
  solUsd,
  rpcUrl,
}) {
  assertTradeMode('topup');
  if (!(addCollateralUsd > 0)) {
    return { signature: null, simulated: false, error: 'addCollateralUsd must be > 0' };
  }
  try {
    const r = await depositToImperialProfile({
      authToken, kp, profileIndex,
      usdAmount: addCollateralUsd,
      solUsd, rpcUrl,
    });
    return { signature: r.signature, simulated: false, raw: r };
  } catch (e) {
    return { signature: null, simulated: false, error: e.message };
  }
}

// --- Add collateral to an existing position (NO size change) ---
//
// Correct Imperial path is POST /mobile/orders/collateral with action=0.
// Do NOT use /mobile/orders with notional=0: that is a decrease-style shape
// and can remove collateral. This endpoint attaches profile free USDC to the
// open position without changing position size.
export async function imperialAddCollateralToPosition({
  authToken,
  kp,
  profileIndex,
  symbol,
  side,
  addCollateralUsd,
  slippageBps,
  venue,
}) {
  assertTradeMode('topup');
  if (!authToken) throw new Error('imperialAddCollateralToPosition: authToken required');
  if (!kp) throw new Error('imperialAddCollateralToPosition: kp required');
  if (profileIndex == null) throw new Error('imperialAddCollateralToPosition: profileIndex required');
  if (!(addCollateralUsd > 0)) return { signature: null, simulated: false, error: 'addCollateralUsd must be > 0' };

  const sym = marketSymbol(symbol);
  const sd = String(side).toLowerCase() === 'short' ? 'short' : 'long';
  const wallet = kp.publicKey.toBase58();
  const resolvedVenue = SUPPORTED_MARKETS[sym]?.venue || venue || 'phoenix';
  if (resolvedVenue === 'phoenix') await ensurePhoenixRegistered({ wallet, profileIndex });

  try {
    const market = await resolveMarket(sym, sd, resolvedVenue);
    const price = await getMarkPrice(sym, resolvedVenue);
    if (!market?.marketMint) throw new Error(`no marketMint for ${sym}/${sd}/${resolvedVenue}`);
    if (!price) throw new Error(`no mark price for ${sym}/${resolvedVenue}`);
    const headers = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    };
    if (config.imperial.apiKey) headers['x-api-key'] = config.imperial.apiKey;
    const body = {
      wallet,
      marketMint: market.marketMint,
      side: sd === 'short' ? 1 : 0,
      action: 0,
      collateralAmount: usdToBase(addCollateralUsd),
      slippageBps: Number(slippageBps ?? config.slippageBps ?? 100),
      profileIndex,
      underwriter: market.underwriter,
      price,
    };
    const res = await fetch(`${config.imperial.baseUrl}/mobile/orders/collateral`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let raw;
    try { raw = text ? JSON.parse(text) : {}; } catch { raw = { raw: text }; }
    if (!res.ok) return { signature: null, simulated: false, error: `/mobile/orders/collateral ${res.status}: ${text}`, raw };
    const parsed = readPlaceOrderResult(`phoenix:addCollateral ${sym} ${sd}`, raw);
    if (parsed.signature) {
      return { signature: parsed.signature, simulated: false, error: undefined, raw, body };
    }

    const txBase64 = extractTransactionBase64(raw);
    if (txBase64) {
      const conn = new Connection(config.rpcUrl, 'confirmed');
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
      tx.sign([kp]);
      const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      const conf = await conn.confirmTransaction(signature, 'confirmed');
      if (conf.value.err) {
        return { signature, simulated: false, error: `collateral tx on-chain err: ${JSON.stringify(conf.value.err)}`, raw, body };
      }
      return { signature, simulated: false, error: undefined, raw, body };
    }

    return { signature: null, simulated: false, error: parsed.error || 'collateral order returned no signature or transaction', raw, body };
  } catch (e) {
    return { signature: null, simulated: false, error: e.message };
  }
}


// --- Close (full or partial) ---
//
// Per Imperial dev (mobile.rs:375-376): there is NO `reduceOnly` flag.
// A close is expressed as { action: 1, side: <same as position>,
// collateralAmount: 0, notional: <usd to close>, NO desiredLeverage }.
// A FULL close requires notional === position.sizeUsd exactly. Callers
// MUST pass `currentSizeUsd` (the live position size from
// imperialReadPosition) so we can snap to the exact value on full closes
// and avoid float drift causing the venue to interpret it as a partial.
//
// reduceSizeUsd >= currentSizeUsd  -> full close (notional = currentSizeUsd)
// reduceSizeUsd <  currentSizeUsd  -> partial close (notional = reduceSizeUsd)
//
// NOTE: the dev only documented the FULL-close recipe explicitly. We're
// applying the same body shape to partials (just with a smaller notional)
// because there is no separate "partial" verb. If Imperial rejects the
// partial form we'll need to swap to incremental opposite-side orders.
export async function imperialPartialClose({
  authToken,
  kp,
  profileIndex,
  symbol,
  side,
  reduceSizeUsd,
  currentSizeUsd,
  slippageBps,
  venue,
  // Optional, but REQUIRED for flash_trade closes — silent reject otherwise.
  // Read from /positions[*].positionPda before calling. See imperial.js
  // scaleMarketPriceForVenue comment for the empirical evidence.
  positionId,
}) {
  assertTradeMode('partial_close');
  if (!(reduceSizeUsd > 0)) {
    return { signature: null, simulated: false, error: 'reduceSizeUsd must be > 0' };
  }
  const sym = String(symbol).toUpperCase();
  const sd = String(side).toLowerCase() === 'short' ? 'short' : 'long';
  const wallet = kp.publicKey.toBase58();

  // Resolve venue the SAME way open does (SUPPORTED_MARKETS catalog wins over
  // caller-supplied venue). Sending venue=undefined makes Imperial route the
  // close through a default venue that doesn't match the on-chain position,
  // which triggers a "Custom: 6015 :: Check permissions" failure on every
  // external (pump.fun-routed) close.
  const resolvedVenue = SUPPORTED_MARKETS[sym]?.venue || venue;

  // Decide notional: snap to exact position size on full close.
  const isFullClose = Number.isFinite(currentSizeUsd) && reduceSizeUsd >= currentSizeUsd;
  const notionalUsd = isFullClose ? Number(currentSizeUsd) : Number(reduceSizeUsd);

  const order = {
    symbol: sym,
    side: sd,                    // SAME side as the position being closed
    venue: resolvedVenue,
    profileIndex,
    wallet,
    action: 1,                   // close action per Imperial spec
    collateralAsset: USDC_MINT,
    collateralAmount: 0,         // must be 0 for close (u64)
    notional: notionalUsd.toFixed(6),
    // NO desiredLeverage, NO reduceOnly
    slippageBps: Number(slippageBps ?? config.slippageBps ?? 100),
    ...(positionId ? { positionId } : {}),
  };
  try {
    const res = await placeOrder(authToken, order);
    const label = isFullClose ? 'phoenix:fullClose' : 'phoenix:partialClose';
    const parsed = readPlaceOrderResult(`${label} ${sym} ${sd}`, res);
    const verified = await pollVerifiedSizeDecrease({
      authToken,
      wallet,
      profileIndex,
      sym,
      sd,
      sizeBefore: currentSizeUsd,
      reduceSizeUsd: notionalUsd,
      label: `${label} ${sym} ${sd}`,
    });
    if (parsed.signature || verified) {
      return {
        signature: parsed.signature || 'verified-via-positions',
        simulated: false,
        error: undefined,
        raw: res,
        verifiedVia: verified ? 'positions' : undefined,
        appliedReduceSizeUsd: verified?.appliedReduceSizeUsd ?? notionalUsd,
        liveSizeUsd: verified?.liveSize,
      };
    }
    return { signature: null, simulated: false, error: parsed.error || 'close order returned no signature and no size decrease was observed', raw: res };
  } catch (e) {
    return { signature: null, simulated: false, error: e.message };
  }
}

// --- Withdraw collateral from profile back to sub-wallet ---
//
// Best-effort: assumes /deposit/build-tx { mode: 'withdraw' } returns a
// signed-tx blob the same way the deposit path does. If Imperial uses a
// different endpoint, update WITHDRAW_PATH / WITHDRAW_MODE at the top
// of this file.
export async function imperialWithdrawCollateral({
  authToken,
  kp,
  profileIndex,
  withdrawUsd,
  rpcUrl,
}) {
  assertTradeMode('withdraw');
  if (!authToken) throw new Error('imperialWithdrawCollateral: authToken required');
  if (!kp) throw new Error('imperialWithdrawCollateral: kp required');
  if (profileIndex == null) throw new Error('imperialWithdrawCollateral: profileIndex required');
  if (!(withdrawUsd > 0)) throw new Error('imperialWithdrawCollateral: withdrawUsd must be > 0');

  const base = config.imperial.baseUrl;
  const wallet = kp.publicKey.toBase58();
  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
  if (config.imperial.apiKey) headers['x-api-key'] = config.imperial.apiKey;

  let res, text, body;
  try {
    res = await fetch(`${base}${WITHDRAW_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        wallet,
        profileIndex,
        amount: usdToBase(withdrawUsd),
        mode: WITHDRAW_MODE,
      }),
    });
    text = await res.text();
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  } catch (e) {
    return { signature: null, simulated: false, error: `withdraw fetch failed: ${e.message}` };
  }

  if (!res.ok || !body?.transaction) {
    const errMsg = `Imperial ${WITHDRAW_PATH} (${WITHDRAW_MODE}) ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`;
    return { signature: null, simulated: false, error: errMsg };
  }

  try {
    const conn = new Connection(rpcUrl || config.rpcUrl, 'confirmed');
    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, 'base64'));
    tx.sign([kp]);
    const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const conf = await conn.confirmTransaction(signature, 'confirmed');
    if (conf.value.err) {
      return {
        signature, simulated: false,
        error: `withdraw tx on-chain err: ${JSON.stringify(conf.value.err)}`,
      };
    }
    return { signature, simulated: false };
  } catch (e) {
    return { signature: null, simulated: false, error: e.message };
  }
}

// --- Convenience: full close (reduce-only for the full size) ---
export async function imperialClosePosition({
  authToken,
  kp,
  profileIndex,
  symbol,
  side,
  sizeUsd,
  leverage,
  slippageBps,
  venue,
  // Optional — required for flash_trade. See imperialPartialClose.
  positionId,
}) {
  return imperialPartialClose({
    authToken, kp, profileIndex, symbol, side,
    reduceSizeUsd: sizeUsd,
    currentSizeUsd: sizeUsd, // full close -> snap notional exactly
    slippageBps, venue, positionId,
  });
}

// Re-export resolveMarket so callers can prefetch venue if needed.
export { resolveMarket };

// --- Keeper read helpers (moved here from loop.js) ---

// Router-aware underlying gate. Imperial-routed tokens check the Imperial
// market catalog; everything else falls back to the Jupiter whitelist.
export function isUnderlyingSupportedForToken(token, underlying) {
  const sym = String(underlying ?? '').toUpperCase();
  if (!sym) return false;
  const routerId = String(token?.router ?? 'imperial').toLowerCase();
  if (routerId === 'imperial') return isSupportedMarket(sym);
  // jupiter (or any unknown id) falls back to the Jupiter whitelist
  return SUPPORTED_SYMBOLS.has(sym);
}

// Profile free USDC (UI units): read the API profile first, then prefer the
// on-chain profile-PDA USDC ATA balance when available. Used to verify that an
// open/topup actually drained collateral instead of being refunded same-tx.
export async function readImperialProfileUsdcUi({ profileIndex, authToken, profilePda }) {
  let ui = 0;
  let pda = profilePda || null;
  try {
    const prof = await getProfile({ profileIndex, token: authToken });
    ui = Number(prof?.usdcUi || 0);
    if (prof?.profilePda) pda = prof.profilePda;
  } catch {
    // Fall through to the cached profile PDA on-chain read below.
  }
  if (pda) {
    try {
      const pdaPk = new PublicKey(pda);
      const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), pdaPk, true);
      const bal = await withRetry(() => conn().getTokenAccountBalance(ata, 'confirmed'));
      const onChain = Number(bal?.value?.uiAmount ?? 0);
      if (Number.isFinite(onChain)) ui = onChain;
    } catch {
      /* ATA may not exist */
    }
  }
  return ui;
}

// Poll the venue until the position shows a positive size (open/topup landed),
// or give up after `attempts` and dump a diagnostic of /positions.
export async function readVerifiedImperialPosition({
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
    const raw = await getPositions(wallet, { token: authToken });
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

// Pick the entry-price basis for PnL: prefer the venue's reported entry/mark or
// the existing launch_mid (via pickEntryMid); fall back to the live mark price.
export async function resolveImperialEntryPrice({ verifiedPos, symbol, venue, token }) {
  const picked = pickEntryMid({
    venueEntry: verifiedPos?.entryPriceUsd,
    venueMark: verifiedPos?.markPriceUsd,
    existingMid: token?.launch_mid,
  });
  if (picked.price) return picked;
  try {
    const markPrice = await getMarkPriceUi(symbol, venue);
    if (markPrice) return { price: Number(markPrice), source: 'perpspad_entry_mid' };
  } catch (e) {
    console.warn(`[imperial:entry] ${symbol} mark fallback failed:`, e.message);
  }
  return { price: null, source: null };
}
