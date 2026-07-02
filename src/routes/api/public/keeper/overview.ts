import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Secret-gated onboarding overview for the /admin cockpit: the collab_signups
// funnel counts + collab_codes pool status. Kept server-side (service role)
// because collab_* has no public read policy, and gated on x-keeper-secret like
// the other /api/public/keeper/* routes.
//
// The collab tables aren't in the generated Database types, so use a loose view.
const db = supabaseAdmin as unknown as SupabaseClient;

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

// A count-only query (head:true) against collab_signups with the given filter.
async function countSignups(filter?: (q: any) => any): Promise<number> {
  let q = db.from("collab_signups").select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count } = await q;
  return count ?? 0;
}

export const Route = createFileRoute("/api/public/keeper/overview")({
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

        try {
          const [
            signups,
            walletVerified,
            xFollowed,
            tgJoined,
            claimed,
            waitlisted,
            codesTotal,
            codesAssigned,
            recent,
          ] = await Promise.all([
            countSignups(),
            countSignups((q) => q.eq("wallet_verified", true)),
            countSignups((q) => q.eq("x_followed", true)),
            countSignups((q) => q.eq("tg_joined", true)),
            countSignups((q) => q.not("code", "is", null)),
            countSignups((q) => q.eq("waitlisted", true)),
            db.from("collab_codes").select("*", { count: "exact", head: true }),
            db.from("collab_codes").select("*", { count: "exact", head: true }).eq("assigned", true),
            // Per-day signup counts for the last ~14 days (sparkline). created_at
            // exists on the table; read the timestamps and bucket by UTC day here.
            db
              .from("collab_signups")
              .select("created_at")
              .order("created_at", { ascending: false })
              .limit(2000),
          ]);

          const codeTotal = codesTotal.count ?? 0;
          const codeAssigned = codesAssigned.count ?? 0;

          // Bucket signups by UTC day (last 14 days) for a small trend series.
          const byDay = new Map<string, number>();
          for (const r of (recent.data ?? []) as { created_at?: string | null }[]) {
            if (!r.created_at) continue;
            const day = r.created_at.slice(0, 10);
            byDay.set(day, (byDay.get(day) ?? 0) + 1);
          }
          const series = [...byDay.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .slice(-14)
            .map(([day, count]) => ({ day, count }));

          return Response.json({
            ok: true,
            funnel: {
              signups,
              walletVerified,
              xFollowed,
              tgJoined,
              claimed,
              waitlisted,
            },
            codes: {
              total: codeTotal,
              assigned: codeAssigned,
              remaining: Math.max(0, codeTotal - codeAssigned),
            },
            series,
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error)?.message ?? "overview failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
