// Imperial Exchange HTTP client.
//
// Phase 0 scope: auth handshake (/mobile/connect + /mobile/exchange),
// routing (/route), and read-only endpoints (balances, positions). Order
// placement helpers are stubbed in shape but gated by config.imperial.enabled
// so they cannot fire until later phases.
//
// Auth model (per Imperial OpenAPI):
//   1. Client picks a random nonce and builds the message
//        `imperial:mobile-connect:{wallet}:{nonce}`
//   2. Sign that message with the wallet's ed25519 secret key (base58 sig)
//   3. POST /mobile/connect { wallet, message, signature } with the Imperial
//      API token in Authorization -> { code }
//   4. POST /mobile/exchange { code } with the Imperial API token in
//      Authorization -> { jwt, expiresAt }
//   5. Use `Authorization: Bearer <jwt>` on subsequent authenticated calls

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { config } from './config.js';
import { limitedFetch } from './rateLimiter.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function seedToKeyObject(seed32) {
  if (seed32.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed32.length}`);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed32)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function publicKeyToKeyObject(publicKey32) {
  if (publicKey32.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${publicKey32.length}`);
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey32)]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function signMessage(keypair, message) {
  const seed = keypair.secretKey.slice(0, 32);
  const keyObj = seedToKeyObject(seed);
  const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const sig = cryptoSign(null, buf, keyObj);
  return bs58.encode(sig);
}

export function verifyMessageSignature({ wallet, message, signature }) {
  const walletBytes = bs58.decode(wallet);
  const sigBytes = bs58.decode(signature);
  const keyObj = publicKeyToKeyObject(walletBytes);
  const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  return cryptoVerify(null, buf, keyObj, sigBytes);
}

export function createMobileConnectPayload(keypair) {
  const wallet = keypair.publicKey.toBase58();
  // Imperial expects nonce as a u64 unix timestamp (ms auto-detected if > 1e12).
  // Previously we sent a 32-char hex string which failed their u64 parse and
  // surfaced as a generic 401 "Failed to generate mobile session".
  const nonce = String(Date.now());
  const message = `imperial:mobile-connect:${wallet}:${nonce}`;
  const signature = signMessage(keypair, message);
  const signatureVerifiedLocally = verifyMessageSignature({ wallet, message, signature });
  return { wallet, nonce, message, signature, signatureVerifiedLocally };
}

class ImperialError extends Error {
  constructor(path, status, body) {
    super(`Imperial ${path} ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

function bearer(value) {
  if (!value) return null;
  return value.toLowerCase().startsWith('bearer ') ? value : `Bearer ${value}`;
}

export function getImperialAuthDiagnostics() {
  const authHeader = bearer(config.imperial.apiKey);
  const payload = decodeJwtPayload(config.imperial.apiKey);
  return {
    clientVersion: 'imperial-auth-apikey-v3',
    authorizationHeaderWillBeSent: Boolean(authHeader),
    xApiKeyHeaderWillBeSent: Boolean(config.imperial.apiKey),
    apiKeyLooksBearerPrefixed: Boolean(config.imperial.apiKey?.toLowerCase().startsWith('bearer ')),
    apiKeyIsJwt: Boolean(payload),
    apiKeyWallet: payload?.wallet ?? null,
    apiKeyExpiresAt: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
    handshakeWillBeSkipped: Boolean(config.imperial.apiKey),
  };
}

async function call(path, { method = 'GET', body, query, token, baseUrl, skipGlobalAuth = false } = {}) {
  const base = baseUrl || config.imperial.baseUrl;
  let url = `${base}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ),
    );
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  const headers = { 'Content-Type': 'application/json' };
  // For handshake calls (/mobile/connect, /mobile/exchange) we MUST NOT attach
  // the global IMPERIAL_API_KEY — that JWT is wallet-scoped and Imperial 401s
  // when we use wallet A's token to mint a token for wallet B.
  const authValue = token || (skipGlobalAuth ? null : config.imperial.apiKey);
  const authHeader = bearer(authValue);
  if (authHeader) headers['Authorization'] = authHeader;
  if (config.imperial.apiKey && !skipGlobalAuth) headers['x-api-key'] = config.imperial.apiKey;

  const res = await limitedFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) throw new ImperialError(path, res.status, parsed);
  return parsed;
}


// --- Auth ---

export async function connect({ wallet, message, signature }, opts = {}) {
  return call('/mobile/connect', { method: 'POST', body: { wallet, message, signature }, skipGlobalAuth: true, ...opts });
}

export async function exchange(code, opts = {}) {
  return call('/mobile/exchange', { method: 'POST', body: { code }, skipGlobalAuth: true, ...opts });
}

// Decode the payload of a JWT without verifying its signature. Used to
// surface the wallet/exp bound to a pre-issued Imperial API key.
export function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Convenience: returns { token, pubkey, expiresAt }.
//
// If IMPERIAL_API_KEY is set, the key IS already a session JWT (issued by
// Imperial, bound to a wallet) so we skip the /mobile/connect + /mobile/exchange
// handshake entirely. We only fall back to the wallet-signing handshake when
// no API key is configured.
//
// Per-wallet handshake cache: the /mobile/connect + /mobile/exchange round-trip
// is expensive and Imperial-issued JWTs are valid for hours. Cache results by
// wallet pubkey so repeated authenticate() calls within a tick (or across ticks
// while the token is still fresh) don't re-handshake. Refresh when within
// 30 min of expiry, or every 30 min if no expiry is reported.
const _authCache = new Map(); // wallet -> { token, pubkey, expiresAt, fetchedAt }
const AUTH_REFRESH_MS = 30 * 60_000;

export async function authenticate(keypair, opts = {}) {
  const apiKey = config.imperial.apiKey;
  const kpWallet = keypair?.publicKey?.toBase58?.() ?? null;

  // Only use the global IMPERIAL_API_KEY when its embedded wallet matches the
  // keypair we're authenticating for. Imperial JWTs are wallet-scoped; reusing
  // one wallet's token for another wallet causes /mobile/orders to silently
  // return no signature (the request looks valid but the auth principal does
  // not own the profile being acted on). For every other sub-wallet we fall
  // through to the per-wallet cache, and finally to a real handshake.
  if (apiKey) {
    const payload = decodeJwtPayload(apiKey) || {};
    const keyWallet = payload.wallet ?? payload.pubkey ?? null;
    if (keyWallet && kpWallet && keyWallet === kpWallet) {
      const expiresAt = payload.exp ? payload.exp * 1000 : undefined;
      return { token: apiKey, pubkey: keyWallet, expiresAt, raw: { source: 'api-key', payload } };
    }
  }

  // Per-wallet cache hit avoids the handshake (and its log noise) entirely.
  if (kpWallet) {
    const cached = _authCache.get(kpWallet);
    const now = Date.now();
    const stillFresh = cached && (
      cached.expiresAt
        ? cached.expiresAt - now > AUTH_REFRESH_MS
        : now - cached.fetchedAt < AUTH_REFRESH_MS
    );
    if (stillFresh) {
      return { token: cached.token, pubkey: cached.pubkey, expiresAt: cached.expiresAt, raw: { source: 'cache' } };
    }
  }

  if (apiKey) {
    const payload = decodeJwtPayload(apiKey) || {};
    const keyWallet = payload.wallet ?? payload.pubkey ?? null;
    if (config.logVerbose) console.warn(`[imperial:auth] IMPERIAL_API_KEY wallet=${keyWallet} != kp wallet=${kpWallet}, running handshake instead`);
  }

  if (!keypair) throw new Error('Imperial authenticate: no API key match and no keypair to sign with');

  const { wallet, message, signature, signatureVerifiedLocally } = createMobileConnectPayload(keypair);
  if (!signatureVerifiedLocally) throw new Error('Imperial auth signature failed local ed25519 verification');
  const { code } = await connect({ wallet, message, signature }, opts);
  if (!code) throw new Error('Imperial /mobile/connect returned no code');
  const exchangeRes = await exchange(code, opts);
  const token = exchangeRes.jwt ?? exchangeRes.token ?? exchangeRes.accessToken;
  if (!token) throw new Error(`Imperial /mobile/exchange returned no jwt: ${JSON.stringify(exchangeRes)}`);
  _authCache.set(wallet, { token, pubkey: wallet, expiresAt: exchangeRes.expiresAt ?? null, fetchedAt: Date.now() });
  return { token, pubkey: wallet, expiresAt: exchangeRes.expiresAt, raw: exchangeRes };
}

// --- Routing (quote only, no side effects) ---
//
// Imperial's /route endpoint is a GET with query params. It returns the best
// venue for a given perp market + size + leverage, based on round-trip fees.
//
// Required query params (verified via scripts/imperial-route-probe7.mjs):
//   asset            base symbol, uppercase (e.g. "SOL", "BTC"). NOT a mint.
//   side             "long" | "short"
//   amount           collateral amount in base units of collateralAsset
//   collateralAsset  mint address of the collateral token (e.g. USDC mint)
//   notional         position size in USD (string)
//   desiredLeverage  desired leverage multiplier (string)
//   slippageBps      max slippage in bps (string)
export async function getRoute({
  asset,
  side,
  amount,
  collateralAsset,
  notional,
  desiredLeverage,
  slippageBps,
}, opts = {}) {
  return call('/route', {
    method: 'GET',
    query: { asset, side, amount, collateralAsset, notional, desiredLeverage, slippageBps },
    ...opts,
  });
}

// Snapshot of perp markets supported by Imperial as of the last enumeration
// run (scripts/imperial-route-probe7.mjs). venue + maxLeverage are best-effort
// hints: the live router may pick a different venue depending on size, and
// Imperial may add/remove markets over time. Treat as a routing whitelist, not
// a source of truth for live leverage caps.
// Re-enumerated via scripts/imperial-route-probe7.mjs (62 markets).
export const SUPPORTED_MARKETS = Object.freeze({
  // Crypto majors
  BTC:      { venue: 'gmtrade',     maxLeverage: 500 },
  ETH:      { venue: 'gmtrade',     maxLeverage: 294 },
  SOL:      { venue: 'gmtrade',     maxLeverage: 250 },
  BNB:      { venue: 'phoenix',     maxLeverage: 9.96 },
  XRP:      { venue: 'gmtrade',     maxLeverage: 250 },
  DOGE:     { venue: 'gmtrade',     maxLeverage: 200 },
  ADA:      { venue: 'gmtrade',     maxLeverage: 100 },
  AVAX:     { venue: 'gmtrade',     maxLeverage: 250 },
  TON:      { venue: 'phoenix',     maxLeverage: 9.96 },
  NEAR:     { venue: 'gmtrade',     maxLeverage: 100 },
  SUI:      { venue: 'phoenix',     maxLeverage: 9.96 },
  TRX:      { venue: 'gmtrade',     maxLeverage: 250 },
  LTC:      { venue: 'gmtrade',     maxLeverage: 100 },
  DOT:      { venue: 'gmtrade',     maxLeverage: 100 },
  BCH:      { venue: 'gmtrade',     maxLeverage: 100 },
  XLM:      { venue: 'gmtrade',     maxLeverage: 100 },
  HYPE:     { venue: 'gmtrade',     maxLeverage: 100 },
  LINK:     { venue: 'gmtrade',     maxLeverage: 100 },
  APE:      { venue: 'gmtrade',     maxLeverage: 100 },
  ZEC:      { venue: 'phoenix',     maxLeverage: 9.96 },
  // DeFi / Sol-eco
  ARB:      { venue: 'gmtrade',     maxLeverage: 100 },
  UNI:      { venue: 'gmtrade',     maxLeverage: 200 },
  AAVE:     { venue: 'gmtrade',     maxLeverage: 250 },
  GMX:      { venue: 'gmtrade',     maxLeverage: 100 },
  JTO:      { venue: 'phoenix',     maxLeverage: 4.99 },
  ENA:      { venue: 'phoenix',     maxLeverage: 9.96 },
  JUP:      { venue: 'phoenix',     maxLeverage: 9.96 },
  PYTH:     { venue: 'flash_trade', maxLeverage: 56.28 },
  KMNO:     { venue: 'flash_trade', maxLeverage: 53.57 },
  // Memes
  BONK:     { venue: 'gmtrade',     maxLeverage: 100 },
  PEPE:     { venue: 'gmtrade',     maxLeverage: 100 },
  SHIB:     { venue: 'gmtrade',     maxLeverage: 200 },
  BOME:     { venue: 'gmtrade',     maxLeverage: 100 },
  WIF:      { venue: 'gmtrade',     maxLeverage: 100 },
  FARTCOIN: { venue: 'gmtrade',     maxLeverage: 100 },
  TRUMP:    { venue: 'gmtrade',     maxLeverage: 100 },
  MELANIA:  { venue: 'gmtrade',     maxLeverage: 100 },
  PUMP:     { venue: 'gmtrade',     maxLeverage: 200 },
  PENGU:    { venue: 'flash_trade', maxLeverage: 28.95 },
  // AI / Privacy
  TAO:      { venue: 'phoenix',     maxLeverage: 4.99 },
  WLD:      { venue: 'gmtrade',     maxLeverage: 100 },
  // Equities (Imperial xStocks via flash_trade)
  TSLA:     { venue: 'flash_trade', maxLeverage: 24.39 },
  NVDA:     { venue: 'flash_trade', maxLeverage: 24.39 },
  AAPL:     { venue: 'flash_trade', maxLeverage: 24.39 },
  AMD:      { venue: 'flash_trade', maxLeverage: 24.39 },
  AMZN:     { venue: 'flash_trade', maxLeverage: 24.39 },
  SPY:      { venue: 'flash_trade', maxLeverage: 24.39 },
  // Commodities
  XAU:      { venue: 'gmtrade',     maxLeverage: 200 },
  XAG:      { venue: 'gmtrade',     maxLeverage: 200 },
  GOLD:     { venue: 'phoenix',     maxLeverage: 24.78 },
  SILVER:   { venue: 'phoenix',     maxLeverage: 24.78 },
  WTI:      { venue: 'gmtrade',     maxLeverage: 100 },
  CRUDEOIL: { venue: 'flash_trade', maxLeverage: 6.92 },
  NATGAS:   { venue: 'flash_trade', maxLeverage: 11.78 },
  COPPER:   { venue: 'phoenix',     maxLeverage: 19.86 },
  // Forex
  EUR:      { venue: 'gmtrade',     maxLeverage: 500 },
  GBP:      { venue: 'gmtrade',     maxLeverage: 500 },
  USDJPY:   { venue: 'gmtrade',     maxLeverage: 500 },
  USDCHF:   { venue: 'gmtrade',     maxLeverage: 500 },
  USDCAD:   { venue: 'gmtrade',     maxLeverage: 500 },
  AUD:      { venue: 'gmtrade',     maxLeverage: 500 },
  NZD:      { venue: 'gmtrade',     maxLeverage: 500 },
});

export function isSupportedMarket(symbol) {
  return Boolean(symbol && SUPPORTED_MARKETS[String(symbol).toUpperCase()]);
}


// --- Read-only ---
//
// Endpoint reality (verified via scripts/imperial-profile-probe.mjs +
// imperial-profile-probe2.mjs):
//   GET /mobile/balances                       -> { wallet, profiles: [...] }
//   GET /positions?walletAddress=<wallet>      -> { dataList: [...], ... }
//   GET /orders?walletAddress=<wallet>         -> { jupiterOrders, passthroughOrders, totalCount }
// Note: /mobile/positions and /mobile/orders are 404/405. The keyed-by-wallet
// `/positions` returns open positions across ALL profiles for that wallet,
// including legacy `source: jupiter_direct` ones.

// Hard floor: Imperial requires >= $10 USDC collateral per position regardless
// of venue. Enforced in imperialRouter.quoteIfEnabled before any /route call.
export const MIN_COLLATERAL_USD = 10;

const USDC_DECIMALS = 6;

// Returns { wallet, profiles: [{ profileIndex, profilePda, usdc }] }
// `usdc` is in base units (6 decimals). Divide by 1e6 for UI.
export async function getBalances(token, opts = {}) {
  return call('/mobile/balances', { token, ...opts });
}

// Convenience: pull a single profile (default index 0 = "Main") with its
// USDC balance already converted to UI units.
export async function getProfile({ profileIndex = 0, token, opts = {} } = {}) {
  const bal = await getBalances(token, opts);
  const p = bal.profiles?.find((x) => x.profileIndex === profileIndex);
  if (!p) throw new Error(`Imperial getProfile: no profile at index ${profileIndex}`);
  return {
    wallet: bal.wallet,
    profileIndex: p.profileIndex,
    profilePda: p.profilePda,
    usdcBase: p.usdc,
    usdcUi: p.usdc / 10 ** USDC_DECIMALS,
  };
}

// Open positions for a given wallet (NOT a profilePda — Imperial keys
// positions by the connected wallet). Returns the raw payload; callers
// typically only need .dataList.
export async function getPositions(walletAddress, { token, ...opts } = {}) {
  if (!walletAddress) throw new Error('getPositions: walletAddress required');
  return call('/positions', { query: { walletAddress }, token, ...opts });
}

// Pending limit / trigger orders for a wallet.
export async function getOrders(walletAddress, { token, ...opts } = {}) {
  if (!walletAddress) throw new Error('getOrders: walletAddress required');
  return call('/orders', { query: { walletAddress }, token, ...opts });
}

// --- Market lookup (per-venue marketMint resolution) ---
//
// /mobile/orders requires `marketMint` + numeric `underwriter`. The mint
// to send depends on the venue:
//   flash_trade -> market.marketAddress
//   gmtrade     -> market.market           (the GMX-style market PDA)
//   phoenix     -> market.orderbook
// Underwriter enum (verified against a live SOL/phoenix order):
//   0 = phoenix, 1 = flash_trade, 2 = gmtrade
//   (verified against live /mobile/orders error messages + working probe body)
//
// We fetch all three venue catalogs once and cache for MARKET_CACHE_TTL_MS.
// Each entry is keyed by `${symbol.toUpperCase()}:${side}:${venue}`.

const VENUE_ENDPOINTS = {
  flash_trade: '/flash/markets',
  gmtrade:     '/gmtrade/markets',
  phoenix:     '/phoenix/markets',
};

export const UNDERWRITER_ENUM = Object.freeze({
  jupiter:     0,
  flash_trade: 1,
  phoenix:     2,
  gmtrade:     3,
});

const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
let _marketCache = null; // { fetchedAt, byKey: Map, byVenue: { ... } }

function mintForVenueEntry(venue, entry) {
  switch (venue) {
    case 'flash_trade': return entry.marketAddress;
    case 'gmtrade':     return entry.market;
    case 'phoenix':     return entry.orderbook;
    default:            return null;
  }
}

async function fetchVenueMarkets(venue, opts = {}) {
  // These catalogs are public; no auth required, but call() will attach the
  // api key harmlessly if present.
  const raw = await call(VENUE_ENDPOINTS[venue], { method: 'GET', ...opts });
  if (!Array.isArray(raw)) throw new Error(`Imperial ${VENUE_ENDPOINTS[venue]} returned non-array`);
  return raw;
}

export async function fetchMarketLookup({ force = false, opts = {} } = {}) {
  const now = Date.now();
  if (!force && _marketCache && now - _marketCache.fetchedAt < MARKET_CACHE_TTL_MS) {
    return _marketCache;
  }
  const [flash, gm, phx] = await Promise.all([
    fetchVenueMarkets('flash_trade', opts),
    fetchVenueMarkets('gmtrade',     opts),
    fetchVenueMarkets('phoenix',     opts),
  ]);

  const byKey = new Map();
  const addAll = (venue, list) => {
    for (const entry of list) {
      const symbol = String(entry.symbol || '').toUpperCase();
      const mint = mintForVenueEntry(venue, entry);
      if (!symbol || !mint) continue;
      // gmtrade + flash_trade rows are side-specific. phoenix rows cover both
      // sides of the same orderbook.
      const sides = entry.side ? [String(entry.side).toLowerCase()] : ['long', 'short'];
      for (const side of sides) {
        byKey.set(`${symbol}:${side}:${venue}`, {
          symbol,
          side,
          venue,
          underwriter: UNDERWRITER_ENUM[venue],
          marketMint: mint,
          raw: entry,
        });
      }
    }
  };
  addAll('flash_trade', flash);
  addAll('gmtrade',     gm);
  addAll('phoenix',     phx);

  _marketCache = {
    fetchedAt: now,
    byKey,
    byVenue: { flash_trade: flash, gmtrade: gm, phoenix: phx },
  };
  return _marketCache;
}

// Resolve (symbol, side, venue) -> { marketMint, underwriter, raw }.
// `venue` defaults to the SUPPORTED_MARKETS hint for that symbol.
export async function resolveMarket(symbol, side, venue, opts = {}) {
  const sym = String(symbol || '').toUpperCase();
  const sd = String(side || '').toLowerCase();
  const v = venue || SUPPORTED_MARKETS[sym]?.venue;
  if (!v) throw new Error(`resolveMarket: no venue for symbol=${sym}`);
  if (!VENUE_ENDPOINTS[v]) throw new Error(`resolveMarket: unknown venue=${v}`);
  if (sd !== 'long' && sd !== 'short') throw new Error(`resolveMarket: bad side=${side}`);

  const lookup = await fetchMarketLookup({ opts });
  const hit = lookup.byKey.get(`${sym}:${sd}:${v}`);
  if (!hit) throw new Error(`resolveMarket: no market for ${sym}/${sd}/${v}`);
  return hit;
}

// --- Order helpers (gated; will only fire in later phases) ---
//
// placeOrder accepts a high-level descriptor and resolves the correct
// marketMint + underwriter per venue. Callers should pass `{ symbol, side,
// venue?, ...rest }`; the legacy shape (`{ marketMint, underwriter, ... }`)
// is still accepted for back-compat with anything that has already wired
// in raw mints.
export async function placeOrder(token, order, opts = {}) {
  if (!config.imperial.enabled || config.imperial.routingMode !== 'live') {
    throw new Error(`Imperial placeOrder blocked: enabled=${config.imperial.enabled} mode=${config.imperial.routingMode}`);
  }
  const body = await buildOrderBody(order, opts);
  try {
    const res = await call('/mobile/orders', { method: 'POST', token, body, ...opts });
    if (res && res.success === false) {
      console.warn(`[imperial:placeOrder] upstream success=false body=${JSON.stringify(body)} res=${JSON.stringify(res).slice(0, 600)}`);
    }
    return res;
  } catch (e) {
    console.warn(`[imperial:placeOrder] threw body=${JSON.stringify(body)} err=${e?.message || e}`);
    throw e;
  }
}

async function readMarkPriceUi(symbol, venue, opts = {}) {
  try {
    const sym = String(symbol || '').toUpperCase();
    const venueKey = venue || SUPPORTED_MARKETS[sym]?.venue;
    const res = await call('/mark-prices', { method: 'GET', ...opts });
    const rows = res?.rows || res?.data || (Array.isArray(res) ? res : []);
    const row = rows.find?.((r) => r.symbol === sym || r.asset === sym);
    const venuePrice = row?.[venueKey] ?? row?.venues?.[venueKey] ?? row?.prices?.[venueKey];
    const price = venuePrice?.price ?? venuePrice?.markPrice ?? row?.price ?? null;
    if (!price) return null;
    const n = Number(price);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    console.warn(`[imperial:markPrice] ${symbol}/${venue} failed: ${e?.message || e}`);
    return null;
  }
}

// Fetch mark price for (symbol, venue). Returns 9-decimal fixed point or null.
// Matches the shape used by scripts/imperial-order-probe.mjs.
export async function getMarkPrice(symbol, venue, opts = {}) {
  const price = await readMarkPriceUi(symbol, venue, opts);
  return price ? Math.round(price * 1_000_000_000) : null;
}

export async function getMarkPriceUi(symbol, venue, opts = {}) {
  return readMarkPriceUi(symbol, venue, opts);
}

// Exposed for tests / shadow-mode logging.
//
// Produces the EXACT body shape proven by scripts/imperial-order-probe.mjs.
// Imperial's /mobile/orders rejects requests that include extra fields like
// `marketMint`, `notional`, `desiredLeverage`, `collateralAsset`, `reduceOnly`
// (returns success:false / "Failed to place order"). We strip them here.
export async function buildOrderBody(order, opts = {}) {
  if (!order || typeof order !== 'object') throw new Error('placeOrder: order must be an object');
  const { symbol, side, venue, marketMint, underwriter, ...rest } = order;

  if (!symbol || !side) {
    throw new Error('placeOrder: must provide { symbol, side }');
  }
  const sym = String(symbol).toUpperCase();
  const resolved = (marketMint && underwriter !== undefined && underwriter !== null)
    ? { underwriter, venue: venue || null }
    : await resolveMarket(sym, side, venue, opts);

  const sideU8 = String(side).toLowerCase() === 'short' ? 1 : 0;

  let sizeUsd = rest.sizeUsd;
  if (sizeUsd === undefined || sizeUsd === null) {
    const n = Number(rest.notional);
    if (Number.isFinite(n) && n > 0) sizeUsd = Math.round(n * 1_000_000);
  }

  const body = {
    wallet: rest.wallet,
    symbol: sym,
    collateralAmount: rest.collateralAmount,
    sizeUsd,
    slippageBps: Number(rest.slippageBps ?? 100),
    side: sideU8,
    orderType: rest.orderType ?? 0,
    triggerCondition: rest.triggerCondition ?? 0,
    action: rest.action ?? 0,
    triggerPrice: rest.triggerPrice ?? 0,
    profileIndex: rest.profileIndex,
    priority: rest.priority ?? 0,
    fundingStatus: rest.fundingStatus ?? 0,
    underwriter: resolved.underwriter,
  };

  const venueKey = resolved.venue || venue;
  if (venueKey) {
    const mp = await getMarkPrice(sym, venueKey, opts);
    if (mp) body.marketPrice = mp;
  }

  // Pass through positionId for close/reduce orders (action=1).
  if (rest.positionId) body.positionId = rest.positionId;

  return body;
}

export { ImperialError };
