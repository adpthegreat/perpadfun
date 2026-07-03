import { createFileRoute } from "@tanstack/react-router";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getServerConnection } from "@/lib/solana/treasury.server";

// Secret-gated mint-status index (FEE_ROUTING_AND_MINT_INDEX.md §3, surface A).
// Paste a mint → resolve its routing state, IGNORING the public visibility gate,
// so a linked-but-hidden (stuck) router can be diagnosed instead of relaunched.
// The /tokens search only covers already-visible tokens; this covers the hidden ones.

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeSecret(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const MINT_RX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const Route = createFileRoute("/api/public/keeper/router-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) {
          return new Response(
            JSON.stringify({ ok: false, error: "KEEPER_SECRET not configured" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return unauthorized();

        const url = new URL(request.url);
        const mint = (url.searchParams.get("mint") ?? "").trim();
        if (!MINT_RX.test(mint)) {
          return new Response(
            JSON.stringify({ ok: false, error: "invalid mint address" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          // Match on external_mint OR the native DBC mint_address — no visibility
          // gate, so hidden/stuck rows resolve. limit(2) to detect a rare dup.
          const { data: rows, error } = await supabaseAdmin
            .from("tokens")
            .select(
              "id, ticker, name, source, status, external_mint, external_platform, mint_address, mint_pending, treasury_wallet_address, first_fee_routed_at, created_at",
            )
            .or(`external_mint.eq.${mint},mint_address.eq.${mint}`)
            .limit(2);

          if (error) {
            return new Response(JSON.stringify({ ok: false, error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          const token = rows?.[0] ?? null;

          if (!token) {
            return Response.json({
              ok: true,
              found: false,
              mint,
              verdict: "not found",
              detail: "No token row references this mint — nothing was created or routed here.",
              nextAction: "Confirm the mint, or link it on /route-fees.",
            });
          }

          const isExternal = String(token.source ?? "") === "external";
          const routed = token.first_fee_routed_at != null;
          const mintPending = !!token.mint_pending;

          // Live sub-wallet SOL balance (cheap RPC). Vault-claimable is NOT probed
          // in v1 (keeper-side pump.fun SDK) — sub-wallet SOL + first_fee_routed_at
          // are enough to diagnose the stuck case.
          let subWalletBalanceSol: number | null = null;
          let balanceError: string | null = null;
          if (token.treasury_wallet_address) {
            try {
              const conn = getServerConnection();
              const lamports = await conn.getBalance(
                new PublicKey(token.treasury_wallet_address),
                "confirmed",
              );
              subWalletBalanceSol = lamports / LAMPORTS_PER_SOL;
            } catch (e) {
              balanceError = e instanceof Error ? e.message : String(e);
            }
          }

          // Recent lifecycle events for this token (claims / sweeps / buybacks).
          const { data: events } = await supabaseAdmin
            .from("treasury_events")
            .select("kind, sol_amount, tx_sig, created_at")
            .eq("token_id", token.id)
            .order("created_at", { ascending: false })
            .limit(10);

          // Does it currently pass the public listTokens visibility gate?
          const listedOnSite = isExternal
            ? !!token.external_mint && !mintPending && routed
            : !!token.mint_address;

          // ── verdict ──
          let verdict: string;
          let detail: string;
          let nextAction: string;
          if (!isExternal) {
            if (token.mint_address) {
              verdict = "native — listed";
              detail = "Native perpspad launch; always listed once it has a DBC mint.";
              nextAction = "None — it's live on the site.";
            } else {
              verdict = "native — mint pending";
              detail = "Native token row exists but no DBC mint yet.";
              nextAction = "Wait for the launch pipeline to mint, or check /admin/keeper-logs.";
            }
          } else if (mintPending) {
            verdict = "reserved (not linked)";
            detail = "Sub-wallet reserved, but no pump.fun mint has been linked to it yet.";
            nextAction = "Link the mint on /route-fees (paste it against this sub-wallet).";
          } else if (routed) {
            verdict = "connected (live)";
            detail = "Fees have been seen and stamped — the coin is visible on the site.";
            nextAction = "None — routing is working.";
          } else if ((subWalletBalanceSol ?? 0) > 0) {
            verdict = "routing (pending stamp)";
            detail =
              "Sub-wallet already holds SOL; it should connect on the next keeper sweep.";
            nextAction =
              "Wait one sweep (~30s). If it never connects, confirm the keeper is deployed with the vault-probe fix.";
          } else {
            verdict = "created (not routed)";
            detail =
              "Linked, but no claimable fees have been seen yet (fees sit in the pump.fun creator-vault until they accrue).";
            nextAction =
              "Accrue some fees, then wait a sweep. Ensure the keeper build has the vault-probe fix (EXTERNAL_ROUTER_VISIBILITY.md §2).";
          }

          return Response.json({
            ok: true,
            found: true,
            mint,
            matchedColumn: token.external_mint === mint ? "external_mint" : "mint_address",
            duplicate: (rows?.length ?? 0) > 1,
            token: {
              id: token.id,
              ticker: token.ticker,
              name: token.name,
              source: token.source ?? "perpspad",
              status: token.status,
              externalPlatform: token.external_platform,
              externalMint: token.external_mint,
              mintAddress: token.mint_address,
              subWallet: token.treasury_wallet_address,
              mintPending,
              firstFeeRoutedAt: token.first_fee_routed_at,
              createdAt: token.created_at,
            },
            subWalletBalanceSol,
            balanceError,
            listedOnSite,
            events: (events ?? []).map((e) => ({
              kind: e.kind,
              solAmount: Number(e.sol_amount ?? 0),
              txSig: e.tx_sig,
              createdAt: e.created_at,
            })),
            verdict,
            detail,
            nextAction,
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error)?.message ?? "router-status failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
