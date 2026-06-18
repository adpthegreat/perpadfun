import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Dedicated per-token keeper_logs read (KEEPER_LOGS_ENDPOINT.md). Reads the
// keeper_logs table directly (NOT joined to token_workflows), so it serves a
// single token's timeline, recent logs across all tokens, AND global rows
// (token_id IS NULL) - none of which the embedded recent_logs on /workflows can.
// Auth: shared secret in x-keeper-secret (compared to KEEPER_SECRET env).

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

const LEVELS = new Set(["info", "warn", "error"]);

export const Route = createFileRoute("/api/public/keeper/logs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) return jsonErr(500, "KEEPER_SECRET not configured");
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return jsonErr(401, "unauthorized");

        const url = new URL(request.url);
        const tokenId = url.searchParams.get("token_id");
        const level = url.searchParams.get("level");
        const event = url.searchParams.get("event");
        // A "+00:00" offset in the cursor gets URL-decoded to a space; repair it
        // so the next_before cursor round-trips even if passed unencoded.
        const before = (url.searchParams.get("before") ?? "").replaceAll(" ", "+") || null;
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));

        if (level && !LEVELS.has(level)) return jsonErr(400, "level must be info, warn, or error");

        // ── stats mode (?stats=1): header strip for the admin UI. Exact counts
        // by level + last activity; per-token also returns the tokens +
        // token_workflows rows. Kept on this route so it shares the same auth.
        if (url.searchParams.get("stats")) {
          const countByLevel = async (lvl: "info" | "warn" | "error") => {
            let q = supabaseAdmin
              .from("keeper_logs")
              .select("id", { count: "exact", head: true })
              .eq("level", lvl);
            if (tokenId) q = q.eq("token_id", tokenId);
            const { count, error } = await q;
            if (error) throw new Error(error.message);
            return count ?? 0;
          };
          const globalNullCountP = (async () => {
            if (tokenId) return 0;
            const { count, error } = await supabaseAdmin
              .from("keeper_logs")
              .select("id", { count: "exact", head: true })
              .is("token_id", null);
            if (error) throw new Error(error.message);
            return count ?? 0;
          })();
          const lastActivityP = (async () => {
            let q = supabaseAdmin
              .from("keeper_logs")
              .select("created_at")
              .order("created_at", { ascending: false })
              .limit(1);
            if (tokenId) q = q.eq("token_id", tokenId);
            const { data: rows, error } = await q;
            if (error) throw new Error(error.message);
            const v = rows?.[0]?.created_at;
            return typeof v === "string" ? v : null;
          })();
          const tokenP = (async () => {
            if (!tokenId) return null;
            const { data: t, error } = await supabaseAdmin
              .from("tokens")
              .select("*")
              .eq("id", tokenId)
              .maybeSingle();
            if (error) throw new Error(error.message);
            return t ?? null;
          })();
          const workflowP = (async () => {
            if (!tokenId) return null;
            const { data: w, error } = await supabaseAdmin
              .from("token_workflows")
              .select("*")
              .eq("token_id", tokenId)
              .maybeSingle();
            if (error) throw new Error(error.message);
            return w ?? null;
          })();
          try {
            const [info, warn, err, globalNullCount, lastActivityAt, token, workflow] =
              await Promise.all([
                countByLevel("info"),
                countByLevel("warn"),
                countByLevel("error"),
                globalNullCountP,
                lastActivityP,
                tokenP,
                workflowP,
              ]);
            return Response.json({
              ok: true,
              total: info + warn + err,
              info,
              warn,
              error: err,
              globalNullCount,
              lastActivityAt,
              token,
              workflow,
            });
          } catch (e) {
            return jsonErr(500, (e as Error).message);
          }
        }

        let query = supabaseAdmin
          .from("keeper_logs")
          .select("id, token_id, tick_id, level, event, message, fields, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (tokenId) query = query.eq("token_id", tokenId);
        if (level) query = query.eq("level", level);
        if (event) query = query.eq("event", event);
        if (before) query = query.lt("created_at", before);

        const { data, error } = await query;
        if (error) return jsonErr(500, error.message);

        const logs = data ?? [];
        // Resolve ticker/name per token_id (no FK embed — it makes PostgREST
        // fail) so the UI can show tickers without a second client round-trip.
        const ids = [...new Set(logs.map((r) => r.token_id).filter(Boolean))] as string[];
        const tokensById: Record<string, { ticker: string | null; name: string | null }> = {};
        if (ids.length) {
          const { data: toks } = await supabaseAdmin
            .from("tokens")
            .select("id, ticker, name")
            .in("id", ids);
          for (const t of toks ?? []) {
            tokensById[t.id as string] = {
              ticker: (t.ticker as string | null) ?? null,
              name: (t.name as string | null) ?? null,
            };
          }
        }
        const enriched = logs.map((r) => ({
          ...r,
          tokens: r.token_id ? tokensById[r.token_id] ?? null : null,
        }));

        // URL-safe cursor (no "+"): clients can pass next_before straight back as ?before=.
        const lastTs = logs.length ? logs[logs.length - 1].created_at : null;
        const nextBefore =
          logs.length === limit && typeof lastTs === "string" ? lastTs.replace("+00:00", "Z") : null;

        return Response.json({
          ok: true,
          token_id: tokenId ?? null,
          count: enriched.length,
          logs: enriched,
          next_before: nextBefore,
        });
      },
    },
  },
});
