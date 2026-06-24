// Page 2: per-token admin economic-activity detail. See plan/ADMIN_PER_TOKEN_PAGE.md.
// Scope: treasury_events / tx_log / keeper_actions / token_workflows for ONE token.
// NOT this page's source: keeper_logs (that lives at /admin/keeper-logs/$tokenId per
// plan/KEEPER_LOGS_PAGES.md). Cross-linked from the footer.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import {
  renderCell,
  RowDetail,
  StatusBadge,
  Stat,
  short,
  formatNum,
  relativeTime,
  keeperIssueFromEvent,
  keeperIssueFromPendingTx,
} from "@/components/admin-logs/cells";

export const Route = createFileRoute("/admin/logs_/$tokenId")({
  component: AdminTokenLogsPage,
  head: () => ({
    meta: [{ title: "Token debug · perpspad" }, { name: "robots", content: "noindex, nofollow" }],
  }),
});

type Tab = "issues" | "tx_log" | "treasury_events" | "workflow";

function AdminTokenLogsPage() {
  const { tokenId } = Route.useParams();
  const [tab, setTab] = useState<Tab>("issues");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Header data: tokens row + token_workflows row (single round trip).
  const headerQ = useQuery({
    queryKey: ["admin-token-header", tokenId],
    queryFn: async () => {
      const [tokenRes, wfRes] = await Promise.all([
        supabase.from("tokens").select("*").eq("id", tokenId).maybeSingle(),
        supabase.from("token_workflows").select("*").eq("token_id", tokenId).maybeSingle(),
      ]);
      if (tokenRes.error) throw tokenRes.error;
      if (wfRes.error) throw wfRes.error;
      return { token: tokenRes.data, workflow: wfRes.data };
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Per-tab data: scoped to token_id.
  const tabQ = useQuery({
    queryKey: ["admin-token-tab", tab, tokenId],
    queryFn: async () => {
      if (tab === "issues") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const [eventsRes, pendingRes] = await Promise.all([
          supabase
            .from("treasury_events")
            .select("*")
            .eq("token_id", tokenId)
            .gte("created_at", since)
            .or(
              "note.ilike.%backoff%,note.ilike.%parked%,note.ilike.%buyback drain err%,note.ilike.%imperial deposit err%,note.ilike.%top-up err%,note.ilike.%wallet capacity%,note.ilike.%below floor%,note.ilike.%fee claim error%,note.ilike.%insufficient lamports%",
            )
            .order("created_at", { ascending: false })
            .limit(200),
          supabase
            .from("tx_log")
            .select("*")
            .eq("token_id", tokenId)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(100),
        ]);
        if (eventsRes.error) throw eventsRes.error;
        if (pendingRes.error) throw pendingRes.error;
        const eventRows = (eventsRes.data ?? []).map((r) =>
          keeperIssueFromEvent(r as Record<string, unknown>),
        );
        const pendingRows = (pendingRes.data ?? []).map((r) =>
          keeperIssueFromPendingTx(r as Record<string, unknown>),
        );
        return [...eventRows, ...pendingRows].sort(
          (a, b) =>
            new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime(),
        );
      }
      if (tab === "workflow") {
        const { data, error } = await supabase
          .from("keeper_actions")
          .select("*")
          .eq("token_id", tokenId)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        return data ?? [];
      }
      // tx_log / treasury_events
      const { data, error } = await supabase
        .from(tab)
        .select("*")
        .eq("token_id", tokenId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 10_000,
  });

  const token = headerQ.data?.token;
  const workflow = headerQ.data?.workflow;
  const rows = (tabQ.data ?? []) as Array<Record<string, unknown>>;
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  const stats = useMemo(() => {
    if (!token) return null;
    const size = Number(token.position_size_usd ?? 0);
    const coll = Number(token.position_collateral_usd ?? 0);
    return {
      size,
      coll,
      effLev: coll > 0 ? size / coll : 0,
      pnl: Number(token.treasury_pnl_usd ?? 0),
      fees: Number(token.fees_accrued_usd ?? 0),
      reserve: Number(token.buyback_reserve_usd ?? 0),
      treasurySol: Number(token.treasury_sol ?? 0),
      lastTickAt: token.last_tick_at as string | null,
    };
  }, [token]);

  function copyId() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(tokenId).catch(() => {
        /* noop */
      });
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="w-full px-4 py-6">
        {/* Back link */}
        <div className="text-xs mb-3">
          <Link to="/admin/logs" className="text-primary hover:underline">
            ← All tokens (/admin/logs)
          </Link>
        </div>

        {/* Header */}
        {headerQ.isLoading ? (
          <div className="text-xs text-muted-foreground">loading token…</div>
        ) : !token ? (
          <div className="border border-border rounded p-4 bg-muted/20 text-xs">
            <div className="font-semibold text-foreground mb-1">Token not found</div>
            <div className="text-muted-foreground">
              No tokens row for id <code className="font-mono">{tokenId}</code>. Re-seed or check
              the id.
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <h1 className="text-xl font-semibold">
                <span className="text-primary font-mono">{token.ticker ?? "?"}</span>
                <span className="text-muted-foreground font-normal text-sm ml-2">{token.name}</span>
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
              {token.mint_address && (
                <a
                  href={`https://solscan.io/account/${token.mint_address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  mint {short(String(token.mint_address))}
                </a>
              )}
              {token.treasury_wallet_address && (
                <a
                  href={`https://solscan.io/account/${token.treasury_wallet_address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  wallet {short(String(token.treasury_wallet_address))}
                </a>
              )}
              {token.imperial_profile_pda && (
                <a
                  href={`https://solscan.io/account/${token.imperial_profile_pda}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  imperial {short(String(token.imperial_profile_pda))}
                </a>
              )}
            </div>

            {/* Stats strip */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 mb-4">
                <Stat label="size" value={"$" + formatNum(stats.size)} />
                <Stat label="coll" value={"$" + formatNum(stats.coll)} />
                <Stat
                  label="eff lev"
                  value={stats.effLev > 0 ? `${stats.effLev.toFixed(2)}x` : "·"}
                />
                <Stat
                  label="PnL"
                  value={"$" + formatNum(stats.pnl)}
                  tone={stats.pnl > 0 ? "good" : stats.pnl < 0 ? "bad" : undefined}
                />
                <Stat label="fees" value={"$" + formatNum(stats.fees)} />
                <Stat label="buyback rsv" value={"$" + formatNum(stats.reserve)} />
                <Stat label="treasury SOL" value={formatNum(stats.treasurySol)} />
                <Stat label="last tick" value={relativeTime(stats.lastTickAt)} />
              </div>
            )}
          </>
        )}

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {(["issues", "tx_log", "treasury_events", "workflow"] as Tab[]).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => {
                setTab(t);
                setExpanded(null);
              }}
            >
              {t}
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={() => tabQ.refetch()}>
            refresh
          </Button>
          <span className="text-xs text-muted-foreground ml-2">
            {tabQ.isLoading ? "loading…" : `${rows.length} rows · auto-refresh 10s`}
          </span>
        </div>

        {/* Workflow tab special-cases the JSON row */}
        {tab === "workflow" && workflow ? (
          <div className="grid md:grid-cols-2 gap-3 mb-4">
            <div className="border border-border rounded p-3 bg-muted/10">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                token_workflows row
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(workflow, null, 2)}
              </pre>
            </div>
            <div className="border border-border rounded p-3 bg-muted/10">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                recent keeper_actions (top 50)
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(rows, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          /* Generic table for issues / tx_log / treasury_events */
          <div className="overflow-auto border border-border rounded max-h-[calc(100vh-340px)]">
            <table className="text-xs w-max min-w-full">
              <thead className="bg-muted/60 sticky top-0 z-10">
                <tr>
                  <th className="w-6"></th>
                  {columns.map((c) => (
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
                {rows.map((row, i) => {
                  const rowKey = (row.id as string | number | undefined) ?? `${i}`;
                  const isOpen = expanded === String(rowKey);
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className="border-t border-border hover:bg-muted/20 cursor-pointer"
                        onClick={() => setExpanded(isOpen ? null : String(rowKey))}
                      >
                        <td className="px-1 text-muted-foreground">{isOpen ? "▾" : "▸"}</td>
                        {columns.map((c) => (
                          <td
                            key={c}
                            className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30"
                          >
                            {renderCell(c, row[c])}
                          </td>
                        ))}
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/10">
                          <td colSpan={columns.length + 1} className="p-3">
                            <RowDetail row={row} tokenInfo={token} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && !tabQ.isLoading && (
                  <tr>
                    <td
                      className="px-2 py-6 text-center text-muted-foreground"
                      colSpan={Math.max(columns.length + 1, 2)}
                    >
                      no rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer cross-link to the keeper-logs view (plan/KEEPER_LOGS_PAGES.md). */}
        <div className="mt-4 text-xs">
          <Link
            to="/admin/keeper-logs/$tokenId"
            params={{ tokenId }}
            className="text-primary hover:underline"
          >
            Keeper lifecycle logs for this token →
          </Link>
        </div>
      </main>
    </div>
  );
}
