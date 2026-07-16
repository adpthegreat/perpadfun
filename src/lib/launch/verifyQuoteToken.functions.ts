// Verify an arbitrary SPL / Token-2022 mint is safe + liquid enough to use as a
// launch quote (pairing) token. The flywheel depends on the keeper swapping the
// quote token's fees -> SOL, so an illiquid or fee-taxed token silently breaks
// it — this gate rejects those up front.
//
// Accepts: plain SPL Token, and Token-2022 whose only extensions are benign
// (metadata, close authority, etc. — e.g. pump.fun coins like ANSEM).
// Rejects: Token-2022 with transfer-fee / transfer-hook / permanent-delegate /
// non-transferable / frozen-by-default / confidential extensions (they tax or
// block the fee->SOL swaps and Meteora pool math), non-mints, unpriceable /
// too-illiquid tokens.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getMint,
  getExtensionTypes,
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";

// Max acceptable price impact when swapping a fee-sized amount of the quote token
// -> SOL. Above this the keeper can't normalize fees without bleeding value, so
// the token is too illiquid to pair. Tune via QUOTE_MAX_PRICE_IMPACT_PCT.
const MAX_PRICE_IMPACT_PCT = Number(process.env.QUOTE_MAX_PRICE_IMPACT_PCT ?? 0.05);
// USD size of the test swap used to probe liquidity (≈ a realistic fee claim).
const LIQUIDITY_PROBE_USD = Number(process.env.QUOTE_LIQUIDITY_PROBE_USD ?? 50);

// Token-2022 extensions that break swaps / pool accounting or let someone move
// or freeze the token. Any of these => reject.
const HARMFUL_EXTENSIONS = new Set<ExtensionType>([
  ExtensionType.TransferFeeConfig,
  ExtensionType.TransferHook,
  ExtensionType.PermanentDelegate,
  ExtensionType.NonTransferable,
  ExtensionType.DefaultAccountState,
  ExtensionType.ConfidentialTransferMint,
]);

export type VerifiedQuoteToken = {
  ok: true;
  mint: string;
  decimals: number;
  program: "spl-token" | "token-2022";
  priceUsd: number;
  priceImpactPct: number;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  name: string | null;
  symbol: string | null;
};
export type QuoteVerifyResult = VerifiedQuoteToken | { ok: false; error: string };

// Best-effort token name + symbol (Jupiter token search). Null when the token
// isn't in Jupiter's index — display-only, never blocks the launch.
async function jupTokenMeta(mint: string): Promise<{ name: string | null; symbol: string | null }> {
  try {
    const r = await fetch(`${JUP_SEARCH}?query=${mint}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return { name: null, symbol: null };
    const j = (await r.json()) as unknown;
    const arr = Array.isArray(j) ? j : [];
    const t = (arr.find((x) => (x as { id?: string })?.id === mint) ?? arr[0]) as
      | { name?: string; symbol?: string }
      | undefined;
    return { name: t?.name ?? null, symbol: t?.symbol ?? null };
  } catch {
    return { name: null, symbol: null };
  }
}

async function jupUsdPrice(mint: string): Promise<number> {
  try {
    const r = await fetch(`${JUP_PRICE}?ids=${mint}`, { headers: { accept: "application/json" } });
    if (!r.ok) return 0;
    const j = (await r.json()) as Record<string, { usdPrice?: number }>;
    const p = j[mint]?.usdPrice;
    return typeof p === "number" && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

// Returns the Jupiter price-impact fraction for swapping `amountRaw` of `mint`
// into SOL, or null if no route exists.
async function jupSolRouteImpact(mint: string, amountRaw: number): Promise<number | null> {
  try {
    const url = `${JUP_QUOTE}?inputMint=${mint}&outputMint=${WSOL_MINT}&amount=${amountRaw}&slippageBps=300&onlyDirectRoutes=false`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = (await r.json()) as { outAmount?: string; priceImpactPct?: string | number };
    if (!j?.outAmount || Number(j.outAmount) <= 0) return null;
    return Number(j.priceImpactPct ?? 0);
  } catch {
    return null;
  }
}

export const verifyQuoteToken = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ mint: z.string().trim().min(32).max(44) }).parse(d))
  .handler(async ({ data }): Promise<QuoteVerifyResult> => {
    // 1) valid base58 pubkey
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(data.mint);
      if (mintPk.toBase58() !== data.mint) throw new Error("noncanonical");
    } catch {
      return { ok: false, error: "Not a valid Solana address." };
    }
    const mintStr = mintPk.toBase58();
    if (mintStr === WSOL_MINT) return { ok: false, error: "Use the SOL quick-pick for SOL." };

    const conn = new Connection(getServerSolanaRpcUrl(), "confirmed");

    // 2) account must exist and be owned by a token program
    const info = await conn.getAccountInfo(mintPk, "confirmed");
    if (!info) return { ok: false, error: "No token exists at this address." };
    const owner = info.owner.toBase58();
    const isT22 = owner === TOKEN_2022_PROGRAM_ID.toBase58();
    const isSpl = owner === TOKEN_PROGRAM_ID.toBase58();
    if (!isSpl && !isT22) return { ok: false, error: "This address is not an SPL token mint." };

    // 3) read the mint (decimals, authorities) via the right program
    let mint;
    try {
      mint = await getMint(
        conn,
        mintPk,
        "confirmed",
        isT22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      );
    } catch {
      return { ok: false, error: "Could not read the token mint." };
    }

    // 4) Token-2022 extension safety — accept metadata etc., reject fee/hook/etc.
    if (isT22 && mint.tlvData?.length) {
      const exts = getExtensionTypes(mint.tlvData);
      const harmful = exts.filter((e) => HARMFUL_EXTENSIONS.has(e));
      if (harmful.length > 0) {
        const names = harmful.map((e) => ExtensionType[e]).join(", ");
        return {
          ok: false,
          error: `Unsupported Token-2022 extension(s): ${names}. These break the fee→SOL swaps.`,
        };
      }
    }

    // 5) must be priceable (needed for market-cap targets)
    const priceUsd = await jupUsdPrice(mintStr);
    if (!priceUsd) {
      return { ok: false, error: "No Jupiter price — token is too new/illiquid to pair." };
    }

    // 6) must be swappable to SOL at acceptable impact (the flywheel depends on it)
    const probeRaw = Math.max(
      1,
      Math.floor((LIQUIDITY_PROBE_USD / priceUsd) * 10 ** mint.decimals),
    );
    const impact = await jupSolRouteImpact(mintStr, probeRaw);
    if (impact == null) {
      return { ok: false, error: "No swap route to SOL — the keeper couldn't convert its fees." };
    }
    if (impact > MAX_PRICE_IMPACT_PCT) {
      return {
        ok: false,
        error: `Too illiquid: swapping ~$${LIQUIDITY_PROBE_USD} of fees to SOL costs ${(impact * 100).toFixed(1)}% (max ${(MAX_PRICE_IMPACT_PCT * 100).toFixed(0)}%).`,
      };
    }

    const meta = await jupTokenMeta(mintStr);

    return {
      ok: true,
      mint: mintStr,
      decimals: mint.decimals,
      program: isT22 ? "token-2022" : "spl-token",
      priceUsd,
      priceImpactPct: impact,
      hasMintAuthority: mint.mintAuthority != null,
      hasFreezeAuthority: mint.freezeAuthority != null,
      name: meta.name,
      symbol: meta.symbol,
    };
  });
