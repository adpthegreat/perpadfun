import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPerpMarkets } from "@/lib/perps.functions";
import { useWallet } from "@/lib/wallet/WalletContext";
import { toast } from "sonner";
import { MarketIcon } from "@/lib/market-icons";
import { supabase } from "@/integrations/supabase/client";
import { useMeteoraLaunch } from "@/hooks/useMeteoraLaunch";
import { BASE_LEVERAGES, DEGEN_LEVERAGES, maxLeverageFor, MARKET_DISPLAY_NAMES, isMarketUnavailable, isSupportedMarket, launchableMarketsInOrder, priceFeedSymbol } from "@/lib/imperial-markets";
import { usePythSnapshot, formatUsdPrice } from "@/hooks/usePythPrices";

export const Route = createFileRoute("/launch")({
  component: LaunchPage,
  head: () => ({
    meta: [
      { title: "Create a coin · perpad" },
      { name: "description", content: "Pick a perp, choose direction and leverage, and launch a Solana token whose reserve mirrors that perp." },
    ],
  }),
});

function LaunchPage() {
  const navigate = useNavigate();
  const { wallet } = useWallet();
  const getPerpFn = useServerFn(getPerpMarkets);
  const { launch, status: launchStatus } = useMeteoraLaunch();
  const isAllowed = wallet?.chain === "solana";

  const marketsQuery = useQuery({
    queryKey: ["perp-markets"],
    queryFn: () => getPerpFn(),
    refetchInterval: 20000,
  });

  const markets = marketsQuery.data?.markets ?? [];
  // Source the picker straight from the Phoenix routing whitelist
  // (SUPPORTED_MARKETS, mirrored in imperial-markets.ts). This guarantees the UI
  // only offers markets the keeper can actually open, and uses the Phoenix
  // symbols (GOLD/SILVER/OIL) rather than the price-feed tickers (XAU/XAG/WTI).
  const marketOrder = launchableMarketsInOrder();
  const pythSnap = usePythSnapshot();
  const top = marketOrder.map((n) => {
    // Live mids are keyed by the price-feed symbol, which differs for metals/oil.
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

  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [twitterUrl, setTwitterUrl] = useState("");
  const [underlying, setUnderlying] = useState("BTC");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [leverage, setLeverage] = useState<number>(3);
  const [degenMode, setDegenMode] = useState(false);
  const [initialBuySol, setInitialBuySol] = useState<string>("0.1");
  const [submitting, setSubmitting] = useState(false);
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [uploading, setUploading] = useState(false);

  const currentMid = markets.find((m) => m.name === priceFeedSymbol(underlying))?.markPx ?? pythSnap[priceFeedSymbol(underlying)]?.markPx;
  const maxLev = maxLeverageFor(underlying);
  const baseOpts = BASE_LEVERAGES.filter((l) => l <= maxLev);
  const degenOpts = DEGEN_LEVERAGES.filter((l) => l <= maxLev);
  // Snap leverage down when switching to a venue with a lower cap.
  useEffect(() => {
    if (maxLev > 0 && leverage > maxLev) {
      const fallback = [...degenOpts, ...baseOpts].reverse().find((l) => l <= maxLev) ?? 2;
      setLeverage(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, maxLev]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet) {
      toast.error("Connect a wallet first");
      return;
    }
    if (wallet.chain !== "solana") {
      toast.error("Use a Solana wallet (Phantom/Solflare)");
      return;
    }
    if (isMarketUnavailable(underlying)) {
      toast.error(`${underlying} is unavailable right now. Pick another market.`);
      return;
    }
    if (!imageUrl) {
      toast.error("Upload a coin image");
      return;
    }
    const buySol = parseFloat(initialBuySol);
    if (!Number.isFinite(buySol) || buySol < 0.1 || buySol > 5) {
      toast.error("Initial buy must be between 0.1 and 5 SOL");
      return;
    }
    setSubmitting(true);
    try {
      toast.message("Approve the launch transactions in your wallet.");
      const res = await launch({
        ticker,
        name,
        description: description || undefined,
        imageUrl: imageUrl || undefined,
        websiteUrl: websiteUrl.trim() || undefined,
        twitterUrl: twitterUrl.trim() || undefined,
        underlying,
        leverage,
        direction,
        creatorAddress: wallet.address,
        initialBuySol: buySol,
      });
      toast.success(`$${ticker} is live on Solana`);
      navigate({ to: "/token/$id", params: { id: res.tokenId } });
    } catch (err: any) {
      toast.error(err?.message ?? "Launch failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Per-token perp isolation is live. Each new token derives its own sub-wallet
  // and opens an isolated Jupiter position. Launches re-enabled.
  const LAUNCHES_PAUSED = false;
  if (LAUNCHES_PAUSED) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight">Launches paused</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            New coin launches are temporarily disabled while we ship per-token perp position isolation. Existing tokens, trading, buybacks, and burns continue to run as normal.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Follow along on the home page. We will re-enable launches as soon as the upgrade is live.
          </p>
          <div className="mt-8">
            <Link to="/">
              <Button variant="outline">Back to home</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }



  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-10">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">← Back</Link>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Create a coin</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Launches on Solana via Meteora's bonding curve, quoted in SOL. Your reserve powers a leveraged perp tied to the market you pick, so the coin price tracks it 24/7. Starts around $3k market cap and graduates to Meteora DAMM near $40k.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-8 border border-border bg-card p-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ticker">Ticker</Label>
              <Input
                id="ticker"
                required
                maxLength={10}
                minLength={2}
                pattern="[A-Z0-9]+"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                placeholder="PERPAD"
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} placeholder="Perpad" className="mt-1.5" />
            </div>
          </div>

          <div>
            <Label htmlFor="desc">Description</Label>
            <Textarea id="desc" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this coin about?" className="mt-1.5" rows={3} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="website">Website <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                id="website"
                type="url"
                maxLength={300}
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://yourcoin.xyz"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="twitter">X / Twitter <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                id="twitter"
                type="url"
                maxLength={300}
                value={twitterUrl}
                onChange={(e) => setTwitterUrl(e.target.value)}
                placeholder="https://x.com/yourcoin"
                className="mt-1.5"
              />
            </div>
          </div>

          <div>
            <Label>Coin image</Label>
            <div className="mt-1.5 flex items-center gap-4">
              <label className="group relative flex h-20 w-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden border border-dashed border-border bg-secondary/30 hover:border-foreground/40">
                {imageUrl ? (
                  <img src={imageUrl} alt="coin" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-center font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                    {uploading ? "uploading…" : "upload"}
                  </span>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 5 * 1024 * 1024) {
                      toast.error("Image must be under 5MB");
                      return;
                    }
                    setUploading(true);
                    const ext = file.name.split(".").pop() ?? "png";
                    const path = `${crypto.randomUUID()}.${ext}`;
                    const { error } = await supabase.storage.from("token-images").upload(path, file, { contentType: file.type });
                    if (error) {
                      toast.error("Upload failed");
                      setUploading(false);
                      return;
                    }
                    const { data } = supabase.storage.from("token-images").getPublicUrl(path);
                    setImageUrl(data.publicUrl);
                    setUploading(false);
                  }}
                />
              </label>
              <div className="text-xs text-muted-foreground">
                {imageUrl ? (
                  <button type="button" onClick={() => setImageUrl("")} className="underline hover:text-foreground">
                    remove
                  </button>
                ) : (
                  "PNG, JPG, or GIF. Up to 5MB."
                )}
              </div>
            </div>
          </div>

          <div>
            <Label>Underlying perp</Label>
            <p className="mt-1 text-xs text-muted-foreground">Live mid prices.</p>
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

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <Label>Direction</Label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(["long", "short"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`border py-2.5 text-sm font-medium capitalize transition-all ${
                      direction === d ? "border-foreground bg-accent" : "border-border hover:border-foreground/40"
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
                    {degenMode ? "Degen mode: ON" : "Degen mode"}
                  </button>
                )}
              </div>
              {baseOpts.length === 0 && degenOpts.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Pick a perp first to see available leverage.
                </p>
              ) : baseOpts.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  This market's venue caps below 2x. Enable Degen mode to see higher options, or pick a different perp.
                </p>
              ) : (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {baseOpts.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLeverage(l)}
                      className={`border py-2.5 text-sm font-medium transition-all ${
                        leverage === l ? "border-foreground bg-accent" : "border-border hover:border-foreground/40"
                      }`}
                    >
                      {l}x
                    </button>
                  ))}
                </div>
              )}
              {degenMode && degenOpts.length > 0 && (
                <>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {degenOpts.map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLeverage(l)}
                        className={`border py-2.5 text-sm font-medium transition-all ${
                          leverage === l
                            ? "border-destructive bg-destructive/10 text-destructive"
                            : "border-border hover:border-destructive/50"
                        }`}
                      >
                        {l}x
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                    {underlying} routes through Phoenix with a venue cap of {maxLev}x. Only leverages at or below the cap are shown.
                  </p>
                </>
              )}
            </div>
          </div>



          <div>
            <Label htmlFor="initialBuy">Initial buy (SOL)</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Your dev buy on launch. Min 0.1, max 5 SOL. Seeds the curve and gives you the first bag.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                id="initialBuy"
                type="number"
                min={0.1}
                max={5}
                step={0.1}
                required
                value={initialBuySol}
                onChange={(e) => setInitialBuySol(e.target.value)}
                className="font-mono"
              />
              <div className="flex gap-1">
                {["0.1", "0.5", "1", "2", "5"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setInitialBuySol(v)}
                    className={`border px-2.5 py-2 font-mono text-[11px] transition-all ${
                      initialBuySol === v ? "border-foreground bg-accent" : "border-border hover:border-foreground/40"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border border-border bg-secondary/40 p-4">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Summary
            </div>
            <div className="mt-2 font-mono text-sm">
              ${ticker || "TICKER"} / {leverage}x {direction} {underlying}
              {currentMid && ` @ ${formatUsdPrice(currentMid)}`}
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              Dev buy: {initialBuySol || "0"} SOL
            </div>
          </div>


          <Button type="submit" size="lg" className="w-full rounded-none" disabled={submitting || !wallet || !isAllowed}>
            {submitting
              ? launchStatus === "awaiting-signature"
                ? "Awaiting wallet…"
                : launchStatus === "sending-prefund"
                  ? "Sending funds to treasury…"
                  : launchStatus === "confirming-prefund"
                    ? "Confirming transfer…"
                    : launchStatus === "launching"
                      ? "Treasury deploying pool…"
                      : "Preparing…"
              : !wallet
                ? "Connect wallet to deploy"
                : <>Deploy coin <ArrowRight className="ml-1 h-4 w-4" /></>}
          </Button>
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Creator pays 0.02 SOL launch fee + ~0.012 SOL mint and ATA rent + your initial buy. Supply locked at 1B.
          </p>
        </form>
      </div>
    </div>
  );
}
