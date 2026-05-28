#!/usr/bin/env node
// Imperial /route discovery. Read-only, no funds at risk.
//
// Hits /route for one symbol per venue and diffs the per-venue payload
// shapes so we can see exactly which fields phoenix / flash_trade / jupiter
// expose that gmtrade does NOT. Those are the candidate extra fields we
// need to forward into /mobile/orders for non-gmtrade venues.
//
// Usage:
//   node keeper/scripts/imperial-route-discovery.mjs
//   node keeper/scripts/imperial-route-discovery.mjs JUP PYTH SOL BTC

import 'dotenv/config';
import { getRoute } from '../src/imperial.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// One representative symbol per venue per VENUE_BY_SYMBOL in imperial.js.
const DEFAULT_SYMBOLS = [
  'SOL',   // gmtrade (known-working)
  'JUP',   // phoenix
  'PYTH',  // flash_trade
  'BTC',   // gmtrade (large cap sanity)
];

// Walk an object and return a set of dotted key paths. Arrays are flattened
// to [*] so we don't get noise from index-specific keys.
function collectKeys(obj, prefix = '', out = new Set()) {
  if (obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectKeys(item, `${prefix}[*]`, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === 'object') collectKeys(v, path, out);
  }
  return out;
}

function banner(t) { console.log(`\n=== ${t} ===`); }

async function probe(symbol) {
  const params = {
    asset: symbol,
    side: 'long',
    amount: '10000000',          // $10 USDC collateral
    collateralAsset: USDC,
    notional: '20',              // 2x
    desiredLeverage: '2',
    slippageBps: '100',
  };
  try {
    const raw = await getRoute(params);
    return { symbol, ok: true, raw };
  } catch (err) {
    return { symbol, ok: false, error: err?.message || String(err) };
  }
}

async function main() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SYMBOLS;
  banner(`Probing /route for: ${symbols.join(', ')}`);

  const results = [];
  for (const s of symbols) {
    process.stdout.write(`  ${s}... `);
    const r = await probe(s);
    console.log(r.ok ? `venue=${r.raw?.venue ?? '?'}` : `FAILED (${r.error})`);
    results.push(r);
  }

  // Group by venue.
  const byVenue = new Map();
  for (const r of results) {
    if (!r.ok) continue;
    const v = r.raw?.venue || 'unknown';
    if (!byVenue.has(v)) byVenue.set(v, []);
    byVenue.get(v).push(r);
  }

  // Dump the full raw response per probe to a json file for offline diffing.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const outDir = path.resolve('keeper/scripts/.route-discovery');
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of results) {
    if (!r.ok) continue;
    const file = path.join(outDir, `${r.symbol}-${r.raw?.venue || 'unknown'}.json`);
    fs.writeFileSync(file, JSON.stringify(r.raw, null, 2));
    console.log(`  wrote ${file}`);
  }

  // Print top-level keys per venue.
  banner('Top-level keys per venue');
  for (const [venue, rs] of byVenue) {
    const keys = new Set();
    for (const r of rs) Object.keys(r.raw || {}).forEach((k) => keys.add(k));
    console.log(`  ${venue.padEnd(12)} ${[...keys].sort().join(', ')}`);
  }

  // Deep key diff: which dotted paths appear for non-gmtrade venues but
  // NOT for gmtrade? Those are our prime suspects for required extra fields.
  banner('Deep key diff vs gmtrade baseline');
  const gmtrade = byVenue.get('gmtrade') || [];
  if (!gmtrade.length) {
    console.log('  no gmtrade response captured, cannot diff');
  } else {
    const baseline = new Set();
    for (const r of gmtrade) collectKeys(r.raw, '', baseline);
    for (const [venue, rs] of byVenue) {
      if (venue === 'gmtrade') continue;
      const venueKeys = new Set();
      for (const r of rs) collectKeys(r.raw, '', venueKeys);
      const extra = [...venueKeys].filter((k) => !baseline.has(k)).sort();
      const missing = [...baseline].filter((k) => !venueKeys.has(k)).sort();
      console.log(`\n  --- ${venue} ---`);
      console.log(`  EXTRA fields (present in ${venue}, absent in gmtrade):`);
      if (!extra.length) console.log('    (none)');
      else for (const k of extra) console.log(`    + ${k}`);
      console.log(`  MISSING fields (present in gmtrade, absent in ${venue}):`);
      if (!missing.length) console.log('    (none)');
      else for (const k of missing) console.log(`    - ${k}`);
    }
  }

  banner('Done');
  console.log('Raw payloads saved in keeper/scripts/.route-discovery/');
  console.log('Inspect the EXTRA fields above. Those are the prime candidates');
  console.log('to forward into /mobile/orders for non-gmtrade venues.');
}

main().catch((e) => {
  console.error('\nDISCOVERY FAILED');
  console.error(e);
  process.exit(1);
});
