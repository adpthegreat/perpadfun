import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Keeper posts here during its external-router scan whenever a route
// sub-wallet has ANY non-zero SOL balance (even below the $100 sweep
// threshold). We stamp first_fee_routed_at so the token becomes visible
// in the public market list immediately, instead of waiting for the first
// $100 sweep. Spam protection is preserved: we still require the wallet
// to have actually received SOL.
//
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

const Schema = z.object({
  token_ids: z.array(z.string().uuid()).min(1).max(500),
});

export const Route = createFileRoute("/api/public/keeper/external-router-seen")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) {
          return new Response(
            JSON.stringify({ ok: false, error: "KEEPER_SECRET not configured" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return unauthorized();

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ ok: false, error: parsed.error.message }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const { error, count } = await supabaseAdmin
          .from("tokens")
          .update({ first_fee_routed_at: new Date().toISOString() }, { count: "exact" })
          .in("id", parsed.data.token_ids)
          .is("first_fee_routed_at", null);

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        return Response.json({ ok: true, stamped: count ?? 0 });
      },
    },
  },
});
