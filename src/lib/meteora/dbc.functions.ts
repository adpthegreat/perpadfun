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
import {
  quoteMintFor,
  fetchQuoteUsdPrice,
  resolveQuote,
  type Quote,
} from "@/lib/launch/config-builder";
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

const launchInput = z
  .object({
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
    underlying: z.string().min(1).max(20).refine(isLaunchableMarket, {
      message: "Unsupported or unavailable market for Imperial routing",
    }),
    leverage: z.number().int().positive(),
    direction: z.enum(["long", "short"]),
    creatorAddress: z.string().min(32).max(44),
    // Quote token the bonding curve is denominated in. Default SOL (legacy).
    // USDC pairs the curve + graduated DAMM pool against USDC. See
    // plan/USDC_PAIRING.md.
    quote: z.enum(["SOL", "USDC", "ANSEM", "UWU", "CUSTOM"]).default("SOL"),
    // Only for quote === "CUSTOM": the verified SPL mint + its decimals
    // (from verifyQuoteToken). Ignored for preset quotes.
    quoteMint: z.string().min(32).max(44).optional(),
    quoteDecimals: z.number().int().min(0).max(9).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.quote === "CUSTOM" && (!d.quoteMint || d.quoteDecimals == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quoteMint"],
        message: "Custom quote requires a verified mint + decimals.",
      });
    }
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
      const preset = data.leverage === 2 ? "gentle" : data.leverage >= 5 ? "parabolic" : "standard";
      // Resolve the quote's mint + decimals now and store them authoritatively —
      // preset quotes from the registry, CUSTOM from the verified input.
      const q = resolveQuote(data.quote, data.quoteMint, data.quoteDecimals);

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
          quote_token: data.quote,
          quote_mint: q.mint,
          quote_decimals: q.decimals,
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
          const reusable = existing && (existing.status === "deprecated" || !existing.mint_address);
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
                quote_token: data.quote,
                quote_mint: q.mint,
                quote_decimals: q.decimals,
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
            if (
              c &&
              (c.confirmationStatus === "confirmed" || c.confirmationStatus === "finalized")
            ) {
              return; // confirmed → stop
            }
            throw new Error("not yet confirmed"); // pending → poll again
          },
          {
            numOfAttempts: 12,
            startingDelay: 1000,
            timeMultiple: 1.5,
            maxDelay: 8000,
            jitter: "full",
            retry: () => true,
          },
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
          "dbc_pool_address, pool_state_refreshed_at, migration_status, sol_raised, graduated_pool_address, current_price_sol, total_supply, quote_token, quote_decimals",
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

      // Quote decimals: SOL = 9, every SPL quote (USDC, ANSEM, …) = 6.
      // sol_raised is reused as the quote-denominated raised amount (see
      // plan/USDC_PAIRING.md, decision 3).
      const quoteDecimals = t.quote_decimals ?? (t.quote_token === "SOL" ? 9 : 6);
      const quoteDivisor = 10 ** quoteDecimals;

      // pool.quoteReserve is in the quote token's base units. If the read doesn't
      // expose it (e.g. a graduated DBC pool whose reserve migrated to DAMM v2),
      // keep the last known value instead of overwriting sol_raised with 0.
      const freshSol = pool?.quoteReserve
        ? Number(BigInt(pool.quoteReserve.toString())) / quoteDivisor
        : null;
      const solRaised = nextSolRaised(freshSol, Number(t.sol_raised ?? 0));

      // Current spot price in quote per base token, derived from sqrtPrice.
      // DBC base decimals 6; quote decimals 9 (SOL) or 6 (USDC).
      let currentPriceSol = Number(t.current_price_sol ?? 0);
      try {
        const sp = (pool as unknown as { sqrtPrice?: { toString(): string } })?.sqrtPrice;
        if (sp) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const priceDec = getPriceFromSqrtPrice(sp as any, 6 as any, quoteDecimals as any);
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
        ticker: z
          .string()
          .min(1)
          .max(12)
          .regex(/^[A-Z0-9]+$/),
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
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const launchAsTreasury = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        tokenId: z.string().uuid(),
        ticker: z
          .string()
          .min(1)
          .max(12)
          .regex(/^[A-Z0-9]+$/),
        name: z.string().min(1).max(64),
        imageUrl: z.string().url().max(500).optional(),
        creatorAddress: z.string().min(32).max(44),
        // Dev-buy amount in the QUOTE token's base units (lamports for SOL,
        // 6-dp base units for USDC). Quote-specific bounds are enforced in the
        // handler once we read the token's quote_token.
        buyAmount: z.number().int().positive().max(10_000_000_000),
        // Signature of the user's prefund transfer. Optional on retries when
        // the token sub-wallet is already funded from a previous attempt.
        prefundSignature: z.string().min(32).max(120).nullable().optional(),
        // 'gentle' | 'standard' | 'parabolic' — picked from leverage server-side.
        curvePreset: z.enum(["gentle", "standard", "parabolic"]),
        // Admin knob (surfaced only by /admin-launch UI): tokens held back
        // from the bonding curve. Undefined/0 = 100% of supply tradable. Passed
        // straight into DBC's buildCurveWithMarketCap `leftover` param.
        leftoverTokens: z.number().int().min(0).max(1_000_000_000).optional(),
        // Admin knob: pre-grinded mint keypair (base58 secret ~88 chars OR
        // JSON array of 64 ints — up to ~320 chars). When present, used as
        // the base mint instead of Keypair.generate(). Undefined = fresh
        // random mint. Wire-level so the operator supplies it per-launch
        // from the UI — never a server env.
        vanityMintPrivateKey: z.string().min(64).max(500).optional(),
        // Required whenever any admin knob is set (leftoverTokens > 0 OR
        // vanityMintPrivateKey). Server checks it against process.env
        // KEEPER_SECRET. Sent by /admin-launch UI (cached from admin-key.ts).
        // /launch omits it and is rejected if it tries to use admin extras.
        adminSecret: z.string().min(1).max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      // Gate admin extras. Public /launch never sends leftoverTokens > 0 or
      // vanityMintPrivateKey, so it doesn't need adminSecret. /admin-launch
      // sends both extras and the adminSecret; server rejects if the secret
      // is missing or doesn't match KEEPER_SECRET.
      const wantsAdminExtras =
        (data.leftoverTokens ?? 0) > 0 || !!data.vanityMintPrivateKey?.trim();
      if (wantsAdminExtras) {
        const expected = (process.env.KEEPER_SECRET ?? "").trim();
        const provided = (data.adminSecret ?? "").trim();
        if (!expected || !provided || expected !== provided) {
          return {
            ok: false as const,
            error:
              "unauthorized: admin extras (leftoverTokens or vanityMintPrivateKey) require a valid keeper secret",
          };
        }
      }

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

      // Quote token the curve is denominated in (set at createDraftToken). The
      // mint + decimals are stored authoritatively so CUSTOM pairings work.
      const { data: quoteRow } = await supabaseAdmin
        .from("tokens")
        .select("quote_token, quote_mint, quote_decimals")
        .eq("id", data.tokenId)
        .single();
      const quote = (quoteRow?.quote_token ?? "SOL") as Quote;
      const quoteMintStr = quoteRow?.quote_mint ?? quoteMintFor(quote).toBase58();
      const quoteDecimals = quoteRow?.quote_decimals ?? (quote === "SOL" ? 9 : 6);

      // Dev-buy bounds in the quote token's base units. Preset quotes have tuned
      // ranges; CUSTOM is permissive (its value is unknown up front — the client
      // enforces sensible amounts and verifyQuoteToken already vetted liquidity).
      const QUOTE_BUY_BOUNDS: Record<Quote, { min: number; max: number }> = {
        SOL: { min: 100_000_000, max: 5_000_000_000 },
        USDC: { min: 5_000_000, max: 5_000_000_000 },
        ANSEM: { min: 10_000_000, max: 50_000_000_000 },
        UWU: { min: 50_000_000, max: 500_000_000_000 },
        CUSTOM: { min: 0, max: Number.MAX_SAFE_INTEGER },
      };
      const bounds = QUOTE_BUY_BOUNDS[quote];
      if (data.buyAmount < bounds.min || data.buyAmount > bounds.max) {
        return {
          ok: false as const,
          error: `Initial buy ${data.buyAmount} out of bounds for ${quote} (min ${bounds.min}, max ${bounds.max} base units)`,
        };
      }

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
              const v = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true }))
                .value;
              if (v?.err) {
                prefundErr = v.err; // terminal on-chain failure → stop polling
                return;
              }
              if (
                v &&
                (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")
              ) {
                prefundOk = true; // confirmed → stop
                return;
              }
              throw new Error("not yet confirmed"); // pending → poll again
            },
            {
              numOfAttempts: 16,
              startingDelay: 1000,
              timeMultiple: 1.5,
              maxDelay: 4000,
              jitter: "full",
              retry: () => true,
            },
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

      const subWalletBal = await conn.getBalance(subWallet.publicKey, "confirmed");
      if (quote !== "SOL") {
        // SPL-quote pools (USDC, ANSEM): SOL only covers rent + 2 tx fees + the
        // quote ATA the SDK uses + keeper seed. The dev-buy itself is pulled from
        // the sub-wallet's quote-token ATA (funded by the user in the prefund).
        const solNeeded = LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED_LAMPORTS;
        if (subWalletBal < solNeeded) {
          return {
            ok: false as const,
            error: `Token sub-wallet SOL too low for rent/fees (${subWalletBal} < ${solNeeded} lamports). Prefund may not have credited yet.`,
          };
        }
        const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } =
          await import("@solana/spl-token");
        // The quote token may be classic SPL or Token-2022 (e.g. ANSEM). Its ATA
        // address depends on the owning program, so derive with the right one —
        // the classic default reads an empty address for a Token-2022 quote and
        // wrongly reports the prefund as uncredited.
        const quoteMintPk = new PublicKey(quoteMintStr);
        const quoteMintInfo = await conn.getAccountInfo(quoteMintPk, "confirmed");
        const quoteProgramId =
          quoteMintInfo && quoteMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;
        const subQuoteAta = getAssociatedTokenAddressSync(
          quoteMintPk,
          subWallet.publicKey,
          true,
          quoteProgramId,
        );
        let quoteBal = 0;
        try {
          const b = await conn.getTokenAccountBalance(subQuoteAta, "confirmed");
          quoteBal = Number(b.value.amount ?? 0);
        } catch {
          quoteBal = 0;
        }
        if (quoteBal < data.buyAmount) {
          return {
            ok: false as const,
            error: `Token sub-wallet ${quote} too low (${quoteBal} < ${data.buyAmount} base units). ${quote} prefund may not have credited yet.`,
          };
        }
      } else {
        const subWalletFundingLamports =
          data.buyAmount + LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED_LAMPORTS;
        if (subWalletBal < subWalletFundingLamports) {
          return {
            ok: false as const,
            error: `Token sub-wallet balance too low (${subWalletBal} < ${subWalletFundingLamports} lamports). Prefund may not have credited yet.`,
          };
        }
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
        DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      } = await import("@meteora-ag/dynamic-bonding-curve-sdk");

      const client = new DynamicBondingCurveClient(conn, "confirmed");
      const config = Keypair.generate();
      // Base mint: fresh keypair unless the operator supplied a pre-grinded
      // vanity secret via the wire. Accepts base58 (88 chars) OR a JSON array
      // of 64 ints — same shape as TREASURY_SECRET_KEY, so operators use one
      // encoding across the codebase. Decoding errors surface cleanly to the
      // caller rather than degrading silently.
      const baseMint = await (async () => {
        const v = data.vanityMintPrivateKey?.trim();
        if (!v) return Keypair.generate();
        const bs58 = (await import("bs58")).default;
        let bytes: Uint8Array;
        try {
          bytes = v.startsWith("[") ? new Uint8Array(JSON.parse(v)) : bs58.decode(v);
        } catch (e) {
          throw new Error(`vanityMintPrivateKey could not be decoded: ${(e as Error).message}`);
        }
        if (bytes.length !== 64) {
          throw new Error(`vanityMintPrivateKey length ${bytes.length} (expected 64)`);
        }
        return Keypair.fromSecretKey(bytes);
      })();
      const userPk = new PublicKey(data.creatorAddress);
      const quoteMint = new PublicKey(quoteMintStr);

      // Market-cap presets are denominated in the QUOTE token. SOL presets are
      // in SOL (~$3k→$40–50k at launch-era prices); the USDC presets target the
      // same USD market caps directly (USDC ≈ $1). Tune these as needed.
      const PRESETS = {
        SOL: {
          gentle: { initialMarketCap: 34, migrationMarketCap: 400 },
          standard: { initialMarketCap: 34, migrationMarketCap: 460 },
          parabolic: { initialMarketCap: 34, migrationMarketCap: 550 },
        },
        USDC: {
          gentle: { initialMarketCap: 3000, migrationMarketCap: 36000 },
          standard: { initialMarketCap: 3000, migrationMarketCap: 41000 },
          parabolic: { initialMarketCap: 3000, migrationMarketCap: 49000 },
        },
      } as const;
      // Market caps in quote units: fixed for SOL/USDC, else derived from the
      // USDC USD targets ÷ the quote's live price (Option B).
      let initialMarketCap: number;
      let migrationMarketCap: number;
      if (quote === "SOL" || quote === "USDC") {
        const preset = PRESETS[quote][data.curvePreset];
        initialMarketCap = preset.initialMarketCap;
        migrationMarketCap = preset.migrationMarketCap;
      } else {
        const usd = PRESETS.USDC[data.curvePreset];
        const price = await fetchQuoteUsdPrice(quoteMintStr);
        if (!price)
          throw new Error(`No live ${quote} price available — can't set market-cap targets.`);
        initialMarketCap = usd.initialMarketCap / price;
        migrationMarketCap = usd.migrationMarketCap / price;
      }

      const configParams = buildCurveWithMarketCap({
        initialMarketCap,
        migrationMarketCap,
        activationType: ActivationType.Slot,
        token: {
          tokenType: TokenType.SPL,
          tokenBaseDecimal: TokenDecimal.SIX,
          tokenQuoteDecimal: quoteDecimals === 9 ? TokenDecimal.NINE : TokenDecimal.SIX,
          tokenUpdateAuthority: TokenUpdateAuthorityOption.CreatorUpdateAuthority,
          totalTokenSupply: 1_000_000_000,
          leftover: data.leftoverTokens ?? 0,
        },
        fee: {
          baseFeeParams: {
            // TEMPORARY — anti-sniper fee curve. Decays from 95% to 2.5% over
            // ~2 minutes (300 slots × 400 ms) in 60 exponential steps. Revert
            // to the prior linear 4%→2.5% over ~24h once initial-launch bot
            // activity settles. See launchAsTreasury field defense in chat.
            baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
            feeSchedulerParam: {
              startingFeeBps: 400, // TEMPORARY 95% (was 400 = 4%)
              endingFeeBps: 250, // 2.5% steady-state
              numberOfPeriod: 60, // TEMPORARY step every ~2s (was 24)
              totalDuration: 300, // TEMPORARY 300 slots = ~2 min (was 216_000 = ~24h)
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
        const { data: pub } = supabaseAdmin.storage.from("token-images").getPublicUrl(jsonPath);
        if (pub?.publicUrl) uri = pub.publicUrl;
      } catch (jsonErr) {
        console.warn(
          "[launchAsTreasury] metadata json upload failed, falling back to image URL",
          jsonErr,
        );
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
            // Sub-wallet pays for the dev-buy (SOL lamports for SOL pools, or
            // USDC base units pulled from its USDC ATA for USDC pools) -> on-chain
            // shows the sub-wallet as the true dev-buyer / pool creator.
            buyer: subWallet.publicKey,
            // Tokens land in the user's wallet -> they show as the dev holder.
            receiver: userPk,
            buyAmount: new BN(data.buyAmount),
            minimumAmountOut: new BN(0),
            referralTokenAccount: null,
          },
        });

      // ── Token-2022 quote fix ────────────────────────────────────────────
      // The SDK's initializeVirtualPoolWithSplToken hardcodes the QUOTE token
      // program to classic SPL (tokenQuoteProgram: TOKEN_PROGRAM_ID). For a
      // Token-2022 quote (e.g. ANSEM) that makes the DBC program CPI into the
      // classic Token program against a Token-2022 mint → IncorrectProgramId at
      // pool deploy. The on-chain instruction leaves token_quote_program
      // unconstrained (verified in the IDL — no address lock), so we patch that
      // one account meta to the correct program. It is account index 11 of
      // initialize_virtual_pool_with_spl_token; index 12 is the base
      // token_program (classic). Guard on both being classic so a future SDK
      // layout change aborts loudly instead of sending a malformed tx.
      {
        const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import("@solana/spl-token");
        const quoteOwner = (await conn.getAccountInfo(new PublicKey(quoteMintStr), "confirmed"))
          ?.owner;
        if (quoteOwner && quoteOwner.equals(TOKEN_2022_PROGRAM_ID)) {
          const SPL_POOL_INIT_DISC = Buffer.from([140, 85, 215, 176, 102, 54, 104, 79]);
          const TOKEN_QUOTE_PROGRAM_INDEX = 11;
          let patched = false;
          for (const ix of createPoolWithFirstBuyTx.instructions) {
            if (
              !ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
              ix.data.length < 8 ||
              !Buffer.from(ix.data.subarray(0, 8)).equals(SPL_POOL_INIT_DISC)
            ) {
              continue;
            }
            const quoteSlot = ix.keys[TOKEN_QUOTE_PROGRAM_INDEX];
            const baseSlot = ix.keys[TOKEN_QUOTE_PROGRAM_INDEX + 1];
            if (
              quoteSlot?.pubkey.equals(TOKEN_PROGRAM_ID) &&
              baseSlot?.pubkey.equals(TOKEN_PROGRAM_ID)
            ) {
              ix.keys[TOKEN_QUOTE_PROGRAM_INDEX] = { ...quoteSlot, pubkey: TOKEN_2022_PROGRAM_ID };
              patched = true;
            }
            break;
          }
          if (!patched) {
            return {
              ok: false as const,
              error:
                "Could not apply the Token-2022 quote fix (SDK pool-init layout changed). Aborting to avoid a bad transaction.",
            };
          }
        }
      }

      // 4. Sign + send config tx. Sub-wallet is fee payer + signer.
      const bh1 = await conn.getLatestBlockhash("confirmed");
      createConfigTx.recentBlockhash = bh1.blockhash;
      createConfigTx.feePayer = subWallet.publicKey;
      createConfigTx.partialSign(config);
      createConfigTx.partialSign(subWallet);
      const configSig = await conn.sendRawTransaction(createConfigTx.serialize(), {
        skipPreflight: false,
      });
      // HTTP-poll the config sig until it's at least `processed`. Replaces the
      // old `conn.confirmTransaction(...).catch(...)` which swallowed timeouts
      // (WebSocket signatureSubscribe stalls on Cloudflare Workers) and raced
      // ahead to send the pool tx while the config was still in-flight —
      // producing AccountOwnedByWrongProgram (Anchor 3007 / 0xbbf) at pool-tx
      // preflight. If the poll times out or reports an on-chain err, abort
      // BEFORE sending the pool tx.
      const ACCEPT = ["processed", "confirmed", "finalized"];
      let configOnChainErr: unknown = null;
      let configConfirmed = false;
      await backOff(
        async () => {
          const v = (await conn.getSignatureStatus(configSig, { searchTransactionHistory: true }))
            .value;
          if (v?.err) {
            configOnChainErr = v.err;
            return;
          }
          if (v?.confirmationStatus && ACCEPT.includes(v.confirmationStatus)) {
            configConfirmed = true;
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
      if (configOnChainErr) {
        return {
          ok: false as const,
          error: `config tx failed on-chain: ${JSON.stringify(configOnChainErr)}. Sig: ${configSig}`,
        };
      }
      if (!configConfirmed) {
        return {
          ok: false as const,
          error: `config tx not confirmed in time. Sig: ${configSig}`,
        };
      }

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
          {
            signature: poolSig,
            blockhash: bh2.blockhash,
            lastValidBlockHeight: bh2.lastValidBlockHeight,
          },
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
