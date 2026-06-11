import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { formatUsd } from "@/lib/tokens";
import { getPlatformStats } from "@/lib/stats.functions";
import {
  Panel,
  StatCard,
  HBars,
  VBars,
  Donut,
  AreaTrend,
  ComboBarsLine,
  GRAY,
  POS,
  NEG,
} from "@/components/stats/charts";

export const Route = createFileRoute("/stats")({
  component: StatsPage,
  head: () => ({
    meta: [
      { title: "Stats · perpad" },
      { name: "description", content: "Platform-wide stats for perpad: assets, leverage, fees, buybacks, and more." },
    ],
  }),
});

const sol = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`;
const cnt = (n: number) => n.toLocaleString();
const dirColors = (data: { label: string }[]) =>
  data.map((d) => (d.label === "long" ? POS : d.label === "short" ? NEG : GRAY[2]));

function StatsPage() {
  const statsFn = useServerFn(getPlatformStats);
  const q = useQuery({
    queryKey: ["platform-stats"],
    queryFn: () => statsFn(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const d = q.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">perpad</div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform stats</h1>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          Aggregated across every token · auto-refresh 60s
          {d?.solUsd ? ` · SOL $${d.solUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ""}
        </p>

        {q.isLoading && (
          <div className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse border border-border bg-secondary/30" />
            ))}
          </div>
        )}

        {q.isError && (
          <div className="mt-10 border border-destructive/40 bg-card p-6 font-mono text-sm text-destructive">
            Failed to load stats: {(q.error as Error)?.message ?? "unknown error"}
          </div>
        )}

        {d && d.ok && d.kpis && d.distributions && (
          <div className="mt-8 space-y-4">
            {/* ── KPI cards ── */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              <StatCard label="Tokens launched" value={cnt(d.kpis.total)} />
              <StatCard label="Live" value={cnt(d.kpis.live)} />
              <StatCard label="Graduated" value={cnt(d.kpis.graduated)} />
              <StatCard label="Open interest" value={formatUsd(d.kpis.oiUsd)} />
              <StatCard label="Collateral deployed" value={formatUsd(d.kpis.collUsd)} />
              <StatCard label="Treasury PnL" value={formatUsd(d.kpis.pnlUsd)} accent={d.kpis.pnlUsd >= 0 ? "pos" : "neg"} />
              <StatCard label="Fees accrued" value={formatUsd(d.kpis.feesUsd)} />
              <StatCard label="Bought back" value={sol(d.kpis.buybackSol)} />
              <StatCard label="Volume routed" value={sol(d.kpis.volumeSol)} />
              <StatCard label="Fees claimed" value={sol(d.kpis.claimSol)} />
              <StatCard label="Burn events" value={cnt(d.kpis.burnEvents)} />
              <StatCard label="Buyback reserve" value={formatUsd(d.kpis.reserveUsd)} />
            </div>

            {/* ── assets + direction ── */}
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Most-used assets" hint={`${d.distributions.assets.length} markets`} className="lg:col-span-2">
                <HBars data={d.distributions.assets.slice(0, 12)} />
              </Panel>
              <Panel title="Direction" hint="long vs short">
                <Donut data={d.distributions.direction} colors={dirColors(d.distributions.direction)} />
              </Panel>
            </div>

            {/* ── launches+buyback combo + leverage ── */}
            <div className="grid gap-4 lg:grid-cols-3">
              <Panel title="Launches & cumulative buyback" hint="last 30d" className="lg:col-span-2">
                <ComboBarsLine
                  data={d.series.map((s) => ({ ...s, d: s.day.slice(5) }))}
                  xKey="d"
                  barKey="launches"
                  lineKey="cumBuybackSol"
                  barLabel="launches/day"
                  lineLabel="cum buyback SOL"
                />
              </Panel>
              <Panel title="Leverage used" hint="base · degen">
                <VBars
                  data={d.distributions.leverages}
                  colorFor={(b) => ((b as { tier?: string }).tier === "base" ? GRAY[3] : GRAY[0])}
                />
              </Panel>
            </div>

            {/* ── fees area + source ── */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Fees claimed / day" hint="SOL · last 30d">
                <AreaTrend data={d.series.map((s) => ({ ...s, d: s.day.slice(5) }))} xKey="d" yKey="feeSol" />
              </Panel>
              <Panel title="Source / lifecycle" hint="status">
                <Donut data={d.distributions.status} />
              </Panel>
            </div>

            {/* ── leaderboards ── */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Leaderboard title="Top by fees" rows={d.leaderboards!.fees} fmt={(v) => formatUsd(v)} />
              <Leaderboard title="Top by treasury PnL" rows={d.leaderboards!.pnl} fmt={(v) => formatUsd(v)} signed />
              <Leaderboard title="Top by position size" rows={d.leaderboards!.size} fmt={(v) => formatUsd(v)} />
              <Leaderboard title="Most burned" rows={d.leaderboards!.burned} fmt={(v) => cnt(v)} />
            </div>

            <p className="pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
              Note: the leverage chart includes legacy tokens above the current 25× Phoenix cap (created before the
              leverage-cap fix), so a small 50×/100× slice is expected.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function Leaderboard({
  title,
  rows,
  fmt,
  signed,
}: {
  title: string;
  rows: { id: string; ticker: string; underlying: string; value: number }[];
  fmt: (v: number) => string;
  signed?: boolean;
}) {
  return (
    <Panel title={title}>
      <div className="space-y-1.5">
        {rows.length === 0 && <div className="font-mono text-[11px] text-muted-foreground">no data</div>}
        {rows.map((r, i) => (
          <Link
            key={r.id}
            to="/token/$id"
            params={{ id: r.id }}
            className="flex items-center gap-2 font-mono text-[11px] hover:text-primary"
          >
            <span className="w-4 text-right tabular-nums text-muted-foreground/50">{i + 1}</span>
            <span className="truncate font-semibold">${r.ticker}</span>
            <span className="truncate text-muted-foreground/60">{r.underlying}</span>
            <span
              className="ml-auto tabular-nums"
              style={signed ? { color: r.value >= 0 ? POS : NEG } : undefined}
            >
              {fmt(r.value)}
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}
