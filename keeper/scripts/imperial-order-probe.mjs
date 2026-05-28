#!/usr/bin/env node
// Live Imperial round-trip: open SOL long $10 / 2x, list positions, close.
//
// Uses the schema confirmed by the probe runs:
//   wallet, asset, symbol, collateralAsset, collateralAmount (u64 base units),
//   notional, sizeUsd, desiredLeverage, slippageBps, side, orderType,
//   triggerCondition, action, triggerPrice, profileIndex, priority,
//   fundingStatus, underwriter (all numeric u8/u16/u64 as appropriate).
//
// THIS SPENDS REAL FUNDS. Requires ~$11 USDC + a little SOL for gas in the
// treasury wallet.
//
// Usage:
//   node keeper/scripts/imperial-order-probe.mjs

import 'dotenv/config';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadKeypair } from '../src/wallet.js';
import { authenticate, getRoute } from '../src/imperial.js';
import { config } from '../src/config.js';
import { pickProfile, DEFAULT_MIN_USDC } from '../src/profileManager.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = config.imperial.baseUrl;
const UNDERWRITER_BY_VENUE = Object.freeze({
  jupiter: 0,
  flash_trade: 1,
  phoenix: 2,
  gmtrade: 3,
});

// Venues whose /mobile/orders we've verified end-to-end with our body shape.
// phoenix + flash_trade currently 200-OK but no on-chain fill, so we treat them
// as unsupported until we figure out their extra required fields.
const SUPPORTED_VENUES = new Set(['gmtrade', 'jupiter']);
const FALLBACK_VENUE = 'gmtrade';

function banner(t) { console.log(`\n=== ${t} ===`); }

function usd6(n) { return Math.round(Number(n) * 1_000_000); }

async function getMarketPrice(token, symbol, venue) {
  const prices = await rawGet('/mark-prices', token);
  if (prices.status < 200 || prices.status >= 300) return { status: prices.status, body: prices.body, price: null };
  const row = prices.body?.rows?.find((r) => r.symbol === symbol || r.asset === symbol);
  const venuePrice = row?.[venue] ?? row?.venues?.[venue] ?? row?.prices?.[venue];
  const price = venuePrice?.price ?? venuePrice?.markPrice ?? row?.price ?? null;
  return { status: prices.status, body: prices.body, price: price ? Math.round(Number(price) * 1_000_000_000) : null };
}

async function rawRequest(method, path, token, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'x-api-key': config.imperial.apiKey || token,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

const rawPost = (p, t, b) => rawRequest('POST', p, t, b);
const rawGet  = (p, t)    => rawRequest('GET',  p, t);

async function main() {
  const kp = loadKeypair(config.treasuryKey);
  const wallet = kp.publicKey.toBase58();
  banner('Auth');
  const auth = await authenticate(kp);
  console.log({ pubkey: wallet, tokenPreview: `${auth.token.slice(0,12)}…` });

  banner('Fresh route quote (SOL long, $10 collateral, 2x)');
  const route = await getRoute({
    asset: 'SOL',
    side: 'long',
    amount: '10000000',
    collateralAsset: USDC,
    notional: '20',
    desiredLeverage: '2',
    slippageBps: '100',
  });
  console.log(JSON.stringify(route, null, 2));

  // Router may pick a venue (phoenix, flash_trade) whose /mobile/orders silently
  // no-ops with our body. Force to a verified venue unless FORCE_VENUE overrides.
  const routerVenue = route?.venue || FALLBACK_VENUE;
  let venue = process.env.FORCE_VENUE || routerVenue;
  if (!process.env.FORCE_VENUE && !SUPPORTED_VENUES.has(venue)) {
    console.log(`>>> router picked ${venue} which is not in SUPPORTED_VENUES, falling back to ${FALLBACK_VENUE}`);
    venue = FALLBACK_VENUE;
  }
  const underwriter = UNDERWRITER_BY_VENUE[venue];
  if (underwriter === undefined) throw new Error(`Unknown Imperial venue: ${venue}`);
  console.log(`>>> using venue=${venue} (underwriter=${underwriter})${process.env.FORCE_VENUE ? ' [forced]' : ''}`);

  banner('GET /mobile/balances + /positions (auto-roll picker)');
  const balances = await rawGet('/mobile/balances', auth.token);
  console.log(`balances status: ${balances.status}`);
  const positionsAll = await rawGet(`/positions?walletAddress=${wallet}`, auth.token);
  const openList = (Array.isArray(positionsAll.body)
    ? positionsAll.body
    : positionsAll.body?.dataList || positionsAll.body?.positions || positionsAll.body?.data || []
  ).filter((p) => p?.source === 'imperial' && (p?.status ?? 'open') === 'open');

  const pick = pickProfile({
    profiles: balances.body?.profiles ?? [],
    positions: openList,
  });
  console.log(`>>> picked profile ${pick.profileIndex} — ${pick.reason}`);
  const profileIndex = pick.profileIndex;

  // Ensure picked profile has enough USDC for non-Jupiter venues.
  if (underwriter !== 0 && pick.needsDeposit) {
    banner(`Depositing $${pick.depositAmountUi} into profile ${profileIndex}`);
    const dep = await rawPost('/deposit/build-tx', auth.token, {
      wallet,
      profileIndex,
      amount: usd6(pick.depositAmountUi),
      mode: 'deposit',
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
    if (conf.value.err) {
      console.error('deposit failed on-chain:', conf.value.err);
      process.exit(1);
    }
    // Poll Imperial balances until the indexer sees the deposit (up to 60s).
    let seen = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const b = await rawGet('/mobile/balances', auth.token);
      const pp = b.body?.profiles?.find((p) => p.profileIndex === profileIndex);
      seen = Number(pp?.usdc ?? 0) / 1_000_000;
      console.log(`  poll ${i + 1}: profile ${profileIndex} usdc = $${seen}`);
      if (seen >= DEFAULT_MIN_USDC) break;
    }
    if (seen < DEFAULT_MIN_USDC) {
      console.error('Imperial indexer did not pick up deposit within 60s, aborting');
      process.exit(1);
    }
  }

  banner('GET /mark-prices');
  const marketPrice = await getMarketPrice(auth.token, 'SOL', venue);
  console.log(`status: ${marketPrice.status}`);
  console.log('selected:', JSON.stringify({ venue, underwriter, marketPrice: marketPrice.price }, null, 2));

  const openBody = {
    wallet,
    symbol: 'SOL',
    collateralAmount: 10_000_000, // $10 USDC in base units
    sizeUsd: usd6(20),       // Imperial order API wants 6-decimal USD fixed point
    slippageBps: 100,
    side: 0,
    orderType: 0,
    triggerCondition: 0,
    action: 0,             // 0 = open / increase
    triggerPrice: 0,
    profileIndex,
    priority: 0,
    fundingStatus: 0,
    underwriter,
  };
  if (marketPrice.price) openBody.marketPrice = marketPrice.price;


  banner('POST /mobile/orders  [LIVE OPEN]');
  console.log('body:', JSON.stringify(openBody));
  const openRes = await rawPost('/mobile/orders', auth.token, openBody);
  console.log(`status: ${openRes.status}`);
  console.log('response:', JSON.stringify(openRes.body, null, 2));

  // Imperial's /mobile/orders is unreliable: it often returns
  // { success:false, error:"Failed to place order" } even when the order
  // actually fills on-chain. So we ignore that response and verify by
  // polling /positions for a freshly-opened SOL long instead.
  const tOpen = Math.floor(Date.now() / 1000) - 30; // accept positions opened in the last 30s
  banner('Verifying open by polling /positions for fresh SOL long');

  let pos = null;
  let positions = { status: 0, body: {} };
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    positions = await rawGet(`/positions?walletAddress=${wallet}`, auth.token);
    const list = Array.isArray(positions.body)
      ? positions.body
      : positions.body?.dataList
        || positions.body?.positions
        || positions.body?.data
        || [];
    pos = list.find((p) =>
      (p.symbol || p.asset) === 'SOL'
      && (p.side === 'long' || p.side === 0)
      && p.source === 'imperial'
      && p.status === 'open'
      && Number(p.openedAt ?? 0) >= tOpen
    );
    console.log(`  poll ${i + 1}: imperial SOL positions=${list.filter(p => p.source === 'imperial').length}, fresh match=${pos ? 'YES' : 'no'}`);
    if (pos) break;
  }

  if (!pos) {
    banner('No fresh Imperial SOL long appeared within 30s — open really did fail');
    console.log('last /positions response:', JSON.stringify(positions.body, null, 2));
    process.exit(1);
  }
  console.log('selected position:', JSON.stringify(pos, null, 2));

  const closeBody = {
    ...openBody,
    action: 1, // 1 = close
    positionId: pos.id || pos.positionId || pos.position_id,
  };

  banner('POST /mobile/orders  [LIVE CLOSE]');
  console.log('body:', JSON.stringify(closeBody));
  const closeRes = await rawPost('/mobile/orders', auth.token, closeBody);
  console.log(`status: ${closeRes.status}`);
  console.log('response:', JSON.stringify(closeRes.body, null, 2));

  banner('Round-trip complete');
}

main().catch((e) => {
  console.error('\nPROBE FAILED');
  console.error(e);
  process.exit(1);
});
