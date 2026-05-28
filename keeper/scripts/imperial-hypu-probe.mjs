// One-shot probe: read all Imperial profiles for a token's sub-wallet.
// Run from keeper/: node scripts/imperial-hypu-probe.mjs [TICKER]
//
// Uses the keeper's existing perpad HTTP client (no @supabase/supabase-js needed).
import 'dotenv/config';
import { listActiveTokens } from '../src/perpad.js';
import { loadKeypair, walletForToken } from '../src/wallet.js';
import { authenticate, getBalances, getPositions, getOrders } from '../src/imperial.js';
import { config } from '../src/config.js';

const TICKER = (process.argv[2] ?? 'HYPU').toUpperCase();
console.log(`[probe] starting for ${TICKER}`);

async function main() {
  for (const k of ['PERPAD_BASE_URL', 'KEEPER_SECRET', 'TREASURY_SOLANA_PRIVATE_KEY']) {
    console.log(`  env ${k}: ${process.env[k] ? 'set' : 'MISSING (using default if any)'}`);
  }
  console.log(`  perpadBaseUrl: ${config.perpadBaseUrl}`);

  console.log(`\n[probe] fetching token list from perpad...`);
  const url = `${config.perpadBaseUrl}/api/public/keeper/tokens`;
  console.log(`  GET ${url}`);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'x-keeper-secret': config.keeperSecret },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`fetch failed after ${Date.now() - t0}ms: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  console.log(`  status=${res.status} bytes=${text.length} elapsed=${Date.now() - t0}ms`);
  if (!res.ok) {
    console.log(`  body: ${text.slice(0, 500)}`);
    throw new Error(`tokens endpoint returned ${res.status}`);
  }
  const json = JSON.parse(text);
  const tokens = json.tokens ?? [];
  console.log(`  got ${tokens.length} tokens`);
  const token = tokens.find((t) => (t.ticker ?? '').toUpperCase() === TICKER);
  if (!token) {
    console.log(`  available tickers: ${tokens.map((t) => t.ticker).join(', ')}`);
    throw new Error(`token ${TICKER} not in active list`);
  }

  console.log(`\ntoken: ${token.ticker} (${token.id})`);
  console.log(`  sub wallet (db): ${token.treasury_wallet_address}`);
  console.log(`  profile_index: ${token.imperial_profile_index}`);
  console.log(`  profile_pda (db): ${token.imperial_profile_pda}`);
  console.log(`  fees_accrued_usd: ${token.fees_accrued_usd}`);

  const master = loadKeypair(config.treasuryKey);
  const kp = walletForToken(master, token);
  console.log(`\nderived sub wallet: ${kp.publicKey.toBase58()}`);
  if (kp.publicKey.toBase58() !== token.treasury_wallet_address) {
    console.log(`  WARNING: derived != db (master key rotated?)`);
  }

  console.log(`\n[probe] authenticating with Imperial...`);
  const auth = await authenticate(kp);
  const jwt = auth.token;
  const bal = await getBalances(jwt);
  console.log(`\nIMPERIAL /mobile/balances wallet=${bal.wallet}`);
  console.log(`  profiles: ${bal.profiles?.length ?? 0}`);
  for (const p of (bal.profiles ?? [])) {
    console.log(`  [${p.profileIndex}] pda=${p.profilePda}  usdc=$${(Number(p.usdc) / 1e6).toFixed(4)}`);
  }

  const pos = await getPositions(bal.wallet, { token: jwt });
  console.log(`\nopen positions: ${pos.dataList?.length ?? 0}`);
  for (const p of (pos.dataList ?? [])) {
    console.log(`  - ${p.asset} ${p.side} src=${p.source} size=$${Number(p.sizeUsd ?? 0).toFixed(2)} coll=$${Number(p.collateralUsd ?? 0).toFixed(2)}`);
  }

  const ord = await getOrders(bal.wallet, { token: jwt });
  console.log(`\npending orders: total=${ord.totalCount} jupiter=${ord.jupiterOrders?.length ?? 0} passthrough=${ord.passthroughOrders?.length ?? 0}`);
}

main().catch((err) => {
  console.error('\n[probe] FAILED:', err?.stack || err?.message || err);
  process.exit(1);
});
