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

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://lite-api.jup.ag/swap/v1/swap';
const SLIPPAGE_BPS = 100; // 1% for stable swap
const PRIORITY_LAMPORTS = 100_000;

// Keep at least this much SOL in the sub-wallet after the swap. This must
// match the keeper capacity check, otherwise the loop thinks $5+ is swappable
// but the swap helper refuses to touch anything below its own higher reserve.
const MIN_SOL_RESERVE = Math.max(0.002, Number(config.walletSolReserve ?? 0.01));

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

async function jupQuote({ inputMint, outputMint, amountLamports }) {
  const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}&onlyDirectRoutes=false&asLegacyTransaction=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jupiter quote ${res.status}: ${await res.text()}`);
  return res.json();
}

async function jupSwap(quoteResponse, userPubkey) {
  const res = await fetch(JUP_SWAP, {
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

  // Touch the ATA addr to keep eslint happy and document the destination.
  void (await getAssociatedTokenAddress(new PublicKey(USDC_MINT), kp.publicKey));

  return {
    swapSig,
    usdcReceived: usdcOutRaw / 1_000_000, // USDC = 6 decimals
    solSpent: lamports / 1e9,
  };
}
