// Shared launch pipeline for the single launch route (public + admin modes). See
// plan/PERPSPAD_LAUNCH.md. Atomicity contract: a `tokens` row is only ever in two
// terminal states — `live` (a real, on-chain, fully-recorded launch) or absent.
//   - admin mode: treasury signs + sends, then the row is inserted ONLY on success.
//   - public mode: a transient `launching` row is inserted at build; the keeper
//     reconciler promotes it to `live` once the pool appears on-chain, or deletes it
//     if the pool never materializes (TTL). No half-states survive.
import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";
import { getTreasuryKeypair } from "@/lib/solana/treasury.server";
import { backOff } from "@/lib/backoff";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { type SupplyBreakdown } from "@/lib/launch/supplyBreakdown";
import { deriveSubWalletKeypair, tokenInvariantsFor } from "@/lib/solana/subWallet.server";
import { isLaunchableMarket, isValidLeverageFor, maxLeverageFor } from "@/lib/imperial-markets";
import {
  breakdownFor,
  buildConfigParams,
  LAUNCH_RENT_AND_FEES_LAMPORTS,
  loadBN,
  loadSdk,
  presetForLeverage,
  publicBaseUrl,
  quoteMintFor,
  quoteDecimalsFor,
  STANDARD_FEE_SCHEDULE,
  SUB_WALLET_OPS_SEED_LAMPORTS,
  type CurvePreset,
  type FeeSchedule,
  type Quote,
} from "@/lib/launch/config-builder";

export const PUBLIC_LAUNCH_FEE_SOL = Number(process.env.PUBLIC_LAUNCH_FEE_SOL ?? 0.01);

export {
  buildConfigParams,
  LAUNCH_RENT_AND_FEES_LAMPORTS,
  loadBN,
  loadSdk,
  presetForLeverage,
  publicBaseUrl,
  quoteMintFor,
  STANDARD_FEE_SCHEDULE,
  SUB_WALLET_OPS_SEED_LAMPORTS,
};
export type { CurvePreset, FeeSchedule, Quote };

// Common launch fields shared by both modes.
export type BaseLaunchFields = {
  ticker: string;
  name: string;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  underlying: string;
  leverage: number;
  direction: "long" | "short";
  quote: Quote;
  creatorAddress: string;
};
export type PublicLaunchInput = BaseLaunchFields & { devBuy: number };
export type AdminLaunchInput = BaseLaunchFields & {
  devBuy: number;
  leftoverTokens?: number;
  feeSchedule?: FeeSchedule;
  tokenId?: string;
};

export function assertMarket(underlying: string, leverage: number) {
  if (!isLaunchableMarket(underlying)) throw new Error(`unsupported market: ${underlying}`);
  if (!isValidLeverageFor(underlying, leverage))
    throw new Error(
      `unsupported leverage ${leverage}x for ${underlying} (cap ${maxLeverageFor(underlying)}x)`,
    );
}

// Worker-safe confirmation — the SAME technique launchAsTreasury uses for its prefund: poll
// getSignatureStatus with exponential backoff (HTTP, no WebSocket signatureSubscribe to stall on a
// Cloudflare Worker). Throws on a terminal on-chain error or if it never reaches confirmed/finalized.
export async function pollConfirmed(
  conn: Connection,
  sig: string,
  minStatus: "processed" | "confirmed" = "confirmed",
): Promise<void> {
  const accept =
    minStatus === "processed"
      ? ["processed", "confirmed", "finalized"]
      : ["confirmed", "finalized"];
  let ok = false;
  let onChainErr: unknown = null;
  await backOff(
    async () => {
      const v = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
      if (v?.err) {
        onChainErr = v.err;
        return;
      }
      if (v?.confirmationStatus && accept.includes(v.confirmationStatus)) {
        ok = true;
        return;
      }
      throw new Error("not yet confirmed");
    },
    {
      numOfAttempts: 16,
      startingDelay: 1000,
      timeMultiple: 1.5,
      maxDelay: 4000,
      jitter: "full",
      retry: () => true,
    },
  ).catch(() => {});
  if (onChainErr) throw new Error(`tx ${sig} failed on-chain: ${JSON.stringify(onChainErr)}`);
  if (!ok) throw new Error(`tx ${sig} not confirmed in time`);
}

// Single row writer. status='live' for a confirmed launch; status='launching' for a
// public pending row awaiting on-chain confirmation. on-conflict(id) keeps it idempotent.
async function upsertTokenRow(args: {
  tokenId: string;
  fields: BaseLaunchFields;
  curvePreset: CurvePreset;
  status: "launching" | "live";
  mint?: string;
  poolAddress?: string;
  configAddress?: string;
  signature?: string;
}) {
  const inv = tokenInvariantsFor(args.tokenId);
  const { error } = await supabaseAdmin.from("tokens").upsert(
    {
      id: args.tokenId,
      treasury_wallet_address: inv.treasury_wallet_address,
      imperial_profile_index: inv.imperial_profile_index,
      ticker: args.fields.ticker,
      name: args.fields.name,
      description: args.fields.description ?? null,
      image_url: args.fields.imageUrl ?? null,
      website_url: args.fields.websiteUrl ?? null,
      twitter_url: args.fields.twitterUrl ?? null,
      underlying: args.fields.underlying,
      leverage: args.fields.leverage,
      direction: args.fields.direction,
      creator_address: args.fields.creatorAddress,
      curve_preset: args.curvePreset,
      status: args.status,
      quote_token: args.fields.quote,
      migration_status: "pending",
      mint_address: args.mint ?? null,
      dbc_pool_address: args.poolAddress ?? null,
      dbc_config_address: args.configAddress ?? null,
      launch_signature: args.signature ?? null,
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
}

// Dry-run: supply breakdown only (no writes / no chain). Admin ?dryRun=1.
export async function previewLaunch(input: {
  quote: Quote;
  leverage: number;
  leftoverTokens?: number;
  feeSchedule?: FeeSchedule;
}): Promise<{ supplyBreakdown: SupplyBreakdown }> {
  const sdk = await loadSdk();
  const configParams = await buildConfigParams(sdk, {
    quote: input.quote,
    curvePreset: presetForLeverage(input.leverage),
    leftoverTokens: input.leftoverTokens,
    feeSchedule: input.feeSchedule,
  });
  return { supplyBreakdown: breakdownFor(configParams, input.leftoverTokens ?? 0) };
}

// ── Admin mode: treasury signs + sends BOTH txs, then the row is written ONLY on
// success (atomic — no row exists unless the launch landed). May set leftover + fee.
export async function launchAdmin(input: AdminLaunchInput): Promise<{
  tokenId: string;
  mint: string;
  poolAddress: string;
  signature: string;
  supplyBreakdown: SupplyBreakdown;
  status: "live";
}> {
  assertMarket(input.underlying, input.leverage);
  const sdk = await loadSdk();
  const BN = await loadBN();
  const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");

  const tokenId = input.tokenId ?? randomUUID();
  const subWallet = deriveSubWalletKeypair(tokenId);

  // The deterministic sub-wallet is the SOLE payer/buyer/pool-creator. In admin/CLI mode there is no
  // browser wallet to prefund it, so the .env/treasury key (the deployer here) funds it itself, then
  // the sub-wallet launches — same role as the frontend prefund, just treasury-signed. Idempotent:
  // only tops up the shortfall. SOL pools: SOL covers rent + fees + dev-buy. USDC pools: SOL covers
  // rent/fees/ATA, and the dev-buy USDC moves from the treasury's USDC account into the sub's ATA.
  const treasury = getTreasuryKeypair();
  const solDevBuy = input.quote === "SOL" ? Math.round(input.devBuy * LAMPORTS_PER_SOL) : 0;
  const requiredSol = solDevBuy + LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED_LAMPORTS;
  const fundIxs: any[] = [];
  const subBal = await conn.getBalance(subWallet.publicKey, "confirmed");
  if (subBal < requiredSol) {
    fundIxs.push(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: subWallet.publicKey,
        lamports: requiredSol - subBal,
      }),
    );
  }
  if (input.quote !== "SOL") {
    // Any SPL quote (USDC, ANSEM, …): fund the sub-wallet's quote-token ATA with
    // the dev-buy amount from the treasury. NOTE: the treasury must hold that
    // token — for ANSEM launches with a dev-buy, seed the treasury with ANSEM or
    // set devBuy=0.
    const spl = await import("@solana/spl-token");
    const qMint = quoteMintFor(input.quote);
    const qDec = quoteDecimalsFor(input.quote);
    const qAmount = Math.round(input.devBuy * 10 ** qDec);
    const subAta = spl.getAssociatedTokenAddressSync(qMint, subWallet.publicKey, true);
    let subQuote = 0;
    try {
      subQuote = Number((await conn.getTokenAccountBalance(subAta, "confirmed")).value.amount ?? 0);
    } catch {
      subQuote = 0; // ATA not created yet
    }
    const quoteToSend = Math.max(0, qAmount - subQuote);
    if (quoteToSend > 0) {
      const treAta = spl.getAssociatedTokenAddressSync(qMint, treasury.publicKey, false);
      fundIxs.push(
        spl.createAssociatedTokenAccountIdempotentInstruction(
          treasury.publicKey,
          subAta,
          subWallet.publicKey,
          qMint,
        ),
        spl.createTransferCheckedInstruction(
          treAta,
          qMint,
          subAta,
          treasury.publicKey,
          quoteToSend,
          qDec,
        ),
      );
    }
  }
  if (fundIxs.length > 0) {
    const fundBh = await conn.getLatestBlockhash("confirmed");
    const fundTx = new Transaction({
      recentBlockhash: fundBh.blockhash,
      feePayer: treasury.publicKey,
    }).add(...fundIxs);
    fundTx.sign(treasury);
    const fundSig = await conn.sendRawTransaction(fundTx.serialize(), { skipPreflight: false });
    await pollConfirmed(conn, fundSig);
  }

  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const userPk = new PublicKey(input.creatorAddress);
  const quoteMint = quoteMintFor(input.quote);
  const curvePreset = presetForLeverage(input.leverage);
  const dec = quoteDecimalsFor(input.quote);
  const metadataUri = `${publicBaseUrl()}/api/v1/launch/${tokenId}/metadata`;
  const configParams = await buildConfigParams(sdk, {
    quote: input.quote,
    curvePreset,
    leftoverTokens: input.leftoverTokens,
    feeSchedule: input.feeSchedule,
  });
  const client = new sdk.DynamicBondingCurveClient(conn, "confirmed");

  const { createConfigTx, createPoolWithFirstBuyTx } =
    await client.pool.createConfigAndPoolWithFirstBuy({
      config: config.publicKey,
      feeClaimer: subWallet.publicKey,
      leftoverReceiver: subWallet.publicKey,
      quoteMint,
      payer: subWallet.publicKey,
      ...configParams,
      preCreatePoolParam: {
        name: input.name,
        symbol: input.ticker,
        uri: metadataUri,
        poolCreator: subWallet.publicKey,
        baseMint: baseMint.publicKey,
      },
      firstBuyParam: {
        buyer: subWallet.publicKey,
        receiver: userPk,
        buyAmount: new BN(Math.round(input.devBuy * 10 ** dec)),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      },
    });

  const bh1 = await conn.getLatestBlockhash("confirmed");
  createConfigTx.recentBlockhash = bh1.blockhash;
  createConfigTx.feePayer = subWallet.publicKey;
  createConfigTx.partialSign(config, subWallet);
  const configSig = await conn.sendRawTransaction(createConfigTx.serialize(), {
    skipPreflight: false,
  });
  // HTTP poll for "processed" (no WebSocket — confirmTransaction's signatureSubscribe stalls on a
  // Worker and is what hung us). Non-fatal: the pool send's preflight below fails if config didn't land.
  await pollConfirmed(conn, configSig, "processed").catch((e) =>
    console.warn("[launchAdmin] config confirm", e),
  );

  const bh2 = await conn.getLatestBlockhash("confirmed");
  createPoolWithFirstBuyTx.recentBlockhash = bh2.blockhash;
  createPoolWithFirstBuyTx.feePayer = subWallet.publicKey;
  createPoolWithFirstBuyTx.partialSign(baseMint, subWallet);
  // send with preflight: a tx that would fail throws HERE (no row written), so a successful send
  // means it will land. RPC lag must never orphan it → persist live now, confirm best-effort after.
  const poolSig = await conn.sendRawTransaction(createPoolWithFirstBuyTx.serialize(), {
    skipPreflight: false,
  });
  const poolAddress = sdk
    .deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey)
    .toBase58();

  await upsertTokenRow({
    tokenId,
    fields: input,
    curvePreset,
    status: "live",
    mint: baseMint.publicKey.toBase58(),
    poolAddress,
    configAddress: config.publicKey.toBase58(),
    signature: poolSig,
  });
  // No confirm here: the pool send already passed preflight, the row is `live`, and the keeper
  // reconciler verifies the pool on-chain. (A confirmTransaction would re-introduce the WS stall.)
  return {
    tokenId,
    mint: baseMint.publicKey.toBase58(),
    poolAddress,
    signature: poolSig,
    supplyBreakdown: breakdownFor(configParams, input.leftoverTokens ?? 0),
    status: "live",
  };
}

// ── Public mode (keyless, fee-gated): build the caller-signed config + pool txs
// (leftover=0, standard fee, + 0.01 SOL caller→treasury fee) and insert a TRANSIENT
// `launching` row. The keeper reconciler promotes it to `live` when the pool confirms,
// or deletes it on TTL. The 0.01 SOL fee (atomic in the pool tx) is the rate-limit.
export async function buildPublicLaunchTx(input: PublicLaunchInput): Promise<{
  tokenId: string;
  mint: string;
  configAddress: string;
  poolAddress: string;
  transactions: { label: "config" | "pool"; base64: string }[];
  supplyBreakdown: SupplyBreakdown;
  protocolFeeSol: number;
}> {
  assertMarket(input.underlying, input.leverage);
  const sdk = await loadSdk();
  const BN = await loadBN();
  const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");

  const tokenId = randomUUID();

  const subWallet = deriveSubWalletKeypair(tokenId);
  const treasury = getTreasuryKeypair();
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  const callerPk = new PublicKey(input.creatorAddress);
  const quoteMint = quoteMintFor(input.quote);
  const curvePreset = presetForLeverage(input.leverage);
  const dec = quoteDecimalsFor(input.quote);
  const metadataUri = `${publicBaseUrl()}/api/v1/launch/${tokenId}/metadata`;
  const configParams = await buildConfigParams(sdk, {
    quote: input.quote,
    curvePreset,
    leftoverTokens: 0,
    feeSchedule: STANDARD_FEE_SCHEDULE,
  });
  const client = new sdk.DynamicBondingCurveClient(conn, "confirmed");

  const { createConfigTx, createPoolWithFirstBuyTx } =
    await client.pool.createConfigAndPoolWithFirstBuy({
      config: config.publicKey,
      feeClaimer: subWallet.publicKey,
      leftoverReceiver: subWallet.publicKey,
      quoteMint,
      payer: callerPk, // CALLER pays all rent
      ...configParams,
      preCreatePoolParam: {
        name: input.name,
        symbol: input.ticker,
        uri: metadataUri,
        poolCreator: subWallet.publicKey,
        baseMint: baseMint.publicKey,
      },
      firstBuyParam: {
        buyer: callerPk,
        receiver: callerPk,
        buyAmount: new BN(Math.round(input.devBuy * 10 ** dec)),
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      },
    });

  const bh = await conn.getLatestBlockhash("confirmed");
  createConfigTx.recentBlockhash = bh.blockhash;
  createConfigTx.feePayer = callerPk;
  createConfigTx.partialSign(config);

  createPoolWithFirstBuyTx.add(
    SystemProgram.transfer({
      fromPubkey: callerPk,
      toPubkey: treasury.publicKey,
      lamports: Math.round(PUBLIC_LAUNCH_FEE_SOL * LAMPORTS_PER_SOL),
    }),
  );
  createPoolWithFirstBuyTx.recentBlockhash = bh.blockhash;
  createPoolWithFirstBuyTx.feePayer = callerPk;
  createPoolWithFirstBuyTx.partialSign(baseMint, subWallet);

  const poolAddress = sdk
    .deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey)
    .toBase58();

  // transient pending row — keeper promotes (pool on-chain) or expires (TTL). Captures
  // metadata so /metadata resolves immediately and nothing depends on a client callback.
  await upsertTokenRow({
    tokenId,
    fields: input,
    curvePreset,
    status: "launching",
    mint: baseMint.publicKey.toBase58(),
    poolAddress,
    configAddress: config.publicKey.toBase58(),
  });

  const ser = (tx: any) =>
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return {
    tokenId,
    mint: baseMint.publicKey.toBase58(),
    configAddress: config.publicKey.toBase58(),
    poolAddress,
    transactions: [
      { label: "config", base64: ser(createConfigTx) },
      { label: "pool", base64: ser(createPoolWithFirstBuyTx) },
    ],
    supplyBreakdown: breakdownFor(configParams, 0),
    protocolFeeSol: PUBLIC_LAUNCH_FEE_SOL,
  };
}

// Server-owned promotion: for each transient `launching` row, promote to `live` once
// its (deterministic) pool exists on-chain, else delete it past the TTL. Runs from the
// keeper tick (POST /api/admin/reconcile-launches). Guarantees no orphaned/half states.
export async function reconcilePendingLaunches(opts?: {
  ttlMinutes?: number;
}): Promise<{ promoted: string[]; expired: string[] }> {
  const ttlMs = (opts?.ttlMinutes ?? 20) * 60_000;
  const { data } = await supabaseAdmin
    .from("tokens")
    .select("id, dbc_pool_address, created_at")
    .eq("status", "launching");
  const rows = data ?? [];
  if (!rows.length) return { promoted: [], expired: [] };

  const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");
  const promoted: string[] = [];
  const expired: string[] = [];
  const cutoff = Date.now() - ttlMs;
  for (const r of rows) {
    const pool = r.dbc_pool_address as string | null;
    let exists = false;
    if (pool) {
      try {
        exists = (await conn.getAccountInfo(new PublicKey(pool))) != null;
      } catch {
        exists = false;
      }
    }
    if (exists) {
      await supabaseAdmin
        .from("tokens")
        .update({ status: "live" })
        .eq("id", r.id)
        .eq("status", "launching");
      promoted.push(r.id as string);
    } else if (r.created_at && new Date(r.created_at as string).getTime() < cutoff) {
      await supabaseAdmin.from("tokens").delete().eq("id", r.id).eq("status", "launching");
      expired.push(r.id as string);
    }
  }
  return { promoted, expired };
}
