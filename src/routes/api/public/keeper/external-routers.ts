import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Returns external (pump.fun etc.) fee routers the keeper should sweep.
// Auth: shared secret in x-keeper-secret header.

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

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/keeper/external-routers")({
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
            "id, ticker, external_platform, external_mint, underlying, leverage, direction, treasury_wallet_address, status, mint_pending, router, imperial_profile_index",
          )
          .eq("source", "external")
          .neq("status", "deprecated")
          .not("treasury_wallet_address", "is", null)
          .limit(500);

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json({ ok: true, routers: data ?? [] });
      },
    },
  },
});
