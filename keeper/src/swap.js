// Generic SOL -> USDC swap via Jupiter v6, used to fund perp collateral
// from claimed trading fees (which land as SOL in the sub-wallet).
//
// Keeps a minimum SOL reserve in the wallet so future tx fees and the
// keeper's own top-up logic don't drain it. Returns the swap signature
// and the USDC amount received (in UI units, 6dp).

import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { config } from './config.js';
import { WSOL_MINT as SOL_MINT, JUP_QUOTE, JUP_SWAP } from './constants.js';
import { jupFetch } from './rateLimiter.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SLIPPAGE_BPS = 100; // 1% for stable swap
const PRIORITY_LAMPORTS = 100_000;

// Keep at least this much SOL in the sub-wallet after the swap. This must
// match the keeper capacity check, otherwise the loop thinks $5+ is swappable
// but the swap helper refuses to touch anything below its own higher reserve.
const MIN_SOL_RESERVE = Math.max(0.002, Number(config.walletSolReserve ?? 0.01));

// --- dust-swap guards (P1 Fix 1) ---
// Don't send a SOL->USDC swap whose quoted output is below this. Defaults to
// the deposit floor so current behavior is preserved; set SWAP_MIN_VIABLE_USDC
// to the Imperial collateral minimum ($10) to stop sub-viable micro-swaps that
// can never fund a position.
export const MIN_VIABLE_USDC = Number(process.env.SWAP_MIN_VIABLE_USDC ?? config.minDepositUsd ?? 2);
// Reject the swap before sending if Jupiter's quoted price impact exceeds this.
const MAX_PRICE_IMPACT_PCT = Number(process.env.SWAP_MAX_PRICE_IMPACT_PCT ?? 0.03);
// After confirmation, if the actual USDC received is below this fraction of the
// quoted output, treat it as a silent route failure and throw (rather than
// reporting an optimistic-but-false success).
const SHORTFALL_FAIL_RATIO = Number(process.env.SWAP_SHORTFALL_FAIL_RATIO ?? 0.5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read a wallet's USDC ATA balance in raw base units (6dp). Returns 0 if the
// ATA does not exist yet.
async function readUsdcRaw(c, owner) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner);
    const bal = await c.getTokenAccountBalance(ata, 'confirmed');
    return Number(bal.value.amount ?? 0);
  } catch {
    return 0;
  }
}

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

async function jupQuote({ inputMint, outputMint, amountLamports }) {
  const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}&onlyDirectRoutes=false&asLegacyTransaction=false`;
  const res = await jupFetch(url);
  if (!res.ok) throw new Error(`jupiter quote ${res.status}: ${await res.text()}`);
  return res.json();
}

async function jupSwap(quoteResponse, userPubkey) {
  const res = await jupFetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: userPubkey,
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: PRIORITY_LAMPORTS,
      dynamicComputeUnitLimit: true,
    }),
  });
  if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Swap up to `wantUsdc` worth of SOL into USDC from `kp`'s wallet.
 * Leaves MIN_SOL_RESERVE SOL behind for tx fees. Returns null if there
 * isn't enough swappable SOL to be worth the gas.
 *
 * @param {object} args
 * @param {number} args.wantUsdc target USDC to acquire (UI units)
 * @param {number} args.solUsd current SOL price in USD
 * @param {import('@solana/web3.js').Keypair} args.kp wallet to swap from
 * @returns {Promise<null | { swapSig: string, usdcReceived: number, solSpent: number }>}
 */
export async function swapSolToUsdc({ wantUsdc, solUsd, kp }) {
  if (!(wantUsdc > 0)) return null;
  if (!(solUsd > 0)) throw new Error('solUsd must be > 0');

  const c = conn();
  const balLamports = await c.getBalance(kp.publicKey, 'confirmed');
  const balSol = balLamports / 1e9;
  const reserveLamports = Math.floor(MIN_SOL_RESERVE * 1e9);
  const swappableLamports = balLamports - reserveLamports;
  if (swappableLamports <= 0) return null;

  // SOL needed for the target USDC + 2% slippage cushion.
  const neededSol = (wantUsdc / solUsd) * 1.02;
  const neededLamports = Math.ceil(neededSol * 1e9);
  const lamports = Math.min(swappableLamports, neededLamports);

  // Dust floor: don't swap less than ~0.001 SOL (~$0.20 in fees would eat it).
  if (lamports < 1_000_000) return null;

  const quote = await jupQuote({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountLamports: lamports,
  });
  const usdcOutRaw = Number(quote.outAmount);
  if (!usdcOutRaw) throw new Error('jupiter returned zero USDC outAmount');

  // Fix 1b: don't send a swap whose quoted output can't reach a usable size.
  // The SOL keeps accumulating in the wallet until a viable swap is possible,
  // instead of bleeding tiny amounts into doomed micro-swaps every tick.
  const usdcOutUi = usdcOutRaw / 1_000_000;
  if (usdcOutUi < MIN_VIABLE_USDC) return null;

  // Fix 1c: reject high-impact routes before sending. For the deep SOL/USDC
  // pair this should be ~0; a high value means a bad/thin route we shouldn't
  // execute. A thrown error is caught by callers and surfaced as a retryable
  // blocked reason.
  const priceImpact = Number(quote.priceImpactPct ?? 0);
  if (priceImpact > MAX_PRICE_IMPACT_PCT) {
    throw new Error(
      `SOL->USDC price impact ${(priceImpact * 100).toFixed(2)}% > max ${(MAX_PRICE_IMPACT_PCT * 100).toFixed(2)}%`,
    );
  }

  // Fix 1a: snapshot the USDC balance BEFORE the swap so we can report the
  // ACTUAL amount received instead of the quoted estimate.
  const usdcBeforeRaw = await readUsdcRaw(c, kp.publicKey);

  const swapResp = await jupSwap(quote, kp.publicKey.toBase58());
  const swapTx = VersionedTransaction.deserialize(
    Buffer.from(swapResp.swapTransaction, 'base64'),
  );
  swapTx.sign([kp]);

  const swapSig = await c.sendTransaction(swapTx, { skipPreflight: false, maxRetries: 3 });
  const swapConfirm = await c.confirmTransaction(swapSig, 'confirmed');
  if (swapConfirm.value.err) {
    throw new Error(`SOL->USDC swap failed on-chain: ${JSON.stringify(swapConfirm.value.err)}`);
  }

  // Fix 1a: confirm the USDC actually landed. The ATA can lag the 'confirmed'
  // commitment by a beat (especially when wrapAndUnwrapSol creates a fresh
  // ATA), so re-poll briefly before measuring the delta.
  let usdcAfterRaw = await readUsdcRaw(c, kp.publicKey);
  for (let i = 0; i < 4 && usdcAfterRaw <= usdcBeforeRaw; i++) {
    await sleep(1000);
    usdcAfterRaw = await readUsdcRaw(c, kp.publicKey);
  }
  const receivedRaw = Math.max(0, usdcAfterRaw - usdcBeforeRaw);

  // The silent-route-failure guard: tx confirmed but little/no USDC arrived.
  // Throwing here stops the keeper from advancing state on a swap that did
  // nothing (the bug previously seen on small tokens like DUMPED/ELON).
  if (receivedRaw < usdcOutRaw * SHORTFALL_FAIL_RATIO) {
    throw new Error(
      `SOL->USDC landed short: expected ~$${usdcOutUi.toFixed(2)}, received $${(receivedRaw / 1_000_000).toFixed(2)} (sig ${swapSig.slice(0, 16)}.. possible silent route fail)`,
    );
  }

  return {
    swapSig,
    usdcReceived: receivedRaw / 1_000_000, // ACTUAL received (6 decimals)
    solSpent: lamports / 1e9,
  };
}

/**
 * Swap up to `wantUsd` worth of USDC into SOL from `kp`'s wallet. Capped at the
 * wallet's actual USDC balance. Used both to (a) convert USDC-quoted DBC/AMM fee
 * claims into SOL so the rest of the keeper's SOL-denominated economics work
 * unchanged, and (b) settle USDC profit slices back to the master treasury.
 *
 * @param {object} args
 * @param {number} args.wantUsd target USD of USDC to swap into SOL (UI units)
 * @param {number} [args.solUsd] current SOL price in USD (optional; only for logs)
 * @param {import('@solana/web3.js').Keypair} args.kp wallet to swap from
 * @returns {Promise<null | { swapSig: string, solReceived: number, usdcSpent: number }>}
 */
export async function swapUsdcToSol({ wantUsd, kp }) {
  if (!(wantUsd > 0)) return null;

  const c = conn();
  const balRaw = await readUsdcRaw(c, kp.publicKey);
  if (balRaw <= 0) return null;

  const wantRaw = Math.floor(wantUsd * 1_000_000);
  const amountRaw = Math.min(balRaw, wantRaw);
  // Dust floor: <$0.01 isn't worth the swap fee.
  if (amountRaw < 10_000) return null;

  const quote = await jupQuote({
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amountLamports: amountRaw,
  });
  const solOutRaw = Number(quote.outAmount);
  if (!solOutRaw) throw new Error('jupiter returned zero SOL outAmount');

  const priceImpact = Number(quote.priceImpactPct ?? 0);
  if (priceImpact > MAX_PRICE_IMPACT_PCT) {
    throw new Error(
      `USDC->SOL price impact ${(priceImpact * 100).toFixed(2)}% > max ${(MAX_PRICE_IMPACT_PCT * 100).toFixed(2)}%`,
    );
  }

  const swapResp = await jupSwap(quote, kp.publicKey.toBase58());
  const swapTx = VersionedTransaction.deserialize(
    Buffer.from(swapResp.swapTransaction, 'base64'),
  );
  swapTx.sign([kp]);

  const swapSig = await c.sendTransaction(swapTx, { skipPreflight: false, maxRetries: 3 });
  const swapConfirm = await c.confirmTransaction(swapSig, 'confirmed');
  if (swapConfirm.value.err) {
    throw new Error(`USDC->SOL swap failed on-chain: ${JSON.stringify(swapConfirm.value.err)}`);
  }

  return {
    swapSig,
    solReceived: solOutRaw / 1e9, // quoted SOL out (wrapAndUnwrapSol unwraps to native)
    usdcSpent: amountRaw / 1_000_000,
  };
}
