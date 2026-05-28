#!/usr/bin/env node
// Imperial handshake smoke test.
//
// Usage:
//   node keeper/scripts/imperial-handshake.mjs              # uses master treasury
//   node keeper/scripts/imperial-handshake.mjs <tokenId>    # uses derived sub-wallet
//
// Reads from keeper/.env (same as the keeper). Does NOT submit any orders.
// Confirms: connect -> sign nonce -> exchange -> bearer token -> /route quote.

import 'dotenv/config';
import { loadKeypair, deriveSubKeypair } from '../src/wallet.js';
import { authenticate, createMobileConnectPayload, getImperialAuthDiagnostics, getRoute, getBalances } from '../src/imperial.js';
import { config } from '../src/config.js';

const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function banner(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const tokenId = process.argv[2];
  const master = loadKeypair(config.treasuryKey);
  const kp = tokenId ? deriveSubKeypair(master, tokenId) : master;
  const label = tokenId ? `sub-wallet(token=${tokenId})` : 'master treasury';

  banner('Config');
  console.log({
    baseUrl: config.imperial.baseUrl,
    enabled: config.imperial.enabled,
    routingMode: config.imperial.routingMode,
    positionMode: config.imperial.positionMode,
    apiKeyPresent: Boolean(config.imperial.apiKey),
    imperialAuth: getImperialAuthDiagnostics(),
    signer: label,
    pubkey: kp.publicKey.toBase58(),
  });

  banner('Local signature check');
  const payload = createMobileConnectPayload(kp);
  console.log({
    wallet: payload.wallet,
    message: payload.message,
    signaturePreview: `${payload.signature.slice(0, 10)}…(${payload.signature.length} chars)`,
    signatureVerifiedLocally: payload.signatureVerifiedLocally,
  });

  banner('Authenticate');
  const auth = await authenticate(kp);
  console.log({ tokenPreview: `${auth.token.slice(0, 10)}…(${auth.token.length} chars)`, raw: auth.raw });

  banner('Balances');
  try {
    const balances = await getBalances(auth.token);
    console.log(balances);
  } catch (err) {
    console.log(`balances failed (non-fatal): ${err.message}`);
  }

  banner('Route quote (SOL -> USDC, 0.01 SOL, swap)');
  try {
    const route = await getRoute({
      inputMint: SOL,
      outputMint: USDC,
      amount: '10000000', // 0.01 SOL in lamports
      slippageBps: 50,
    });
    console.log(JSON.stringify(route, null, 2));
  } catch (err) {
    console.log(`route failed: ${err.message}`);
    if (err.body) console.log('route body:', JSON.stringify(err.body, null, 2));
    process.exitCode = 2;
  }

  banner('Done');
  console.log('Handshake completed without submitting any orders.');
}

main().catch((err) => {
  console.error('\nHANDSHAKE FAILED');
  console.error(err);
  process.exit(1);
});
