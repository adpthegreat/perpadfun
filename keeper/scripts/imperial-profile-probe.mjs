// Probe Imperial mobile endpoints to discover profile / balance / deposit /
// positions shapes. Run: cd keeper && node scripts/imperial-profile-probe.mjs
import 'dotenv/config';

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const KEY = process.env.IMPERIAL_API_KEY;
if (!KEY) { console.error('IMPERIAL_API_KEY missing'); process.exit(1); }

// Candidate endpoints. We will GET each and dump status + top-level shape.
// Add/remove freely as we learn more.
const PATHS = [
  '/mobile/profile',
  '/mobile/user',
  '/mobile/account',
  '/mobile/balance',
  '/mobile/balances',
  '/mobile/wallet',
  '/mobile/deposit',
  '/mobile/deposits',
  '/mobile/deposit-address',
  '/mobile/positions',
  '/mobile/orders',
  '/mobile/portfolio',
  '/profile',
  '/account',
  '/positions',
  '/balance',
];

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${shape(v[0], depth + 1)} x${v.length}]`;
  }
  if (typeof v === 'object') {
    if (depth > 2) return '{…}';
    const keys = Object.keys(v).slice(0, 12);
    return `{ ${keys.map(k => `${k}: ${shape(v[k], depth + 1)}`).join(', ')}${Object.keys(v).length > 12 ? ', …' : ''} }`;
  }
  return typeof v;
}

async function hit(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY, Accept: 'application/json' },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    console.log(`\n[${res.status}] GET ${path}`);
    if (parsed !== null) {
      console.log(`  shape: ${shape(parsed)}`);
      console.log(`  sample: ${JSON.stringify(parsed).slice(0, 600)}`);
    } else {
      console.log(`  body: ${text.slice(0, 400)}`);
    }
  } catch (e) {
    console.log(`\n[ERR] GET ${path} — ${e.message}`);
  }
}

console.log(`Probing ${BASE}`);
for (const p of PATHS) await hit(p);
console.log('\n=== Done ===');
