// Real on-chain buyback + burn.
//
// Flow per call:
//   1. Quote SOL -> token via Jupiter v6 (slippage cap from config).
//   2. Build, sign, send the swap tx with the treasury keypair.
//   3. Confirm on-chain.
//   4. Burn the received tokens out of the treasury's ATA via SPL `burn`.
//   5. Return { swapSig, burnSig, solSpent, tokensBought, tokensBurned }.
//
// If the swap confirms but the burn fails, the tokens sit in the treasury ATA
// and the caller logs a `swap` tx_log row with status=confirmed but no `burn`
// row. Phase 2 keeper sweep can re-attempt the burn idempotently by checking
// the ATA balance against the swap amount.

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createBurnInstruction,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from './config.js';
import { loadKeypair } from './wallet.js';
import { WSOL_MINT as SOL_MINT, JUP_QUOTE, JUP_SWAP } from './constants.js';
import { jupFetch } from './rateLimiter.js';

// Auto-detect SPL Token vs Token-2022 from the mint's account owner.
// pump.fun mints today are Token-2022; legacy SPL mints are still
// Token-classic. The ATA derivation + burn instruction differ by program,
// so we resolve this once per call and thread it through.
async function resolveTokenProgram(connection, mintPk) {
  const info = await connection.getAccountInfo(mintPk, 'confirmed');
  if (!info) throw new Error(`mint ${mintPk.toBase58()} not found`);
  const owner = info.owner.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  if (owner === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  throw new Error(`mint ${mintPk.toBase58()} has unknown token program owner ${owner}`);
}

const SLIPPAGE_BPS = 200; // 2%
const PRIORITY_LAMPORTS = 100_000;

// Reserves kept in the signing wallet so the swap+burn txs don't fail with
// `insufficient lamports`. ATA rent + 2 tx fees + priority fee headroom.
const RENT_RESERVE_LAMPORTS = 2_500_000;   // ~0.0025 SOL (ATA + slack)
const FEE_BUFFER_LAMPORTS   = 1_500_000;   // ~0.0015 SOL (2 txs + priority)
const MIN_SPEND_LAMPORTS    = 1_000_000;   // 0.001 SOL min, else skip

// Base floor every buyback-signing wallet must retain so the swap+burn txs
// (which create the output-token ATA and pay 2 tx fees) can't fail with
// `insufficient lamports`. This is the same RENT_RESERVE + FEE_BUFFER floor
// the swap path enforces internally below.
export const BUYBACK_BASE_FLOOR_LAMPORTS = RENT_RESERVE_LAMPORTS + FEE_BUFFER_LAMPORTS; // 0.004 SOL
// Extra keep-alive a SUB-wallet holds on top of the base floor so it stays
// fundable for the next tick's ops (rent top-ups, fee claims) instead of being
// drained to the bare tx floor by a single buyback.
export const SUB_BUYBACK_OPERATING_RESERVE_LAMPORTS = 6_000_000; // 0.006 SOL

// Lamports a wallet may spend on a buyback while keeping its required reserve.
// Master keeps only the base tx floor; sub-wallets also keep the operating
// reserve. Returns 0 (never negative) when below the floor.
export function buybackSpendableLamports({ walletLamports, isMaster = false }) {
  const reserve = BUYBACK_BASE_FLOOR_LAMPORTS + (isMaster ? 0 : SUB_BUYBACK_OPERATING_RESERVE_LAMPORTS);
  return Math.max(0, Number(walletLamports || 0) - reserve);
}

function detailedFetchError(label, error) {
  const cause = error?.cause;
  const bits = [error?.message ?? String(error)];
  if (cause?.code) bits.push(`code=${cause.code}`);
  if (cause?.hostname) bits.push(`host=${cause.hostname}`);
  if (cause?.address) bits.push(`address=${cause.address}`);
  return new Error(`${label} fetch failed: ${bits.join(' ')}`);
}

async function withNetworkDetail(label, fn) {
  try {
    return await fn();
  } catch (e) {
    throw detailedFetchError(label, e);
  }
}

let _connection = null;
function conn() {
  if (!_connection) _connection = new Connection(config.rpcUrl, 'confirmed');
  return _connection;
}

let _treasury = null;
function treasury() {
  if (!_treasury) _treasury = loadKeypair(config.treasuryKey);
  return _treasury;
}

export async function burnExistingTokenBalance({ mintAddress, kp: kpArg }) {
  const kp = kpArg ?? treasury();
  const mint = new PublicKey(mintAddress);
  const c = conn();
  const tokenProgramId = await resolveTokenProgram(c, mint);
  const ata = await getAssociatedTokenAddress(mint, kp.publicKey, true, tokenProgramId);
  let burnAmount;
  try {
    const acct = await getAccount(c, ata, 'confirmed', tokenProgramId);
    burnAmount = acct.amount;
  } catch {
    return null;
  }
  if (burnAmount === 0n) return null;

  const burnIx = createBurnInstruction(ata, mint, kp.publicKey, burnAmount, [], tokenProgramId);
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_LAMPORTS,
  });
  const { blockhash, lastValidBlockHeight } = await withNetworkDetail('solana blockhash', () =>
    c.getLatestBlockhash('confirmed'),
  );
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [priorityIx, burnIx],
  }).compileToV0Message();
  const burnTx = new VersionedTransaction(msg);
  burnTx.sign([kp]);
  const burnSig = await withNetworkDetail('solana burn send', () =>
    c.sendTransaction(burnTx, { skipPreflight: false, maxRetries: 3 }),
  );
  const burnConfirm = await withNetworkDetail('solana burn confirm', () =>
    c.confirmTransaction(
      { signature: burnSig, blockhash, lastValidBlockHeight },
      'confirmed',
    ),
  );
  if (burnConfirm.value.err) {
    throw new Error(`burn failed on-chain: ${JSON.stringify(burnConfirm.value.err)}`);
  }
  return { burnSig, tokensBurned: Number(burnAmount) };
}

async function jupQuote({ inputMint, outputMint, amountLamports }) {
  const url = `${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}&onlyDirectRoutes=false&asLegacyTransaction=false`;
  let res;
  try {
    res = await jupFetch(url);
  } catch (e) {
    throw detailedFetchError('jupiter quote', e);
  }
  if (!res.ok) throw new Error(`jupiter quote ${res.status}: ${await res.text()}`);
  return res.json();
}

async function jupSwap(quoteResponse, userPubkey) {
  let res;
  try {
    res = await jupFetch(JUP_SWAP, {
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
  } catch (e) {
    throw detailedFetchError('jupiter swap', e);
  }
  if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${await res.text()}`);
  return res.json();
}

// Buys the given token using either SOL or a specified input mint (e.g. USDC)
// from `kp`, then burns 100% of the received tokens from `kp`'s ATA.
//
// Backwards-compat: caller may pass `solAmount` (SOL UI units) and we default
// `payMint=SOL`. For external tokens whose collateral settles in USDC, pass
// `payMint=USDC_MINT` + `payAmountBaseUnits=<usd * 1e6>` so we skip the
// USDC -> SOL hop entirely (one swap, no extra slippage/fees).
export async function buybackAndBurn({
  mintAddress,
  solAmount,
  kp: kpArg,
  payMint,
  payAmountBaseUnits,
}) {
  const kp = kpArg ?? treasury();
  const mint = new PublicKey(mintAddress);
  const c = conn();

  // Resolve the input leg. Default: SOL (legacy path).
  const inputMint = payMint || SOL_MINT;
  let inputAmount;
  if (payAmountBaseUnits != null) {
    inputAmount = Math.floor(Number(payAmountBaseUnits));
  } else {
    if (!solAmount || solAmount <= 0) throw new Error('solAmount must be > 0 (or pass payAmountBaseUnits)');
    inputAmount = Math.floor(solAmount * 1e9);
  }
  if (!inputAmount || inputAmount <= 0) throw new Error('buyback input amount must be > 0');

  // The output token's ATA (pump.fun mints are Token-2022, rent ~0.0021 SOL) is
  // created by the swap tx and paid from THIS wallet's SOL — regardless of the
  // input leg. So the SOL floor must be checked for BOTH the SOL-input and the
  // payMint (token-input) paths; otherwise a token-input buyback fails in
  // simulation creating the ATA and gets retried every tick (logdumps/FIXES.md
  // Issue 2). RENT_RESERVE (ATA rent + slack) + FEE_BUFFER (2 txs + priority).
  const walletLamports = await withNetworkDetail('solana getBalance', () =>
    c.getBalance(kp.publicKey, 'confirmed'),
  );
  const RENT_FLOOR_LAMPORTS = RENT_RESERVE_LAMPORTS + FEE_BUFFER_LAMPORTS;
  if (walletLamports < RENT_FLOOR_LAMPORTS) {
    const err = new Error(
      `buyback skip: wallet=${kp.publicKey.toBase58()} lamports=${walletLamports} below ATA-rent+fee floor=${RENT_FLOOR_LAMPORTS} (input=${inputMint === SOL_MINT ? 'sol' : 'token'})`,
    );
    err.code = 'INSUFFICIENT_FUNDS';
    throw err;
  }

  // Defensive clamp: when paying in SOL, cap inputAmount to the wallet's
  // actual spendable lamports (balance - rent reserve - fee buffer). This
  // prevents `insufficient lamports` / Meteora 0xbbf failures when the
  // caller's planned spend is stale vs the current wallet balance.
  if (inputMint === SOL_MINT) {
    const spendable = Math.max(0, walletLamports - RENT_RESERVE_LAMPORTS - FEE_BUFFER_LAMPORTS);
    if (spendable < MIN_SPEND_LAMPORTS) {
      const err = new Error(
        `buyback skip: wallet=${kp.publicKey.toBase58()} lamports=${walletLamports} spendable=${spendable} below MIN_SPEND=${MIN_SPEND_LAMPORTS}`,
      );
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }
    if (inputAmount > spendable) {
      console.log(
        `[buyback] clamp ${mintAddress}: requested=${inputAmount} lamports -> ${spendable} lamports (wallet=${walletLamports})`,
      );
      inputAmount = spendable;
      // Recompute solAmount so the return value reflects what we actually spent.
      if (solAmount != null) solAmount = inputAmount / 1e9;
    }
  }

  // ---- swap ----
  const quote = await jupQuote({
    inputMint,
    outputMint: mintAddress,
    amountLamports: inputAmount,
  });
  const tokensBought = Number(quote.outAmount); // in mint base units
  if (!tokensBought) throw new Error('jupiter returned zero outAmount');

  const swapResp = await jupSwap(quote, kp.publicKey.toBase58());
  const swapTxBuf = Buffer.from(swapResp.swapTransaction, 'base64');
  const swapTx = VersionedTransaction.deserialize(swapTxBuf);
  swapTx.sign([kp]);

  const swapSig = await withNetworkDetail('solana swap send', () =>
    c.sendTransaction(swapTx, { skipPreflight: false, maxRetries: 3 }),
  );
  const swapConfirm = await withNetworkDetail('solana swap confirm', () =>
    c.confirmTransaction(swapSig, 'confirmed'),
  );
  if (swapConfirm.value.err) {
    throw new Error(`swap failed on-chain: ${JSON.stringify(swapConfirm.value.err)}`);
  }

  // ---- burn ----
  // Read ACTUAL balance in the ATA after swap (slippage means actual <= quoted).
  // Also picks up any stranded tokens from a previous failed burn on this mint.
  // Auto-detect token program: pump.fun mints today are Token-2022, but some
  // legacy/migrated mints are still classic SPL. We try the detected program
  // first, then fall back to the other program and retry with a short poll to
  // absorb RPC lag between confirmTransaction and the balance reflecting.
  let tokenProgramId = await resolveTokenProgram(c, mint);
  let ata = await getAssociatedTokenAddress(mint, kp.publicKey, true, tokenProgramId);
  let burnAmount = 0n;
  const triedPrograms = [tokenProgramId];
  const altProgram = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_PROGRAM_ID
    : TOKEN_2022_PROGRAM_ID;

  // Poll up to ~6s for the balance to land. RPC nodes often lag a beat behind
  // confirmTransaction even at 'confirmed' commitment.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const acct = await getAccount(c, ata, 'confirmed', tokenProgramId);
      if (acct.amount > 0n) {
        burnAmount = acct.amount;
        break;
      }
    } catch {
      /* ATA may not exist yet, keep polling */
    }
    // After 2 misses, also try the alternate token program in case the mint
    // resolver was wrong (e.g., AMM migration changed the owner mid-flight).
    if (attempt === 2 && !triedPrograms.some((p) => p.equals(altProgram))) {
      try {
        const altAta = await getAssociatedTokenAddress(mint, kp.publicKey, true, altProgram);
        const acct = await getAccount(c, altAta, 'confirmed', altProgram);
        if (acct.amount > 0n) {
          tokenProgramId = altProgram;
          ata = altAta;
          burnAmount = acct.amount;
          break;
        }
        triedPrograms.push(altProgram);
      } catch {
        triedPrograms.push(altProgram);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (burnAmount === 0n) {
    throw new Error(
      `swap landed but ATA balance is 0 after 6s poll across [${triedPrograms.map((p) => p.toBase58().slice(0, 8)).join(',')}] (sig=${swapSig})`,
    );
  }
  const burnIx = createBurnInstruction(ata, mint, kp.publicKey, burnAmount, [], tokenProgramId);
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_LAMPORTS,
  });
  const { blockhash, lastValidBlockHeight } = await withNetworkDetail('solana blockhash', () =>
    c.getLatestBlockhash('confirmed'),
  );
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [priorityIx, burnIx],
  }).compileToV0Message();
  const burnTx = new VersionedTransaction(msg);
  burnTx.sign([kp]);
  const burnSig = await withNetworkDetail('solana burn send', () =>
    c.sendTransaction(burnTx, { skipPreflight: false, maxRetries: 3 }),
  );
  const burnConfirm = await withNetworkDetail('solana burn confirm', () =>
    c.confirmTransaction(
      { signature: burnSig, blockhash, lastValidBlockHeight },
      'confirmed',
    ),
  );
  if (burnConfirm.value.err) {
    throw new Error(`burn failed on-chain (tokens sit in ATA): ${JSON.stringify(burnConfirm.value.err)}`);
  }

  return {
    swapSig,
    burnSig,
    solSpent: solAmount ?? 0,
    inputMint,
    inputAmount,
    tokensBought,
    tokensBurned: Number(burnAmount),
  };
}
