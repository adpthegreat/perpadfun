// Page 4: /admin/keeper-logs/$tokenId — single token's keeper_logs timeline.
// See plan/KEEPER_LOGS_PAGES.md §4.3. Counterpart to /admin/logs/$tokenId.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import {
  LevelBadge,
  RowDetail,
  Stat,
  StatusBadge,
  relativeTime,
  short,
} from "@/components/admin-logs/cells";
import { getKeeperLogStats, listKeeperLogs } from "@/lib/keeper-logs.functions";

export const Route = createFileRoute("/admin/keeper-logs_/$tokenId")({
  component: AdminTokenKeeperLogsPage,
  head: () => ({
    meta: [
      { title: "Token keeper logs · perpad" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

type Level = "info" | "warn" | "error";
const LEVELS: Level[] = ["info", "warn", "error"];
const PAGE_LIMIT = 100;

function AdminTokenKeeperLogsPage() {
  const { tokenId } = Route.useParams();
  const [level, setLevel] = useState<Level | "">("");
  const [eventFilter, setEventFilter] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const listFn = useServerFn(listKeeperLogs);
  const statsFn = useServerFn(getKeeperLogStats);

  // header / stats: token + workflow + by-level counts for THIS token
  const stats = useQuery({
    queryKey: ["keeper-logs-stats", tokenId],
    queryFn: () => statsFn({ data: { tokenId } }),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const logsQ = useQuery({
    queryKey: ["keeper-logs-list", tokenId, level, eventFilter, cursor],
    queryFn: () =>
      listFn({
        data: {
          tokenId,
          level: level || undefined,
          event: eventFilter || undefined,
          before: cursor || undefined,
          limit: PAGE_LIMIT,
        },
      }),
    refetchInterval: 10_000,
  });

  const rawLogs = logsQ.data?.logs ?? [];
  const nextBefore = logsQ.data?.nextBefore ?? null;

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

  const token = stats.data?.token ?? null;
  const workflow = stats.data?.workflow ?? null;

  function copyId() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(tokenId).catch(() => {
        /* noop */
      });
    }
  }

  function applyFilters() {
    setCursor(null);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="w-full px-4 py-6">
        <div className="text-xs mb-3 flex flex-wrap gap-3">
          <Link to="/admin/keeper-logs" className="text-primary hover:underline">
            ← All keeper logs (/admin/keeper-logs)
          </Link>
          <Link
            to="/admin/logs/$tokenId"
            params={{ tokenId }}
            className="text-primary hover:underline"
          >
            Economic activity for this token →
          </Link>
        </div>

        {/* Header */}
        {stats.isLoading ? (
          <div className="text-xs text-muted-foreground">loading token…</div>
        ) : !token ? (
          <div className="border border-border rounded p-4 bg-muted/20 text-xs mb-3">
            <div className="font-semibold text-foreground mb-1">Token not found</div>
            <div className="text-muted-foreground">
              No tokens row for id <code className="font-mono">{tokenId}</code>. The keeper_logs
              view still works (if there are any rows for this id they will appear below) but the
              header is empty.
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h1 className="text-xl font-semibold">
              <span className="text-primary font-mono">{String(token.ticker ?? "?")}</span>
              <span className="text-muted-foreground font-normal text-sm ml-2">
                {String(token.name ?? "")}
              </span>
              <span className="text-muted-foreground font-normal text-sm ml-2">· keeper logs</span>
            </h1>
            {workflow?.state && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-foreground font-mono">
                state: {String(workflow.state)}
                {workflow.blocked_reason ? ` · ${String(workflow.blocked_reason)}` : ""}
              </span>
            )}
            <StatusBadge
              status={token.status as string | undefined}
              migration={token.migration_status as string | undefined}
            />
            <Button size="sm" variant="outline" onClick={copyId} title={tokenId}>
              copy id
            </Button>
          </div>
        )}

        {/* Per-token counts strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
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
          <Stat label="last activity" value={relativeTime(stats.data?.lastActivityAt)} />
        </div>

        {/* Filters (no token filter — scoped) */}
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

        {/* Table (no ticker / token_id cols — scoped) */}
        <div className="overflow-auto border border-border rounded max-h-[calc(100vh-360px)]">
          <table className="text-xs w-max min-w-full">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                <th className="w-6"></th>
                {["time", "level", "event", "message", "fields"].map((c) => (
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
                        <td colSpan={6} className="p-3">
                          <RowDetail
                            row={r as unknown as Record<string, unknown>}
                            tokenInfo={token}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && !logsQ.isLoading && (
                <tr>
                  <td className="px-2 py-6 text-center text-muted-foreground" colSpan={6}>
                    no keeper_logs for this token (with these filters)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3 text-xs">
          {nextBefore ? (
            <Button size="sm" variant="outline" onClick={() => setCursor(nextBefore)}>
              load older
            </Button>
          ) : (
            <span className="text-muted-foreground">end of timeline</span>
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
