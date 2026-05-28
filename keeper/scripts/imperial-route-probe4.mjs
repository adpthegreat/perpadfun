// Probe Imperial /route adding `notional` and walk remaining required fields.
import 'dotenv/config';

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const KEY = process.env.IMPERIAL_API_KEY;
if (!KEY) { console.error('IMPERIAL_API_KEY missing'); process.exit(1); }

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER = '11111111111111111111111111111111';

const base = { asset: SOL, side: 'long', amount: '10000000', leverage: '2', collateralAsset: USDC };

const candidates = [
  { ...base, notional: '20' },
  { ...base, notional: '20000000' },
  { ...base, notional: '20', collateral: '10' },
  { ...base, notional: '20', collateralAmount: '10' },
  { ...base, notional: '20', slippageBps: '100' },
  { ...base, notional: '20', slippageBps: '100', user: USER },
  { ...base, notional: '20', slippageBps: '100', userPublicKey: USER },
  { ...base, notional: '20', slippageBps: '100', owner: USER },
  { asset: SOL, side: 'long', notional: '20', leverage: '2', collateralAsset: USDC, collateralAmount: '10' },
  { asset: SOL, side: 'long', notional: '20', leverage: '2', collateralAsset: USDC, userPublicKey: USER, slippageBps: '100' },
  // Try notional as USD vs base units variants
  { ...base, notional: '20.0' },
  { ...base, notional: '0.1' },
];

async function hit(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/route?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
  });
  const text = await res.text();
  console.log(`[${res.status}] ${JSON.stringify(params)}`);
  console.log(`        ${text.slice(0, 300)}\n`);
}

console.log(`Probing ${BASE}/route\n`);
for (const c of candidates) await hit(c);
console.log('=== Done ===');
