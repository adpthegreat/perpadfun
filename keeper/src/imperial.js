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

// Thin string-returning wrapper over authenticate(). Auth is already cached
// per-wallet inside authenticate (_authCache, 30-min refresh), so callers that
// only need the JWT can use this without managing a second cache.
export async function getAuthToken(keypair, opts = {}) {
  const r = await authenticate(keypair, opts);
  return r.token;
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

// ============================================================================
// SUPPORTED_MARKETS — Phoenix-only routing whitelist
// ============================================================================
//
// Per plan/KEEPER_PHOENIX_LOCK.md: every market routes to Phoenix. Other
// venues (gmtrade, flash_trade, jupiter) are deprecated for new positions
// (the helpers remain in repo as legacy fallbacks only).
//
// SNAPSHOT SOURCE: /phoenix/markets (Imperial authenticated endpoint).
// Captured 2026-06-03 via test/live/discover-phoenix-markets.live.test.ts.
// Re-run that test whenever Phoenix adds / removes a market.
//
// The project's primary asset list (per UI): BTC, ETH, SOL, ZEC, HYPE,
// SILVER, GOLD, OIL. All 8 supported on Phoenix; OIL aliases WTIOIL.
//
// CAVEAT: maxLeverage is the venue ceiling. Token creators pick anything
// up to this number; the keeper clamps if a creator-chosen leverage exceeds it.
// ============================================================================
// Frozen seed: the last hand-pinned snapshot. SUPPORTED_MARKETS (below) is
// seeded from this and then kept fresh at runtime by marketSync.js (every 36h)
// so a new Phoenix market like NVDA/TSLA appears without a hand-edit + redeploy.
const SUPPORTED_MARKETS_SNAPSHOT = Object.freeze({
  // ─── Primary (UI-prominent) ───
  BTC:      { venue: 'phoenix', maxLeverage: 40 },
  ETH:      { venue: 'phoenix', maxLeverage: 25 },
  SOL:      { venue: 'phoenix', maxLeverage: 25 },
  ANSEM:    { venue: 'phoenix', maxLeverage: 3 },
  SPCX:   { venue: 'phoenix', maxLeverage: 15 },                  // direct passthrough
  ZEC:      { venue: 'phoenix', maxLeverage: 10 },
  HYPE:     { venue: 'phoenix', maxLeverage: 10 },
  SILVER:   { venue: 'phoenix', maxLeverage: 25 },
  GOLD:     { venue: 'phoenix', maxLeverage: 25 },
  OIL:      { venue: 'phoenix', maxLeverage: 20, alias: 'WTIOIL' }, // Phoenix calls it WTIOIL
  WTIOIL:   { venue: 'phoenix', maxLeverage: 20 },  
  NVDA:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  AAPL:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  GOOGL:  { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  TSLA:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  MU:     { venue: 'phoenix', maxLeverage: 15 },                  // direct passthrough
  MSFT:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  META:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  AMZN:   { venue: 'phoenix', maxLeverage: 20 },                  // direct passthrough
  SNDK:   { venue: 'phoenix', maxLeverage: 15 },                  // direct passthrough
  AMD:    { venue: 'phoenix', maxLeverage: 10 },                  // direct passthrough
  INTC:   { venue: 'phoenix', maxLeverage: 10 },                  // direct passthrough
  CRWV:   { venue: 'phoenix', maxLeverage: 10 },                  // direct passthrough

  // ─── Other crypto majors ───
  XRP:      { venue: 'phoenix', maxLeverage: 15 },
  BNB:      { venue: 'phoenix', maxLeverage: 10 },
  DOGE:     { venue: 'phoenix', maxLeverage: 10 },
  ADA:      { venue: 'phoenix', maxLeverage: 10 },
  SUI:      { venue: 'phoenix', maxLeverage: 10 },
  TRX:      { venue: 'phoenix', maxLeverage: 10 },
  NEAR:     { venue: 'phoenix', maxLeverage: 10 },
  TON:      { venue: 'phoenix', maxLeverage: 10 },
  XLM:      { venue: 'phoenix', maxLeverage: 5 },
  XPL:      { venue: 'phoenix', maxLeverage: 10 },

  // ─── DeFi / Sol-eco ───
  AAVE:     { venue: 'phoenix', maxLeverage: 10 },
  JTO:      { venue: 'phoenix', maxLeverage: 5 },
  JUP:      { venue: 'phoenix', maxLeverage: 10 },
  ENA:      { venue: 'phoenix', maxLeverage: 10 },
  ONDO:     { venue: 'phoenix', maxLeverage: 10 },
  MORPHO:   { venue: 'phoenix', maxLeverage: 5 },
  LIT:      { venue: 'phoenix', maxLeverage: 5 },

  // ─── AI / data ───
  FET:      { venue: 'phoenix', maxLeverage: 5 },
  RENDER:   { venue: 'phoenix', maxLeverage: 5 },
  VIRTUAL:  { venue: 'phoenix', maxLeverage: 5 },
  TAO:      { venue: 'phoenix', maxLeverage: 5 },
  WLD:      { venue: 'phoenix', maxLeverage: 10 },

  // ─── Memes / misc ───
  FARTCOIN: { venue: 'phoenix', maxLeverage: 10 },
  CHIP:     { venue: 'phoenix', maxLeverage: 5 },
  SKR:      { venue: 'phoenix', maxLeverage: 3 },
  MEGA:     { venue: 'phoenix', maxLeverage: 5 },
  MET:      { venue: 'phoenix', maxLeverage: 5 },
  VVV:      { venue: 'phoenix', maxLeverage: 5 },
  MON:      { venue: 'phoenix', maxLeverage: 5 },

  // ─── Commodities ───
  COPPER:   { venue: 'phoenix', maxLeverage: 20 },
});

// Live, mutable catalog seeded from the snapshot. marketSync.js mutates this
// object IN PLACE (never reassigns) so every consumer reading
// SUPPORTED_MARKETS[sym] at call time picks up new markets without a redeploy.
export const SUPPORTED_MARKETS = { ...SUPPORTED_MARKETS_SNAPSHOT };

// Upsert the live catalog from a freshly fetched/loaded map
// { SYM: { venue, maxLeverage, alias? } }. Upsert-only by default (safe):
// removals are handled as soft (DB active=false) so a market briefly missing
// from the feed never breaks venue resolution for already-open positions.
// Returns { changed, added: [...], updated: [...] }.
export function applyMarketCatalog(next, { prune = false } = {}) {
  const added = [];
  const updated = [];
  if (!next || typeof next !== 'object') return { changed: false, added, updated };
  for (const [rawSym, v] of Object.entries(next)) {
    if (!v || !Number.isFinite(Number(v.maxLeverage))) continue;
    const sym = String(rawSym).toUpperCase();
    const entry = {
      venue: v.venue ?? 'phoenix',
      maxLeverage: Number(v.maxLeverage),
      ...(v.alias ? { alias: v.alias } : {}),
    };
    const cur = SUPPORTED_MARKETS[sym];
    if (!cur) {
      added.push(sym);
      SUPPORTED_MARKETS[sym] = entry;
    } else if (cur.maxLeverage !== entry.maxLeverage || cur.venue !== entry.venue) {
      updated.push(sym);
      SUPPORTED_MARKETS[sym] = entry;
    }
    // identical entry -> leave it untouched (no write)
  }
  if (prune) {
    const keep = new Set(Object.keys(next).map((s) => s.toUpperCase()));
    for (const sym of Object.keys(SUPPORTED_MARKETS)) {
      if (!keep.has(sym)) delete SUPPORTED_MARKETS[sym];
    }
  }
  return { changed: added.length > 0 || updated.length > 0, added, updated };
}

export function isSupportedMarket(symbol) {
  return Boolean(symbol && SUPPORTED_MARKETS[String(symbol).toUpperCase()]);
}

// Normalize an input symbol to the venue's canonical market symbol, resolving
// aliases (e.g. OIL -> WTIOIL, which is what Phoenix calls it). Unknown symbols
// pass through uppercased.
export function marketSymbol(symbol) {
  const sym = String(symbol ?? "").toUpperCase();
  return SUPPORTED_MARKETS[sym]?.alias ?? sym;
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
//
// Phoenix-locked after KEEPER_PHOENIX_LOCK.md Phase B: when no explicit
// venue is passed, default to 'phoenix' instead of consulting
// SUPPORTED_MARKETS. Operator can override with the IMPERIAL_VENUE_OVERRIDE
// env (set it to a venue name to force, or 'auto' to restore the previous
// SUPPORTED_MARKETS lookup behavior).
export async function resolveMarket(symbol, side, venue, opts = {}) {
  const sym = String(symbol || '').toUpperCase();
  const sd = String(side || '').toLowerCase();
  const override = process.env.IMPERIAL_VENUE_OVERRIDE;
  const v =
    venue ||
    (override && override !== 'auto' ? override : null) ||
    (override === 'auto' ? SUPPORTED_MARKETS[sym]?.venue : 'phoenix');
  if (!v) throw new Error(`resolveMarket: no venue for symbol=${sym}`);
  if (!VENUE_ENDPOINTS[v]) throw new Error(`resolveMarket: unknown venue=${v}`);
  if (sd !== 'long' && sd !== 'short') throw new Error(`resolveMarket: bad side=${side}`);

  const lookup = await fetchMarketLookup({ opts });
  const hit = lookup.byKey.get(`${sym}:${sd}:${v}`);
  if (!hit) throw new Error(`resolveMarket: no market for ${sym}/${sd}/${v}`);
  return hit;
}

// --- Order helpers (gated; will only fire in later phases) ---
// ============================================================================
// Phoenix profile registration
// ============================================================================
//
// Phoenix requires a one-time /phoenix/register call per (wallet,profileIndex)
// before /mobile/orders works. It's idempotent server-side, so re-registering
// is fine. We cache successes in a process-local Set so we only hit the
// endpoint once per keeper boot per profile.
//
// Per KEEPER_PHOENIX_LOCK.md Phase C.
const PHOENIX_REGISTERED = new Set();

function phoenixRegisterCacheKey(wallet, profileIndex) {
  return `${wallet}:${profileIndex ?? 0}`;
}

/**
 * Idempotently activate the Phoenix profile for (wallet, profileIndex).
 * Safe to call before every open — succeeds fast on the cache-hit path.
 * Returns { activated, profilePda, message, cached } or null on failure.
 * Never throws — Imperial says /mobile/orders auto-activates on first use,
 * so a register failure here just degrades to the OpenAPI fallback path.
 */
export async function ensurePhoenixRegistered({ wallet, profileIndex = 0 } = {}) {
  if (!wallet) return null;
  const key = phoenixRegisterCacheKey(wallet, profileIndex);
  if (PHOENIX_REGISTERED.has(key)) {
    return { activated: true, cached: true, profilePda: null, message: 'cache-hit' };
  }
  try {
    const res = await call('/phoenix/register', {
      method: 'POST',
      body: { wallet, profileIndex },
    });
    PHOENIX_REGISTERED.add(key);
    return {
      activated: Boolean(res?.activated ?? true),
      cached: false,
      profilePda: res?.profilePda ?? null,
      message: res?.message ?? 'registered',
    };
  } catch (e) {
    console.warn(
      `[imperial:phoenix-register] wallet=${String(wallet).slice(0, 8)}... ` +
        `profile=${profileIndex} failed (continuing — /mobile/orders auto-activates): ${e?.message || e}`,
    );
    return null;
  }
}

/** Test-only — clear the in-process register cache (e.g. on wallet rotation). */
export function __clearPhoenixRegisterCache() {
  PHOENIX_REGISTERED.clear();
}

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

// Map our internal venue identifier to the row key used by Imperial's
// /mark-prices response. The API uses `flash` not `flash_trade`.
function markPriceVenueKey(venue) {
  if (venue === 'flash_trade') return 'flash';
  return venue;
}

async function readMarkPriceUi(symbol, venue, opts = {}) {
  try {
    const sym = String(symbol || '').toUpperCase();
    const venueKey = markPriceVenueKey(venue || SUPPORTED_MARKETS[sym]?.venue);
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

// Parse `FLASH_PRICE_EXPONENTS="SOL=6,BTC=2,ETH=4"` into a per-symbol exponent map.
// Each symbol's value is `10^exp` for the marketPrice field on flash_trade orders.
// See plan/KEEPER_PHOENIX_MIGRATION.md §1.1 for the bug history.
function parseFlashPriceExponents(s) {
  if (!s) return {};
  const out = {};
  for (const part of String(s).split(',')) {
    const [sym, exp] = part.split('=');
    if (sym && exp !== undefined) {
      const n = Number(exp);
      if (Number.isFinite(n)) out[sym.trim().toUpperCase()] = n;
    }
  }
  return out;
}
const FLASH_PRICE_EXPONENTS = parseFlashPriceExponents(process.env.FLASH_PRICE_EXPONENTS);

// Per-venue marketPrice scaling from the canonical 1e9 oracle scale.
//
// Imperial's /mark-prices returns prices in a uniform 1e9 oracle scale (we
// internally call this `base = uiPrice × 1e9`), but each venue's order
// processor expects a different on-chain decimal layout:
//
//   - gmtrade / jupiter: read raw 1e9                              -> no scale
//   - phoenix:           frontend sends 1e6; downstream ×1000 makes 1e9
//                        on-chain. So we send 1e6 (divide by 1000).
//   - flash_trade:       per-market Pyth-style exponent. The market metadata
//                        reports a NEGATIVE `priceExponent` (e.g. HYPE=-8,
//                        XAU=-3) which means the on-chain integer is
//                        `uiPrice × 10^(-priceExponent)`. Read from
//                        FLASH_PRICE_EXPONENTS env ("HYPE=-8,SOL=-8,XAU=-3").
//                        See scripts/fetch-flash-markets or the live
//                        discover-flash-exponents test to populate the env.
//
// Conversion from our `base = uiPrice × 1e9` representation:
//   target = base × 10^(-priceExp − 9)
//   (e.g. priceExp=-8 -> base × 10^-1 = base / 10)
//
// Without this scaling: Phoenix sees prices ~1000x too large -> CLOB rejects
// the IOC. Flash sees oracle mismatch. GMTrade is fine because base == 1e9.
function scaleMarketPriceForVenue(mp, venue, symbol) {
  if (!mp) return null;
  // Phoenix: frontend sends 1e6, downstream order bot ×1000 produces the
  // correct 1e9 on-chain. So we divide by 1000.
  if (venue === 'phoenix') return Math.round(mp / 1000);
  // Flash, GMTrade, Jupiter: asymmetric — Flash OPEN (action=0) accepts raw
  // 1e9 (verified 2026-06-02 sig=4gAxCax... and 2026-06-03 sig=6XrDVgik...),
  // but Flash CLOSE (action=1) silently rejects raw 1e9 — confirmed
  // empirically 2026-06-03 sig=2nac4MeQ6zQahHw2..., which succeeded by
  // scaling to per-market priceExponent (HYPE = -8 → divide by 10) AND
  // including the position's `positionPda` as `positionId` in the body.
  //
  // Recommended posture if Flash is ever re-enabled:
  //   1. Set FLASH_PRICE_EXPONENTS env covering every symbol you trade
  //      (e.g. "HYPE=-8,SOL=-8,BTC=-8,ETH=-8,ZEC=-8,GOLD=-3,SILVER=-5").
  //      The exponent makes BOTH open AND close work; raw 1e9 only works
  //      for open.
  //   2. Always pass `positionId` (the on-chain position PDA from
  //      /positions[*].positionPda) on close orders. The keeper's
  //      buildOrderBody already plumbs `positionId` through when present.
  //
  // Until then Flash stays gated behind FLASH_TESTS=1 + IMPERIAL_SUPPORTED_
  // OPEN_VENUES (Phoenix-only by default). See plan/KEEPER_PHOENIX_LOCK.md.
  if (venue === 'flash_trade') {
    const sym = String(symbol || '').toUpperCase();
    const priceExp = FLASH_PRICE_EXPONENTS[sym];
    if (priceExp === undefined) return mp; // raw 1e9 default — open works, close won't
    // base = uiPrice × 1e9; on-chain target = uiPrice × 10^(−priceExp)
    return Math.round(mp * Math.pow(10, -priceExp - 9));
  }
  return mp;
}

// Fetch mark price for (symbol, venue). Returns a venue-scaled fixed-point
// integer or null. The base oracle scale is 1e9; per-venue scaling is applied
// inside scaleMarketPriceForVenue.
export async function getMarkPrice(symbol, venue, opts = {}) {
  const price = await readMarkPriceUi(symbol, venue, opts);
  if (!price) return null;
  const base = Math.round(price * 1_000_000_000);
  return scaleMarketPriceForVenue(base, venue, symbol);
}

// Exposed for tests so they can verify the scaling logic without hitting
// the live /mark-prices endpoint.
export const __scaleMarketPriceForVenue = scaleMarketPriceForVenue;
export const __FLASH_PRICE_EXPONENTS = FLASH_PRICE_EXPONENTS;

export async function getMarkPriceUi(symbol, venue, opts = {}) {
  return readMarkPriceUi(symbol, venue, opts);
}

// Safe wrapper: live mark price in UI units, or null on any error / non-positive
// value. Used by the keeper for PnL marks where a feed blip must not throw.
export async function getMarkPriceUiSafe(symbol, venue, opts = {}) {
  try {
    const mark = Number(await getMarkPriceUi(symbol, venue, opts));
    return Number.isFinite(mark) && mark > 0 ? mark : null;
  } catch (e) {
    console.warn(`[imperial:mark] ${symbol} live mark failed:`, e.message);
    return null;
  }
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
