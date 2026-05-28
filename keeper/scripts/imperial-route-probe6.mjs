// Probe Imperial /route - figure out what `asset` accepts as a venue/symbol.
import 'dotenv/config';

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const KEY = process.env.IMPERIAL_API_KEY;
if (!KEY) { console.error('IMPERIAL_API_KEY missing'); process.exit(1); }

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BTC_MINT = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'; // wBTC (Wormhole)
const ETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'; // wETH (Wormhole)

const assets = [
  'SOL', 'sol', 'SOL-PERP', 'SOL_PERP', 'SOL/USDC', 'SOL-USD', 'SOLUSDC', 'SOLUSD', 'SOL-USDC',
  'BTC', 'BTC-PERP', 'ETH', 'ETH-PERP',
  BTC_MINT, ETH_MINT,
];

const baseParams = (asset) => ({
  asset,
  side: 'long',
  collateralAsset: USDC,
  notional: '20',
  desiredLeverage: '2',
  slippageBps: '100',
});

async function hit(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/route?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
  });
  const text = await res.text();
  console.log(`[${res.status}] asset=${params.asset}`);
  console.log(`        ${text.slice(0, 300)}\n`);
}

// Also probe discovery endpoints that might list supported venues/assets.
async function discover() {
  const paths = ['/venues', '/markets', '/assets', '/symbols', '/perps/markets', '/mobile/markets'];
  for (const p of paths) {
    try {
      const res = await fetch(`${BASE}${p}`, {
        headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY },
      });
      const text = await res.text();
      console.log(`[${res.status}] GET ${p}`);
      console.log(`        ${text.slice(0, 400)}\n`);
    } catch (e) { console.log(`ERR ${p}: ${e.message}`); }
  }
}

console.log(`Probing ${BASE}\n--- discovery ---`);
await discover();
console.log('--- asset variants on /route ---');
for (const a of assets) await hit(baseParams(a));
console.log('=== Done ===');
