// Server functions backing the Meteora DBC launch flow.
//
// The heavy lifting (building the createConfigAndPool tx) happens client-side
// via @meteora-ag/dynamic-bonding-curve-sdk. The server just:
//   1. createDraftToken: validates inputs, snapshots the HL launch mid, inserts
//      a row with status='launching' so we own the ticker before signing.
//   2. recordLaunch: confirms the on-chain tx landed and flips the row to live.
//   3. refreshPoolState: reads on-chain DBC pool state and updates sol_raised
//      + migration_status. Called on-demand from the token page.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";
import { isLaunchableMarket, isValidLeverageFor, maxLeverageFor } from "@/lib/imperial-markets";
import { newTokenIdentity, tokenInvariantsFor } from "@/lib/solana/subWallet.server";
import { transitionLaunch, markLaunchFailed } from "@/lib/launch/launchState";
import { nextSolRaised, nextMigrationStatus } from "@/lib/launch/poolState";
import { backOff } from "@/lib/backoff";

const PERP_FEED = "https://api.hyperliquid.xyz/info";

function assertAllowedLauncher(_addr: string) {
  // Launches are open to any Solana wallet.
}

async function getMid(coin: string): Promise<number> {
  const res = await fetch(PERP_FEED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!res.ok) throw new Error(`perp mid ${res.status}`);
  const mids = (await res.json()) as Record<string, string>;
  const v = mids[coin];
  if (!v) throw new Error(`Unknown perp market: ${coin}`);
  return Number(v);
}

// Phase 5: launch_mid is best-effort. The market is already validated by the
// isLaunchableMarket refine, and the keeper backfills entry price from Imperial
// when launch_mid is null — so a price-feed blip must NOT fail a launch.
async function tryGetMid(coin: string): Promise<number | null> {
  try {
    return await getMid(coin);
  } catch (e) {
    console.warn(`getMid(${coin}) failed; launch_mid will backfill later:`, e);
    return null;
  }
}

const launchInput = z.object({
  ticker: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z0-9]+$/, "Letters and numbers only"),
  name: z.string().min(1).max(32),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().max(500).optional(),
  websiteUrl: z.string().url().max(300).optional(),
  twitterUrl: z.string().url().max(300).optional(),
  underlying: z
    .string()
    .min(1)
    .max(20)
    .refine(isLaunchableMarket, {
      message: "Unsupported or unavailable market for Imperial routing",
    }),
  leverage: z.number().int().positive(),
  direction: z.enum(["long", "short"]),
  creatorAddress: z.string().min(32).max(44),
}).superRefine((d, ctx) => {
  // Leverage must be an allowed tier AND at or below the market's venue cap.
  // The picker enforces this client-side; re-check here so a stale/crafted
  // request can't launch an over-cap (e.g. 50×/100×) or off-tier position.
  if (!isValidLeverageFor(d.underlying, d.leverage)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["leverage"],
      message: `Unsupported leverage ${d.leverage}x for ${d.underlying} (Phoenix cap ${maxLeverageFor(d.underlying)}x)`,
    });
  }
});

export const createDraftToken = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => launchInput.parse(d))
  .handler(async ({ data }) => {
    try {
      assertAllowedLauncher(data.creatorAddress);
      const mid = await tryGetMid(data.underlying);
      const preset =
        data.leverage === 2 ? "gentle" : data.leverage >= 5 ? "parabolic" : "standard";

      // Atomic creation: the id + sub-wallet + profile index are derived
      // up-front and written in the SAME insert, so a token row can never
      // exist without its invariants (see LAUNCH_REFACTOR.md).
      const identity = newTokenIdentity();
      const { data: row, error } = await supabaseAdmin
        .from("tokens")
        .insert({
          id: identity.id,
          treasury_wallet_address: identity.treasury_wallet_address,
          imperial_profile_index: identity.imperial_profile_index,
          ticker: data.ticker,
          name: data.name,
          description: data.description ?? null,
          image_url: data.imageUrl ?? null,
          website_url: data.websiteUrl ?? null,
          twitter_url: data.twitterUrl ?? null,
          underlying: data.underlying,
          leverage: data.leverage,
          direction: data.direction,
          creator_address: data.creatorAddress,
          launch_mid: mid,
          curve_preset: preset,
          status: "launching",
          quote_token: "SOL",
          migration_status: "pending",
        })
        .select()
        .single();
      if (error) {
        if (error.code === "23505") {
          // Allow reuse of the ticker when:
          //  - existing row was deprecated (abandoned/test launch), OR
          //  - existing row never finalized on-chain (no mint_address)
          // In both cases we overwrite the row with the new launch's data
          // and hand back its id so the client can keep going.
          const { data: existing } = await supabaseAdmin
            .from("tokens")
            .select("id, mint_address, status, creator_address")
            .eq("ticker", data.ticker)
            .maybeSingle();
          const reusable =
            existing && (existing.status === "deprecated" || !existing.mint_address);
          if (reusable) {
            await supabaseAdmin
              .from("tokens")
              .update({
                ...tokenInvariantsFor(existing.id),
                name: data.name,
                description: data.description ?? null,
                image_url: data.imageUrl ?? null,
                website_url: data.websiteUrl ?? null,
                twitter_url: data.twitterUrl ?? null,
                underlying: data.underlying,
                leverage: data.leverage,
                direction: data.direction,
                creator_address: data.creatorAddress,
                launch_mid: mid,
                curve_preset: preset,
                status: "launching",
                migration_status: "pending",
                mint_address: null,
                dbc_pool_address: null,
                dbc_config_address: null,
                sol_raised: 0,
                treasury_sol: 0,
                position_size_usd: 0,
                position_collateral_usd: 0,
                opened_collateral_usd: 0,
                treasury_pnl_usd: 0,
                fees_accrued_usd: 0,
                buyback_reserve_usd: 0,
                tokens_burned: 0,
                last_sol_raised_seen: 0,
                pnl_high_water_usd: 0,
                position_opened_at: null,
                lp_position_address: null,
                graduated_pool_address: null,
                launch_signature: null,
                metadata_address: null,
              })
              .eq("id", existing.id);
            return {
              ok: true as const,
              tokenId: existing.id,
              launchMid: mid,
              curvePreset: preset,
              error: null as string | null,
            };
          }
          return { ok: false as const, error: "Ticker already taken" };
        }
        throw error;
      }

      return {
        ok: true as const,
        tokenId: row.id,
        launchMid: mid,
        curvePreset: preset,
        error: null as string | null,
      };
    } catch (e: unknown) {
      console.error("createDraftToken", e);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Failed to create draft",
      };
    }
  });

export const recordLaunch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        tokenId: z.string().uuid(),
        signature: z.string().min(32).max(120),
        mintAddress: z.string().min(32).max(44),
        dbcPoolAddress: z.string().min(32).max(44),
        dbcConfigAddress: z.string().min(32).max(44),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      // Best-effort confirmation poll. If RPC is laggy we still write the row
      // so the on-chain pool never ends up orphaned in the DB. backOff retries
      // on ANYTHING — "not yet confirmed" or a transient RPC error — matching
      // the old loop's error-tolerance, with exponential delay + jitter.
      const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");
      let confirmedErr: unknown = null;
      try {
        await backOff(
          async () => {
            const c = (
              await conn.getSignatureStatus(data.signature, { searchTransactionHistory: true })
            ).value;
            if (c?.err) {
              confirmedErr = c.err; // terminal on-chain failure → stop polling
              return;
            }
            if (c && (c.confirmationStatus === "confirmed" || c.confirmationStatus === "finalized")) {
              return; // confirmed → stop
            }
            throw new Error("not yet confirmed"); // pending → poll again
          },
          { numOfAttempts: 12, startingDelay: 1000, timeMultiple: 1.5, maxDelay: 8000, jitter: "full", retry: () => true },
        );
      } catch {
        // Exhausted the poll budget without confirmation; proceed best-effort.
      }

      if (confirmedErr) {
        // Terminal: the launch tx failed on-chain. Move the row out of
        // `launching` so it isn't shown or picked up by the keeper.
        await markLaunchFailed(data.tokenId, `launch tx failed: ${JSON.stringify(confirmedErr)}`);
        return { ok: false as const, error: `Launch tx failed: ${JSON.stringify(confirmedErr)}` };
      }

      const res = await transitionLaunch(data.tokenId, "live", {
        launch_signature: data.signature,
        mint_address: data.mintAddress,
        dbc_pool_address: data.dbcPoolAddress,
        dbc_config_address: data.dbcConfigAddress,
        migration_status: "curve",
      });
      if (!res.ok) throw new Error(res.error ?? "launch transition failed");
      return { ok: true as const, error: null as string | null };
    } catch (e: unknown) {
      console.error("recordLaunch", e);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Failed to record launch",
      };
    }
  });

export const refreshPoolState = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ tokenId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    try {
      const { data: t, error } = await supabaseAdmin
        .from("tokens")
        .select(
          "dbc_pool_address, pool_state_refreshed_at, migration_status, sol_raised, graduated_pool_address, current_price_sol, total_supply",
        )
        .eq("id", data.tokenId)
        .single();
      if (error || !t?.dbc_pool_address) {
        return { ok: false as const, error: "No pool to refresh" };
      }

      // Stale gate: only refresh if last refresh > 4s ago
      const last = t.pool_state_refreshed_at ? new Date(t.pool_state_refreshed_at).getTime() : 0;
      if (Date.now() - last < 4_000) {
        return {
          ok: true as const,
          cached: true,
          solRaised: Number(t.sol_raised ?? 0),
          currentPriceSol: Number(t.current_price_sol ?? 0),
          migrationStatus: t.migration_status as string,
          graduatedPoolAddress: (t.graduated_pool_address ?? null) as string | null,
          error: null as string | null,
        };
      }

      // Dynamic import server-side; SDK is pure JS, safe in Worker runtime.
      const {
        DynamicBondingCurveClient,
        getPriceFromSqrtPrice,
        deriveDammV2PoolAddress,
        DAMM_V2_MIGRATION_FEE_ADDRESS,
      } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
      const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");
      const client = new DynamicBondingCurveClient(conn, "confirmed");

      const poolPk = new PublicKey(t.dbc_pool_address);
      const pool = await client.state.getPool(poolPk);

      // pool.quoteReserve is in lamports for SOL pools. If the read doesn't
      // expose it (e.g. a graduated DBC pool whose reserve migrated to DAMM v2),
      // keep the last known value instead of overwriting sol_raised with 0.
      const freshSol = pool?.quoteReserve ? Number(BigInt(pool.quoteReserve.toString())) / 1e9 : null;
      const solRaised = nextSolRaised(freshSol, Number(t.sol_raised ?? 0));

      // Current spot price in SOL per base token, derived from sqrtPrice.
      // DBC defaults: base decimals 6, quote (SOL) decimals 9.
      let currentPriceSol = Number(t.current_price_sol ?? 0);
      try {
        const sp = (pool as unknown as { sqrtPrice?: { toString(): string } })?.sqrtPrice;
        if (sp) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const priceDec = getPriceFromSqrtPrice(sp as any, 6 as any, 9 as any);
          const decoded = Number(priceDec?.toString?.() ?? priceDec ?? 0);
          if (decoded > 0) currentPriceSol = decoded;
        }
      } catch (priceErr) {
        console.warn("price decode failed", priceErr);
      }

      // Migration is one-way: never downgrade a token that is already graduated
      // (a transient/undefined isMigrated read must not flip it back to "curve",
      // which would send the keeper to the DBC fee-claim path on a DAMM v2 pool).
      const migrationStatus = nextMigrationStatus(
        t.migration_status,
        (pool as unknown as { isMigrated?: boolean })?.isMigrated,
      );

      // After graduation, derive the DAMM v2 pool address so the keeper can
      // claim trading fees from it. Keep the last known DBC price as a floor
      // (we don't re-price from DAMM here to avoid pulling cp-amm-sdk).
      let graduatedPoolAddress: string | null = t.graduated_pool_address ?? null;
      if (migrationStatus === "graduated" && !graduatedPoolAddress) {
        try {
          const cfg = await client.state.getPoolConfig(pool.config);
          const feeOpt = Number(
            (cfg as unknown as { migrationFeeOption?: number }).migrationFeeOption ?? 0,
          );
          const dammCfg = DAMM_V2_MIGRATION_FEE_ADDRESS[feeOpt];
          const baseMint = (pool as unknown as { baseMint: PublicKey }).baseMint;
          const quoteMint = (cfg as unknown as { quoteMint: PublicKey }).quoteMint;
          if (dammCfg && baseMint && quoteMint) {
            graduatedPoolAddress = deriveDammV2PoolAddress(dammCfg, baseMint, quoteMint).toBase58();
          }
        } catch (derErr) {
          console.warn("damm v2 pool derive failed", derErr);
        }
      }

      const { error: upErr } = await supabaseAdmin
        .from("tokens")
        .update({
          sol_raised: solRaised,
          current_price_sol: currentPriceSol,
          migration_status: migrationStatus,
          graduated_pool_address: graduatedPoolAddress,
          pool_state_refreshed_at: new Date().toISOString(),
        })
        .eq("id", data.tokenId);
      if (upErr) throw upErr;


      return {
        ok: true as const,
        cached: false,
        solRaised,
        currentPriceSol,
        migrationStatus,
        graduatedPoolAddress,
        error: null as string | null,
      };
    } catch (e: unknown) {
      const err = e as Error;
      console.error("refreshPoolState", err?.message, err?.stack);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Failed to refresh pool",
      };
    }

  });

export const deleteDraft = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ tokenId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    try {
      await supabaseAdmin.from("tokens").delete().eq("id", data.tokenId).eq("status", "launching");
      return { ok: true as const, error: null as string | null };
    } catch (e: unknown) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Failed" };
    }
  });

// Recover an orphaned launch: the on-chain tx landed but the DB row was
// wiped (or never finalized). Caller supplies what they know; we locate the
// pool on-chain by base mint and insert a fresh row.
export const recoverLaunch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        mintAddress: z.string().min(32).max(44),
        ticker: z.string().min(1).max(12).regex(/^[A-Z0-9]+$/),
        name: z.string().min(1).max(64),
        description: z.string().max(500).optional(),
        imageUrl: z.string().url().max(500).optional(),
        underlying: z.string().min(1).max(20),
        leverage: z.number().int().positive(),
        direction: z.enum(["long", "short"]),
        creatorAddress: z.string().min(32).max(44),
        dbcPoolAddress: z.string().min(32).max(44),
        dbcConfigAddress: z.string().min(32).max(44),
        signature: z.string().min(32).max(120).optional(),
      })
      .superRefine((d, ctx) => {
        if (!isValidLeverageFor(d.underlying, d.leverage)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["leverage"],
            message: `Unsupported leverage ${d.leverage}x for ${d.underlying} (Phoenix cap ${maxLeverageFor(d.underlying)}x)`,
          });
        }
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      assertAllowedLauncher(data.creatorAddress);
      const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");
      const { DynamicBondingCurveClient } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
      const client = new DynamicBondingCurveClient(conn, "confirmed");
      // Verify the pool actually exists on-chain before writing.
      const pool = await client.state.getPool(new PublicKey(data.dbcPoolAddress));
      if (!pool) return { ok: false as const, error: "Pool not found on-chain" };

      const mid = await tryGetMid(data.underlying);
      const preset = data.leverage === 2 ? "gentle" : data.leverage >= 5 ? "parabolic" : "standard";
      const quoteReserveRaw = pool?.quoteReserve ? BigInt(pool.quoteReserve.toString()) : 0n;
      const solRaised = Number(quoteReserveRaw) / 1e9;

      const identity = newTokenIdentity();
      const { data: row, error } = await supabaseAdmin
        .from("tokens")
        .insert({
          id: identity.id,
          treasury_wallet_address: identity.treasury_wallet_address,
          imperial_profile_index: identity.imperial_profile_index,
          ticker: data.ticker,
          name: data.name,
          description: data.description ?? null,
          image_url: data.imageUrl ?? null,
          underlying: data.underlying,
          leverage: data.leverage,
          direction: data.direction,
          creator_address: data.creatorAddress,
          launch_mid: mid,
          curve_preset: preset,
          status: "live",
          quote_token: "SOL",
          migration_status: "curve",
          mint_address: data.mintAddress,
          dbc_pool_address: data.dbcPoolAddress,
          dbc_config_address: data.dbcConfigAddress,
          launch_signature: data.signature ?? null,
          sol_raised: solRaised,
          pool_state_refreshed_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, tokenId: row.id, error: null as string | null };
    } catch (e) {
      console.error("recoverLaunch", e);
      return { ok: false as const, error: e instanceof Error ? e.message : "Recover failed" };
    }
  });




// Sub-wallet-signed launch. The user funds the deterministic token sub-wallet,
// which creates the config + pool, dev-buys in the same atomic pool tx with the
// USER as token receiver (so the creator wallet shows as the dev holder), and
// is set as poolCreator + feeClaimer for later creator-fee claims.
const NATIVE_SOL_MINT_STR = "So11111111111111111111111111111111111111112";

export const launchAsTreasury = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        tokenId: z.string().uuid(),
        ticker: z.string().min(1).max(12).regex(/^[A-Z0-9]+$/),
        name: z.string().min(1).max(64),
        imageUrl: z.string().url().max(500).optional(),
        creatorAddress: z.string().min(32).max(44),
        // Dev-buy amount in lamports. Validated server-side against bounds.
        buyLamports: z.number().int().min(100_000_000).max(5_000_000_000),
        // Signature of the user's prefund transfer. Optional on retries when
        // the token sub-wallet is already funded from a previous attempt.
        prefundSignature: z.string().min(32).max(120).nullable().optional(),
        // 'gentle' | 'standard' | 'parabolic' — picked from leverage server-side.
        curvePreset: z.enum(["gentle", "standard", "parabolic"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      assertAllowedLauncher(data.creatorAddress);
      const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");

      // Derive this token's deterministic sub-wallet. It owns the DBC
      // feeClaimer + leftoverReceiver + poolCreator slots so every
      // creator-side trading fee lands in the sub-wallet, not master.
      // The keeper re-derives the same keypair server-side to sign.
      // The token's sub-wallet (signer). Its address + imperial_profile_index
      // were written atomically at creation (see LAUNCH_REFACTOR.md), so there
      // is no re-assignment here.
      const { deriveSubWalletKeypair } = await import("@/lib/solana/subWallet.server");
      const subWallet = deriveSubWalletKeypair(data.tokenId);

      // 1. Verify the prefund landed when this call includes a fresh transfer.
      // Retries can omit the signature because we re-check the sub-wallet's
      // current balance below and continue without charging the user again.
      if (data.prefundSignature) {
        // Poll up to 16 times for confirmation. Unlike recordLaunch this is
        // STRICT: if it never confirms we abort the launch (the balance check
        // below would fail anyway). backOff retries on "not yet confirmed" AND
        // transient RPC errors (the old flat loop would abort on either); a
        // terminal on-chain err stops polling early. const-capture keeps the
        // signature narrowed to string inside the closure.
        const sig = data.prefundSignature;
        let prefundOk = false;
        let prefundErr: unknown = null;
        try {
          await backOff(
            async () => {
              const v = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
              if (v?.err) {
                prefundErr = v.err; // terminal on-chain failure → stop polling
                return;
              }
              if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
                prefundOk = true; // confirmed → stop
                return;
              }
              throw new Error("not yet confirmed"); // pending → poll again
            },
            { numOfAttempts: 16, startingDelay: 1000, timeMultiple: 1.5, maxDelay: 4000, jitter: "full", retry: () => true },
          );
        } catch {
          // Exhausted the 16-attempt budget without a confirmed/finalized status.
        }
        if (prefundErr) return { ok: false as const, error: "Prefund tx failed on-chain" };
        if (!prefundOk) return { ok: false as const, error: "Prefund tx not confirmed in time" };
      }

      // Sub-wallet needs to cover: dev-buy + rent for config/pool/mint/etc
      // + tx fees + ongoing keeper ops seed. It is the only signer on the
      // launch txs and appears on-chain as the true pool creator, payer, and dev-buyer.
      // Sub-wallet must cover dev-buy + rent for config/pool/mint/etc + tx fees
      // + ongoing keeper ops seed. We over-provision rent & fees so a retry
      // after a partial failure (e.g. config landed but pool tx didn't) still
      // passes this balance check. Config rent alone is ~0.008 SOL.
      const SUB_WALLET_OPS_SEED_LAMPORTS = 10_000_000; // 0.01 SOL keep-alive after launch
      const LAUNCH_RENT_AND_FEES_LAMPORTS = 100_000_000; // 0.10 SOL: covers rent + 2 tx fees + ~0.04 SOL retry buffer
      const subWalletFundingLamports =
        data.buyLamports + LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED_LAMPORTS;

      const subWalletBal = await conn.getBalance(subWallet.publicKey, "confirmed");
      if (subWalletBal < subWalletFundingLamports) {
        return {
          ok: false as const,
          error: `Token sub-wallet balance too low (${subWalletBal} < ${subWalletFundingLamports} lamports). Prefund may not have credited yet.`,
        };
      }

      // 2. Build config + pool-with-first-buy with SUB-WALLET as
      //    payer/buyer/poolCreator/feeClaimer. Tokens still land in the
      //    user's wallet so they appear as the dev holder.
      const { default: BN } = await import("bn.js");
      const {
        DynamicBondingCurveClient,
        buildCurveWithMarketCap,
        TokenType,
        TokenDecimal,
        TokenUpdateAuthorityOption,
        MigrationOption,
        MigrationFeeOption,
        ActivationType,
        CollectFeeMode,
        BaseFeeMode,
        deriveDbcPoolAddress,
      } = await import("@meteora-ag/dynamic-bonding-curve-sdk");

      const client = new DynamicBondingCurveClient(conn, "confirmed");
      const config = Keypair.generate();
      const baseMint = Keypair.generate();
      const userPk = new PublicKey(data.creatorAddress);
      const quoteMint = new PublicKey(NATIVE_SOL_MINT_STR);


      const presets = {
        gentle: { initialMarketCap: 34, migrationMarketCap: 400 },
        standard: { initialMarketCap: 34, migrationMarketCap: 460 },
        parabolic: { initialMarketCap: 34, migrationMarketCap: 550 },
      } as const;
      const preset = presets[data.curvePreset];

      const configParams = buildCurveWithMarketCap({
        initialMarketCap: preset.initialMarketCap,
        migrationMarketCap: preset.migrationMarketCap,
        activationType: ActivationType.Slot,
        token: {
          tokenType: TokenType.SPL,
          tokenBaseDecimal: TokenDecimal.SIX,
          tokenQuoteDecimal: TokenDecimal.NINE,
          tokenUpdateAuthority: TokenUpdateAuthorityOption.CreatorUpdateAuthority,
          totalTokenSupply: 1_000_000_000,
          leftover: 0,
        },
        fee: {
          baseFeeParams: {
            baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
            feeSchedulerParam: {
              startingFeeBps: 250,
              endingFeeBps: 100,
              numberOfPeriod: 24,
              totalDuration: 216_000,
            },
          },
          dynamicFeeEnabled: true,
          collectFeeMode: CollectFeeMode.QuoteToken,
          creatorTradingFeePercentage: 0,
          poolCreationFee: 0,
          enableFirstSwapWithMinFee: false,
        },
        migration: {
          migrationOption: MigrationOption.MET_DAMM_V2,
          migrationFeeOption: MigrationFeeOption.FixedBps100,
          migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        },
        liquidityDistribution: {
          partnerPermanentLockedLiquidityPercentage: 50,
          partnerLiquidityPercentage: 0,
          creatorPermanentLockedLiquidityPercentage: 50,
          creatorLiquidityPercentage: 0,
        },
        lockedVesting: {
          totalLockedVestingAmount: 0,
          numberOfVestingPeriod: 0,
          cliffUnlockAmount: 0,
          totalVestingDuration: 0,
          cliffDurationFromMigrationTime: 0,
        },
      });

      // Build off-chain Metaplex-style JSON metadata so platforms like
      // Axiom/DexScreener/Phantom can show the image + socials.
      const { data: tokenRow } = await supabaseAdmin
        .from("tokens")
        .select("description, website_url, twitter_url")
        .eq("id", data.tokenId)
        .single();

      const fallbackImage = `https://placehold.co/256x256?text=${encodeURIComponent(data.ticker)}`;
      const imageForJson = data.imageUrl ?? fallbackImage;
      const metadataJson: Record<string, unknown> = {
        name: data.name,
        symbol: data.ticker,
        description: tokenRow?.description ?? "",
        image: imageForJson,
      };
      if (tokenRow?.website_url) metadataJson.external_url = tokenRow.website_url;
      const extensions: Record<string, string> = {};
      if (tokenRow?.twitter_url) extensions.twitter = tokenRow.twitter_url;
      if (tokenRow?.website_url) extensions.website = tokenRow.website_url;
      if (Object.keys(extensions).length > 0) metadataJson.extensions = extensions;

      let uri = imageForJson;
      try {
        const jsonPath = `metadata/${data.tokenId}.json`;
        const { error: upJsonErr } = await supabaseAdmin.storage
          .from("token-images")
          .upload(jsonPath, JSON.stringify(metadataJson, null, 2), {
            contentType: "application/json",
            upsert: true,
          });
        if (upJsonErr) throw upJsonErr;
        const { data: pub } = supabaseAdmin.storage
          .from("token-images")
          .getPublicUrl(jsonPath);
        if (pub?.publicUrl) uri = pub.publicUrl;
      } catch (jsonErr) {
        console.warn("[launchAsTreasury] metadata json upload failed, falling back to image URL", jsonErr);
      }

      const { createConfigTx, createPoolWithFirstBuyTx } =
        await client.pool.createConfigAndPoolWithFirstBuy({
          config: config.publicKey,
          // Sub-wallet owns creator-side fees for this token.
          feeClaimer: subWallet.publicKey,
          leftoverReceiver: subWallet.publicKey,
          quoteMint,
          // Sub-wallet pays rent for config + pool + ATAs.
          payer: subWallet.publicKey,
          ...configParams,
          preCreatePoolParam: {
            name: data.name,
            symbol: data.ticker,
            uri,
            // poolCreator = sub-wallet so ClaimCreatorTradingFee succeeds
            // when the keeper signs from the sub-wallet.
            poolCreator: subWallet.publicKey,
            baseMint: baseMint.publicKey,
          },

          firstBuyParam: {
            // Sub-wallet pays for the dev-buy SOL too -> on-chain shows
            // the sub-wallet as the true dev-buyer / pool creator.
            buyer: subWallet.publicKey,
            // Tokens land in the user's wallet -> they show as the dev holder.
            receiver: userPk,
            buyAmount: new BN(data.buyLamports),
            minimumAmountOut: new BN(0),
            referralTokenAccount: null,
          },
        });

      // 4. Sign + send config tx. Sub-wallet is fee payer + signer.
      const bh1 = await conn.getLatestBlockhash("confirmed");
      createConfigTx.recentBlockhash = bh1.blockhash;
      createConfigTx.feePayer = subWallet.publicKey;
      createConfigTx.partialSign(config);
      createConfigTx.partialSign(subWallet);
      const configSig = await conn.sendRawTransaction(createConfigTx.serialize(), {
        skipPreflight: false,
      });
      // Wait for "processed" instead of "confirmed". The pool tx only needs
      // the config account to exist on-chain (already true after processed),
      // and "confirmed" takes 10-30s which blew our Worker subrequest budget
      // and left the launch half-done.
      await conn
        .confirmTransaction(
          { signature: configSig, blockhash: bh1.blockhash, lastValidBlockHeight: bh1.lastValidBlockHeight },
          "processed",
        )
        .catch((e) => console.warn("confirm configTx", e));

      // 5. Sign + send pool+buy tx. Sub-wallet is fee payer + buyer + creator.
      const bh2 = await conn.getLatestBlockhash("confirmed");
      createPoolWithFirstBuyTx.recentBlockhash = bh2.blockhash;
      createPoolWithFirstBuyTx.feePayer = subWallet.publicKey;
      createPoolWithFirstBuyTx.partialSign(baseMint);
      createPoolWithFirstBuyTx.partialSign(subWallet);
      const poolSig = await conn.sendRawTransaction(createPoolWithFirstBuyTx.serialize(), {
        skipPreflight: false,
      });

      const poolAddress = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, config.publicKey);

      // 6. Persist row immediately so RPC lag never orphans the launch.
      const { error: upErr } = await supabaseAdmin
        .from("tokens")
        .update({
          status: "live",
          launch_signature: poolSig,
          mint_address: baseMint.publicKey.toBase58(),
          dbc_pool_address: poolAddress.toBase58(),
          dbc_config_address: config.publicKey.toBase58(),
          migration_status: "curve",
        })
        .eq("id", data.tokenId);
      if (upErr) throw upErr;

      // 7. Best-effort confirm (don't block success).
      conn
        .confirmTransaction(
          { signature: poolSig, blockhash: bh2.blockhash, lastValidBlockHeight: bh2.lastValidBlockHeight },
          "confirmed",
        )
        .catch((e) => console.warn("confirm poolTx", e));



      return {
        ok: true as const,
        tokenId: data.tokenId,
        mint: baseMint.publicKey.toBase58(),
        poolAddress: poolAddress.toBase58(),
        signature: poolSig,
        error: null as string | null,
      };
    } catch (e: unknown) {
      const err = e as Error;
      console.error("launchAsTreasury", err?.message, err?.stack);
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Treasury launch failed",
      };
    }

  });

