// Smoke test: pull all venue catalogs and resolve a handful of markets.
// Run: cd keeper && node scripts/imperial-market-lookup-smoke.mjs
import 'dotenv/config';
import { fetchMarketLookup, resolveMarket, SUPPORTED_MARKETS, UNDERWRITER_ENUM } from '../src/imperial.js';

const SAMPLES = [
  ['SOL',  'long'],   // gmtrade
  ['SOL',  'short'],
  ['BTC',  'long'],   // gmtrade
  ['TAO',  'long'],   // phoenix
  ['PYTH', 'long'],   // flash_trade
  ['TSLA', 'long'],   // flash_trade (equities)
  ['EUR',  'short'],  // forex
  ['BONK', 'long'],   // memes
];

const t0 = Date.now();
const lookup = await fetchMarketLookup({ force: true });
console.log(`Fetched in ${Date.now() - t0}ms`);
console.log(`  flash_trade rows: ${lookup.byVenue.flash_trade.length}`);
console.log(`  gmtrade     rows: ${lookup.byVenue.gmtrade.length}`);
console.log(`  phoenix     rows: ${lookup.byVenue.phoenix.length}`);
console.log(`  total keyed:      ${lookup.byKey.size}`);
console.log(`  underwriter enum:`, UNDERWRITER_ENUM);

console.log('\nResolutions:');
let ok = 0, fail = 0;
for (const [sym, side] of SAMPLES) {
  try {
    const r = await resolveMarket(sym, side);
    console.log(`  ✓ ${sym.padEnd(8)} ${side.padEnd(5)} venue=${r.venue.padEnd(11)} underwriter=${r.underwriter} mint=${r.marketMint}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${sym.padEnd(8)} ${side.padEnd(5)} ${e.message}`);
    fail++;
  }
}

// Sanity: every SUPPORTED_MARKETS symbol should resolve for at least one side.
console.log(`\nCoverage check across SUPPORTED_MARKETS (${Object.keys(SUPPORTED_MARKETS).length} symbols):`);
const missing = [];
for (const sym of Object.keys(SUPPORTED_MARKETS)) {
  try { await resolveMarket(sym, 'long'); } catch { missing.push(sym); }
}
if (missing.length) console.log(`  missing long-side resolution: ${missing.join(', ')}`);
else console.log('  all symbols resolve on long side ✓');

console.log(`\nSamples: ${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
