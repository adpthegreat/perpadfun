// Client-side "zap-in" to the PERPSPAD-WSOL DAMM v2 pool: take a SOL input,
// swap+split it across both sides of the pool, and deposit as LP in one flow
// (Meteora's zap program). The user's browser wallet signs the single tx;
// nothing here touches server secrets.
//
// Verified ground truth (do not change without re-verifying on-chain):
//   - PERPSPAD mint:    PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL
//   - WSOL mint:        So11111111111111111111111111111111111111112
//   - PERPSPAD/WSOL DAMM v2 pool (MigrationFeeOption.FixedBps100):
//     84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ
//   - pool tokenA = PERPSPAD, tokenB = WSOL (confirmed via fetchPoolState)
// The input is SOL (WSOL), which matches tokenB -> "direct" zap route, so the
// zap-sdk never emits separate Jupiter swap transactions (swapTransactions is
// always empty). That's what lets us fold the whole flow into ONE transaction.
//
// Why a single atomic tx (and not the SDK's separate setup/ledger/zap/cleanup
// transactions): the ZapInDammV2 instruction reads the user's token-account
// balances. Those accounts (the PERPSPAD + WSOL ATAs) and the wrapped SOL are
// created by the "setup" instructions. If setup and zap-in land in DIFFERENT
// transactions, zap-in's preflight simulation runs against a chain state where
// those ATAs don't exist yet -> the on-chain program panics at token.rs reading
// a length-0 account ("range end index 72 out of range for slice of length 0").
// Merging every instruction into one legacy tx (create position -> create ATAs +
// wrap SOL -> init ledger + set balance -> zap-in -> close ledger + unwrap SOL)
// makes them execute in order in the same tx, so the accounts always exist by
// the time zap-in reads them, and any failure reverts the whole thing (no
// stranded WSOL, no orphan position). Verified end-to-end via on-chain
// simulateTransaction: err=null, ~231k CU, deposits + adds liquidity cleanly.
// Serialized message is ~856 bytes, well under the 1232-byte limit.
//
// Jupiter quotes go through the SAME CORS-friendly endpoint the rest of the
// app uses (lite-api.jup.ag). The zap-sdk's default is api.jup.ag (key-gated),
// so we override `jupiterApiUrl` on both the `Zap` ctor and `getJupiterQuote`.

import { ensureBufferPolyfill } from "../buffer-polyfill";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// zap-sdk + cp-amm-sdk reference Node's Buffer; polyfill must run first.
ensureBufferPolyfill();

export const PERPSPAD_MINT = "PerPsCe2SJ7Q25CN4R5TTX4fmBdmknE2hQmqCt96fHL";
export const PERPSPAD_WSOL_POOL = "84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Same endpoint src/lib/jupiter.ts uses for browser swaps (CORS-friendly).
const JUP_LITE_API = "https://lite-api.jup.ag";

// A unit quote (1 whole input token, not 1 lamport) is what zap-sdk's
// price-calc path expects — see the d.ts docs on getZapInDammV2DirectPoolParams:
// dammV2Quote / jupiterQuote are "for exactly 1 input token in lamports (used
// for price calculation, not the actual amountIn)". For SOL that's 1e9 lamports;
// at 1 lamport the pool's swapOutAmount rounds to 0 and getPriceImpact throws
// "amount out must be greater than 0".
const UNIT_SOL = new BN(1_000_000_000);

// Observed ~231k CU in on-chain simulation; 400k gives comfortable margin. An
// explicit limit makes landing predictable instead of relying on the runtime's
// instruction-count-derived default.
const ZAP_COMPUTE_UNIT_LIMIT = 400_000;

export type BuiltZap = {
  positionNftKeypair: Keypair;
  // One atomic transaction: create position + setup + ledger + zap-in + cleanup.
  // Caller stamps a fresh blockhash + feePayer, partialSign(positionNftKeypair),
  // then wallet-signs and sends. Returned unsigned/blockhash-less so the caller
  // controls freshness.
  transaction: Transaction;
};

/**
 * Build (but do NOT sign) the single atomic zap-in transaction for
 * `amountLamports` of SOL into the PERPSPAD/WSOL pool. Caller must:
 *   1. stamp a fresh blockhash + feePayer,
 *   2. transaction.partialSign(positionNftKeypair),
 *   3. wallet.signTransaction(transaction),
 *   4. send + confirm.
 */
export async function buildPerpspadZap(opts: {
  connection: Connection;
  user: PublicKey;
  amountLamports: BN;
  slippageBps: number;
}): Promise<BuiltZap> {
  const { Zap, getJupiterQuote } = await import("@meteora-ag/zap-sdk");
  const { CpAmm, getTokenDecimals } = await import("@meteora-ag/cp-amm-sdk");

  const connection = opts.connection;
  const pool = new PublicKey(PERPSPAD_WSOL_POOL);
  const inputMint = new PublicKey(WSOL_MINT); // user deposits SOL
  const amm = new CpAmm(connection);
  const zap = new Zap(connection, {
    jupiterApiUrl: JUP_LITE_API,
    jupiterApiKey: "",
  });

  const poolState = await amm.fetchPoolState(pool);
  const tokenADecimal = await getTokenDecimals(connection, poolState.tokenAMint, TOKEN_PROGRAM_ID);
  const tokenBDecimal = await getTokenDecimals(connection, poolState.tokenBMint, TOKEN_PROGRAM_ID);

  // DAMM v2 quote via the pool itself — getQuote() returns the exact shape
  // ({ swapInAmount, consumedInAmount, swapOutAmount, minSwapOutAmount,
  //  totalFee, priceImpact }) getZapInDammV2DirectPoolParams expects.
  const slot = await connection.getSlot("confirmed");
  const now = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const dammV2Quote = amm.getQuote({
    inAmount: UNIT_SOL,
    inputTokenMint: inputMint,
    slippage: opts.slippageBps,
    poolState,
    currentTime: now,
    currentSlot: slot,
    tokenADecimal,
    tokenBDecimal,
    hasReferral: false,
  });

  // Jupiter quote for the swap leg (SOL -> PERPSPAD). May legitimately be null
  // when no direct Jupiter route exists; zap-sdk falls back to the DAMM v2
  // swap in that case.
  const [tokenAMintB58, tokenBMintB58] = [
    poolState.tokenAMint.toBase58(),
    poolState.tokenBMint.toBase58(),
  ];
  const otherSideMint = tokenAMintB58 === WSOL_MINT ? tokenBMintB58 : tokenAMintB58;
  const jupiterQuote = await getJupiterQuote(
    inputMint,
    new PublicKey(otherSideMint),
    UNIT_SOL,
    40, // maxAccounts — matches the zap-sdk example
    opts.slippageBps,
    false, // dynamicSlippage
    false, // onlyDirectRoutes
    false, // restrictIntermediateTokens
    undefined, // forJitoBundle
    { jupiterApiUrl: JUP_LITE_API, jupiterApiKey: "" },
  ).catch(() => null);

  const positionNftKeypair = Keypair.generate();
  const zapParam = await zap.getZapInDammV2DirectPoolParams({
    user: opts.user,
    inputTokenMint: inputMint,
    amountIn: opts.amountLamports,
    pool,
    positionNftMint: positionNftKeypair.publicKey,
    maxSqrtPriceChangeBps: 1000,
    maxTransferAmountExtendPercentage: 20,
    maxAccounts: 40,
    slippageBps: opts.slippageBps,
    dammV2Quote,
    jupiterQuote,
  });

  const zapResp = await zap.buildZapInDammV2Transaction(zapParam);

  // Direct WSOL route -> the SDK never emits Jupiter swap txs. If that ever
  // changes, those are separate versioned transactions that can't be folded
  // into this legacy tx and would need their own confirmed submission — fail
  // loudly rather than silently drop them.
  if (zapResp.swapTransactions.length > 0) {
    throw new Error(
      "Zap route unexpectedly requires separate Jupiter swaps; single-tx flow can't cover it.",
    );
  }

  const createPositionTx = await amm.createPosition({
    owner: opts.user,
    payer: opts.user,
    pool,
    positionNft: positionNftKeypair.publicKey,
  });

  // Order is load-bearing: create the position NFT, then create the token ATAs
  // and wrap the input SOL, then init + set the zap ledger, then zap-in (which
  // reads the now-existing ATA balances), then close the ledger + unwrap dust.
  const transaction = new Transaction();
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: ZAP_COMPUTE_UNIT_LIMIT }));
  transaction.add(...createPositionTx.instructions);
  if (zapResp.setupTransaction) transaction.add(...zapResp.setupTransaction.instructions);
  transaction.add(...zapResp.ledgerTransaction.instructions);
  transaction.add(...zapResp.zapInTransaction.instructions);
  transaction.add(...zapResp.cleanUpTransaction.instructions);

  return { positionNftKeypair, transaction };
}

// ---------------------------------------------------------------------------
// Reading + exiting existing positions ("my LP" / "unzap")
// ---------------------------------------------------------------------------

export type PerpspadPosition = {
  position: PublicKey;
  positionNftAccount: PublicKey;
  // Raw cp-amm PositionState — kept opaque here; buildUnzapTx passes it back to
  // the SDK verbatim, and the UI only reads the derived amounts below.
  positionState: unknown;
  unlockedLiquidity: BN; // removable liquidity (Q64)
  amountPerpspad: BN; // tokenA the position would return on full withdraw (6dp)
  amountSol: BN; // tokenB (WSOL/SOL) the position would return (9dp)
  feePerpspad: BN; // unclaimed trading fees in PERPSPAD (6dp)
  feeSol: BN; // unclaimed trading fees in SOL (9dp)
};

export type PerpspadPositions = {
  positions: PerpspadPosition[];
  totalPerpspad: BN;
  totalSol: BN;
  totalFeePerpspad: BN;
  totalFeeSol: BN;
};

/**
 * Fetch the connected user's removable LP positions in the PERPSPAD/WSOL pool,
 * with each position's withdrawable PERPSPAD + SOL amounts derived from its
 * unlocked liquidity. Uses getUserPositionByPool (which queries only the user's
 * own position NFTs — light on RPC, unlike a full program-account scan).
 * Positions with no unlocked liquidity (e.g. permanently-locked migration
 * liquidity) are filtered out — they can't be withdrawn.
 */
export async function fetchPerpspadPositions(opts: {
  connection: Connection;
  user: PublicKey;
}): Promise<PerpspadPositions> {
  const {
    CpAmm,
    getAmountAFromLiquidityDelta,
    getAmountBFromLiquidityDelta,
    getUnClaimLpFee,
    Rounding,
  } = await import("@meteora-ag/cp-amm-sdk");

  const pool = new PublicKey(PERPSPAD_WSOL_POOL);
  const amm = new CpAmm(opts.connection);
  const poolState = await amm.fetchPoolState(pool);
  const raw = await amm.getUserPositionByPool(pool, opts.user);

  const positions: PerpspadPosition[] = [];
  for (const p of raw) {
    const unlockedLiquidity: BN = p.positionState.unlockedLiquidity;
    if (!unlockedLiquidity || unlockedLiquidity.isZero()) continue;
    const amountPerpspad = getAmountAFromLiquidityDelta(
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      unlockedLiquidity,
      Rounding.Down,
      poolState.collectFeeMode,
    );
    const amountSol = getAmountBFromLiquidityDelta(
      poolState.sqrtMinPrice,
      poolState.sqrtPrice,
      unlockedLiquidity,
      Rounding.Down,
      poolState.collectFeeMode,
    );
    // Unclaimed trading fees the position has earned. feeTokenA = PERPSPAD,
    // feeTokenB = SOL. These are swept back to the wallet automatically on unzap
    // (removeAllLiquidityAndClosePosition claims fees as part of the exit).
    const fee = getUnClaimLpFee(poolState, p.positionState);
    positions.push({
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      positionState: p.positionState,
      unlockedLiquidity,
      amountPerpspad,
      amountSol,
      feePerpspad: fee.feeTokenA,
      feeSol: fee.feeTokenB,
    });
  }

  const totalPerpspad = positions.reduce((acc, p) => acc.add(p.amountPerpspad), new BN(0));
  const totalSol = positions.reduce((acc, p) => acc.add(p.amountSol), new BN(0));
  const totalFeePerpspad = positions.reduce((acc, p) => acc.add(p.feePerpspad), new BN(0));
  const totalFeeSol = positions.reduce((acc, p) => acc.add(p.feeSol), new BN(0));
  return { positions, totalPerpspad, totalSol, totalFeePerpspad, totalFeeSol };
}

/**
 * Build (unsigned) the "unzap" transaction for a single position: remove ALL
 * liquidity, claim fees, close the position, and unwrap the WSOL back to native
 * SOL (the SDK adds the unwrap automatically because tokenB is native). Returns
 * PERPSPAD + SOL to the user's wallet. Caller stamps blockhash + feePayer,
 * wallet-signs (the position NFT already exists, so no extra keypair), sends,
 * and confirms.
 *
 * slippageBps guards the minimum token amounts against price drift between build
 * and execution.
 */
export async function buildUnzapTx(opts: {
  connection: Connection;
  user: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  positionState: unknown;
  slippageBps: number;
}): Promise<Transaction> {
  const {
    CpAmm,
    getCurrentPoint,
    getAmountAFromLiquidityDelta,
    getAmountBFromLiquidityDelta,
    Rounding,
  } = await import("@meteora-ag/cp-amm-sdk");

  const pool = new PublicKey(PERPSPAD_WSOL_POOL);
  const amm = new CpAmm(opts.connection);
  const poolState = await amm.fetchPoolState(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positionState = opts.positionState as any;

  // Slippage-protected minimums from the current price.
  const liq: BN = positionState.unlockedLiquidity;
  const expectedA = getAmountAFromLiquidityDelta(
    poolState.sqrtPrice,
    poolState.sqrtMaxPrice,
    liq,
    Rounding.Down,
    poolState.collectFeeMode,
  );
  const expectedB = getAmountBFromLiquidityDelta(
    poolState.sqrtMinPrice,
    poolState.sqrtPrice,
    liq,
    Rounding.Down,
    poolState.collectFeeMode,
  );
  const keepBps = new BN(Math.max(0, 10_000 - opts.slippageBps));
  const tokenAAmountThreshold = expectedA.mul(keepBps).div(new BN(10_000));
  const tokenBAmountThreshold = expectedB.mul(keepBps).div(new BN(10_000));

  const currentPoint = await getCurrentPoint(opts.connection, poolState.activationType);
  const vestings = await amm.getAllVestingsByPosition(opts.position).catch(() => []);

  // removeAllLiquidityAndClosePosition returns a ready Transaction (remove +
  // claim fee + close + unwrap SOL). It already sizes its own compute budget;
  // simulated at ~33k CU, so no extra ComputeBudget instruction is added (a
  // duplicate would be rejected by the runtime).
  const tx = await amm.removeAllLiquidityAndClosePosition({
    owner: opts.user,
    position: opts.position,
    positionNftAccount: opts.positionNftAccount,
    poolState,
    positionState,
    tokenAAmountThreshold,
    tokenBAmountThreshold,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vestings: vestings.map((v: any) => ({ account: v.publicKey, vestingState: v.account })),
    currentPoint,
  });
  return tx;
}

/**
 * Build (unsigned) the "claim fees" transaction for a single position: harvest
 * the position's accrued trading fees to the user's wallet WITHOUT touching the
 * liquidity (the position stays open and keeps earning). The SDK unwraps the
 * WSOL fee side back to native SOL automatically. Caller stamps blockhash +
 * feePayer, wallet-signs, sends, confirms.
 */
export async function buildClaimFeesTx(opts: {
  connection: Connection;
  user: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
}): Promise<Transaction> {
  const { CpAmm, getTokenProgram } = await import("@meteora-ag/cp-amm-sdk");

  const pool = new PublicKey(PERPSPAD_WSOL_POOL);
  const amm = new CpAmm(opts.connection);
  const poolState = await amm.fetchPoolState(pool);

  // Returns a ready Transaction (claim + unwrap SOL). Simulated at ~16k CU with
  // its own budget, so no extra ComputeBudget instruction is added.
  return amm.claimPositionFee({
    owner: opts.user,
    position: opts.position,
    pool,
    positionNftAccount: opts.positionNftAccount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
  });
}
