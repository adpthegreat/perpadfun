// Server functions for the keeper-logs viewer pages (plan/KEEPER_LOGS_PAGES.md).
// Mirror the dedicated GET /api/public/keeper/logs endpoint via supabaseAdmin so
// no KEEPER_SECRET ever reaches the browser and no RLS policy is needed on
// keeper_logs. The page and the curl always agree.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LEVELS = ["info", "warn", "error"] as const;

// Concrete JSON type so TanStack Start's ServerFn serialization check passes
// (Record<string, unknown> trips RegisteredSerializableInput because `unknown`
// can't be proved serializable).
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export type KeeperLogRow = {
  id: number;
  token_id: string | null;
  tick_id: string | null;
  level: "info" | "warn" | "error";
  event: string | null;
  message: string;
  fields: JsonObject;
  created_at: string;
  // Embedded via PostgREST (tokens FK on keeper_logs.token_id). NULL for global
  // (token_id IS NULL) rows; .ticker/.name may be NULL even for non-global rows
  // if the tokens row was deleted (CASCADE).
  tokens: { ticker: string | null; name: string | null } | null;
};

export type KeeperLogStats = {
  total: number;
  info: number;
  warn: number;
  error: number;
  globalNullCount: number;
  lastActivityAt: string | null;
  token: JsonObject | null;
  workflow: JsonObject | null;
};

// listKeeperLogs — same query as src/routes/api/public/keeper/logs.ts.
export const listKeeperLogs = createServerFn({ method: "GET" })
  .inputValidator(
    (d: {
      tokenId?: string;
      level?: "info" | "warn" | "error";
      event?: string;
      before?: string;
      limit?: number;
    }) =>
      z
        .object({
          tokenId: z.string().uuid().optional(),
          level: z.enum(LEVELS).optional(),
          event: z.string().max(64).optional(),
          before: z.string().optional(),
          limit: z.number().int().min(1).max(1000).default(100),
        })
        .parse(d),
  )
  .handler(async ({ data }) => {
    // Repair "+00:00" -> space corruption (same as the endpoint) so a Z-form
    // cursor or a raw +00:00 cursor both round-trip.
    const before = data.before ? data.before.replaceAll(" ", "+") : null;

    // Plain select — mirrors the proven GET /api/public/keeper/logs query. We do
    // NOT use a `tokens ( ... )` FK embed here: it makes the whole query fail
    // (PostgREST relationship error) and the page then showed "no logs match"
    // instead of any rows. Tickers are resolved in a cheap second query below.
    let q = supabaseAdmin
      .from("keeper_logs")
      .select("id, token_id, tick_id, level, event, message, fields, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.tokenId) q = q.eq("token_id", data.tokenId);
    if (data.level) q = q.eq("level", data.level);
    if (data.event) q = q.eq("event", data.event);
    if (before) q = q.lt("created_at", before);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const base = (rows ?? []) as Omit<KeeperLogRow, "tokens">[];

    // Resolve ticker/name for the token_ids present, without an FK embed.
    const ids = [...new Set(base.map((r) => r.token_id).filter(Boolean))] as string[];
    const tokenById = new Map<string, { ticker: string | null; name: string | null }>();
    if (ids.length) {
      const { data: toks, error: tErr } = await supabaseAdmin
        .from("tokens")
        .select("id, ticker, name")
        .in("id", ids);
      if (tErr) throw new Error(tErr.message);
      for (const t of toks ?? []) {
        tokenById.set(t.id as string, {
          ticker: (t.ticker as string | null) ?? null,
          name: (t.name as string | null) ?? null,
        });
      }
    }

    const logs: KeeperLogRow[] = base.map((r) => ({
      ...r,
      tokens: r.token_id ? tokenById.get(r.token_id) ?? null : null,
    }));
    const lastTs = logs.length ? logs[logs.length - 1].created_at : null;
    // URL-safe cursor (no "+"): clients can pass nextBefore straight back as ?before=.
    const nextBefore =
      logs.length === data.limit && typeof lastTs === "string"
        ? lastTs.replace("+00:00", "Z")
        : null;

    return { logs, nextBefore } as { logs: KeeperLogRow[]; nextBefore: string | null };
  });

// getKeeperLogStats — header / stats strip data for both pages.
//   omit tokenId -> global counts (incl. global_null row count).
//   pass tokenId -> per-token counts + the tokens row + the token_workflows row.
export const getKeeperLogStats = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId?: string }) =>
    z.object({ tokenId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data }): Promise<KeeperLogStats> => {
    const tokenId = data.tokenId;

    // Three parallel COUNT queries — exact counts without fetching every row.
    const countByLevel = async (level: "info" | "warn" | "error"): Promise<number> => {
      let q = supabaseAdmin
        .from("keeper_logs")
        .select("id", { count: "exact", head: true })
        .eq("level", level);
      if (tokenId) q = q.eq("token_id", tokenId);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return count ?? 0;
    };

    // global_null count: only meaningful in the all-tokens view.
    const globalNullCountP: Promise<number> = (async () => {
      if (tokenId) return 0;
      const { count, error } = await supabaseAdmin
        .from("keeper_logs")
        .select("id", { count: "exact", head: true })
        .is("token_id", null);
      if (error) throw new Error(error.message);
      return count ?? 0;
    })();

    // last activity row.
    const lastActivityP: Promise<string | null> = (async () => {
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

    // token + workflow only when scoped.
    const tokenP: Promise<JsonObject | null> = (async () => {
      if (!tokenId) return null;
      const { data: t, error } = await supabaseAdmin
        .from("tokens")
        .select("*")
        .eq("id", tokenId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (t as unknown as JsonObject | null) ?? null;
    })();

    const workflowP: Promise<JsonObject | null> = (async () => {
      if (!tokenId) return null;
      const { data: w, error } = await supabaseAdmin
        .from("token_workflows")
        .select("*")
        .eq("token_id", tokenId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (w as unknown as JsonObject | null) ?? null;
    })();

    const [info, warn, error, globalNullCount, lastActivityAt, token, workflow] = await Promise.all(
      [
        countByLevel("info"),
        countByLevel("warn"),
        countByLevel("error"),
        globalNullCountP,
        lastActivityP,
        tokenP,
        workflowP,
      ],
    );

    return {
      total: info + warn + error,
      info,
      warn,
      error,
      globalNullCount,
      lastActivityAt,
      token,
      workflow,
    };
  });
