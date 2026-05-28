// Phase 2b: discover Imperial /route's full query contract.
//
// First probe told us GET /route is the right shape but it wants `asset`,
// not `inputMint`/`outputMint`. This script peels the onion: start with the
// known-good base, add fields one at a time, print what the server complains
// about next. Each 400 "missing field X" tells us the next field to add.
//
// Run:  node scripts/imperial-route-probe2.mjs

import { config } from '../src/config.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const apiKey = config.imperial.apiKey;
const baseUrl = config.imperial.baseUrl;

if (!apiKey) {
  console.error('Missing IMPERIAL_API_KEY');
  process.exit(1);
}

// Each row is a candidate full param set; we'll iterate until one returns 200
// (or until errors stop being "missing field" and start being semantic).
const candidates = [
  { asset: SOL },
  { asset: SOL, amount: '10000000' },
  { asset: SOL, outputAsset: USDC, amount: '10000000' },
  { inputAsset: SOL, outputAsset: USDC, amount: '10000000' },
  { fromAsset: SOL, toAsset: USDC, amount: '10000000' },
  { asset: SOL, quote: USDC, amount: '10000000' },
  { asset: SOL, target: USDC, amount: '10000000' },
  { asset: SOL, output: USDC, amount: '10000000' },
  // with common siblings
  { asset: SOL, outputAsset: USDC, amount: '10000000', slippageBps: '100' },
  { asset: SOL, outputAsset: USDC, amount: '10000000', side: 'sell' },
  { asset: SOL, outputAsset: USDC, amount: '10000000', mode: 'swap' },
  { asset: SOL, outputAsset: USDC, amount: '10000000', userPublicKey: '11111111111111111111111111111111' },
];

function preview(t, max = 280) {
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…(${t.length})` : t;
}

async function hit(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${baseUrl}/route?${qs}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
  });
  const text = await res.text();
  console.log(`[${res.status}] params=${JSON.stringify(params)}`);
  console.log(`        body: ${preview(text)}\n`);
}

console.log(`Probing ${baseUrl}/route\n`);

for (const c of candidates) {
  // eslint-disable-next-line no-await-in-loop
  await hit(c);
}

console.log('=== Done ===');
console.log('Find first 200 (success) OR the deepest 400 — the body tells us the next field.');
