import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

function jsonErr(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/keeper/workflows")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) return jsonErr(500, "KEEPER_SECRET not configured");
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return jsonErr(401, "unauthorized");

        const url = new URL(request.url);
        const tokenId = url.searchParams.get("token_id");
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));

        let query = supabaseAdmin
          .from("token_workflows")
          .select(
            `
            *,
            tokens!inner (
              id,
              ticker,
              mint_address,
              external_mint,
              source,
              router,
              treasury_wallet_address,
              imperial_profile_index,
              imperial_profile_pda,
              fees_accrued_usd,
              buyback_reserve_usd,
              position_opened_at,
              position_size_usd,
              position_collateral_usd,
              launch_mid,
              status
            )
          `,
          )
          .order("updated_at", { ascending: false })
          .limit(limit);

        if (tokenId) query = query.eq("token_id", tokenId);

        const { data, error } = await query;
        if (error) return jsonErr(500, error.message);

        let actionsByToken: Record<string, unknown[]> = {};
        let logsByToken: Record<string, unknown[]> = {};
        const tokenIds = (data ?? []).map((row) => row.token_id);
        if (tokenIds.length) {
          const { data: actions, error: actionErr } = await supabaseAdmin
            .from("keeper_actions")
            .select("*")
            .in("token_id", tokenIds)
            .order("created_at", { ascending: false })
            .limit(Math.min(1000, tokenIds.length * 5));
          if (actionErr) return jsonErr(500, actionErr.message);
          actionsByToken = (actions ?? []).reduce<Record<string, unknown[]>>((acc, action) => {
            const key = String(action.token_id);
            acc[key] ??= [];
            if (acc[key].length < 5) acc[key].push(action);
            return acc;
          }, {});

          // Per-token log timeline. Single-token view (token_id filter) returns the
          // full window up to `limit`; the list view returns a small preview per token.
          const logsPerToken = tokenId ? limit : 10;
          const { data: logs, error: logErr } = await supabaseAdmin
            .from("keeper_logs")
            .select("*")
            .in("token_id", tokenIds)
            .order("created_at", { ascending: false })
            .limit(Math.min(2000, tokenIds.length * logsPerToken));
          if (logErr) return jsonErr(500, logErr.message);
          logsByToken = (logs ?? []).reduce<Record<string, unknown[]>>((acc, log) => {
            const key = String(log.token_id);
            acc[key] ??= [];
            if (acc[key].length < logsPerToken) acc[key].push(log);
            return acc;
          }, {});
        }

        return Response.json({
          ok: true,
          workflows: (data ?? []).map((row) => ({
            ...row,
            recent_actions: actionsByToken[row.token_id] ?? [],
            recent_logs: logsByToken[row.token_id] ?? [],
          })),
        });
      },
    },
  },
});
