// Direct Meteora swaps for perpspad-native coins — no Jupiter dependency, so a
// brand-new coin is tradable the instant its pool exists:
//   - pre-graduation  -> Dynamic Bonding Curve (DBC) swapQuote + swap
//   - post-graduation -> DAMM v2 (cp-amm) getQuote + swap
// Both SDKs are heavy, so they're lazily imported (code-split out of the main
// bundle). The 1% perpspad fee is appended as a SOL transfer in the same tx the
// user signs (see meteoraSwapTx). Pool addresses come from the token record
// (dbc_pool_address / graduated_pool_address).
import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";

export const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export type MeteoraMode = "dbc" | "damm";
export type Side = "buy" | "sell";
export type MeteoraQuote = { outAmount: number; minOut: number };

async function mintInfo(connection: Connection, mint: PublicKey) {
  const info = await connection.getParsedAccountInfo(mint);
  const program = info.value?.owner ?? TOKEN_PROGRAM;
  const decimals = Number((info.value?.data as any)?.parsed?.info?.decimals ?? 0);
  return { program, decimals };
}

// ---------------- DBC (pre-graduation) ----------------
async function dbcClient(connection: Connection) {
  const { DynamicBondingCurveClient } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  return new DynamicBondingCurveClient(connection, "confirmed");
}

async function dbcQuote(opts: {
  connection: Connection;
  poolAddress: string;
  side: Side;
  amountIn: number;
  slippageBps: number;
}): Promise<MeteoraQuote> {
  const { getCurrentPoint } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = await dbcClient(opts.connection);
  const pool = await client.state.getPool(new PublicKey(opts.poolAddress));
  const config = await client.state.getPoolConfig(pool.config);
  const currentPoint = await getCurrentPoint(opts.connection, config.activationType);
  const q = client.pool.swapQuote({
    virtualPool: pool,
    config,
    swapBaseForQuote: opts.side === "sell", // sell = base(token) -> quote(SOL)
    amountIn: new BN(opts.amountIn),
    slippageBps: opts.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  const out = Number((q as any).amountOut ?? q.minimumAmountOut);
  return { outAmount: out, minOut: Number(q.minimumAmountOut) };
}

async function dbcSwapTx(opts: {
  connection: Connection;
  poolAddress: string;
  user: PublicKey;
  side: Side;
  amountIn: number;
  minOut: number;
}): Promise<Transaction> {
  const client = await dbcClient(opts.connection);
  return client.pool.swap({
    owner: opts.user,
    pool: new PublicKey(opts.poolAddress),
    amountIn: new BN(opts.amountIn),
    minimumAmountOut: new BN(opts.minOut),
    swapBaseForQuote: opts.side === "sell",
    referralTokenAccount: null,
    payer: opts.user,
  });
}

// ---------------- DAMM v2 / cp-amm (post-graduation) ----------------
async function ammClient(connection: Connection) {
  const { CpAmm } = await import("@meteora-ag/cp-amm-sdk");
  return new CpAmm(connection);
}

async function dammQuote(opts: {
  connection: Connection;
  poolAddress: string;
  tokenMint: string;
  side: Side;
  amountIn: number;
  slippageBps: number;
}): Promise<MeteoraQuote> {
  const amm = await ammClient(opts.connection);
  const pool = await amm.fetchPoolState(new PublicKey(opts.poolAddress));
  const a = await mintInfo(opts.connection, pool.tokenAMint);
  const b = await mintInfo(opts.connection, pool.tokenBMint);
  const slot = await opts.connection.getSlot();
  const now = (await opts.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const q = amm.getQuote({
    inAmount: new BN(opts.amountIn),
    inputTokenMint: opts.side === "buy" ? new PublicKey(WSOL) : new PublicKey(opts.tokenMint),
    slippage: opts.slippageBps,
    poolState: pool,
    currentTime: now,
    currentSlot: slot,
    tokenADecimal: a.decimals,
    tokenBDecimal: b.decimals,
    hasReferral: false,
  });
  return { outAmount: Number(q.swapOutAmount), minOut: Number(q.minSwapOutAmount) };
}

async function dammSwapTx(opts: {
  connection: Connection;
  poolAddress: string;
  tokenMint: string;
  user: PublicKey;
  side: Side;
  amountIn: number;
  minOut: number;
}): Promise<Transaction> {
  const amm = await ammClient(opts.connection);
  const pool = await amm.fetchPoolState(new PublicKey(opts.poolAddress));
  const a = await mintInfo(opts.connection, pool.tokenAMint);
  const b = await mintInfo(opts.connection, pool.tokenBMint);
  const tokenPk = new PublicKey(opts.tokenMint);
  // cp-amm's TxBuilder is `Promise<Transaction>`, so awaiting swap() yields the tx.
  return amm.swap({
    payer: opts.user,
    pool: new PublicKey(opts.poolAddress),
    inputTokenMint: opts.side === "buy" ? new PublicKey(WSOL) : tokenPk,
    outputTokenMint: opts.side === "buy" ? tokenPk : new PublicKey(WSOL),
    amountIn: new BN(opts.amountIn),
    minimumAmountOut: new BN(opts.minOut),
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAProgram: a.program,
    tokenBProgram: b.program,
    referralTokenAccount: null,
    receiver: opts.user,
  });
}

// ---------------- unified ----------------
export async function meteoraQuote(opts: {
  connection: Connection;
  mode: MeteoraMode;
  poolAddress: string;
  tokenMint: string;
  side: Side;
  amountIn: number;
  slippageBps: number;
}): Promise<MeteoraQuote> {
  return opts.mode === "dbc" ? dbcQuote(opts) : dammQuote(opts);
}

/**
 * Build the Meteora swap Transaction and append the 1% SOL fee transfer, ready
 * for the wallet to sign. `feeLamports` is computed by the caller (no extra
 * price call). Returns a legacy Transaction with feePayer + blockhash set.
 */
export async function meteoraSwapTx(opts: {
  connection: Connection;
  mode: MeteoraMode;
  poolAddress: string;
  tokenMint: string;
  user: string;
  side: Side;
  amountIn: number;
  minOut: number;
  feeWallet: string;
  feeLamports: number;
}): Promise<Transaction> {
  const user = new PublicKey(opts.user);
  const tx =
    opts.mode === "dbc"
      ? await dbcSwapTx({ ...opts, user })
      : await dammSwapTx({ ...opts, user });
  if (opts.feeLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: new PublicKey(opts.feeWallet),
        lamports: opts.feeLamports,
      }),
    );
  }
  tx.feePayer = user;
  tx.recentBlockhash = (await opts.connection.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}
