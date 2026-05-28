import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listTokens, getOpenPerpPositions, getProtocolStats } from "@/lib/tokens.functions";
import { getPerpMarkets } from "@/lib/perps.functions";
import { formatUsd } from "@/lib/tokens";
import { Progress } from "@/components/ui/progress";
import { formatDistanceToNowStrict } from "date-fns";
import { MarketIcon } from "@/lib/market-icons";
import { usePythSnapshot } from "@/hooks/usePythPrices";
import { MARKET_DISPLAY_NAMES } from "@/lib/imperial-markets";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "perpad. solana coins with a perp treasury." },
      {
        name: "description",
        content:
          "Launch Solana coins paired with a leveraged perp treasury that buys and burns supply on every up tick.",
      },
    ],
  }),
});

type Tab = "all" | "trending" | "new" | "graduated";
type SourceFilter = "all" | "perpad" | "pump_fun";
const ALWAYS_VISIBLE_EXTERNAL_MINTS = new Set([
  "iJMcUZNW9KXVXwkTMJMXZWgGrs8EPwVUK7xxHvxpump",
  "7w8wjfzFMVCWg1KtqmhXvGmweVjfEqbBjUsJ6UJnpump",
]);
const ALWAYS_VISIBLE_TICKERS = new Set(["SQUEEZE"]);
// Hide spam HYPU duplicates by mint, keep the canonical iJMc... one.
const HIDDEN_EXTERNAL_MINTS = new Set([
  "ddwE4tjoKNDsYbdEKHCj8FxFLr13w75ygyh5HrFpump",
]);
const PINNED_TOP_TICKER = "PERPAD";
const FEATURED_EXTERNAL_MINTS = new Set([
  "iJMcUZNW9KXVXwkTMJMXZWgGrs8EPwVUK7xxHvxpump",
]);

function Index() {
  const [tab, setTab] = useState<Tab>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const listTokensFn = useServerFn(listTokens);
  const getPerpFn = useServerFn(getPerpMarkets);
  const getPositionsFn = useServerFn(getOpenPerpPositions);
  const getStatsFn = useServerFn(getProtocolStats);

  const statsQuery = useQuery({
    queryKey: ["protocol-stats"],
    queryFn: () => getStatsFn(),
    refetchInterval: 30000,
  });

  const tokensQuery = useQuery({
    queryKey: ["tokens", tab],
    queryFn: () => listTokensFn({ data: { tab: tab === "all" ? "trending" : tab } }),
    refetchInterval: 15000,
  });

  const marketsQuery = useQuery({
    queryKey: ["perp-markets"],
    queryFn: () => getPerpFn(),
    refetchInterval: 15000,
  });

  const positionsQuery = useQuery({
    queryKey: ["open-perp-positions"],
    queryFn: () => getPositionsFn({ data: { limit: 20 } }),
    refetchInterval: 15000,
  });

  const tokens = tokensQuery.data?.tokens ?? [];
  const allMarkets = marketsQuery.data?.markets ?? [];
  const IMPERIAL_SUPPORTED = new Set([
    "BTC",
    "ETH",
    "SOL",
    "BNB",
    "XRP",
    "DOGE",
    "ADA",
    "AVAX",
    "TON",
    "NEAR",
    "SUI",
    "TRX",
    "LTC",
    "DOT",
    "BCH",
    "XLM",
    "HYPE",
    "LINK",
    "APE",
    "ZEC",
    "ARB",
    "UNI",
    "AAVE",
    "GMX",
    "JTO",
    "ENA",
    "JUP",
    "PYTH",
    "KMNO",
    "BONK",
    "PEPE",
    "SHIB",
    "BOME",
    "WIF",
    "FARTCOIN",
    "TRUMP",
    "MELANIA",
    "PUMP",
    "PENGU",
    "TAO",
    "WLD",
    "TSLA",
    "NVDA",
    "AAPL",
    "AMD",
    "AMZN",
    "SPY",
    "XAU",
    "XAG",
    "WTI",
  ]);
  const marketOrder = [
    "BTC",
    "ETH",
    "SOL",
    "HYPE",
    "ZEC",
    "BONK",
    "PEPE",
    "WIF",
    "FARTCOIN",
    "PUMP",
    "PENGU",
    "TAO",
    "WLD",
    "JUP",
    "TRUMP",
    "BNB",
    "XRP",
    "TON",
    "DOGE",
    "SUI",
    "ADA",
    "LTC",
    "BCH",
    "AVAX",
    "DOT",
    "TRX",
    "NEAR",
    "XLM",
    "LINK",
    "APE",
    "PYTH",
    "JTO",
    "KMNO",
    "ENA",
    "AAVE",
    "UNI",
    "ARB",
    "GMX",
    "BOME",
    "SHIB",
    "MELANIA",
    "TSLA",
    "NVDA",
    "AAPL",
    "AMD",
    "AMZN",
    "SPY",
    "XAU",
    "XAG",
    "WTI",
  ];
  // Hyperliquid quotes some meme markets per 1000 tokens (kBONK, kPEPE, kSHIB, kBOME).
  // Map display symbol → HL feed symbol + scaling factor so we render per-token price.
  const HL_ALIAS: Record<string, { feed: string; scale: number }> = {
    BONK: { feed: "kBONK", scale: 1000 },
    PEPE: { feed: "kPEPE", scale: 1000 },
    SHIB: { feed: "kSHIB", scale: 1000 },
  };
  const pythSnap = usePythSnapshot();
  const topMarkets = marketOrder
    .filter((n) => IMPERIAL_SUPPORTED.has(n))
    .map((n) => {
      const alias = HL_ALIAS[n];
      const feedName = alias?.feed ?? n;
      const scale = alias?.scale ?? 1;
      const live = allMarkets.find((m) => m.name === feedName);
      const pyth = pythSnap[n];
      const markPx = live?.markPx != null ? live.markPx / scale : (pyth?.markPx ?? null);
      const change24h = live?.change24h ?? pyth?.change24h ?? null;
      return {
        name: n,
        displayName: MARKET_DISPLAY_NAMES[n] ?? n,
        markPx,
        change24h,
        supported: true,
      };
    });
  const positions = positionsQuery.data?.positions ?? [];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Header />

      <div className="mx-auto grid w-full max-w-[1400px] flex-1 min-h-0 grid-cols-1 gap-4 px-4 py-4 lg:grid-cols-[260px_minmax(0,1fr)_280px]">
        {/* Left: perp markets */}
        <aside className="hidden min-h-0 lg:flex lg:flex-col">
          <Panel title="markets" live>
            {topMarkets.length === 0 ? (
              <EmptyBlock label="loading…" />
            ) : (
              <ul className="divide-y divide-border">
                {topMarkets.map((m) => (
                  <li key={m.name} className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <MarketIcon name={m.name} size={22} />
                      <div className="font-mono text-[13px] font-bold tracking-wide">
                        {m.displayName}
                      </div>
                    </div>
                    <div className="text-right">
                      {m.markPx != null ? (
                        <>
                          <div className="font-mono text-xs font-bold tabular-nums">
                            $
                            {m.markPx >= 100
                              ? m.markPx.toLocaleString(undefined, { maximumFractionDigits: 0 })
                              : m.markPx >= 1
                                ? m.markPx.toLocaleString(undefined, { maximumFractionDigits: 4 })
                                : m.markPx.toLocaleString(undefined, {
                                    maximumSignificantDigits: 4,
                                  })}
                          </div>
                          {m.change24h != null ? (
                            <div
                              className={`font-mono text-[11px] font-semibold tabular-nums ${m.change24h >= 0 ? "text-primary" : "text-destructive"}`}
                            >
                              {m.change24h >= 0 ? "+" : ""}
                              {m.change24h.toFixed(2)}%
                            </div>
                          ) : (
                            <div className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
                              live
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="h-1 w-8 animate-pulse rounded-full bg-muted" />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>

        {/* Center */}
        <main className="flex min-h-0 min-w-0 flex-col gap-4">
          <section className="relative shrink-0 overflow-hidden border border-border bg-card">
            <video
              src="/hero-bg.mp4"
              autoPlay
              loop
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover opacity-50"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-card via-card/60 to-card/20" />
            <div className="relative px-8 py-6 md:px-10 md:py-7">
              <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                solana · perp backed
              </div>
              <h1 className="font-display mt-2 max-w-xl text-3xl leading-[0.95] text-foreground md:text-[2.5rem]">
                coins with a <em className="text-muted-foreground">heartbeat</em>.
              </h1>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-foreground/80">
                Launch a Solana coin tied to a perp. Each coin runs a leveraged perp treasury that
                auto buys and burns supply on every up tick.
              </p>
            </div>
          </section>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border">
            <div className="flex items-center gap-6">
              {(["all", "trending", "new", "graduated"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`relative py-3 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                    tab === t ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "all" ? "all tokens" : t}
                  {tab === t && (
                    <span className="absolute inset-x-0 -bottom-px h-px bg-foreground" />
                  )}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 pb-2 md:pb-0">
              {[
                { id: "all" as const, label: "all" },
                { id: "perpad" as const, label: "perpad" },
                { id: "pump_fun" as const, label: "pump.fun" },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSourceFilter(f.id)}
                  className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${
                    sourceFilter === f.id
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="hidden shrink-0 grid-cols-[1.6fr_1.2fr_1.4fr_0.8fr] gap-3 px-4 pb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground md:grid">
            <div>coin</div>
            <div>underlying</div>
            <div>graduation</div>
            <div className="text-right">mcap</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border border-border bg-card">
            {(() => {
              let filteredTokens = tokens.filter((t) => {
                if (t.externalMint && HIDDEN_EXTERNAL_MINTS.has(t.externalMint)) return false;
                if (sourceFilter === "all") return true;
                if (sourceFilter === "perpad") return t.source !== "external";
                if (sourceFilter === "pump_fun")
                  return t.source === "external" && t.externalPlatform === "pump_fun";
                return true;
              });
              const featuredRank = (t: typeof filteredTokens[number]) =>
                t.externalMint && FEATURED_EXTERNAL_MINTS.has(t.externalMint) ? 1 : 0;
              if (tab === "all") {
                filteredTokens = [...filteredTokens].sort((a, b) => {
                  const aMain = a.ticker.toUpperCase() === PINNED_TOP_TICKER ? 1 : 0;
                  const bMain = b.ticker.toUpperCase() === PINNED_TOP_TICKER ? 1 : 0;
                  if (aMain !== bMain) return bMain - aMain;
                  const aFeat = featuredRank(a);
                  const bFeat = featuredRank(b);
                  if (aFeat !== bFeat) return bFeat - aFeat;
                  const aPinned =
                    (a.externalMint && ALWAYS_VISIBLE_EXTERNAL_MINTS.has(a.externalMint)) ||
                    ALWAYS_VISIBLE_TICKERS.has(a.ticker.toUpperCase())
                      ? 1
                      : 0;
                  const bPinned =
                    (b.externalMint && ALWAYS_VISIBLE_EXTERNAL_MINTS.has(b.externalMint)) ||
                    ALWAYS_VISIBLE_TICKERS.has(b.ticker.toUpperCase())
                      ? 1
                      : 0;
                  if (aPinned !== bPinned) return bPinned - aPinned;
                  const mcapDiff = (b.marketCap ?? 0) - (a.marketCap ?? 0);
                  if (mcapDiff !== 0) return mcapDiff;
                  // Stable tiebreaker: newer first. Without this, every
                  // freshly-routed external floors to the same mcap and
                  // shuffles in/out of the top-15 slice on each refetch.
                  const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                  const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                  return bt - at;
                });
              } else {
                filteredTokens = [...filteredTokens].sort((a, b) => {
                  const aMain = a.ticker.toUpperCase() === PINNED_TOP_TICKER ? 1 : 0;
                  const bMain = b.ticker.toUpperCase() === PINNED_TOP_TICKER ? 1 : 0;
                  if (aMain !== bMain) return bMain - aMain;
                  return featuredRank(b) - featuredRank(a);
                });
              }
              const visibleLimit = tab === "all" ? 20 : 15;
              filteredTokens = filteredTokens.slice(0, visibleLimit);
              if (tokensQuery.isLoading) {
                return (
                  <div className="flex min-h-[200px] items-center justify-center font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                    loading live tokens…
                  </div>
                );
              }
              if (filteredTokens.length === 0) {
                return (
                  <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                    <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                      {sourceFilter === "pump_fun"
                        ? "no pump.fun coins routed yet"
                        : sourceFilter === "perpad"
                          ? "no perpad coins yet"
                          : "no coins yet"}
                    </div>
                    <p className="max-w-xs text-sm text-muted-foreground">
                      Be first. The first coin on perpad lives forever in the history.
                    </p>
                    <Link
                      to="/launch"
                      className="mt-2 border border-foreground px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-foreground hover:text-background"
                    >
                      launch the first
                    </Link>
                  </div>
                );
              }
              return (
                <>
                  <ul className="divide-y divide-border">
                    {filteredTokens.map((t) => {
                      const isFeatured = !!(t.externalMint && FEATURED_EXTERNAL_MINTS.has(t.externalMint));
                      return (
                      <li key={t.id}>
                        <Link
                          to="/token/$id"
                          params={{ id: t.id }}
                          className={`grid grid-cols-[1fr_auto] gap-3 px-4 py-3 transition-colors hover:bg-secondary/40 md:grid-cols-[1.6fr_1.2fr_1.4fr_0.8fr] md:items-center ${
                            isFeatured
                              ? "border-l-2 border-l-primary bg-primary/[0.06]"
                              : t.leverage >= 10
                                ? "border-l-2 border-l-destructive bg-destructive/[0.03]"
                                : ""
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {t.imageUrl ? (
                              <img
                                src={t.imageUrl}
                                alt={t.ticker}
                                className={`h-9 w-9 shrink-0 object-cover bg-accent ${
                                  isFeatured ? "ring-1 ring-primary" : t.leverage >= 10 ? "ring-1 ring-destructive" : ""
                                }`}
                                loading="lazy"
                              />
                            ) : (
                              <div
                                className={`flex h-9 w-9 shrink-0 items-center justify-center bg-accent text-[11px] font-semibold text-accent-foreground ${
                                  isFeatured ? "ring-1 ring-primary" : t.leverage >= 10 ? "ring-1 ring-destructive" : ""
                                }`}
                              >
                                {t.ticker.slice(0, 2)}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <div className="truncate text-sm font-semibold">${t.ticker}</div>
                                {isFeatured ? (
                                  <span className="shrink-0 border border-primary/50 bg-primary/15 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-primary">
                                    featured
                                  </span>
                                ) : null}
                                {t.leverage >= 10 ? (
                                  <span className="shrink-0 border border-destructive/50 bg-destructive/10 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-destructive">
                                    degen
                                  </span>
                                ) : null}
                                {t.source === "external" ? (
                                  <span className="shrink-0 border border-green-500/40 bg-green-500/10 px-1 py-0 font-mono text-[9px] uppercase tracking-wider text-green-400">
                                    {t.externalPlatform === "pump_fun" ? "pump.fun" : "routed"}
                                  </span>
                                ) : null}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {t.name}
                              </div>
                            </div>
                          </div>
                          <div className="hidden items-center gap-2 font-mono text-[11px] md:flex">
                            <MarketIcon name={t.underlying} size={18} />
                            <span
                              className={t.leverage >= 10 ? "text-destructive" : "text-foreground"}
                            >
                              {t.leverage}x {t.direction}
                            </span>
                          </div>
                          <div className="hidden md:block">
                            {t.source === "external" ? (
                              <span className="inline-flex items-center gap-1.5 border border-green-500/40 bg-green-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-green-400">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                                FEE ROUTER
                              </span>
                            ) : t.graduated ? (
                              <span className="inline-flex items-center gap-1.5 border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
                                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                                GRADUATED
                              </span>
                            ) : (
                              <div className="flex items-center gap-2">
                                <Progress
                                  value={t.graduationProgress * 100}
                                  className="h-1 flex-1"
                                />
                                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                  {Math.round(t.graduationProgress * 100)}%
                                </span>
                              </div>
                            )}
                          </div>

                          <div className="text-right font-mono text-xs tabular-nums">
                            {formatUsd(t.marketCap)}
                          </div>
                        </Link>
                      </li>
                      );
                    })}
                  </ul>
                  <Link
                    to="/tokens"
                    className="flex items-center justify-center border-t border-border px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
                  >
                    view more →
                  </Link>
                </>
              );
            })()}
          </div>
        </main>

        {/* Right: open perp positions */}
        <aside className="hidden min-h-0 lg:flex lg:flex-col">
          <Panel title="open perp positions" live>
            {positions.length === 0 ? (
              <EmptyBlock label="no open positions" />
            ) : (
              <ul className="divide-y divide-border">
                {positions.map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/token/$id"
                      params={{ id: p.id }}
                      className="block px-4 py-2.5 transition-colors hover:bg-secondary/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <MarketIcon name={p.underlying} size={16} />
                          <span className="font-mono text-[11px] font-bold">${p.ticker}</span>
                          <span
                            className={`font-mono text-[10px] uppercase tracking-[0.18em] ${p.direction === "long" ? "text-primary" : "text-destructive"}`}
                          >
                            {p.leverage}x {p.direction}
                          </span>
                        </div>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {p.openedAt
                            ? formatDistanceToNowStrict(new Date(p.openedAt), { addSuffix: false })
                            : ""}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between font-mono text-[11px]">
                        <span className="text-muted-foreground tabular-nums">
                          {formatUsd(p.sizeUsd)}
                        </span>
                        <span
                          className={`tabular-nums ${p.pnlUsd >= 0 ? "text-primary" : "text-destructive"}`}
                        >
                          {p.pnlUsd >= 0 ? "+" : ""}
                          {formatUsd(p.pnlUsd)} ({p.pnlPct >= 0 ? "+" : ""}
                          {p.pnlPct.toFixed(2)}%)
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>

      <FooterLine
        buybackSol={statsQuery.data?.buybackSol ?? 0}
        volumeSol={statsQuery.data?.volumeSol ?? 0}
        solUsd={pythSnap["SOL"]?.markPx ?? null}
      />
    </div>
  );
}

function FooterLine({
  buybackSol,
  volumeSol,
  solUsd,
}: {
  buybackSol: number;
  volumeSol: number;
  solUsd: number | null;
}) {
  const buybackUsd = solUsd ? buybackSol * solUsd : null;
  const volumeUsd = solUsd ? volumeSol * solUsd : null;
  const fmt = (n: number | null) =>
    n == null ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return (
    <footer className="shrink-0 border-t border-border/60 bg-background">
      <div className="mx-auto flex h-10 max-w-[1400px] flex-wrap items-center justify-between gap-x-6 px-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <span className="hidden sm:inline">perpad · solana · perps</span>
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground/70">bought back</span>
            <span className="font-bold tabular-nums text-foreground">{fmt(buybackUsd)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground/70">total volume</span>
            <span className="font-bold tabular-nums text-foreground">{fmt(volumeUsd)}</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="https://x.com/perpadfun"
            target="_blank"
            rel="noreferrer"
            aria-label="x"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M18.244 2H21l-6.52 7.45L22 22h-6.797l-4.74-6.19L4.8 22H2.04l6.974-7.97L2 2h6.93l4.286 5.66L18.244 2Zm-1.193 18.4h1.88L7.06 3.5H5.06l11.99 16.9Z" />
            </svg>
          </a>
          <a
            href="https://github.com/tekPioneered/perpad"
            target="_blank"
            rel="noreferrer"
            aria-label="github"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.97 3.22 9.18 7.69 10.67.56.1.77-.24.77-.54 0-.27-.01-1.16-.02-2.1-3.13.68-3.79-1.34-3.79-1.34-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.11 1.16.9-.25 1.86-.38 2.82-.38.96 0 1.92.13 2.82.38 2.15-1.46 3.1-1.16 3.1-1.16.62 1.55.23 2.7.12 2.98.72.79 1.16 1.8 1.16 3.03 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.04.76 2.1 0 1.52-.01 2.75-.01 3.12 0 .3.2.65.78.54 4.46-1.49 7.68-5.7 7.68-10.67C23.25 5.48 18.27.5 12 .5Z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}

function Panel({
  title,
  live,
  children,
}: {
  title: string;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border border-border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </span>
        {live && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> live
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="flex h-48 items-center justify-center font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
      {label}
    </div>
  );
}
