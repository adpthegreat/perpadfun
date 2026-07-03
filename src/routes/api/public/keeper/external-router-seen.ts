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

        const { data: stamped, error } = await supabaseAdmin
          .from("tokens")
          .update({ first_fee_routed_at: new Date().toISOString() })
          .in("id", parsed.data.token_ids)
          .is("first_fee_routed_at", null)
          .select("id, external_mint, source");

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        // GC: evict the LOSING pending reservations for any mint that is now
        // CONNECTED — duplicate/squatter rows that reserved params but never
        // became the on-chain recipient. Only one connected router per mint is
        // possible (partial unique index), so the pending siblings can never win.
        //
        // Keyed to "this mint is connected" (queried among the posted ids), NOT to
        // "just stamped this call" — so it's IDEMPOTENT and RETRIES: the keeper
        // re-posts a connected router's id every tick (the on-chain recipient still
        // matches), so if a delete fails once, the next tick re-runs it. Once the
        // siblings are gone the delete simply matches nothing.
        // See plan/FEE_ROUTING_AND_MINT_INDEX.md §6.
        let evicted = 0;
        const { data: connectedRows } = await supabaseAdmin
          .from("tokens")
          .select("external_mint")
          .in("id", parsed.data.token_ids)
          .eq("source", "external")
          .not("external_mint", "is", null)
          .not("first_fee_routed_at", "is", null);
        const connectedMints = [
          ...new Set((connectedRows ?? []).map((r) => r.external_mint as string)),
        ];
        if (connectedMints.length > 0) {
          const { data: removed, error: gcErr } = await supabaseAdmin
            .from("tokens")
            .delete()
            .eq("source", "external")
            .in("external_mint", connectedMints)
            .is("first_fee_routed_at", null) // spares the connected winner
            .select("id");
          // Non-fatal: the stamp already succeeded; a failed GC is retried next tick.
          if (!gcErr) evicted = removed?.length ?? 0;
        }

        return Response.json({ ok: true, stamped: stamped?.length ?? 0, evicted });
      },
    },
  },
});
