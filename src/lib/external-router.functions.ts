import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomBytes, randomUUID } from "crypto";
import bs58 from "bs58";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deriveSubWalletAddress, TOKEN_IMPERIAL_PROFILE_INDEX } from "@/lib/solana/subWallet.server";
import { isLaunchableMarket, isValidLeverageFor, maxLeverageFor } from "@/lib/imperial-markets";


const PLATFORMS = ["pump_fun", "other"] as const;
const DIRECTIONS = ["long", "short"] as const;

const MINT_RX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLAIM_TOKEN_RX = /^[1-9A-HJ-NP-Za-km-z]{40,64}$/;

async function fetchPumpFunMeta(mint: string): Promise<
  | { ok: true; ticker: string; name: string; image: string | null }
  | { ok: false; transient: boolean; error: string }
> {
  let res: Response;
  try {
    res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: "application/json" },
    });
  } catch (e) {
    console.warn("[external-router] pump.fun metadata fetch failed", e);
    return { ok: false, transient: true, error: "Could not verify mint with pump.fun right now. Please try again in a moment." };
  }
  if (res.status === 404) {
    return { ok: false, transient: false, error: "This mint was not found on pump.fun. Double check the address." };
  }
  if (!res.ok) {
    return { ok: false, transient: true, error: "Could not verify mint with pump.fun right now. Please try again in a moment." };
  }
  const meta = (await res.json().catch(() => null)) as
    | { symbol?: string; name?: string; image_uri?: string | null; mint?: string }
    | null;
  if (!meta || (!meta.symbol && !meta.name && !meta.mint)) {
    return { ok: false, transient: false, error: "This mint was not found on pump.fun. Double check the address." };
  }
  return {
    ok: true,
    ticker: meta.symbol ? meta.symbol.toUpperCase().slice(0, 16) : mint.slice(0, 8).toUpperCase(),
    name: meta.name ? meta.name.slice(0, 80) : `Router ${mint.slice(0, 4)}…${mint.slice(-4)}`,
    image: meta.image_uri ?? null,
  };
}

export const createExternalRouter = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        externalMint: z.string().regex(MINT_RX, "Invalid Solana mint"),
        externalPlatform: z.enum(PLATFORMS).default("pump_fun"),
        underlying: z
          .string()
          .trim()
          .min(1)
          .max(24)
          .refine(isLaunchableMarket, {
            message: "Unsupported or unavailable market for Imperial routing",
          }),
        leverage: z.number().int().positive(),
        direction: z.enum(DIRECTIONS),
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
    const { data: existing } = await supabaseAdmin
      .from("tokens")
      .select("id")
      .eq("external_mint", data.externalMint)
      .maybeSingle();
    if (existing) {
      return {
        ok: false as const,
        error: "This mint already has a fee router. Each token can only be routed once.",
        tokenId: null,
        address: null,
        claimToken: null,
      };
    }

    const tokenId = randomUUID();
    const address = deriveSubWalletAddress(tokenId);
    const claimToken = bs58.encode(randomBytes(32));

    let resolvedTicker = data.externalMint.slice(0, 8).toUpperCase();
    let resolvedName = `Router ${data.externalMint.slice(0, 4)}…${data.externalMint.slice(-4)}`;
    let resolvedImage: string | null = null;
    if (data.externalPlatform === "pump_fun") {
      const meta = await fetchPumpFunMeta(data.externalMint);
      if (!meta.ok) {
        return { ok: false as const, error: meta.error, tokenId: null, address: null, claimToken: null };
      }
      resolvedTicker = meta.ticker;
      resolvedName = meta.name;
      resolvedImage = meta.image;
    }

    const { error } = await supabaseAdmin.from("tokens").insert({
      id: tokenId,
      source: "external",
      external_platform: data.externalPlatform,
      external_mint: data.externalMint,
      claim_token: claimToken,
      ticker: resolvedTicker,
      name: resolvedName,
      underlying: data.underlying,
      leverage: data.leverage,
      direction: data.direction,
      image_url: resolvedImage,
      treasury_wallet_address: address,
      imperial_profile_index: TOKEN_IMPERIAL_PROFILE_INDEX,
      quote_token: "SOL",
      status: "live",
      migration_status: "external",
      mint_pending: false,
    });

    if (error) {
      const msg = /tokens_external_mint_unique/i.test(error.message)
        ? "This mint already has a fee router. Each token can only be routed once."
        : error.message;
      return { ok: false as const, error: msg, tokenId: null, address: null, claimToken: null };
    }

    return {
      ok: true as const,
      error: null,
      tokenId,
      address,
      claimToken,
      activationSignature: null as string | null,
      activationError: null as string | null,
    };
  });

// Reserve a sub-wallet BEFORE the pump.fun coin exists. User pastes the
// returned address into pump.fun's "fee receiver" field at launch, then
// comes back via the claim-token URL to bind the freshly-minted token.
export const reserveExternalRouter = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        externalPlatform: z.enum(PLATFORMS).default("pump_fun"),
        underlying: z
          .string()
          .trim()
          .min(1)
          .max(24)
          .refine(isLaunchableMarket, {
            message: "Unsupported or unavailable market for Imperial routing",
          }),
        leverage: z.number().int().positive(),
        direction: z.enum(DIRECTIONS),
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
    const tokenId = randomUUID();
    const address = deriveSubWalletAddress(tokenId);
    const claimToken = bs58.encode(randomBytes(32));

    const shortId = tokenId.replace(/-/g, "").slice(0, 8).toUpperCase();
    const placeholderTicker = `PEND-${shortId}`;
    const placeholderName = `Pending router ${shortId}`;

    const { error } = await supabaseAdmin.from("tokens").insert({
      id: tokenId,
      source: "external",
      external_platform: data.externalPlatform,
      external_mint: null,
      claim_token: claimToken,
      ticker: placeholderTicker,
      name: placeholderName,
      underlying: data.underlying,
      leverage: data.leverage,
      direction: data.direction,
      image_url: null,
      treasury_wallet_address: address,
      imperial_profile_index: TOKEN_IMPERIAL_PROFILE_INDEX,
      quote_token: "SOL",
      status: "live",
      migration_status: "external",
      mint_pending: true,
    });

    if (error) {
      return {
        ok: false as const,
        error: error.message,
        tokenId: null,
        address: null,
        claimToken: null,
      };
    }

    return {
      ok: true as const,
      error: null,
      tokenId,
      address,
      claimToken,
    };
  });

// Bind a pump.fun mint to an existing pending router. Verifies the mint
// exists on pump.fun and that no other router already claims it.
export const linkMintToRouter = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        claimToken: z.string().regex(CLAIM_TOKEN_RX, "Invalid claim token"),
        externalMint: z.string().regex(MINT_RX, "Invalid Solana mint"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from("tokens")
      .select("id, mint_pending, external_mint, external_platform")
      .eq("claim_token", data.claimToken)
      .eq("source", "external")
      .maybeSingle();
    if (lookupErr || !row) {
      return { ok: false as const, error: "Router not found. Check your claim token." };
    }
    if (!row.mint_pending && row.external_mint) {
      if (row.external_mint === data.externalMint) {
        return { ok: true as const, error: null, alreadyLinked: true };
      }
      return { ok: false as const, error: "This router is already linked to a different mint." };
    }

    const { data: collision } = await supabaseAdmin
      .from("tokens")
      .select("id")
      .eq("external_mint", data.externalMint)
      .neq("id", row.id)
      .maybeSingle();
    if (collision) {
      return { ok: false as const, error: "This mint already has a fee router. Each token can only be routed once." };
    }

    let ticker = data.externalMint.slice(0, 8).toUpperCase();
    let name = `Router ${data.externalMint.slice(0, 4)}…${data.externalMint.slice(-4)}`;
    let image: string | null = null;
    if (row.external_platform === "pump_fun") {
      const meta = await fetchPumpFunMeta(data.externalMint);
      if (!meta.ok) {
        return { ok: false as const, error: meta.error };
      }
      ticker = meta.ticker;
      name = meta.name;
      image = meta.image;
    }

    const { error: updErr } = await supabaseAdmin
      .from("tokens")
      .update({
        external_mint: data.externalMint,
        mint_pending: false,
        ticker,
        name,
        image_url: image,
      })
      .eq("id", row.id);
    if (updErr) {
      const msg = /tokens_external_mint_unique/i.test(updErr.message)
        ? "This mint already has a fee router. Each token can only be routed once."
        : /tokens_ticker/i.test(updErr.message)
        ? "A token with that ticker is already registered. Contact support."
        : updErr.message;
      return { ok: false as const, error: msg };
    }

    return { ok: true as const, error: null, alreadyLinked: false };
  });

// Same as linkMintToRouter but resolves the pending row by sub-wallet address
// instead of claim token. The user already has the sub-wallet address (they
// pasted it into pump.fun as the fee receiver), so no private link is needed.
export const linkMintByAddress = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        subWalletAddress: z.string().regex(MINT_RX, "Invalid sub-wallet address"),
        externalMint: z.string().regex(MINT_RX, "Invalid Solana mint"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { data: row, error: lookupErr } = await supabaseAdmin
      .from("tokens")
      .select("id, claim_token, mint_pending, external_mint, external_platform")
      .eq("treasury_wallet_address", data.subWalletAddress)
      .eq("source", "external")
      .maybeSingle();
    if (lookupErr || !row) {
      return { ok: false as const, error: "No pending router found for that sub-wallet address.", claimToken: null };
    }
    if (!row.mint_pending && row.external_mint) {
      if (row.external_mint === data.externalMint) {
        return { ok: true as const, error: null, alreadyLinked: true, claimToken: row.claim_token };
      }
      return { ok: false as const, error: "This sub-wallet is already linked to a different mint.", claimToken: null };
    }

    const { data: collision } = await supabaseAdmin
      .from("tokens")
      .select("id")
      .eq("external_mint", data.externalMint)
      .neq("id", row.id)
      .maybeSingle();
    if (collision) {
      return { ok: false as const, error: "This mint already has a fee router. Each token can only be routed once.", claimToken: null };
    }

    let ticker = data.externalMint.slice(0, 8).toUpperCase();
    let name = `Router ${data.externalMint.slice(0, 4)}…${data.externalMint.slice(-4)}`;
    let image: string | null = null;
    if (row.external_platform === "pump_fun") {
      const meta = await fetchPumpFunMeta(data.externalMint);
      if (!meta.ok) {
        return { ok: false as const, error: meta.error, claimToken: null };
      }
      ticker = meta.ticker;
      name = meta.name;
      image = meta.image;
    }

    const { error: updErr } = await supabaseAdmin
      .from("tokens")
      .update({
        external_mint: data.externalMint,
        mint_pending: false,
        ticker,
        name,
        image_url: image,
      })
      .eq("id", row.id);
    if (updErr) {
      const msg = /tokens_external_mint_unique/i.test(updErr.message)
        ? "This mint already has a fee router. Each token can only be routed once."
        : updErr.message;
      return { ok: false as const, error: msg, claimToken: null };
    }

    return { ok: true as const, error: null, alreadyLinked: false, claimToken: row.claim_token };
  });
