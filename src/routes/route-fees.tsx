import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPerpMarkets } from "@/lib/perps.functions";
import { createExternalRouter, reserveExternalRouter, linkMintByAddress } from "@/lib/external-router.functions";
import { toast } from "sonner";
import { ArrowRight, Copy, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { MarketIcon } from "@/lib/market-icons";
import { HowItWorksButton } from "@/components/HowItWorksButton";
import { BASE_LEVERAGES, DEGEN_LEVERAGES, maxLeverageFor, MARKET_DISPLAY_NAMES, isMarketUnavailable, isSupportedMarket, launchableMarketsInOrder, priceFeedSymbol } from "@/lib/imperial-markets";
import { usePythSnapshot, formatUsdPrice } from "@/hooks/usePythPrices";

export const Route = createFileRoute("/route-fees")({
  component: RouteFeesPage,
  head: () => ({
    meta: [
      { title: "Route fees · perpad" },
      {
        name: "description",
        content:
          "Generate a one-use sub-wallet and route any token's creator fees into a backing perp, buyback and burn, and treasury reserve.",
      },
      { property: "og:title", content: "Route fees · perpad" },
      {
        property: "og:description",
        content:
          "Point your pump.fun creator fees at a perpad sub-wallet. We open a backing perp, buy and burn your token, and hold treasury runway.",
      },
    ],
  }),
});

type Mode = "existing" | "preroute";

type CreateResult = {
  ok: true;
  tokenId: string;
  address: string;
  claimToken: string;
  mode: Mode;
} | null;

function RouteFeesPage() {
  const getPerpFn = useServerFn(getPerpMarkets);
  const createFn = useServerFn(createExternalRouter);
  const reserveFn = useServerFn(reserveExternalRouter);
  const linkFn = useServerFn(linkMintByAddress);

  const marketsQuery = useQuery({
    queryKey: ["perp-markets"],
    queryFn: () => getPerpFn(),
    refetchInterval: 15000,
  });
  const markets = marketsQuery.data?.markets ?? [];
  // Source the picker straight from the Phoenix routing whitelist
  // (SUPPORTED_MARKETS, mirrored in imperial-markets.ts) so it only offers
  // markets the keeper can open, using Phoenix symbols (GOLD/SILVER/OIL) not the
  // price-feed tickers (XAU/XAG/WTI).
  const marketOrder = launchableMarketsInOrder();
  const pythSnap = usePythSnapshot();
  const top = marketOrder.map((n) => {
    const feed = priceFeedSymbol(n);
    const live = markets.find((m) => m.name === feed);
    const pyth = pythSnap[feed];
    const markPx = live?.markPx ?? pyth?.markPx ?? null;
    const change24h = live?.change24h ?? pyth?.change24h ?? null;
    return {
      name: n,
      displayName: MARKET_DISPLAY_NAMES[n] ?? n,
      maxLeverage: maxLeverageFor(n),
      markPx,
      change24h,
      supported: isSupportedMarket(n),
      unavailable: isMarketUnavailable(n),
    };
  });


  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [mode, setMode] = useState<Mode>("existing");
  const [externalMint, setExternalMint] = useState("");
  const [linkMint, setLinkMint] = useState("");
  const [underlying, setUnderlying] = useState("BTC");
  const [leverage, setLeverage] = useState<number>(2);
  const [degenMode, setDegenMode] = useState(false);
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult>(null);
  const [showLinkStep, setShowLinkStep] = useState(false);
  const [linkingSubmitting, setLinkingSubmitting] = useState(false);

  const maxLev = maxLeverageFor(underlying);
  const baseOpts = BASE_LEVERAGES.filter((l) => l <= maxLev);
  const degenOpts = DEGEN_LEVERAGES.filter((l) => l <= maxLev);
  useEffect(() => {
    if (maxLev > 0 && leverage > maxLev) {
      const fallback = [...degenOpts, ...baseOpts].reverse().find((l) => l <= maxLev) ?? 2;
      setLeverage(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, maxLev]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isMarketUnavailable(underlying)) {
      toast.error(`${underlying} is unavailable right now. Pick another market.`);
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "existing") {
        const r = await createFn({
          data: {
            externalMint: externalMint.trim(),
            externalPlatform: "pump_fun",
            underlying,
            leverage,
            direction,
          },
        });
        if (!r.ok) {
          toast.error(r.error ?? "Failed to create router");
          return;
        }
        setResult({ ok: true, tokenId: r.tokenId!, address: r.address!, claimToken: r.claimToken!, mode });
        toast.success("Sub-wallet generated.");
      } else {
        const r = await reserveFn({
          data: {
            externalPlatform: "pump_fun",
            underlying,
            leverage,
            direction,
          },
        });
        if (!r.ok) {
          toast.error(r.error ?? "Failed to reserve sub-wallet");
          return;
        }
        setResult({ ok: true, tokenId: r.tokenId!, address: r.address!, claimToken: r.claimToken!, mode });
        toast.success("Sub-wallet reserved. Paste it into pump.fun, then come back to link your mint.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  async function onLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!result) return;
    setLinkingSubmitting(true);
    try {
      const r = await linkFn({
        data: {
          subWalletAddress: result.address,
          externalMint: linkMint.trim(),
        },
      });
      if (!r.ok) {
        toast.error(r.error ?? "Failed to link mint");
        return;
      }
      toast.success(r.alreadyLinked ? "Mint was already linked." : "Mint linked. Buyback+burn is live.");
      window.location.href = `/route-fees/${r.claimToken}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLinkingSubmitting(false);
    }
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="container mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3 w-3" /> No wallet connect required
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">Route fees to a perpad sub-wallet</h1>
            <HowItWorksButton />
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Generate a fresh, one-use sub-wallet. Set it as the creator-fee receiver on your pump.fun
            token. Every fee that lands is split 50% backing perp, 25% buyback and burn, 25% treasury
            runway. Only perpad can move funds out.
          </p>
          <p className="mt-2 max-w-2xl text-sm font-medium text-amber-600 dark:text-amber-400">
            Your token needs to generate at least $100 in fees (with perpad as the sole fee receiver) before automation kicks in.
          </p>
        </div>

        {!result ? (
          <form onSubmit={onSubmit} className="space-y-6 rounded-2xl border border-border bg-card p-6">
            <div>
              <Label>I want to</Label>
              <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setMode("existing")}
                  className={`rounded-md border px-4 py-3 text-left transition ${
                    mode === "existing"
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  <div className="text-sm font-medium">Route existing coin</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">My pump.fun token already exists.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("preroute")}
                  className={`rounded-md border px-4 py-3 text-left transition ${
                    mode === "preroute"
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Sparkles className="h-3.5 w-3.5 text-primary" /> Pre-route new launch
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">I haven't created my coin yet.</div>
                </button>
              </div>
            </div>

            {mode === "existing" ? (
              <div>
                <Label htmlFor="mint">Token mint address</Label>
                <Input
                  id="mint"
                  required
                  placeholder="e.g. 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
                  value={externalMint}
                  onChange={(e) => setExternalMint(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            ) : (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
                <div className="font-medium text-foreground">No mint needed yet.</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  We'll generate a sub-wallet now. Paste it into pump.fun's "fee receiver" field at launch.
                  Once your coin is live, hit "I set the sub-wallet as sole creator fee receiver" on the next screen and drop in the fresh mint. Done.
                </p>
              </div>
            )}

            {(
              <div className="space-y-3 border-t border-border pt-5">
                <div>
                  <Label>Backing perp</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Live mid prices. Pick any market to back your token.</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {marketsQuery.isLoading ? (
                      Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="h-16 animate-pulse border border-border bg-secondary/30" />
                      ))
                    ) : (
                      <>
                        {(showAllMarkets ? top : top.slice(0, 12)).map((m) => {
                          const unlocked = m.supported && !m.unavailable;
                          const label = m.unavailable ? "UNAVAILABLE" : (!m.supported ? "SOON" : null);
                          const title = m.unavailable
                            ? "Unavailable: venue not yet supported by the keeper."
                            : !m.supported
                            ? "Not on Phoenix yet. Coming soon."
                            : undefined;
                          return (
                            <button
                              key={m.name}
                              type="button"
                              disabled={!unlocked}
                              onClick={() => unlocked && setUnderlying(m.name)}
                              title={title}
                              className={`relative border px-3 py-2.5 text-left transition-all ${
                                !unlocked
                                  ? "cursor-not-allowed border-border/50 opacity-50"
                                  : underlying === m.name
                                  ? "border-foreground bg-accent"
                                  : "border-border hover:border-foreground/40"
                              }`}
                            >
                              <div className="flex items-center gap-1.5">
                                <MarketIcon name={m.name} size={16} />
                                <div className="font-mono text-sm font-semibold">{m.displayName}</div>
                                {label ? (
                                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">{label}</span>
                                ) : (
                                  <span
                                    className="ml-auto rounded-sm bg-amber-400/15 px-1 py-0.5 font-mono text-[9px] font-semibold text-amber-500"
                                    title={`Max leverage ${m.maxLeverage}x on Phoenix`}
                                  >
                                    {m.maxLeverage}x
                                  </span>
                                )}
                              </div>


                              {m.markPx != null ? (
                                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                  {formatUsdPrice(m.markPx)}
                                </div>
                              ) : (
                                <div className="font-mono text-[10px] tabular-nums text-muted-foreground/60 animate-pulse">loading.</div>
                              )}
                              {m.change24h != null ? (
                                <div className={`font-mono text-[10px] tabular-nums ${m.change24h >= 0 ? "text-primary" : "text-destructive"}`}>
                                  {m.change24h >= 0 ? "+" : ""}{m.change24h.toFixed(1)}%
                                </div>
                              ) : (
                                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">&nbsp;</div>
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                  {top.length > 12 && (
                    <button
                      type="button"
                      onClick={() => setShowAllMarkets((s) => !s)}
                      className="mt-3 w-full border border-border py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                    >
                      {showAllMarkets ? "View less" : `View more (${top.length - 12})`}
                    </button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Direction</Label>
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      {(["long", "short"] as const).map((d) => (
                        <button
                          type="button"
                          key={d}
                          onClick={() => setDirection(d)}
                          className={`rounded-md border px-3 py-2 text-sm uppercase transition ${
                            direction === d
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <Label>Leverage</Label>
                      {degenOpts.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = !degenMode;
                            setDegenMode(next);
                            if (!next && leverage > 5) setLeverage(5);
                          }}
                          className={`text-xs font-medium uppercase tracking-wide transition ${
                            degenMode ? "text-destructive" : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {degenMode ? "Degen: ON" : "Degen mode"}
                        </button>
                      )}
                    </div>
                    {baseOpts.length === 0 && degenOpts.length === 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Pick a perp first to see available leverage.
                      </p>
                    ) : baseOpts.length === 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        This market's venue caps below 2x. Enable Degen mode or pick another perp.
                      </p>
                    ) : (
                      <div className="mt-1.5 grid grid-cols-3 gap-2">
                        {baseOpts.map((l) => (
                          <button
                            type="button"
                            key={l}
                            onClick={() => setLeverage(l)}
                            className={`rounded-md border px-3 py-2 text-sm transition ${
                              leverage === l
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {l}x
                          </button>
                        ))}
                      </div>
                    )}
                    {degenMode && degenOpts.length > 0 && (
                      <>
                        <div className="mt-2 grid grid-cols-4 gap-2">
                          {degenOpts.map((l) => (
                            <button
                              type="button"
                              key={l}
                              onClick={() => setLeverage(l)}
                              className={`rounded-md border px-3 py-2 text-sm transition ${
                                leverage === l
                                  ? "border-destructive bg-destructive/10 text-destructive"
                                  : "border-border text-muted-foreground hover:text-destructive"
                              }`}
                            >
                              {l}x
                            </button>
                          ))}
                        </div>
                        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                          {underlying} caps at {maxLev}x on Phoenix. Only allowed leverages are shown.
                        </p>
                      </>
                    )}
                  </div>


                </div>
              </div>
            )}

            <Button type="submit" disabled={submitting} className="w-full" size="lg">
              {submitting
                ? mode === "preroute" ? "Reserving…" : "Generating…"
                : mode === "preroute" ? "Reserve sub-wallet" : "Generate sub-wallet"}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              The sub-wallet is one-use and derived per-router. No two tokens share a wallet, ever.
            </p>
          </form>
        ) : (
          <div className="space-y-5 rounded-2xl border border-border bg-card p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">
                  {result.mode === "preroute" ? "Sub-wallet reserved" : "Sub-wallet ready"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {result.mode === "preroute"
                    ? "Paste this address into pump.fun's fee-receiver field at launch. Once your coin is live, link the mint right here."
                    : "Paste this address into pump.fun as your token's creator-fee receiver. Fees auto-route the moment they arrive."}
                </p>
              </div>
            </div>

            <Field label="Sub-wallet address (Solana)" value={result.address} mono onCopy={() => copy(result.address, "Address")} />

            {result.mode === "preroute" ? (
              <>
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <div className="text-sm font-medium text-foreground">Next steps</div>
                  <ol className="mt-2 list-decimal pl-5 text-sm text-muted-foreground space-y-1">
                    <li>Go to pump.fun and start your launch.</li>
                    <li>Paste the address above into the "Fee receiver" field.</li>
                    <li>Launch your coin.</li>
                    <li>Hit the button below and paste your fresh mint to activate buyback+burn.</li>
                  </ol>
                </div>

                {!showLinkStep ? (
                  <Button onClick={() => setShowLinkStep(true)} className="w-full" size="lg">
                    I set the sub-wallet as sole creator fee receiver
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                ) : (
                  <form onSubmit={onLinkSubmit} className="space-y-3 rounded-lg border border-border bg-background/40 p-4">
                    <div>
                      <Label htmlFor="link-mint">Your launched mint address</Label>
                      <Input
                        id="link-mint"
                        required
                        autoFocus
                        placeholder="The mint pump.fun just gave you"
                        value={linkMint}
                        onChange={(e) => setLinkMint(e.target.value)}
                        className="font-mono text-xs"
                      />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        We'll bind it to your reserved sub-wallet and activate buyback+burn. Backing perp, direction, and leverage stay as you set them.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button type="submit" disabled={linkingSubmitting} className="flex-1">
                        {linkingSubmitting ? "Linking..." : "Link mint and go live"}
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setShowLinkStep(false)}>
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  Next step on pump.fun
                </div>
                <ol className="mt-2 list-decimal pl-5 text-sm text-muted-foreground space-y-1">
                  <li>Edit your token.</li>
                  <li>Paste the address above into the "Creator fee receiver" field.</li>
                  <li>Save. All future creator fees land here automatically.</li>
                </ol>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  onCopy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        <code
          className={`flex-1 break-all rounded bg-background px-3 py-2 text-xs ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
        <Button size="sm" variant="outline" onClick={onCopy}>
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
