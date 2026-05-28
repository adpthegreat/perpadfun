// Round 2 — now that we know /mobile/balances works, probe the
// endpoints that need params or different methods.
// Run: cd keeper && node scripts/imperial-profile-probe2.mjs
import 'dotenv/config';

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const KEY = process.env.IMPERIAL_API_KEY;
if (!KEY) { console.error('IMPERIAL_API_KEY missing'); process.exit(1); }

function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${shape(v[0], depth + 1)} x${v.length}]`;
  }
  if (typeof v === 'object') {
    if (depth > 3) return '{…}';
    const keys = Object.keys(v).slice(0, 16);
    return `{ ${keys.map(k => `${k}: ${shape(v[k], depth + 1)}`).join(', ')}${Object.keys(v).length > 16 ? ', …' : ''} }`;
  }
  return typeof v;
}

async function hit(method, path, { body } = {}) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'x-api-key': KEY,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
    console.log(`\n[${res.status}] ${method} ${path}`);
    if (parsed !== null) {
      console.log(`  shape: ${shape(parsed)}`);
      console.log(`  sample: ${JSON.stringify(parsed).slice(0, 800)}`);
    } else {
      console.log(`  body: ${text.slice(0, 400)}`);
    }
  } catch (e) {
    console.log(`\n[ERR] ${method} ${path} — ${e.message}`);
  }
}

// Pull wallet + first non-empty profile from /mobile/balances first.
const balRes = await fetch(`${BASE}/mobile/balances`, {
  headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY, Accept: 'application/json' },
});
const balances = await balRes.json();
const wallet = balances.wallet;
const profile = balances.profiles?.find(p => p.usdc > 0) || balances.profiles?.[0];
console.log(`Using wallet=${wallet}`);
console.log(`Using profile=${profile?.profilePda} (index=${profile?.profileIndex}, usdc=${profile?.usdc})`);

// /positions variants
await hit('GET', `/positions?walletAddress=${wallet}`);
await hit('GET', `/positions?walletAddress=${profile.profilePda}`);
await hit('GET', `/mobile/positions?walletAddress=${wallet}`);
await hit('GET', `/mobile/positions?walletAddress=${profile.profilePda}`);
await hit('GET', `/mobile/positions?profilePda=${profile.profilePda}`);

// /orders — likely needs POST with body
await hit('GET', `/mobile/orders?walletAddress=${wallet}`);
await hit('GET', `/orders?walletAddress=${wallet}`);

// Deposit address discovery — try a few more shapes
await hit('GET', `/mobile/deposit-address?profilePda=${profile.profilePda}`);
await hit('GET', `/mobile/profile/${profile.profilePda}`);
await hit('GET', `/mobile/balances/${profile.profilePda}`);
