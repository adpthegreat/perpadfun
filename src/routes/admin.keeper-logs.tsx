// Page 3: /admin/keeper-logs — all keeper_logs across every token (lifecycle / diagnostic view).
// See plan/KEEPER_LOGS_PAGES.md. Counterpart to /admin/logs but reads keeper_logs (NOT
// treasury_events / tx_log). Data via the listKeeperLogs server fn (supabaseAdmin),
// so no KEEPER_SECRET in the browser and no RLS on keeper_logs.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { LevelBadge, RowDetail, Stat, relativeTime, short } from "@/components/admin-logs/cells";
// Reads keeper_logs via the secret-gated /api/public/keeper/logs route using the
// admin key (x-keeper-secret) from localStorage — keeper_logs stays non-public.
import { getKeeperLogStats, listKeeperLogs, AdminKeyError } from "@/lib/keeper-logs.client";
import { getAdminKey, setAdminKey } from "@/lib/admin-key";

export const Route = createFileRoute("/admin/keeper-logs")({
  component: AdminKeeperLogsPage,
  head: () => ({
    meta: [{ title: "Keeper logs · perpad" }, { name: "robots", content: "noindex, nofollow" }],
  }),
});

type Level = "info" | "warn" | "error";
const LEVELS: Level[] = ["info", "warn", "error"];
const PAGE_LIMIT = 100;

function AdminKeeperLogsPage() {
  const [level, setLevel] = useState<Level | "">("");
  const [eventFilter, setEventFilter] = useState("");
  const [tokenFilter, setTokenFilter] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adminKey, setAdminKeyState] = useState<string>(() => getAdminKey());

  // header stats (global)
  const stats = useQuery({
    queryKey: ["keeper-logs-stats", adminKey],
    queryFn: () => getKeeperLogStats({ data: {} }),
    enabled: !!adminKey,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // logs list (filters + cursor)
  const logsQ = useQuery({
    queryKey: ["keeper-logs-list", adminKey, level, eventFilter, tokenFilter, cursor],
    queryFn: () =>
      listKeeperLogs({
        data: {
          level: level || undefined,
          event: eventFilter || undefined,
          tokenId: tokenFilter || undefined,
          before: cursor || undefined,
          limit: PAGE_LIMIT,
        },
      }),
    enabled: !!adminKey,
    refetchInterval: 10_000,
  });

  const locked = !adminKey || logsQ.error instanceof AdminKeyError;

  const rawLogs = logsQ.data?.logs ?? [];
  const nextBefore = logsQ.data?.nextBefore ?? null;

  // client-side substring search across message + JSON.stringify(fields)
  const rows = useMemo(() => {
    if (!search) return rawLogs;
    const s = search.toLowerCase();
    return rawLogs.filter(
      (r) =>
        r.message.toLowerCase().includes(s) ||
        JSON.stringify(r.fields ?? {})
          .toLowerCase()
          .includes(s) ||
        (r.event ?? "").toLowerCase().includes(s),
    );
  }, [rawLogs, search]);

  function applyFilters() {
    setCursor(null);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="w-full px-4 py-6">
        <div className="text-xs mb-3">
          <Link to="/admin/logs" className="text-primary hover:underline">
            ← Economic activity (/admin/logs)
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h1 className="text-xl font-semibold">Keeper logs (lifecycle)</h1>
          <span className="text-xs text-muted-foreground">
            all tokens · auto-refresh 10s · cursor pages older
          </span>
        </div>

        {/* Admin key (x-keeper-secret) — stored in this browser only, sent as a
            header to the secret-gated logs route. keeper_logs is not public. */}
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <span className="text-muted-foreground">admin key:</span>
          <input
            type="password"
            className="px-2 py-1 rounded border border-border bg-background w-[260px] font-mono"
            placeholder="x-keeper-secret (enter once)"
            defaultValue={adminKey}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.target as HTMLInputElement).value.trim();
                setAdminKey(v);
                setAdminKeyState(v);
              }
            }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== adminKey) {
                setAdminKey(v);
                setAdminKeyState(v);
              }
            }}
          />
          {locked ? (
            <span className="text-amber-500">enter the keeper secret to load logs</span>
          ) : (
            <span className="text-emerald-500">unlocked</span>
          )}
        </div>

        {/* Counts strip */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
          <Stat
            label="total"
            value={stats.data ? String(stats.data.total) : "·"}
            tone={stats.isLoading ? "loading" : undefined}
          />
          <Stat
            label="error"
            value={stats.data ? String(stats.data.error) : "·"}
            tone={stats.data && stats.data.error > 0 ? "bad" : undefined}
          />
          <Stat label="warn" value={stats.data ? String(stats.data.warn) : "·"} />
          <Stat label="info" value={stats.data ? String(stats.data.info) : "·"} />
          <Stat
            label="global (no token)"
            value={stats.data ? String(stats.data.globalNullCount) : "·"}
          />
          <Stat label="last activity" value={relativeTime(stats.data?.lastActivityAt)} />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Button
            size="sm"
            variant={level === "" ? "default" : "outline"}
            onClick={() => {
              setLevel("");
              applyFilters();
            }}
          >
            all
          </Button>
          {LEVELS.map((l) => (
            <Button
              key={l}
              size="sm"
              variant={level === l ? "default" : "outline"}
              onClick={() => {
                setLevel(l);
                applyFilters();
              }}
            >
              {l}
            </Button>
          ))}
          <input
            className="text-xs px-2 py-1 rounded border border-border bg-background w-[160px]"
            placeholder="event (exact)"
            value={eventFilter}
            onChange={(e) => {
              setEventFilter(e.target.value.trim());
              applyFilters();
            }}
          />
          <input
            className="text-xs px-2 py-1 rounded border border-border bg-background w-[260px]"
            placeholder="filter by token_id (uuid)"
            value={tokenFilter}
            onChange={(e) => {
              setTokenFilter(e.target.value.trim());
              applyFilters();
            }}
          />
          {tokenFilter.length === 36 && (
            <Link to="/admin/keeper-logs/$tokenId" params={{ tokenId: tokenFilter }}>
              <Button size="sm" variant="outline">
                open
              </Button>
            </Link>
          )}
          <input
            className="text-xs px-2 py-1 rounded border border-border bg-background w-[220px]"
            placeholder="search any field..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={() => logsQ.refetch()}>
            refresh
          </Button>
          <span className="text-xs text-muted-foreground ml-1">
            {logsQ.isLoading
              ? "loading…"
              : `${rows.length}${rawLogs.length !== rows.length ? `/${rawLogs.length}` : ""} rows`}
          </span>
        </div>

        {/* Table */}
        <div className="overflow-auto border border-border rounded max-h-[calc(100vh-320px)]">
          <table className="text-xs w-max min-w-full">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                <th className="w-6"></th>
                {["time", "ticker", "token_id", "level", "event", "message", "fields"].map((c) => (
                  <th
                    key={c}
                    className="text-left px-2 py-1.5 font-mono whitespace-nowrap border-l border-border/40"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rowKey = String(r.id);
                const isOpen = expanded === rowKey;
                const ticker = r.tokens?.ticker ?? null;
                const fieldsCount = Object.keys(r.fields ?? {}).length;
                return (
                  <Fragment key={rowKey}>
                    <tr
                      className="border-t border-border hover:bg-muted/20 cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : rowKey)}
                    >
                      <td className="px-1 text-muted-foreground">{isOpen ? "▾" : "▸"}</td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30 text-muted-foreground">
                        {relativeTime(r.created_at)}
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30 text-primary">
                        {r.token_id ? (
                          <Link
                            to="/admin/keeper-logs/$tokenId"
                            params={{ tokenId: String(r.token_id) }}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {ticker ?? "?"}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground italic">global</span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30 text-muted-foreground">
                        {r.token_id ? short(String(r.token_id)) : "·"}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap border-l border-border/30">
                        <LevelBadge level={r.level} />
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30">
                        {r.event ?? <span className="text-muted-foreground">·</span>}
                      </td>
                      <td className="px-2 py-1 font-mono border-l border-border/30 max-w-[420px] truncate">
                        {r.message}
                      </td>
                      <td className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30 text-muted-foreground">
                        {fieldsCount > 0 ? `{${fieldsCount}}` : "·"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/10">
                        <td colSpan={8} className="p-3">
                          <RowDetail
                            row={r as unknown as Record<string, unknown>}
                            tokenInfo={(r.tokens ?? null) as Record<string, unknown> | null}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {logsQ.isError && (
                <tr>
                  <td className="px-2 py-6 text-center text-destructive" colSpan={8}>
                    Failed to load keeper_logs: {(logsQ.error as Error)?.message ?? "unknown error"}
                  </td>
                </tr>
              )}
              {rows.length === 0 && !logsQ.isLoading && !logsQ.isError && (
                <tr>
                  <td className="px-2 py-6 text-center text-muted-foreground" colSpan={8}>
                    no keeper_logs match these filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Load older */}
        <div className="mt-3 flex items-center gap-3 text-xs">
          {nextBefore ? (
            <Button size="sm" variant="outline" onClick={() => setCursor(nextBefore)}>
              load older
            </Button>
          ) : (
            <span className="text-muted-foreground">end of page</span>
          )}
          {cursor && (
            <Button size="sm" variant="outline" onClick={() => setCursor(null)}>
              back to newest
            </Button>
          )}
          <span className="text-muted-foreground">
            cursor: <code className="font-mono">{cursor ? short(cursor) : "newest"}</code>
          </span>
        </div>
      </main>
    </div>
  );
}
