import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HIDDEN_STATUS_PG_LIST } from "@/lib/launch/launchState";

// Tokens whose durable workflow state is a STUCK CANDIDATE, for the keeper's
// reconciliation job (KEEPER_RECONCILE.md). Unlike /tokens this is:
//   - targeted: filtered on token_workflows.state via the (state, next_retry_at)
//     index, instead of scanning the active feed;
//   - uncapped relative to the active set (the stuck set is tiny), so the recon
//     can recover ANY stuck token, not just ones in the 200-row /tokens window.
// The 20-min staleness threshold for *_pending (and the "blocked too long"
// escalation) is applied by the keeper's pure reconcileNeed(), not here.
// Auth: shared secret in x-keeper-secret (compared to KEEPER_SECRET env).

const STUCK_CANDIDATE_STATES = ["error", "blocked", "position_open_pending", "topup_pending"];

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

export const Route = createFileRoute("/api/public/keeper/stuck-tokens")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) {
          return new Response(JSON.stringify({ ok: false, error: "KEEPER_SECRET not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return unauthorized();

        const { data, error } = await supabaseAdmin
          .from("tokens")
          // Same feed-shape as /tokens (so the recon's token handling is unchanged),
          // but INNER-joined to the workflow row and filtered to stuck candidates.
          .select(
            "id, ticker, underlying, leverage, direction, mint_address, external_mint, source, " +
              "graduated_pool_address, sol_raised, position_size_usd, position_collateral_usd, " +
              "opened_collateral_usd, treasury_pnl_usd, fees_accrued_usd, position_opened_at, " +
              "buyback_reserve_usd, pending_drift_sig, launch_mid, treasury_wallet_address, " +
              "imperial_profile_index, imperial_profile_pda, router, " +
              "token_workflows!inner ( state, blocked_reason, next_retry_at, updated_at )",
          )
          .in("token_workflows.state", STUCK_CANDIDATE_STATES) // uses the (state) index
          .not("status", "in", HIDDEN_STATUS_PG_LIST)
          .limit(500);

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json({ ok: true, tokens: data ?? [] });
      },
    },
  },
});
