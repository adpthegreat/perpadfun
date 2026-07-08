// /admin — the unified admin cockpit. One secret-gated page that gives a
// whole-app overview (system health, token activity, workflow states, recent
// keeper logs, economics, onboarding funnel) and links out to the detail pages
// (/stats, /admin/keeper-logs, /admin/logs, /token/$id). Read-only (v1).
//
// Auth: the x-keeper-secret is entered once (localStorage, admin-key.ts) and
// sent as a header to the secret-gated /api/public/keeper/* routes. getPlatformStats
// is public. See plan/ADMIN_DASHBOARD.md.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { LevelBadge, Stat, relativeTime, short } from "@/components/admin-logs/cells";
import { getAdminKey, setAdminKey } from "@/lib/admin-key";
import { listKeeperLogs, AdminKeyError } from "@/lib/keeper-logs.api";
import {
  listKeeperTokens,
  listStuckTokens,
  getOverview,
  getRouterStatus,
  workflowOf,
} from "@/lib/admin-overview.api";
import { getPlatformStats } from "@/lib/stats.functions";

export const Route = createFileRoute("/admin")({
  component: AdminCockpit,
  head: () => ({
    meta: [{ title: "Admin · perpspad" }, { name: "robots", content: "noindex, nofollow" }],
  }),
});

// ── formatters ────────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const usd = (n: number) =>
  `$${num(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const cnt = (n: number) => num(n).toLocaleString();

function Panel({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-border rounded bg-card ${className}`}>
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

// Verdict → tone for the router-lookup card.
function verdictTone(verdict: string): string {
  if (verdict.startsWith("connected") || verdict.startsWith("native — listed"))
    return "text-emerald-500";
  if (verdict.startsWith("routing")) return "text-amber-500";
  if (verdict === "not found") return "text-muted-foreground";
  return "text-red-500";
}

function AdminCockpit() {
  const [adminKey, setAdminKeyState] = useState<string>(() => getAdminKey());
  const enabled = !!adminKey;
  const statsFn = useServerFn(getPlatformStats);

  // Router / mint-status lookup (FEE_ROUTING_AND_MINT_INDEX.md §3).
  const [mintInput, setMintInput] = useState("");
  const [lookupMint, setLookupMint] = useState("");
  const routerQ = useQuery({
    queryKey: ["admin-router-status", adminKey, lookupMint],
    queryFn: () => getRouterStatus(lookupMint),
    enabled: enabled && !!lookupMint,
    retry: false,
  });

  const tokensQ = useQuery({
    queryKey: ["admin-tokens", adminKey],
    queryFn: listKeeperTokens,
    enabled,
    refetchInterval: 20_000,
  });
  const stuckQ = useQuery({
    queryKey: ["admin-stuck", adminKey],
    queryFn: listStuckTokens,
    enabled,
    refetchInterval: 30_000,
  });
  const overviewQ = useQuery({
    queryKey: ["admin-overview", adminKey],
    queryFn: getOverview,
    enabled,
    refetchInterval: 60_000,
  });
  const logsQ = useQuery({
    queryKey: ["admin-recent-logs", adminKey],
    queryFn: () => listKeeperLogs({ data: { limit: 60 } }),
    enabled,
    refetchInterval: 15_000,
  });
  // getPlatformStats is public (no key) — powers the economics strip + charts.
  const statsQ = useQuery({
    queryKey: ["admin-platform-stats"],
    queryFn: () => statsFn(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const locked =
    !adminKey ||
    tokensQ.error instanceof AdminKeyError ||
    logsQ.error instanceof AdminKeyError;

  const tokens = tokensQ.data ?? [];
  const stuck = stuckQ.data ?? [];
  const stats = statsQ.data;
  const overview = overviewQ.data;

  // Freshest last_tick_at across the feed → the keeper-alive readout (rendered
  // as a relative time; relativeTime handles "now").
  const freshestTick = useMemo(() => {
    let iso: string | null = null;
    let best = 0;
    for (const t of tokens) {
      if (!t.last_tick_at) continue;
      const ms = Date.parse(t.last_tick_at);
      if (Number.isFinite(ms) && ms > best) {
        best = ms;
        iso = t.last_tick_at;
      }
    }
    return iso;
  }, [tokens]);

  // Workflow state counts (prefer the tokens feed; fall back to stats).
  const wfCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tokens) {
      const state = workflowOf(t)?.state ?? "unknown";
      m.set(state, (m.get(state) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tokens]);

  // Economics totals summed over the feed (independent of the public stats fn).
  const totals = useMemo(() => {
    let fees = 0,
      reserve = 0,
      pnl = 0,
      oi = 0;
    for (const t of tokens) {
      fees += num(t.fees_accrued_usd);
      reserve += num(t.buyback_reserve_usd);
      pnl += num(t.treasury_pnl_usd);
      oi += num(t.position_size_usd);
    }
    return { fees, reserve, pnl, oi };
  }, [tokens]);

  // Recent issues: warn + error rows from the last page, newest first.
  const issues = useMemo(() => {
    const rows = logsQ.data?.logs ?? [];
    return rows.filter((r) => r.level === "warn" || r.level === "error").slice(0, 25);
  }, [logsQ.data]);

  const maxSeries = useMemo(
    () => Math.max(1, ...(overview?.series ?? []).map((s) => s.count)),
    [overview],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Admin cockpit</h1>
          <span className="text-[11px] text-muted-foreground">
            whole-app overview · auto-refresh · read-only
          </span>
        </div>

        {/* Admin key gate (x-keeper-secret; stored in this browser only) */}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">admin key:</span>
          <input
            type="password"
            className="w-[260px] rounded border border-border bg-background px-2 py-1 font-mono"
            placeholder="admin key (enter once)"
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
            <span className="text-amber-500">enter the keeper secret to load the cockpit</span>
          ) : (
            <span className="text-emerald-500">unlocked</span>
          )}
        </div>

        {/* ── Health strip ── */}
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="keeper last tick"
            value={freshestTick ? relativeTime(freshestTick) : "·"}
            tone={tokensQ.isLoading ? "loading" : undefined}
          />
          <Stat label="active tokens" value={enabled ? cnt(tokens.length) : "·"} />
          <Stat
            label="stuck"
            value={enabled ? cnt(stuck.length) : "·"}
            tone={stuck.length > 0 ? "bad" : stuck.length === 0 && enabled ? "good" : undefined}
          />
          <Stat
            label="issues (recent)"
            value={enabled ? cnt(issues.length) : "·"}
            tone={issues.some((r) => r.level === "error") ? "bad" : undefined}
          />
          <Stat label="signups" value={overview ? cnt(overview.funnel.signups) : "·"} />
          <Stat
            label="codes left"
            value={overview ? cnt(overview.codes.remaining) : "·"}
            tone={overview && overview.codes.remaining === 0 ? "bad" : undefined}
          />
        </div>

        {/* ── Economics strip ── */}
        <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-8">
          <Stat label="Σ open interest" value={enabled ? usd(totals.oi) : "·"} />
          <Stat
            label="Σ treasury pnl"
            value={enabled ? usd(totals.pnl) : "·"}
            tone={totals.pnl < 0 ? "bad" : totals.pnl > 0 ? "good" : undefined}
          />
          <Stat label="Σ fees accrued" value={enabled ? usd(totals.fees) : "·"} />
          <Stat label="Σ buyback reserve" value={enabled ? usd(totals.reserve) : "·"} />
          <Stat label="bought back" value={stats?.kpis ? `${num(stats.kpis.buybackSol).toFixed(2)} SOL` : "·"} />
          <Stat label="fees claimed" value={stats?.kpis ? `${num(stats.kpis.claimSol).toFixed(2)} SOL` : "·"} />
          <Stat label="burn events" value={stats?.kpis ? cnt(stats.kpis.burnEvents) : "·"} />
          <Stat label="graduated" value={stats?.kpis ? cnt(stats.kpis.graduated) : "·"} />
        </div>

        {/* ── 2-col: workflow states + onboarding funnel ── */}
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Workflow states" hint={`${tokens.length} managed`}>
            {wfCounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {enabled ? "no tokens" : "locked"}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {wfCounts.map(([state, c]) => (
                  <div
                    key={state}
                    className="flex items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1"
                  >
                    <span className="font-mono text-xs">{state}</span>
                    <span className="text-xs font-semibold">{c}</span>
                  </div>
                ))}
              </div>
            )}
            {stuck.length > 0 && (
              <div className="mt-3 border-t border-border pt-2">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-amber-500">
                  stuck ({stuck.length})
                </div>
                <ul className="space-y-1">
                  {stuck.slice(0, 8).map((t) => {
                    const w = workflowOf(t);
                    return (
                      <li key={t.id} className="flex items-center gap-2 text-xs">
                        <Link
                          to="/admin/keeper-logs/$tokenId"
                          params={{ tokenId: t.id }}
                          className="font-mono text-primary hover:underline"
                        >
                          {t.ticker ?? short(t.id)}
                        </Link>
                        <span className="font-mono text-muted-foreground">{w?.state}</span>
                        {w?.blocked_reason && (
                          <span className="truncate text-muted-foreground">
                            — {w.blocked_reason}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Panel>

          <Panel
            title="Onboarding funnel"
            hint={overview ? `${overview.codes.remaining}/${overview.codes.total} codes left` : ""}
          >
            {!overview ? (
              <p className="text-xs text-muted-foreground">{enabled ? "loading…" : "locked"}</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="signups" value={cnt(overview.funnel.signups)} />
                  <Stat label="wallet ✓" value={cnt(overview.funnel.walletVerified)} />
                  <Stat label="X followed" value={cnt(overview.funnel.xFollowed)} />
                  <Stat label="TG joined" value={cnt(overview.funnel.tgJoined)} />
                  <Stat label="claimed" value={cnt(overview.funnel.claimed)} />
                  <Stat label="waitlisted" value={cnt(overview.funnel.waitlisted)} />
                </div>
                {overview.series.length > 0 && (
                  <div className="mt-3 border-t border-border pt-2">
                    <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                      signups / day
                    </div>
                    <div className="flex items-end gap-1" style={{ height: 48 }}>
                      {overview.series.map((s) => (
                        <div
                          key={s.day}
                          className="flex-1 rounded-t bg-primary/70"
                          style={{ height: `${Math.max(4, (s.count / maxSeries) * 48)}px` }}
                          title={`${s.day}: ${s.count}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>

        {/* ── Router / mint-status lookup (diagnose stuck external routers) ── */}
        <Panel
          title="Router lookup"
          hint="paste a mint → routing status (finds hidden/stuck routers)"
          className="mb-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-[420px] max-w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
              placeholder="mint address (external pump.fun mint or native DBC mint)"
              value={mintInput}
              onChange={(e) => setMintInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setLookupMint(mintInput.trim());
              }}
            />
            <Button size="sm" variant="outline" onClick={() => setLookupMint(mintInput.trim())}>
              look up
            </Button>
            {lookupMint && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMintInput("");
                  setLookupMint("");
                }}
              >
                clear
              </Button>
            )}
          </div>

          {lookupMint && (
            <div className="mt-3">
              {routerQ.isLoading && (
                <p className="text-xs text-muted-foreground">resolving {short(lookupMint)}…</p>
              )}
              {routerQ.isError && (
                <p className="text-xs text-destructive">
                  {(routerQ.error as Error)?.message ?? "lookup failed"}
                </p>
              )}
              {routerQ.data && (
                <div className="rounded border border-border bg-muted/10 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`text-sm font-semibold ${verdictTone(routerQ.data.verdict)}`}>
                      {routerQ.data.verdict}
                    </span>
                    {routerQ.data.token && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {routerQ.data.token.ticker ?? "?"} · {routerQ.data.token.source} ·{" "}
                        {routerQ.data.token.status ?? "?"}
                      </span>
                    )}
                    {routerQ.data.listedOnSite != null && (
                      <span
                        className={`font-mono text-[11px] ${
                          routerQ.data.listedOnSite ? "text-emerald-500" : "text-amber-500"
                        }`}
                      >
                        {routerQ.data.listedOnSite ? "listed on site" : "hidden"}
                      </span>
                    )}
                    {routerQ.data.duplicate && (
                      <span className="font-mono text-[11px] text-amber-500">
                        ⚠ multiple rows match
                      </span>
                    )}
                  </div>

                  <p className="mt-1.5 text-xs text-foreground/90">{routerQ.data.detail}</p>
                  <p className="mt-1 text-xs">
                    <span className="text-muted-foreground">next: </span>
                    {routerQ.data.nextAction}
                  </p>

                  {routerQ.data.token && (
                    <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                      <Stat
                        label="sub-wallet SOL"
                        value={
                          routerQ.data.subWalletBalanceSol != null
                            ? `${routerQ.data.subWalletBalanceSol.toFixed(4)}`
                            : "·"
                        }
                        tone={
                          (routerQ.data.subWalletBalanceSol ?? 0) > 0 ? "good" : undefined
                        }
                      />
                      <Stat
                        label="first fee routed"
                        value={
                          routerQ.data.token.firstFeeRoutedAt
                            ? relativeTime(routerQ.data.token.firstFeeRoutedAt)
                            : "never"
                        }
                        tone={routerQ.data.token.firstFeeRoutedAt ? "good" : "bad"}
                      />
                      <Stat label="created" value={relativeTime(routerQ.data.token.createdAt)} />
                      <Stat
                        label="sub-wallet"
                        value={
                          routerQ.data.token.subWallet ? short(routerQ.data.token.subWallet) : "·"
                        }
                      />
                    </div>
                  )}

                  {routerQ.data.token && (
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      <Link
                        to="/token/$id"
                        params={{ id: routerQ.data.token.id }}
                        className="text-primary hover:underline"
                      >
                        open token →
                      </Link>
                      <Link
                        to="/admin/keeper-logs/$tokenId"
                        params={{ tokenId: routerQ.data.token.id }}
                        className="text-primary hover:underline"
                      >
                        keeper logs →
                      </Link>
                    </div>
                  )}

                  {routerQ.data.events && routerQ.data.events.length > 0 && (
                    <div className="mt-3 border-t border-border pt-2">
                      <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                        recent events
                      </div>
                      <div className="overflow-auto">
                        <table className="w-max min-w-full text-xs">
                          <tbody>
                            {routerQ.data.events.map((ev, i) => (
                              <tr key={i} className="border-t border-border/40">
                                <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                                  {relativeTime(ev.createdAt)}
                                </td>
                                <td className="whitespace-nowrap px-2 py-1 font-mono">{ev.kind}</td>
                                <td className="whitespace-nowrap px-2 py-1 font-mono">
                                  {ev.solAmount ? `${ev.solAmount.toFixed(4)} SOL` : "·"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ── Token activity table ── */}
        <Panel
          title="Token activity"
          hint={`${tokens.length} managed · auto-refresh 20s`}
          className="mb-4"
        >
          <div className="overflow-auto">
            <table className="w-max min-w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  {[
                    "ticker",
                    "state",
                    "market",
                    "size",
                    "coll",
                    "treasury pnl",
                    "fees",
                    "reserve",
                    "last tick",
                    "",
                  ].map((c) => (
                    <th
                      key={c}
                      className="whitespace-nowrap border-l border-border/40 px-2 py-1.5 text-left font-mono"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => {
                  const w = workflowOf(t);
                  const pnl = num(t.treasury_pnl_usd);
                  return (
                    <tr key={t.id} className="border-t border-border hover:bg-muted/20">
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono text-primary">
                        <Link to="/token/$id" params={{ id: t.id }} className="hover:underline">
                          {t.ticker ?? short(t.id)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono">
                        {w?.state ?? "·"}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono text-muted-foreground">
                        {t.underlying ?? "?"}
                        {t.leverage ? ` ${t.leverage}x` : ""} {t.direction ?? ""}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono">
                        {usd(num(t.position_size_usd))}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono">
                        {usd(num(t.position_collateral_usd))}
                      </td>
                      <td
                        className={`whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono ${
                          pnl < 0 ? "text-red-500" : pnl > 0 ? "text-emerald-500" : ""
                        }`}
                      >
                        {usd(pnl)}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono">
                        {usd(num(t.fees_accrued_usd))}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono">
                        {usd(num(t.buyback_reserve_usd))}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1 font-mono text-muted-foreground">
                        {relativeTime(t.last_tick_at)}
                      </td>
                      <td className="whitespace-nowrap border-l border-border/30 px-2 py-1">
                        <Link
                          to="/admin/keeper-logs/$tokenId"
                          params={{ tokenId: t.id }}
                          className="text-primary hover:underline"
                        >
                          logs
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {tokens.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-2 py-6 text-center text-muted-foreground">
                      {enabled
                        ? tokensQ.isLoading
                          ? "loading…"
                          : "no managed tokens"
                        : "enter the admin key to load tokens"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── Recent issues (warn/error) ── */}
        <Panel
          title="Recent issues"
          hint="warn / error · last page · auto-refresh 15s"
          className="mb-4"
        >
          {issues.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {enabled ? "no recent warnings or errors 🎉" : "locked"}
            </p>
          ) : (
            <div className="overflow-auto">
              <table className="w-max min-w-full text-xs">
                <tbody>
                  {issues.map((r) => (
                    <tr key={String(r.id)} className="border-t border-border">
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                        {relativeTime(r.created_at)}
                      </td>
                      <td className="px-2 py-1">
                        <LevelBadge level={r.level} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-primary">
                        {r.token_id ? (
                          <Link
                            to="/admin/keeper-logs/$tokenId"
                            params={{ tokenId: String(r.token_id) }}
                            className="hover:underline"
                          >
                            {r.tokens?.ticker ?? short(String(r.token_id))}
                          </Link>
                        ) : (
                          <span className="italic text-muted-foreground">global</span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono">
                        {r.event ?? <span className="text-muted-foreground">·</span>}
                      </td>
                      <td className="max-w-[520px] truncate px-2 py-1 font-mono">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-2 text-xs">
            <Link to="/admin/keeper-logs" className="text-primary hover:underline">
              → all keeper logs
            </Link>
          </div>
        </Panel>

        {/* ── Quick links ── */}
        <div className="flex flex-wrap gap-2 text-xs">
          <Link to="/stats">
            <Button size="sm" variant="outline">
              platform stats
            </Button>
          </Link>
          <Link to="/admin/keeper-logs">
            <Button size="sm" variant="outline">
              keeper logs
            </Button>
          </Link>
          <Link to="/admin/logs">
            <Button size="sm" variant="outline">
              economic activity
            </Button>
          </Link>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              tokensQ.refetch();
              stuckQ.refetch();
              overviewQ.refetch();
              logsQ.refetch();
              statsQ.refetch();
            }}
          >
            refresh all
          </Button>
        </div>
      </main>
    </div>
  );
}
