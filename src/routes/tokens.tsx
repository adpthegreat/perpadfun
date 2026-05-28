import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listTokens } from "@/lib/tokens.functions";
import { formatUsd } from "@/lib/tokens";

export const Route = createFileRoute("/tokens")({
  component: TokensPage,
  head: () => ({
    meta: [
      { title: "Market · perpad" },
      { name: "description", content: "Every coin live on perpad, each one collateralised by a perp." },
    ],
  }),
});

type Tab = "trending" | "new" | "graduated";

function TokensPage() {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("new");
  const listFn = useServerFn(listTokens);
  const tokensQuery = useQuery({
    queryKey: ["tokens-all", tab],
    queryFn: () => listFn({ data: { tab } }),
    refetchInterval: 15000,
  });

  const list = (tokensQuery.data?.tokens ?? [])
    .filter(
      (t) =>
        t.ticker.toLowerCase().includes(q.toLowerCase()) ||
        t.underlying.toLowerCase().includes(q.toLowerCase()) ||
        t.name.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((a, b) => {
      const aMain = a.ticker.toUpperCase() === "PERPAD" ? 1 : 0;
      const bMain = b.ticker.toUpperCase() === "PERPAD" ? 1 : 0;
      return bMain - aMain;
    });

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Market</h1>
            <p className="mt-2 text-sm text-muted-foreground">{list.length} coins · every one backed by a perp</p>
          </div>
          <Button asChild className="rounded-none"><Link to="/launch">Create a coin</Link></Button>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Input
            placeholder="Search ticker, name or underlying…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs rounded-none"
          />
          <div className="flex gap-1 border border-border p-1">
            {(["new", "trending", "graduated"] as Tab[]).map((s) => (
              <button
                key={s}
                onClick={() => setTab(s)}
                className={`px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${tab === s ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {tokensQuery.isLoading ? (
          <div className="mt-12 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">loading…</div>
        ) : list.length === 0 ? (
          <div className="mt-12 border border-border bg-card p-12 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">nothing here yet</div>
            <Button asChild className="mt-4 rounded-none"><Link to="/launch">launch the first</Link></Button>
          </div>
        ) : (
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((t) => (
              <Link
                key={t.id}
                to="/token/$id"
                params={{ id: t.id }}
                className="border border-border bg-card p-5 transition-colors hover:border-foreground"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {t.imageUrl ? (
                      <img
                        src={t.imageUrl}
                        alt={t.ticker}
                        loading="lazy"
                        className="h-10 w-10 shrink-0 object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-accent text-xs font-semibold text-accent-foreground">
                        {t.ticker.slice(0, 2)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <div className="truncate text-sm font-semibold">${t.ticker}</div>
                        {t.source === "external" ? (
                          <span className="shrink-0 border border-green-500/40 bg-green-500/10 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-green-400">
                            {t.externalPlatform === "pump_fun" ? "pump.fun" : "routed"}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{t.name}</div>
                    </div>
                  </div>
                  <div className="shrink-0 border border-border px-1.5 py-0.5 font-mono text-[10px]">
                    {t.leverage}x {t.direction}
                  </div>
                </div>
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="font-mono text-base font-semibold tabular-nums">{formatUsd(t.priceUsd)}</div>
                    <div className={`font-mono text-[11px] tabular-nums ${t.changePct >= 0 ? "text-primary" : "text-destructive"}`}>
                      {t.changePct >= 0 ? "+" : ""}{t.changePct.toFixed(2)}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">mcap</div>
                    <div className="font-mono text-xs tabular-nums">{formatUsd(t.marketCap)}</div>
                  </div>
                </div>
                {t.source === "external" ? (
                  <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-green-400/80">
                    fee router · {t.leverage}x {t.direction} {t.underlying} backing
                  </div>
                ) : (
                  <div className="mt-4">
                    <div className="mb-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      <span>graduation</span>
                      <span className="tabular-nums">{Math.round(t.graduationProgress * 100)}%</span>
                    </div>
                    <Progress value={t.graduationProgress * 100} className="h-1" />
                  </div>
                )}

              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
