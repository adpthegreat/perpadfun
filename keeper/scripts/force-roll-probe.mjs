#!/usr/bin/env node
// Force a profile roll to a FRESH index (maxIndex+1) by passing an
// artificially tight usdcCap so every existing profile looks "full".
// Then deposits $15 into the new profile, opens a $10/2x SOL long, polls
// /positions for confirmation, and closes immediately.
//
// Cost: gas + ~$0.20 slippage on $10. Spends real funds.
//
// Usage:
//   node keeper/scripts/force-roll-probe.mjs
//   FORCED_CAP=1 node keeper/scripts/force-roll-probe.mjs   # override

import 'dotenv/config';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair } from '../src/wallet.js';
import { authenticate, getRoute } from '../src/imperial.js';
import { config } from '../src/config.js';
import { pickProfile, DEFAULT_MIN_USDC } from '../src/profileManager.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = config.imperial.baseUrl;
const UNDERWRITER_BY_VENUE = Object.freeze({ jupiter: 0, flash_trade: 1, phoenix: 2, gmtrade: 3 });
const SUPPORTED_VENUES = new Set(['gmtrade', 'jupiter']);
const FALLBACK_VENUE = 'gmtrade';

function banner(t) { console.log(`\n=== ${t} ===`); }
function usd6(n) { return Math.round(Number(n) * 1_000_000); }
const toUi = (b) => Number(b ?? 0) / 1_000_000;

async function rawRequest(method, path, token, body) {
  const headers = { Authorization: `Bearer ${token}`, 'x-api-key': config.imperial.apiKey || token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}
const rawPost = (p, t, b) => rawRequest('POST', p, t, b);
const rawGet  = (p, t)    => rawRequest('GET',  p, t);

async function getMarketPrice(token, symbol, venue) {
  const r = await rawGet('/mark-prices', token);
  const row = r.body?.rows?.find((x) => x.symbol === symbol || x.asset === symbol);
  const vp = row?.[venue] ?? row?.venues?.[venue] ?? row?.prices?.[venue];
  const price = vp?.price ?? vp?.markPrice ?? row?.price ?? null;
  return price ? Math.round(Number(price) * 1e9) : null;
}

let _passes = 0, _fails = 0;
function assert(name, cond, detail) {
  if (cond) { _passes++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else      { _fails++;  console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

async function main() {
  const kp = loadKeypair(config.treasuryKey);
  const wallet = kp.publicKey.toBase58();
  banner('Auth');
  const auth = await authenticate(kp);
  console.log({ pubkey: wallet });

  banner('Snapshot: balances + positions BEFORE');
  const balBefore = await rawGet('/mobile/balances', auth.token);
  const profilesBefore = balBefore.body?.profiles ?? [];
  const maxBefore = profilesBefore.length
    ? Math.max(...profilesBefore.map((p) => p.profileIndex))
    : -1;
  console.log(`existing profiles: ${profilesBefore.length}, maxIndex: ${maxBefore}`);
  for (const p of profilesBefore) console.log(`  profile ${p.profileIndex}: $${toUi(p.usdc).toFixed(2)}`);

  const positionsAll = await rawGet(`/positions?walletAddress=${wallet}`, auth.token);
  const openList = (Array.isArray(positionsAll.body)
    ? positionsAll.body
    : positionsAll.body?.dataList || positionsAll.body?.positions || positionsAll.body?.data || []
  ).filter((p) => p?.source === 'imperial' && (p?.status ?? 'open') === 'open');

  // Tight cap: anything >= $0.01 looks "full". Forces roll to maxIndex+1.
  const forcedCap = Number(process.env.FORCED_CAP ?? 0.01);
  banner(`pickProfile with caps.usdcCap=${forcedCap} (force-roll)`);
  const pick = pickProfile({
    profiles: profilesBefore,
    positions: openList,
    caps: { usdcCap: forcedCap },
  });
  console.log(`>>> picked profile ${pick.profileIndex} — ${pick.reason}`);
  console.log(`>>> needsDeposit=${pick.needsDeposit}, depositAmountUi=${pick.depositAmountUi}`);

  const expectedFresh = maxBefore + 1;
  assert('picked a fresh index (maxIndex+1)', pick.profileIndex === expectedFresh,
    `expected ${expectedFresh}, got ${pick.profileIndex}`);
  assert('needsDeposit=true on fresh profile', pick.needsDeposit === true);

  const profileIndex = pick.profileIndex;

  banner(`Depositing $${pick.depositAmountUi} into NEW profile ${profileIndex}`);
  const dep = await rawPost('/deposit/build-tx', auth.token, {
    wallet, profileIndex, amount: usd6(pick.depositAmountUi), mode: 'deposit',
  });
  console.log(`build-tx status: ${dep.status}`);
  if (dep.status < 200 || dep.status >= 300 || !dep.body?.transaction) {
    console.error('deposit build failed:', JSON.stringify(dep.body, null, 2));
    process.exit(1);
  }
  const conn = new Connection(config.rpcUrl, 'confirmed');
  const tx = VersionedTransaction.deserialize(Buffer.from(dep.body.transaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  console.log('deposit tx:', sig);
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) { console.error('deposit on-chain err:', conf.value.err); process.exit(1); }

  // Wait for indexer to see the new profile.
  let seen = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const b = await rawGet('/mobile/balances', auth.token);
    const pp = b.body?.profiles?.find((p) => p.profileIndex === profileIndex);
    seen = toUi(pp?.usdc);
    console.log(`  poll ${i + 1}: profile ${profileIndex} usdc = $${seen}`);
    if (seen >= DEFAULT_MIN_USDC) break;
  }
  assert(`Imperial indexer sees new profile ${profileIndex} funded`, seen >= DEFAULT_MIN_USDC,
    `usdc=$${seen}`);
  if (seen < DEFAULT_MIN_USDC) process.exit(1);

  banner('Route quote (SOL long, $10 / 2x)');
  const route = await getRoute({
    asset: 'SOL', side: 'long', amount: '10000000', collateralAsset: USDC,
    notional: '20', desiredLeverage: '2', slippageBps: '100',
  });
  let venue = process.env.FORCE_VENUE || route?.venue || FALLBACK_VENUE;
  if (!process.env.FORCE_VENUE && !SUPPORTED_VENUES.has(venue)) venue = FALLBACK_VENUE;
  const underwriter = UNDERWRITER_BY_VENUE[venue];
  console.log(`venue=${venue} underwriter=${underwriter}`);

  const marketPrice = await getMarketPrice(auth.token, 'SOL', venue);

  const openBody = {
    wallet, symbol: 'SOL',
    collateralAmount: 10_000_000, sizeUsd: usd6(20),
    slippageBps: 100, side: 0, orderType: 0, triggerCondition: 0, action: 0,
    triggerPrice: 0, profileIndex, priority: 0, fundingStatus: 0, underwriter,
  };
  if (marketPrice) openBody.marketPrice = marketPrice;

  banner(`POST /mobile/orders OPEN on profile ${profileIndex}`);
  const openRes = await rawPost('/mobile/orders', auth.token, openBody);
  console.log(`status: ${openRes.status}`);

  const tOpen = Math.floor(Date.now() / 1000) - 30;
  banner('Polling /positions for fresh SOL long on new profile');
  let pos = null, positions = { body: {} };
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    positions = await rawGet(`/positions?walletAddress=${wallet}`, auth.token);
    const list = Array.isArray(positions.body)
      ? positions.body
      : positions.body?.dataList || positions.body?.positions || positions.body?.data || [];
    pos = list.find((p) =>
      (p.symbol || p.asset) === 'SOL'
      && (p.side === 'long' || p.side === 0)
      && p.source === 'imperial'
      && p.status === 'open'
      && Number(p.openedAt ?? 0) >= tOpen
    );
    console.log(`  poll ${i + 1}: match=${pos ? 'YES' : 'no'}${pos ? ` (profileIndex=${pos.profileIndex})` : ''}`);
    if (pos) break;
  }
  assert('open position appeared', !!pos);
  assert('position tagged with new profileIndex',
    pos && Number(pos.profileIndex) === profileIndex,
    pos ? `got profileIndex=${pos.profileIndex}, expected ${profileIndex}` : '');

  if (pos) {
    banner('POST /mobile/orders CLOSE');
    const closeRes = await rawPost('/mobile/orders', auth.token, {
      ...openBody, action: 1,
      positionId: pos.id || pos.positionId || pos.position_id,
    });
    console.log(`status: ${closeRes.status}`);
  }

  banner(`Result: ${_passes} passed, ${_fails} failed`);
  process.exit(_fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nPROBE FAILED'); console.error(e); process.exit(1); });
