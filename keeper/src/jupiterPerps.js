// Jupiter Perpetuals integration.
//
// Three modes via PERP_HEDGE_MODE env:
//   off      -> all open/close/topup/withdraw are no-ops. Returns null sigs.
//   simulate -> builds the real transaction, RPC-simulates it, logs the
//               result (compute units, error if any), returns null sig.
//   live     -> builds, simulates as preflight, then submits. Returns real sig.
//
// Recommended rollout: deploy with off (default) -> flip to simulate, hit
// /tick once, eyeball logs -> flip to live.
//
// The Jupiter Perps program is a Codama-generated client built on @solana/kit
// (web3.js v2). The rest of this keeper is on @solana/web3.js v1, so we have
// a small bridge: build kit IInstruction, convert to v1 TransactionInstruction,
// sign with the existing v1 Keypair, send with the existing v1 Connection.

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, createCloseAccountInstruction, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import {
  getCreateIncreasePositionMarketRequestInstruction,
  getCreateDecreasePositionMarketRequestInstruction,
  fetchPosition,
  fetchCustody,
  PERPETUALS_PROGRAM_ADDRESS,
  Side,
} from 'jup-perps-client';
import { createSolanaRpc, address as kitAddress, getProgramDerivedAddress, getAddressEncoder, getBytesEncoder, getU64Encoder } from '@solana/kit';
import { config, describeRpcUrl } from './config.js';
import { loadKeypair } from './wallet.js';
import { getUsdPriceFor } from './prices.js';

// --- mainnet constants (Jupiter JLP pool + custody addresses) ---
const PROGRAM_ID = PERPETUALS_PROGRAM_ADDRESS; // 'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
const JLP_POOL    = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

// Per-symbol custody PDA (token whose price the position tracks) + mint.
// Source: Jupiter station guides / on-chain JLP pool custodies array.
const CUSTODY = {
  SOL:  { custody: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz', mint: 'So11111111111111111111111111111111111111112' },
  ETH:  { custody: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  BTC:  { custody: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
  USDC: { custody: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};

// Jupiter's own perp custodies only cover SOL/ETH/BTC. Kept here for the legacy
// jupiterOpenPosition path which still uses CUSTODY[].
export const JUPITER_SUPPORTED_SYMBOLS = new Set(['SOL', 'ETH', 'BTC']);

// Router-agnostic gate used by loop.js + externalRouters.js to decide whether
// a token's underlying is hedgeable on the currently-active router (Imperial).
// Imperial supports 62 markets (see imperial.js SUPPORTED_MARKETS). We re-export
// the union here so the loop doesn't drop TON/HYPE/TAO/etc. as "unsupported".
import { SUPPORTED_MARKETS as IMPERIAL_SUPPORTED_MARKETS } from './imperial.js';
export const SUPPORTED_SYMBOLS = new Set([
  ...Object.keys(IMPERIAL_SUPPORTED_MARKETS),
  'SOL', 'ETH', 'BTC',
]);

// PDAs / constants used in account meta.
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM            = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM           = '11111111111111111111111111111111';
const JUP_QUOTE                = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP                 = 'https://lite-api.jup.ag/swap/v1/swap';
const WSOL_MINT                = 'So11111111111111111111111111111111111111112';

let _connection = null;
let _treasury = null;
let _kitRpc = null;
let _perpetualsPda = null;
let _eventAuthorityPda = null;
let _warmed = false;

function detailedFetchError(label, error) {
  const cause = error?.cause;
  const bits = [error?.message ?? String(error)];
  if (cause?.code) bits.push(`code=${cause.code}`);
  if (cause?.hostname) bits.push(`host=${cause.hostname}`);
  if (cause?.address) bits.push(`address=${cause.address}`);
  return new Error(`${label} fetch failed: ${bits.join(' ')}`);
}

function conn() {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 90_000,
    });
  }
  return _connection;
}

function treasury() {
  if (!_treasury) _treasury = loadKeypair(config.treasuryKey);
  return _treasury;
}

function pickSigner(kp) {
  return kp ?? treasury();
}

// Ensures the sub-wallet (or master if kp=null) has at least neededUsd USDC.
// If short, swaps SOL -> USDC via Jupiter Swap API. No-op when hedgeMode='off'
// (we never spend real funds in off mode). Keeps ~0.003 SOL reserve for fees.
async function ensureUsdc(kp, neededUsd) {
  if (config.hedgeMode === 'off') return { skipped: true };
  if (!Number.isFinite(neededUsd) || neededUsd <= 0) return { skipped: true };
  const signer = pickSigner(kp);
  const ata = await getAssociatedTokenAddress(new PublicKey(CUSTODY.USDC.mint), signer.publicKey);
  let haveUsd = 0;
  try {
    const bal = await conn().getTokenAccountBalance(ata, 'confirmed');
    haveUsd = Number(bal.value.uiAmount ?? 0);
  } catch { /* ATA missing - treated as 0 */ }
  if (haveUsd >= neededUsd) return { swapped: false, haveUsd };

  const shortUsd = neededUsd - haveUsd;
  const targetUsd = shortUsd * 1.02; // 2% buffer for slippage/price drift
  const solPx = await getUsdPriceFor('SOL');
  if (!Number.isFinite(solPx) || solPx <= 0) throw new Error('ensureUsdc: bad SOL price');
  const solIn = targetUsd / solPx;
  const lamports = BigInt(Math.ceil(solIn * 1e9));

  const lamportBal = BigInt(await conn().getBalance(signer.publicKey, 'confirmed'));
  const FEE_RESERVE = 3_000_000n; // ~0.003 SOL
  if (lamportBal < lamports + FEE_RESERVE) {
    throw new Error(
      `ensureUsdc: ${signer.publicKey.toBase58()} short SOL. need=${lamports} +reserve=${FEE_RESERVE} have=${lamportBal}`,
    );
  }

  // Quote SOL -> USDC
  const qUrl = new URL(JUP_QUOTE);
  qUrl.searchParams.set('inputMint', WSOL_MINT);
  qUrl.searchParams.set('outputMint', CUSTODY.USDC.mint);
  qUrl.searchParams.set('amount', lamports.toString());
  qUrl.searchParams.set('slippageBps', '100');
  qUrl.searchParams.set('onlyDirectRoutes', 'false');
  qUrl.searchParams.set('asLegacyTransaction', 'false');
  let qRes;
  try { qRes = await fetch(qUrl, { headers: { accept: 'application/json' } }); }
  catch (e) { throw detailedFetchError('jupiter swap quote', e); }
  if (!qRes.ok) throw new Error(`jupiter swap quote ${qRes.status}: ${await qRes.text()}`);
  const quote = await qRes.json();

  // Build swap tx
  const sRes = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 100_000,
    }),
  });
  if (!sRes.ok) throw new Error(`jupiter swap build ${sRes.status}: ${await sRes.text()}`);
  const { swapTransaction } = await sRes.json();
  if (!swapTransaction) throw new Error('jupiter swap returned no transaction');

  if (config.hedgeMode === 'simulate') {
    console.log(`[ensureUsdc-sim] would swap ~${(Number(lamports) / 1e9).toFixed(4)} SOL -> ~$${targetUsd.toFixed(2)} USDC for ${signer.publicKey.toBase58()}`);
    return { swapped: false, simulated: true, haveUsd };
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([signer]);
  const sig = await conn().sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await conn().confirmTransaction(sig, 'confirmed');
  console.log(`[ensureUsdc] swapped ~${(Number(lamports) / 1e9).toFixed(4)} SOL -> ~$${targetUsd.toFixed(2)} USDC for ${signer.publicKey.toBase58()} sig=${sig}`);
  return { swapped: true, sig, haveUsd };
}

function kitRpc() {
  if (!_kitRpc) _kitRpc = createSolanaRpc(config.rpcUrl);
  return _kitRpc;
}


async function getPerpetualsPda() {
  if (_perpetualsPda) return _perpetualsPda;
  const [pda] = await getProgramDerivedAddress({
    programAddress: kitAddress(PROGRAM_ID),
    seeds: [getBytesEncoder().encode(new TextEncoder().encode('perpetuals'))],
  });
  _perpetualsPda = pda;
  return pda;
}

async function getEventAuthorityPda() {
  if (_eventAuthorityPda) return _eventAuthorityPda;
  const [pda] = await getProgramDerivedAddress({
    programAddress: kitAddress(PROGRAM_ID),
    seeds: [getBytesEncoder().encode(new TextEncoder().encode('__event_authority'))],
  });
  _eventAuthorityPda = pda;
  return pda;
}

// position PDA = ["position", owner, pool, custody, collateralCustody, side(1 or 2)]
async function getPositionPda({ owner, custody, collateralCustody, side }) {
  const sideByte = side === 'long' ? 1 : 2;
  const [pda] = await getProgramDerivedAddress({
    programAddress: kitAddress(PROGRAM_ID),
    seeds: [
      getBytesEncoder().encode(new TextEncoder().encode('position')),
      getAddressEncoder().encode(kitAddress(owner)),
      getAddressEncoder().encode(kitAddress(JLP_POOL)),
      getAddressEncoder().encode(kitAddress(custody)),
      getAddressEncoder().encode(kitAddress(collateralCustody)),
      new Uint8Array([sideByte]),
    ],
  });
  return pda;
}

async function getPositionRequestPda({ position, counter, kind }) {
  const requestChange = kind === 'increase' ? 1 : 2;
  const [pda] = await getProgramDerivedAddress({
    programAddress: kitAddress(PROGRAM_ID),
    seeds: [
      getBytesEncoder().encode(new TextEncoder().encode('position_request')),
      getAddressEncoder().encode(kitAddress(position)),
      getU64Encoder().encode(BigInt(counter)),
      new Uint8Array([requestChange]),
    ],
  });
  return pda;
}

function parseExpectedPositionRequestPda(logs) {
  const text = (logs ?? []).join('\n');
  if (!text.includes('ConstraintSeeds') || !text.includes('account: position_request')) return null;
  for (let i = 0; i < logs.length - 1; i++) {
    if (!logs[i].includes('Program log: Right:')) continue;
    const match = logs[i + 1].match(/Program log:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (match) return match[1];
  }
  return null;
}

async function getJupiterMinimumOut({ inputMint, outputMint, amount, slippageBps }) {
  if (inputMint === outputMint || amount <= 0n) return { __option: 'None' };

  const url = new URL(JUP_QUOTE);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw detailedFetchError('jupiter minOut quote', e);
  }
  if (!res.ok) throw new Error(`jupiter minOut quote ${res.status}: ${await res.text()}`);

  const quote = await res.json();
  const outAmount = BigInt(quote.outAmount ?? 0);
  const otherAmountThreshold = BigInt(quote.otherAmountThreshold ?? 0);
  const minOut = otherAmountThreshold > 0n ? otherAmountThreshold : outAmount;
  if (minOut <= 0n) throw new Error('jupiter minOut quote returned zero output');
  return { __option: 'Some', value: minOut };
}

// --- kit IInstruction -> v1 TransactionInstruction bridge ---
function kitIxToV1(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: (a.role & 0b10) !== 0,   // role bit 1 = signer
      isWritable: (a.role & 0b01) !== 0, // role bit 0 = writable
    })),
    data: Buffer.from(ix.data),
  });
}

export async function getJupPerps() {
  if (_warmed) return true;
  const rpc = describeRpcUrl(config.rpcUrl);
  console.log(`[jup] using ${rpc.redactedUrl} host=${rpc.host}`);
  console.log(`[jup] hedge mode = ${config.hedgeMode.toUpperCase()}`);
  console.log(`[jup] gate $${config.feeGateUsd} / open $${config.openCollateralUsd} / pnl trig $${config.pnlTriggerUsd} / lev cap ${config.leverageCapMult}x`);
  if (config.hedgeMode === 'off') {
    console.log('[jup] perp leg DISABLED. fees claimed + buyback+burn still run.');
  } else if (config.hedgeMode === 'simulate') {
    console.log('[jup] perp leg in SIMULATE mode. tx will be built and RPC-simulated, never submitted.');
  } else {
    console.log('[jup] perp leg LIVE. real positions will be opened with real USDC. caps enforced in loop.');
  }
  _warmed = true;
  return true;
}

export function marketIndexFor(symbol) {
  const up = String(symbol || '').toUpperCase();
  if (!SUPPORTED_SYMBOLS.has(up)) {
    throw new Error(`unsupported symbol ${up} (only SOL/ETH/BTC)`);
  }
  return up;
}

// Resolves to USDC ATA balance of the given (or master) wallet. Surfaced on /status.
export async function getFreeCollateralUsd(kp = null) {
  const signer = pickSigner(kp);
  const ata = await getAssociatedTokenAddress(new PublicKey(CUSTODY.USDC.mint), signer.publicKey);
  try {
    const bal = await conn().getTokenAccountBalance(ata, 'confirmed');
    return Number(bal.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}


// Read live position from chain. Returns null if no position open, or
// { collateralUsd, sizeUsd, side, unrealizedPnlUsd }.
export async function readPerpPosition({ symbol, side, kp = null }) {
  const signer = pickSigner(kp);
  const sym = marketIndexFor(symbol);
  const owner = signer.publicKey.toBase58();
  const custodyAddr = CUSTODY[sym].custody;
  const collateralCustodyAddr = side === 'long' ? custodyAddr : CUSTODY.USDC.custody;
  const positionPda = await getPositionPda({ owner, custody: custodyAddr, collateralCustody: collateralCustodyAddr, side });


  try {
    const pos = await fetchPosition(kitRpc(), positionPda);
    const sizeUsd = Number(pos.data.sizeUsd) / 1e6;
    if (sizeUsd <= 0) return null;
    const collateralUsd = Number(pos.data.collateralUsd) / 1e6;
    // unrealizedPnl is not on the account directly. We approximate from
    // current mark price vs entry. The generated account field is `price`
    // and uses 1e6 precision like sizeUsd/collateralUsd.
    const entryPriceUsd = Number(pos.data.price) / 1e6;
    const markPriceUsd = await getUsdPriceFor(sym);
    if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
      throw new Error(`invalid Jupiter position entry price ${String(pos.data.price)}`);
    }
    const baseSize = sizeUsd / entryPriceUsd;
    const direction = side === 'long' ? 1 : -1;
    const unrealizedPnlUsd = baseSize * (markPriceUsd - entryPriceUsd) * direction;
    return {
      sizeUsd,
      collateralUsd,
      side,
      entryPriceUsd,
      markPriceUsd,
      unrealizedPnlUsd,
      positionPda: positionPda.toString(),
    };
  } catch {
    return null; // account does not exist = no position
  }
}

// --- core: build + submit/simulate a position-request tx ---
// kind: 'increase' (open or topup) | 'decrease' (close, partial close, withdraw)
// returns { signature: string|null, simulated: boolean, error?: string }
async function buildAndExecute({
  symbol,
  side,
  sizeUsdDelta,        // bigint (1e6)
  collateralTokenDelta, // bigint (collateral mint decimals)
  kind,
  kp: kpArg = null,
}) {
  if (config.hedgeMode === 'off') {
    console.log(`[jup-off] would ${kind} ${symbol} ${side} sizeΔ=$${Number(sizeUsdDelta) / 1e6} collΔ=${collateralTokenDelta}`);
    return { signature: null, simulated: false };
  }

  const kp = pickSigner(kpArg);
  const owner = kp.publicKey.toBase58();

  const sym = marketIndexFor(symbol);
  const positionCustody = CUSTODY[sym].custody;
  const collateralCustody = side === 'long' ? positionCustody : CUSTODY.USDC.custody;
  const inputMint = CUSTODY.USDC.mint; // we always fund collateral in USDC
  const positionPda = await getPositionPda({ owner, custody: positionCustody, collateralCustody, side });
  const counter = BigInt(Date.now()); // unique per-request
  const positionRequestPda = await getPositionRequestPda({ position: positionPda, counter, kind });

  // On decrease the program REQUIRES desiredMint == position collateral mint
  // (per Jupiter perps docs: "For closing positions and collateral withdrawals,
  // mint is equal to the position collateral token's mint address"). For a
  // short SOL position the collateral is USDC, so desiredMint=USDC. Using WSOL
  // here triggers AnchorError 6015 (InvalidArgument) at
  // create_decrease_position_market_request.rs:175.
  // For a long position the collateral IS the underlying (WSOL for SOL longs).
  // On increase we always fund in USDC.
  const collateralMintForSettle = side === 'long' ? CUSTODY[sym].mint : CUSTODY.USDC.mint;
  const settleMint = kind === 'decrease' ? collateralMintForSettle : CUSTODY.USDC.mint;

  // positionRequestAta = ATA(desiredMint, positionRequest, allowOwnerOffCurve=true).
  const positionRequestAta = await getAssociatedTokenAddress(
    new PublicKey(settleMint),
    new PublicKey(positionRequestPda.toString()),
    true,
  );
  const fundingAccount = await getAssociatedTokenAddress(new PublicKey(CUSTODY.USDC.mint), kp.publicKey);
  const receivingAta = await getAssociatedTokenAddress(new PublicKey(settleMint), kp.publicKey);
  const perpetualsPda = await getPerpetualsPda();
  const eventAuthority = await getEventAuthorityPda();

  // priceSlippage = bound on index price (1e6 USD). Long => max accepted,
  // short => min accepted. Must be near oracle, not arbitrarily wide, or the
  // program rejects with InvalidArgument (6015).
  const SIDE_LONG = Side.Long;
  const SIDE_SHORT = Side.Short;

  const oraclePriceUsd = await getUsdPriceFor(sym);
  const bps = Math.max(10, Math.min(2000, config.slippageBps)); // clamp 0.1%..20%
  // increase long / decrease short => buying => priceSlippage is a ceiling (oracle * (1+bps))
  // increase short / decrease long => selling => priceSlippage is a floor   (oracle * (1-bps))
  const wantCeiling = (kind === 'increase' && side === 'long') || (kind === 'decrease' && side === 'short');
  const factor = wantCeiling ? (1 + bps / 10000) : (1 - bps / 10000);
  const priceSlippageE6 = BigInt(Math.max(1, Math.floor(oraclePriceUsd * factor * 1e6)));
  const collateralMint = side === 'long' ? CUSTODY[sym].mint : CUSTODY.USDC.mint;
  // increase: USDC -> collateral (size of collateralTokenDelta).
  // decrease settles to the position collateral mint. For SOL shorts this is
  // USDC, so there is no swap and jupiterMinimumOut must be None. Supplying a
  // USDC -> WSOL minimum-out while desiredMint=USDC trips InvalidArgument 6015.
  const jupiterMinimumOut = await getJupiterMinimumOut({
    inputMint,
    outputMint: kind === 'increase' ? collateralMint : settleMint,
    amount: collateralTokenDelta,
    slippageBps: bps,
  });

  const common = {
    owner: { address: kitAddress(owner) }, // TransactionSigner expects an object with address
    fundingAccount: kitAddress(fundingAccount.toBase58()),
    receivingAccount: kitAddress(receivingAta.toBase58()),
    perpetuals: perpetualsPda,
    pool: kitAddress(JLP_POOL),
    position: positionPda,
    positionRequest: positionRequestPda,
    positionRequestAta: kitAddress(positionRequestAta.toBase58()),
    custody: kitAddress(positionCustody),
    collateralCustody: kitAddress(collateralCustody),
    inputMint: kitAddress(inputMint),
    desiredMint: kitAddress(settleMint),
    referral: kitAddress(PROGRAM_ID), // no referral = pass program id
    tokenProgram: kitAddress(TOKEN_PROGRAM),
    associatedTokenProgram: kitAddress(ASSOCIATED_TOKEN_PROGRAM),
    systemProgram: kitAddress(SYSTEM_PROGRAM),
    eventAuthority,
    program: kitAddress(PROGRAM_ID),
  };

  // increase and decrease have DIFFERENT arg shapes in the Jupiter Perps IDL:
  //   increase: { sizeUsdDelta, collateralTokenDelta, side, priceSlippage,
  //               jupiterMinimumOut, counter }
  //   decrease: { collateralUsdDelta, sizeUsdDelta, priceSlippage,
  //               jupiterMinimumOut, entirePosition: Option<bool>, counter }
  // Mixing them caused "Cannot convert undefined to a BigInt" on partial close
  // because collateralUsdDelta was undefined.
  let args;
  if (kind === 'increase') {
    args = {
      sizeUsdDelta,
      collateralTokenDelta,
      side: side === 'long' ? SIDE_LONG : SIDE_SHORT,
      priceSlippage: priceSlippageE6,
      jupiterMinimumOut,
      counter,
    };
  } else {
    args = {
      // callers reuse `collateralTokenDelta` as the USD-denominated withdraw
      // amount on the decrease path (partialClose / closePosition pass 0n).
      collateralUsdDelta: collateralTokenDelta,
      sizeUsdDelta,
      priceSlippage: priceSlippageE6,
      jupiterMinimumOut,
      entirePosition: { __option: 'None' },
      counter,
    };
  }

  console.log(`[jup-${config.hedgeMode}] BUILD ${kind} ${symbol} ${side}`, {
    owner, positionPda: positionPda.toString(),
    positionRequestPda: positionRequestPda.toString(),
    positionRequestAta: positionRequestAta.toBase58(),
    fundingAccount: fundingAccount.toBase58(),
    custody: positionCustody, collateralCustody, inputMint, desiredMint: settleMint,
    sizeUsdDelta: sizeUsdDelta.toString(),
    collateralTokenDelta: collateralTokenDelta.toString(),
    priceSlippageE6: priceSlippageE6.toString(),
    jupiterMinimumOut: jupiterMinimumOut.__option === 'Some' ? jupiterMinimumOut.value.toString() : null,
    oraclePriceUsd, counter: counter.toString(),
  });

  let kitIx;
  if (kind === 'increase') {
    kitIx = getCreateIncreasePositionMarketRequestInstruction({ ...common, ...args });
  } else {
    kitIx = getCreateDecreasePositionMarketRequestInstruction({ ...common, ...args });
  }

  const v1Ix = kitIxToV1(kitIx);
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 });
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  // On decrease the program writes realized PnL into receivingAccount = ATA(desiredMint, owner).
  // Our unwrapWsol() helper closes the wSOL ATA after each settlement, so on the next decrease
  // the ATA does not exist on chain and the program fails with MissingAccount. Idempotently
  // (re)create receivingAta in the same tx before invoking the perp IX. Safe on increase too
  // (no-op if the USDC ATA already exists).
  const ataCreateIx = createAssociatedTokenAccountIdempotentInstruction(
    kp.publicKey,           // payer
    new PublicKey(receivingAta.toBase58 ? receivingAta.toBase58() : receivingAta.toString()),
    kp.publicKey,           // owner
    new PublicKey(settleMint),
  );

  const c = conn();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimitIx, cuPriceIx, ataCreateIx, v1Ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([kp]);

  // Always simulate as preflight.
  const sim = await c.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
  if (sim.value.err) {
    const expectedPositionRequest = parseExpectedPositionRequestPda(sim.value.logs);
    if (expectedPositionRequest && expectedPositionRequest !== positionRequestPda.toString()) {
      const expectedAta = await getAssociatedTokenAddress(
        new PublicKey(settleMint),
        new PublicKey(expectedPositionRequest),
        true,
      );
      const retryCommon = {
        ...common,
        positionRequest: kitAddress(expectedPositionRequest),
        positionRequestAta: kitAddress(expectedAta.toBase58()),
      };
      const retryKitIx = kind === 'increase'
        ? getCreateIncreasePositionMarketRequestInstruction({ ...retryCommon, ...args })
        : getCreateDecreasePositionMarketRequestInstruction({ ...retryCommon, ...args });
      const retryV1Ix = kitIxToV1(retryKitIx);
      const retryMessage = new TransactionMessage({
        payerKey: kp.publicKey,
        recentBlockhash: blockhash,
        instructions: [cuLimitIx, cuPriceIx, ataCreateIx, retryV1Ix],
      }).compileToV0Message();
      const retryTx = new VersionedTransaction(retryMessage);
      retryTx.sign([kp]);
      const retrySim = await c.simulateTransaction(retryTx, { sigVerify: false, commitment: 'confirmed' });
      if (!retrySim.value.err) {
        console.log(`[jup-${config.hedgeMode}] sim OK after position_request PDA retry ${kind} ${symbol} ${side} CU=${retrySim.value.unitsConsumed}`);
        if (config.hedgeMode === 'simulate') return { signature: null, simulated: true };
        const sig = await c.sendTransaction(retryTx, { skipPreflight: true, maxRetries: 3 });
        console.log(`[jup-live] submitted ${kind} ${symbol} ${side} sig=${sig}`);
        return { signature: sig, simulated: false };
      }
    }
    const logs = (sim.value.logs ?? []).slice(-8).join(' | ');
    const errMsg = `simulate err ${JSON.stringify(sim.value.err)} :: ${logs}`;
    console.warn(`[jup-${config.hedgeMode}] ${kind} ${symbol} ${side} ${errMsg}`);
    return { signature: null, simulated: true, error: errMsg };
  }

  console.log(`[jup-${config.hedgeMode}] sim OK ${kind} ${symbol} ${side} CU=${sim.value.unitsConsumed} sizeΔ=$${Number(sizeUsdDelta) / 1e6} collΔ=${collateralTokenDelta}`);

  if (config.hedgeMode === 'simulate') {
    return { signature: null, simulated: true };
  }

  // live: submit.
  const sig = await c.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  console.log(`[jup-live] submitted ${kind} ${symbol} ${side} sig=${sig}`);
  // We don't wait for confirmation here — Jupiter's off-chain keeper still
  // has to fill the request. The caller writes pending_drift_sig and polls
  // on subsequent ticks.
  return { signature: sig, simulated: false };
}

// --- public surface used by loop.js ---

// Open a fresh position. collateralUsd in USDC, sizeUsd = collateral * leverage.
export async function openPosition({ symbol, side, collateralUsd, sizeUsd, kp = null }) {
  await ensureUsdc(kp, collateralUsd);
  const sizeUsdDelta = BigInt(Math.floor(sizeUsd * 1e6));
  const collateralTokenDelta = BigInt(Math.floor(collateralUsd * 1e6));
  return buildAndExecute({
    symbol, side, sizeUsdDelta, collateralTokenDelta, kind: 'increase', kp,
  });
}

export async function topUpCollateral({ symbol, side, addCollateralUsd, kp = null }) {
  await ensureUsdc(kp, addCollateralUsd);
  return buildAndExecute({
    symbol, side,
    sizeUsdDelta: 0n,
    collateralTokenDelta: BigInt(Math.floor(addCollateralUsd * 1e6)),
    kind: 'increase', kp,
  });
}

export async function increasePosition({ symbol, side, addSizeUsd, addCollateralUsd, kp = null }) {
  await ensureUsdc(kp, addCollateralUsd);
  return buildAndExecute({
    symbol, side,
    sizeUsdDelta: BigInt(Math.floor(addSizeUsd * 1e6)),
    collateralTokenDelta: BigInt(Math.floor(addCollateralUsd * 1e6)),
    kind: 'increase', kp,
  });
}

export async function withdrawCollateral({ symbol, side, withdrawUsd, kp = null }) {
  return buildAndExecute({
    symbol, side,
    sizeUsdDelta: 0n,
    collateralTokenDelta: BigInt(Math.floor(withdrawUsd * 1e6)),
    kind: 'decrease', kp,
  });
}

export async function partialClose({ symbol, side, reduceSizeUsd, kp = null }) {
  // collateralTokenDelta on the decrease path is the USD amount (1e6) to
  // withdraw from the position. Passing reduceSizeUsd here makes the program
  // actually pay out the realized PnL slice (as wSOL via desiredMint) instead
  // of leaving it inside the position as added collateral.
  const usdE6 = BigInt(Math.floor(reduceSizeUsd * 1e6));
  return buildAndExecute({
    symbol, side,
    sizeUsdDelta: usdE6,
    collateralTokenDelta: usdE6,
    kind: 'decrease', kp,
  });
}

export async function closePerp({ symbol, side, sizeUsd, collateralUsd, kp = null }) {
  return buildAndExecute({
    symbol, side,
    sizeUsdDelta: BigInt(Math.floor(sizeUsd * 1e6)),
    collateralTokenDelta: BigInt(Math.floor(collateralUsd * 1e6)),
    kind: 'decrease', kp,
  });
}


// Close the keeper's wSOL ATA (if it exists and has a balance) so that any
// wSOL received from a decrease/partialClose settlement is unwrapped back to
// native SOL on the owner. The buyback path spends native SOL, so without
// this the realized PnL would just sit as wSOL forever.
const WSOL_PK = new PublicKey('So11111111111111111111111111111111111111112');
export async function unwrapWsol(kpArg = null) {
  const kp = pickSigner(kpArg);
  const c = conn();
  const ata = await getAssociatedTokenAddress(WSOL_PK, kp.publicKey);
  const info = await c.getAccountInfo(ata, 'confirmed');
  if (!info) return { closed: false, reason: 'no ata' };
  try {
    const ix = createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey);
    const { blockhash } = await c.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    const sig = await c.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await c.confirmTransaction(sig, 'confirmed');
    return { closed: true, signature: sig };
  } catch (e) {
    return { closed: false, reason: e.message };
  }
}
