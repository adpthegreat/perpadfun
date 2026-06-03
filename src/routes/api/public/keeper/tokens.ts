import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HIDDEN_STATUS_PG_LIST } from "@/lib/launch/launchState";

// Returns the list of active tokens the Fly keeper should manage on Drift.
// Auth: shared secret in x-keeper-secret header (compared to KEEPER_SECRET env).

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

export const Route = createFileRoute("/api/public/keeper/tokens")({
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

        const { data, error } = await supabaseAdmin
          .from("tokens")
          .select(
            "id, ticker, underlying, leverage, direction, mint_address, external_mint, external_platform, source, dbc_pool_address, dbc_config_address, graduated_pool_address, quote_token, sol_raised, position_size_usd, position_collateral_usd, opened_collateral_usd, treasury_pnl_usd, last_tick_at, fees_accrued_usd, position_opened_at, last_sol_raised_seen, buyback_reserve_usd, pnl_high_water_usd, pending_drift_sig, last_fee_claim_at, last_fee_claim_signature, lp_position_address, migration_status, treasury_wallet_address, imperial_profile_index, imperial_profile_pda, router, " +
              // Embed the durable workflow state so the keeper can guard opens on
              // it (Fix 3a — see OPEN_CHAIN_REFACTOR_V2.md) instead of the
              // crash-prone position_opened_at / pending_drift_sig fields.
              "token_workflows ( state, blocked_reason, next_retry_at, updated_at )",
          )
          // Native perpad tokens need a DBC mint to be managed. External
          // (pump.fun) tokens are managed once they have a treasury wallet
          // (i.e. fees have started flowing) so the keeper can tick their
          // perp position, track pnl_high_water, and fire the +$25 profit
          // slice -> buyback+burn on the external_mint.
          .or("mint_address.not.is.null,and(source.eq.external,treasury_wallet_address.not.is.null)")
          .not("status", "in", HIDDEN_STATUS_PG_LIST)
          .limit(200);

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
