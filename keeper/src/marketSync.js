// Phoenix market catalog auto-sync (plan/PHOENIX_MARKET_SYNC.md).
//
// Every config.marketSyncTickMs (default 36h) this fetches Imperial's
// /phoenix/markets and, if the catalog changed (new market like NVDA/TSLA or a
// changed max-leverage), refreshes the keeper's in-memory SUPPORTED_MARKETS so
// the routing list never needs a hand-edit. If unchanged it does nothing.
// In-memory only: a restart starts from the hardcoded snapshot and re-fetches
// shortly after boot. Gated by config.marketSyncEnabled.
import { config } from './config.js';
import { authenticate, SUPPORTED_MARKETS, applyMarketCatalog } from './imperial.js';
import { loadKeypair } from './wallet.js';
import { keeperLog } from './workflow.js';
import { limitedFetch } from './rateLimiter.js';

let _running = false;
let _lastSyncAt = null;

// Parse a /phoenix/markets response into { SYM: { venue, maxLeverage } }.
function buildCatalog(rows) {
  const cat = {};
  for (const m of rows ?? []) {
    if (!m || typeof m !== 'object') continue;
    const sym = String(m.symbol || m.asset || m.name || m.marketName || '').toUpperCase();
    const maxLev = Number(m.maxLeverage ?? m.max_leverage ?? m.leverage);
    if (!sym || !Number.isFinite(maxLev) || maxLev <= 0) continue;
    cat[sym] = { venue: 'phoenix', maxLeverage: maxLev };
  }
  return cat;
}

async function fetchPhoenixMarkets(token) {
  const base = config.imperial?.baseUrl || 'https://api.imperial.space/api/v1';
  const res = await limitedFetch(`${base}/phoenix/markets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    throw new Error(`phoenix/markets returned non-JSON (${res.status})`);
  }
  return Array.isArray(json) ? json : json?.rows || json?.data || Object.values(json ?? {});
}

export async function runMarketSyncTick() {
  if (!config.marketSyncEnabled) return { skipped: 'disabled' };
  if (_running) return { skipped: 'already-running' };
  _running = true;
  try {
    const kp = loadKeypair(config.treasuryKey);
    const auth = await authenticate(kp);
    const rows = await fetchPhoenixMarkets(auth.token);
    const candidate = buildCatalog(rows);
    const fetched = Object.keys(candidate).length;
    const current = Object.keys(SUPPORTED_MARKETS).length;

    // Sanity guard: never let a truncated/garbage response shrink the catalog.
    if (fetched < Math.max(8, Math.floor(current * 0.5))) {
      keeperLog(null, 'warn', 'phoenix market sync: implausible response, skipped', { fetched, current });
      return { skipped: 'too-few', fetched };
    }

    const res = applyMarketCatalog(candidate); // upsert-only (delistings stay soft)
    _lastSyncAt = new Date().toISOString();
    if (!res.changed) {
      keeperLog(null, 'info', 'phoenix catalog in sync', { count: fetched });
      return { changed: false, count: fetched };
    }
    keeperLog(null, 'warn', 'phoenix catalog refreshed', {
      added: res.added,
      updated: res.updated,
      count: fetched,
    });
    return { changed: true, added: res.added, updated: res.updated, count: fetched };
  } catch (e) {
    keeperLog(null, 'warn', 'phoenix market sync failed', { error: e.message });
    return { error: e.message };
  } finally {
    _running = false;
  }
}

export function getMarketSyncStatus() {
  return {
    enabled: config.marketSyncEnabled,
    tickMs: config.marketSyncTickMs,
    lastSyncAt: _lastSyncAt,
    running: _running,
    marketCount: Object.keys(SUPPORTED_MARKETS).length,
  };
}
