#!/usr/bin/env node
// Top-up probe: simulates what fees.js will do when a fee-route slice
// is dripped into an Imperial profile that already has an open position.
//
// Flow:
//   1. Pick the lowest funded profile (defaults to PROFILE=1).
//   2. Open a $10 / 2x SOL long there.
//   3. Snapshot profile.usdc + position size.
//   4. Deposit $5 more USDC into that SAME profile (no roll, no new index).
//   5. Verify: profile.usdc grew by ~$5, position is still open + unchanged.
//   6. Close.
//
// Spends real funds: gas + slippage on $10. Roughly $0.20.
//
// Usage:
//   node keeper/scripts/imperial-topup-probe.mjs
//   PROFILE=1 TOPUP_USD=5 node keeper/scripts/imperial-topup-probe.mjs

import 'dotenv/config';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair } from '../src/wallet.js';
import { authenticate, getRoute } from '../src/imperial.js';
import { config } from '../src/config.js';

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

async function getProfileUsdc(token, profileIndex) {
  const b = await rawGet('/mobile/balances', token);
  const p = b.body?.profiles?.find((x) => x.profileIndex === profileIndex);
  return toUi(p?.usdc);
}

async function findOpenPos(token, wallet, profileIndex, sinceUnix) {
  const positions = await rawGet(`/positions?walletAddress=${wallet}`, token);
  const list = Array.isArray(positions.body)
    ? positions.body
    : positions.body?.dataList || positions.body?.positions || positions.body?.data || [];
  return list.find((p) =>
    (p.symbol || p.asset) === 'SOL'
    && (p.side === 'long' || p.side === 0)
    && p.source === 'imperial'
    && p.status === 'open'
    && Number(p.profileIndex) === profileIndex
    && (sinceUnix == null || Number(p.openedAt ?? 0) >= sinceUnix)
  );
}

async function main() {
  const profileIndex = Number(process.env.PROFILE ?? 1);
  const topupUsd = Number(process.env.TOPUP_USD ?? 5);
  const kp = loadKeypair(config.treasuryKey);
  const wallet = kp.publicKey.toBase58();

  banner('Auth');
  const auth = await authenticate(kp);
  console.log({ pubkey: wallet, profileIndex, topupUsd });

  banner(`Snapshot BEFORE: profile ${profileIndex}`);
  const usdcBefore = await getProfileUsdc(auth.token, profileIndex);
  console.log(`  profile ${profileIndex}.usdc = $${usdcBefore.toFixed(4)}`);
  if (usdcBefore < 11) {
    console.error(`profile ${profileIndex} has $${usdcBefore} < $11, cannot open. Pick a funded PROFILE.`);
    process.exit(1);
  }

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

  const tOpen = Math.floor(Date.now() / 1000) - 30;
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
  assert('open accepted', openRes.status >= 200 && openRes.status < 300);

  banner('Polling /positions for open');
  let pos = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    pos = await findOpenPos(auth.token, wallet, profileIndex, tOpen);
    console.log(`  poll ${i + 1}: ${pos ? `OPEN id=${pos.id || pos.positionId} size=${pos.sizeUsd ?? pos.size}` : 'no'}`);
    if (pos) break;
  }
  assert('open position appeared', !!pos);
  if (!pos) { banner(`Result: ${_passes} passed, ${_fails} failed`); process.exit(1); }

  const sizeBefore = Number(pos.sizeUsd ?? pos.size ?? pos.notionalUsd ?? 0);
  const collBefore = Number(pos.collateralUsd ?? pos.collateral ?? 0);
  const usdcAfterOpen = await getProfileUsdc(auth.token, profileIndex);
  console.log(`  position size=$${sizeBefore} collateral=$${collBefore}`);
  console.log(`  profile.usdc after open = $${usdcAfterOpen.toFixed(4)} (was $${usdcBefore.toFixed(4)})`);

  banner(`Top-up: deposit $${topupUsd} into SAME profile ${profileIndex}`);
  const dep = await rawPost('/deposit/build-tx', auth.token, {
    wallet, profileIndex, amount: usd6(topupUsd), mode: 'deposit',
  });
  console.log(`build-tx status: ${dep.status}`);
  assert('build-tx ok', dep.status >= 200 && dep.status < 300 && !!dep.body?.transaction);
  if (!dep.body?.transaction) { banner(`Result: ${_passes} passed, ${_fails} failed`); process.exit(1); }

  const conn = new Connection(config.rpcUrl, 'confirmed');
  const tx = VersionedTransaction.deserialize(Buffer.from(dep.body.transaction, 'base64'));
  tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  console.log('top-up tx:', sig);
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) {
    console.error('top-up on-chain err:', conf.value.err);
    assert('top-up tx confirmed', false);
  } else {
    assert('top-up tx confirmed', true);
  }

  banner(`Polling: profile ${profileIndex}.usdc grows by ~$${topupUsd}`);
  let usdcAfter = usdcAfterOpen;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    usdcAfter = await getProfileUsdc(auth.token, profileIndex);
    const grew = usdcAfter - usdcAfterOpen;
    console.log(`  poll ${i + 1}: profile.usdc = $${usdcAfter.toFixed(4)} (delta +$${grew.toFixed(4)})`);
    if (grew >= topupUsd * 0.95) break;
  }
  const delta = usdcAfter - usdcAfterOpen;
  assert(`profile.usdc grew by ~$${topupUsd}`, delta >= topupUsd * 0.95,
    `delta=$${delta.toFixed(4)}, expected ~$${topupUsd}`);

  banner('Verify open position still intact after top-up');
  const posAfter = await findOpenPos(auth.token, wallet, profileIndex, tOpen);
  assert('position still open', !!posAfter);
  if (posAfter) {
    const sizeAfter = Number(posAfter.sizeUsd ?? posAfter.size ?? posAfter.notionalUsd ?? 0);
    assert('position size unchanged', Math.abs(sizeAfter - sizeBefore) < 0.01,
      `before=$${sizeBefore} after=$${sizeAfter}`);
    const sameId = (posAfter.id || posAfter.positionId) === (pos.id || pos.positionId);
    assert('same positionId (no reopen)', sameId);
  }

  banner('POST /mobile/orders CLOSE');
  const closeRes = await rawPost('/mobile/orders', auth.token, {
    ...openBody, action: 1,
    positionId: pos.id || pos.positionId || pos.position_id,
  });
  console.log(`status: ${closeRes.status}`);
  assert('close accepted', closeRes.status >= 200 && closeRes.status < 300);

  banner(`Result: ${_passes} passed, ${_fails} failed`);
  process.exit(_fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nPROBE FAILED'); console.error(e); process.exit(1); });
