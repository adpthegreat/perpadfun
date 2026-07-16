// Price feeds for the treasury flywheel.
//
// Primary source: Pyth Hermes HTTP API (free, no key, no SDK, no subscription).
// Fallback source: Jupiter price API. A temporary Pyth 503 must not freeze fee
// claims for every token, so we fall back and then keep a short-lived cache.

const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';
const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
const PRICE_TIMEOUT_MS = Number(process.env.PRICE_TIMEOUT_MS ?? '8000');
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS ?? '300000');

// Pyth mainnet feed ids (0x-prefixed hex). Source: pyth.network/developers/price-feed-ids
export const PYTH_FEEDS = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
};

const JUP_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
};

const _cache = new Map();

function shortBody(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function fetchJsonWithTimeout(url, label) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PRICE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} ${res.status}: ${shortBody(text)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function remember(symbol, price, source) {
  _cache.set(symbol, { price, source, at: Date.now() });
  return price;
}

function cached(symbol) {
  const item = _cache.get(symbol);
  if (!item || Date.now() - item.at > PRICE_CACHE_TTL_MS) return null;
  console.warn(`[prices] ${symbol}/USD using cached ${item.source} price ${item.price}`);
  return item.price;
}

async function fetchPythPrice(feedId) {
  const url = `${HERMES}?ids[]=${feedId}`;
  const json = await fetchJsonWithTimeout(url, 'pyth');
  const item = json?.parsed?.[0];
  if (!item) throw new Error('pyth: empty parsed array');
  const p = item.price;
  // Pyth prices come as { price: "12345", expo: -8, ... }. Real value = price * 10^expo.
  const price = Number(p.price) * Math.pow(10, Number(p.expo));
  if (!isFinite(price) || price <= 0) throw new Error(`pyth: invalid price ${p.price}@${p.expo}`);
  return price;
}

async function fetchJupiterPrice(symbol) {
  const mint = JUP_MINTS[symbol];
  if (!mint) throw new Error(`jupiter: no mint configured for ${symbol}`);
  const json = await fetchJsonWithTimeout(`${JUP_PRICE}?ids=${mint}`, 'jupiter price');
  const price = Number(json?.[mint]?.usdPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`jupiter: invalid ${symbol} price`);
  return price;
}

export async function getSolUsd() {
  return getUsdPriceFor('SOL');
}

export async function getUsdPriceFor(symbol) {
  const sym = symbol.toUpperCase();
  const id = PYTH_FEEDS[sym];
  if (!id) throw new Error(`no pyth feed configured for ${sym}`);

  try {
    return remember(sym, await fetchPythPrice(id), 'pyth');
  } catch (pythErr) {
    try {
      const price = await fetchJupiterPrice(sym);
      console.warn(`[prices] ${sym}/USD pyth unavailable (${pythErr.message}); using Jupiter ${price}`);
      return remember(sym, price, 'jupiter');
    } catch (jupErr) {
      const fallback = cached(sym);
      if (fallback) return fallback;
      throw new Error(`${sym} price unavailable. pyth=${pythErr.message}; jupiter=${jupErr.message}`);
    }
  }
}

// USD price for an ARBITRARY SPL mint via Jupiter price v3 (accepts any mint —
// unlike getUsdPriceFor which is symbol/feed-gated). Cached like the others.
// Returns 0 on failure so the caller can decide (e.g. skip the USD gate).
export async function getMintUsdPrice(mint) {
  if (!mint) return 0;
  const key = `mint:${mint}`;
  try {
    const json = await fetchJsonWithTimeout(`${JUP_PRICE}?ids=${mint}`, 'jupiter price');
    const price = Number(json?.[mint]?.usdPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`invalid price for ${mint}`);
    return remember(key, price, 'jupiter');
  } catch (e) {
    const fallback = cached(key);
    if (fallback) return fallback;
    console.warn(`[prices] mint ${mint}/USD unavailable: ${e.message}`);
    return 0;
  }
}

// Given a swap that traded `solIn` SOL for `tokensOut` of an SPL mint,
// the implied per-token USD price is (solIn * solUsd) / tokensOut.
export function impliedTokenUsd({ solIn, tokensOut, solUsd }) {
  if (!tokensOut || tokensOut <= 0) return 0;
  return (solIn * solUsd) / tokensOut;
}
