// Probe Imperial /route - add desiredLeverage, keep walking required fields.
import 'dotenv/config';

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const KEY = process.env.IMPERIAL_API_KEY;
if (!KEY) { console.error('IMPERIAL_API_KEY missing'); process.exit(1); }

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER = '11111111111111111111111111111111';

const base = {
  asset: SOL,
  side: 'long',
  amount: '10000000',
  collateralAsset: USDC,
  notional: '20',
  desiredLeverage: '2',
};

const candidates = [
  base,
  { ...base, slippageBps: '100' },
  { ...base, slippageBps: '100', userPublicKey: USER },
  { ...base, slippageBps: '100', user: USER },
  { ...base, slippageBps: '100', owner: USER },
  { ...base, slippageBps: '100', wallet: USER },
  { ...base, slippageBps: '100', trader: USER },
  // try without `amount` since notional may replace it
  { asset: SOL, side: 'long', collateralAsset: USDC, notional: '20', desiredLeverage: '2', slippageBps: '100' },
  { asset: SOL, side: 'long', collateralAsset: USDC, notional: '20', desiredLeverage: '2', slippageBps: '100', userPublicKey: USER },
  // short side sanity
  { ...base, side: 'short', slippageBps: '100', userPublicKey: USER },
  // try numeric leverage variants
  { ...base, desiredLeverage: '2.0' },
  { ...base, desiredLeverage: '20000' },
];

async function hit(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/route?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
  });
  const text = await res.text();
  console.log(`[${res.status}] ${JSON.stringify(params)}`);
  console.log(`        ${text.slice(0, 400)}\n`);
}

console.log(`Probing ${BASE}/route\n`);
for (const c of candidates) await hit(c);
console.log('=== Done ===');
