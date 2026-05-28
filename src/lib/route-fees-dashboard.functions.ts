import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getServerConnection } from "@/lib/solana/treasury.server";

// Claim-token is the bearer secret. Anyone holding it gets to see this
// router's dashboard. Safe to expose mint/address/sweep history publicly,
// but we still gate on the token so the URL is not enumerable.
const CLAIM_TOKEN_RX = /^[1-9A-HJ-NP-Za-km-z]{40,64}$/;

export const getRouterDashboard = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z.object({ claimToken: z.string().regex(CLAIM_TOKEN_RX, "Invalid claim token") }).parse(d),
  )
  .handler(async ({ data }) => {
    const { data: token, error } = await supabaseAdmin
      .from("tokens")
      .select(
        "id, ticker, name, external_mint, external_platform, underlying, leverage, direction, treasury_wallet_address, created_at, status, mint_pending",
      )
      .eq("claim_token", data.claimToken)
      .eq("source", "external")
      .maybeSingle();

    if (error || !token) {
      return { ok: false as const, error: "Router not found. Check your claim token." };
    }

    // Live on-chain SOL balance of the sub-wallet.
    let balanceSol = 0;
    let balanceError: string | null = null;
    try {
      if (token.treasury_wallet_address) {
        const conn = getServerConnection();
        const lamports = await conn.getBalance(new PublicKey(token.treasury_wallet_address), "confirmed");
        balanceSol = lamports / LAMPORTS_PER_SOL;
      }
    } catch (e) {
      balanceError = e instanceof Error ? e.message : String(e);
    }

    // Recent sweep events for this router (kinds prefixed external_*).
    const { data: events } = await supabaseAdmin
      .from("treasury_events")
      .select("id, kind, sol_amount, tokens_amount, pnl_delta_usd, tx_sig, note, created_at")
      .eq("token_id", token.id)
      .order("created_at", { ascending: false })
      .limit(50);

    const list = events ?? [];
    const sumBy = (kind: string) =>
      list
        .filter((e) => e.kind === kind)
        .reduce((acc, e) => acc + Number(e.sol_amount ?? 0), 0);
    const sumTokensBy = (kind: string) =>
      list
        .filter((e) => e.kind === kind)
        .reduce((acc, e) => acc + Number(e.tokens_amount ?? 0), 0);

    return {
      ok: true as const,
      error: null,
      router: {
        id: token.id,
        ticker: token.ticker,
        name: token.name,
        externalMint: token.external_mint,
        externalPlatform: token.external_platform,
        underlying: token.underlying,
        leverage: token.leverage,
        direction: token.direction,
        address: token.treasury_wallet_address,
        status: token.status,
        mintPending: !!token.mint_pending,
        createdAt: token.created_at,
      },
      balance: { sol: balanceSol, error: balanceError },
      totals: {
        perpSol: sumBy("external_perp"),
        buybackSol: sumBy("external_buyback"),
        treasurySol: sumBy("external_split_treasury"),
        // tokens_amount stored as base units (6 decimals). Convert to whole tokens.
        tokensBurned: sumTokensBy("external_buyback") / 1e6,
      },
      events: list.map((e) => ({
        id: e.id,
        kind: e.kind,
        solAmount: Number(e.sol_amount ?? 0),
        tokensAmount: Number(e.tokens_amount ?? 0) / 1e6,
        pnlDeltaUsd: e.pnl_delta_usd != null ? Number(e.pnl_delta_usd) : null,
        txSig: e.tx_sig,
        note: e.note,
        createdAt: e.created_at,
      })),
    };
  });
