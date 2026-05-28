// Imperial /route discovery probe.
//
// Imperial's public docs don't publish the routing API spec, and our first
// attempt (POST /route with a JSON body) returned 405. This script hits a
// handful of likely shapes with a real API key and tiny SOL->USDC quote so
// we can see which one(s) Imperial actually accepts, then patch getRoute()
// to match in one shot.
//
// Run:  node scripts/imperial-route-probe.mjs

import { config } from '../src/config.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AMOUNT = '10000000';   // 0.01 SOL in lamports
const SLIPPAGE = '100';      // 1% in bps

const apiKey = config.imperial.apiKey;
const baseUrl = config.imperial.baseUrl;

if (!apiKey) {
  console.error('Missing IMPERIAL_API_KEY in .env');
  process.exit(1);
}

const baseQuery = new URLSearchParams({
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amount: AMOUNT,
  slippageBps: SLIPPAGE,
});

const jsonBody = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amount: AMOUNT,
  slippageBps: Number(SLIPPAGE),
};

const probes = [
  { label: 'GET /route?query',          method: 'GET',     path: `/route?${baseQuery}` },
  { label: 'GET /quote?query',          method: 'GET',     path: `/quote?${baseQuery}` },
  { label: 'GET /swap/quote?query',     method: 'GET',     path: `/swap/quote?${baseQuery}` },
  { label: 'GET /mobile/route?query',   method: 'GET',     path: `/mobile/route?${baseQuery}` },
  { label: 'GET /mobile/quote?query',   method: 'GET',     path: `/mobile/quote?${baseQuery}` },
  { label: 'GET /routing/quote?query',  method: 'GET',     path: `/routing/quote?${baseQuery}` },
  { label: 'OPTIONS /route',            method: 'OPTIONS', path: '/route' },
  { label: 'OPTIONS /quote',            method: 'OPTIONS', path: '/quote' },
  { label: 'POST /route (json body)',   method: 'POST',    path: '/route', body: jsonBody },
  { label: 'POST /quote (json body)',   method: 'POST',    path: '/quote', body: jsonBody },
];

function preview(text, max = 240) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…(${clean.length} chars)` : clean;
}

async function probe({ label, method, path, body }) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  };
  if (body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const allow = res.headers.get('allow') || res.headers.get('access-control-allow-methods') || '';
    console.log(
      `[${res.status}] ${label}` +
      (allow ? `  (allow: ${allow})` : '') +
      `\n        body: ${preview(text)}\n`
    );
  } catch (err) {
    console.log(`[ERR] ${label}\n        ${err.message}\n`);
  }
}

console.log(`Probing ${baseUrl} with apiKey ${apiKey.slice(0,8)}…${apiKey.slice(-6)}\n`);

for (const p of probes) {
  // run sequentially so output stays readable
  // eslint-disable-next-line no-await-in-loop
  await probe(p);
}

console.log('=== Done ===');
console.log('Look for a 200 (success), or a 400 with a body like');
console.log('"missing field X" — that tells us the real contract.');
