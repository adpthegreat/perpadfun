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
        // URL-safe cursor (no "+"): clients can pass next_before straight back as ?before=.
        const lastTs = logs.length ? logs[logs.length - 1].created_at : null;
        const nextBefore =
          logs.length === limit && typeof lastTs === "string" ? lastTs.replace("+00:00", "Z") : null;

        return Response.json({
          ok: true,
          token_id: tokenId ?? null,
          count: logs.length,
          logs,
          next_before: nextBefore,
        });
      },
    },
  },
});
