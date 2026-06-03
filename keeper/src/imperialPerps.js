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
import { config } from './config.js';
import {
  getPositions,
  placeOrder,
  resolveMarket,
  isSupportedMarket,
  MIN_COLLATERAL_USD,
  SUPPORTED_MARKETS,
  ensurePhoenixRegistered,
} from './imperial.js';
import { ensureUsdcForDeposit, depositToImperialProfile } from './imperialDeposit.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

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
    throw new Error(`imperial trade blocked: positionMode=off (action=${action})`);
  }
  if (mode === 'open-only' && (action === 'withdraw' || action === 'partial_close')) {
    throw new Error(`imperial trade blocked: positionMode=open-only forbids ${action}`);
  }
  if (!['open-only', 'full'].includes(mode)) {
    throw new Error(`imperial trade blocked: positionMode=${mode}`);
  }
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
  const signature = typeof res?.signature === 'string' && res.signature.length > 0 ? res.signature : null;
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
  const sym = String(symbol).toUpperCase();
  const sd = String(side || 'long').toLowerCase();

  let raw;
  try {
    raw = await getPositions(wallet, { token });
  } catch (e) {
    console.warn(`[imperial:readPos] ${sym} ${sd} getPositions failed:`, e.message);
    return null;
  }
  const list = Array.isArray(raw?.dataList) ? raw.dataList : Array.isArray(raw) ? raw : [];

  // Filter to this profile + market + side. Be liberal in matching: Imperial
  // entries may key symbol as `symbol`, `asset`, `marketSymbol`, or
  // `baseSymbol`. profileIndex may be a number or string.
  const matched = list.find((p) => {
    const pi = Number(pick(p, ['profileIndex', 'profileIdx', 'profile_id', 'profile']));
    if (Number.isFinite(pi) && Number(pi) !== Number(profileIndex)) return false;
    const psym = String(pick(p, ['symbol', 'asset', 'marketSymbol', 'baseSymbol', 'underlying', 'market']) || '').toUpperCase();
    if (psym && psym !== sym) return false;
    const pside = normalizePositionSide(pick(p, ['side', 'direction', 'positionSide']));
    if (pside && pside !== sd) return false;
    return true;
  });
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

  return {
    sizeUsd,
    collateralUsd: Number.isFinite(collateralUsd) ? collateralUsd : 0,
    side: sd,
    entryPriceUsd: Number.isFinite(entryPriceUsd) ? entryPriceUsd : undefined,
    markPriceUsd: Number.isFinite(markPriceUsd) ? markPriceUsd : undefined,
    unrealizedPnlUsd,
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
  const sym = String(symbol).toUpperCase();
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
  const resolvedVenue = venue || SUPPORTED_MARKETS[sym]?.venue;
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
  const notionalUsd = Number(collateralUsd) * Number(leverage);
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
    venue,
    profileIndex,
    wallet,
    collateralAsset: USDC_MINT,
    collateralAmount: usdToBase(collateralUsd),
    notional: notionalUsd.toFixed(6),
    desiredLeverage: String(leverage),
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
  leverage,
  slippageBps,
  solUsd,
  rpcUrl,
  venue,
}) {
  assertTradeMode('increase');
  let depositPrep = null;
  if (addCollateralUsd > 0) {
    const depRes = await depositToImperialProfile({
      authToken, kp, profileIndex,
      usdAmount: addCollateralUsd,
      solUsd, rpcUrl,
    });
    depositPrep = depRes;
  }
  if (!(addSizeUsd > 0)) {
    return {
      signature: depositPrep?.signature ?? null,
      simulated: false,
      depositPrep,
    };
  }
  // Place an additional same-side order for the size delta.
  const sym = String(symbol).toUpperCase();
  const sd = String(side).toLowerCase() === 'short' ? 'short' : 'long';
  const wallet = kp.publicKey.toBase58();
  // Use base leverage so the order size matches what the loop expects.
  const collForOrder = addSizeUsd / Math.max(1, Number(leverage || 1));
  const order = {
    symbol: sym,
    side: sd,
    venue,
    profileIndex,
    wallet,
    collateralAsset: USDC_MINT,
    collateralAmount: usdToBase(collForOrder),
    notional: Number(addSizeUsd).toFixed(6),
    desiredLeverage: String(leverage || 1),
    slippageBps: Number(slippageBps ?? config.slippageBps ?? 100),
    reduceOnly: false,
  };
  try {
    const res = await placeOrder(authToken, order);
    const parsed = readPlaceOrderResult(`imperial:increase ${sym} ${sd}`, res);
    return { signature: parsed.signature, simulated: false, depositPrep, error: parsed.error || undefined, raw: res };
  } catch (e) {
    return { signature: null, simulated: false, depositPrep, error: e.message };
  }
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

  // Decide notional: snap to exact position size on full close.
  const isFullClose = Number.isFinite(currentSizeUsd) && reduceSizeUsd >= currentSizeUsd;
  const notionalUsd = isFullClose ? Number(currentSizeUsd) : Number(reduceSizeUsd);

  const order = {
    symbol: sym,
    side: sd,                    // SAME side as the position being closed
    venue,
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
    const label = isFullClose ? 'imperial:fullClose' : 'imperial:partialClose';
    const parsed = readPlaceOrderResult(`${label} ${sym} ${sd}`, res);
    return { signature: parsed.signature, simulated: false, error: parsed.error || undefined, raw: res };
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
