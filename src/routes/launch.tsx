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
import { verifyQuoteToken, type VerifiedQuoteToken } from "@/lib/launch/verifyQuoteToken.functions";
import { useWallet as useSolanaAdapterWallet, useConnection } from "@solana/wallet-adapter-react";
import { QUOTE_TOKENS } from "@/lib/launch/config-builder";
import {
  planSwapForTarget,
  executeSwap,
  quoteTokenBalanceRaw,
  type SwapPlan,
} from "@/lib/launch/quoteSwap";

// Client-side pre-check so obviously bad input never round-trips to the server.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
function isLikelySolanaAddress(s: string): boolean {
  const t = s.trim();
  return t.length >= 32 && t.length <= 44 && BASE58_RE.test(t);
}
import {
  BASE_LEVERAGES,
  DEGEN_LEVERAGES,
  maxLeverageFor,
  MARKET_DISPLAY_NAMES,
  isMarketUnavailable,
  isSupportedMarket,
  launchableMarketsInOrder,
  priceFeedSymbol,
} from "@/lib/imperial-markets";
import { usePythSnapshot, formatUsdPrice } from "@/hooks/usePythPrices";

export const Route = createFileRoute("/launch")({
  component: LaunchPage,
  head: () => ({
    meta: [
      { title: "Create a coin · perpspad" },
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
  const [quote, setQuote] = useState<"SOL" | "USDC" | "ANSEM" | "UWU" | "CUSTOM">("SOL");
  const verifyFn = useServerFn(verifyQuoteToken);
  const [customMint, setCustomMint] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifiedQuoteToken | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  async function verifyCustom() {
    setVerifyErr(null);
    setVerified(null);
    const mint = customMint.trim();
    if (!isLikelySolanaAddress(mint)) {
      setVerifyErr("Enter a valid Solana mint address.");
      return;
    }
    setVerifying(true);
    try {
      const res = await verifyFn({ data: { mint } });
      if (res.ok) setVerified(res);
      else setVerifyErr(res.error);
    } catch (e) {
      setVerifyErr(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }
  const [leverage, setLeverage] = useState<number>(3);
  const [degenMode, setDegenMode] = useState(false);
  const [initialBuySol, setInitialBuySol] = useState<string>("0.1");
  const [submitting, setSubmitting] = useState(false);
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Wallet-adapter primitives for the "acquire the quote token" swap (separate
  // from the app WalletContext, which doesn't expose signTransaction).
  const { publicKey: adapterPk, signTransaction: adapterSign } = useSolanaAdapterWallet();
  const { connection } = useConnection();
  const [quoteBalRaw, setQuoteBalRaw] = useState<number | null>(null);
  const [balNonce, setBalNonce] = useState(0); // bump to re-read balance after a swap
  const [swapping, setSwapping] = useState(false);
  const [swapEst, setSwapEst] = useState<SwapPlan | null>(null);

  // Dev-buy bounds + quick-pick presets per quote token (amounts are in the
  // quote token's own units).
  const BUY_BOUNDS = {
    SOL: { min: 0.1, max: 5, default: "0.1", presets: ["0.1", "0.5", "1", "2", "5"], step: 0.1 },
    USDC: { min: 5, max: 5000, default: "20", presets: ["5", "20", "50", "100", "500"], step: 1 },
    ANSEM: {
      min: 10,
      max: 50000,
      default: "100",
      presets: ["10", "100", "500", "1000", "5000"],
      step: 1,
    },
    UWU: {
      min: 50,
      max: 500000,
      default: "1000",
      presets: ["50", "500", "1000", "10000", "50000"],
      step: 1,
    },
    // Custom token's value is unknown before verify → permissive placeholder;
    // once verified we replace this with a price-derived bound (see activeBounds).
    CUSTOM: { min: 0, max: 1e15, default: "0", presets: ["0"], step: 1 },
  } as const;
  // Effective dev-buy bounds. For CUSTOM we don't know the token's value until
  // it's verified, so we cap the dev buy at the same ~$5,000 USD ceiling as the
  // USDC quote (max units = $5,000 ÷ live price) instead of the placeholder 1e15.
  const activeBounds =
    quote === "CUSTOM" && verified
      ? {
          min: 0,
          max:
            verified.priceUsd > 0 ? Math.max(1, Math.floor(5000 / verified.priceUsd)) : 1_000_000,
          default: "0",
          presets: ["0"] as readonly string[],
          step: 1,
        }
      : BUY_BOUNDS[quote];
  // Unit label shown next to the dev-buy field: the token's symbol for CUSTOM
  // (falls back to "token" pre-verify), otherwise the quick-pick name.
  const quoteUnitLabel = quote === "CUSTOM" ? (verified?.symbol ?? "token") : quote;
  // Switching the quote resets the dev-buy to a valid default for that token.
  const selectQuote = (q: "SOL" | "USDC" | "ANSEM" | "UWU" | "CUSTOM") => {
    setQuote(q);
    setInitialBuySol(BUY_BOUNDS[q].default);
  };

  // Resolved mint/decimals/symbol for the selected NON-SOL quote (null for SOL,
  // which the dev-buy already pays in — no swap needed). CUSTOM resolves from
  // the verified token; presets from the registry.
  const activeQuote =
    quote === "SOL"
      ? null
      : quote === "CUSTOM"
        ? verified
          ? { mint: verified.mint, decimals: verified.decimals, symbol: verified.symbol ?? "token" }
          : null
        : {
            mint: QUOTE_TOKENS[quote].mint,
            decimals: QUOTE_TOKENS[quote].quoteDecimal,
            symbol: QUOTE_TOKENS[quote].label,
          };

  // Read the creator's balance of the selected quote token (program-agnostic).
  useEffect(() => {
    let cancelled = false;
    if (!adapterPk || !activeQuote) {
      setQuoteBalRaw(null);
      return;
    }
    quoteTokenBalanceRaw(connection, adapterPk, activeQuote.mint)
      .then((raw) => !cancelled && setQuoteBalRaw(raw))
      .catch(() => !cancelled && setQuoteBalRaw(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterPk, activeQuote?.mint, balNonce]);

  const devBuyNum = parseFloat(initialBuySol);
  const devBuyRaw =
    activeQuote && Number.isFinite(devBuyNum) && devBuyNum > 0
      ? Math.floor(devBuyNum * 10 ** activeQuote.decimals)
      : 0;
  // Shortfall (in raw units) between the dev-buy and what the wallet holds. Only
  // computed once the balance has loaded, so the swap CTA never flashes.
  const shortfallRaw =
    activeQuote && quoteBalRaw != null ? Math.max(0, devBuyRaw - quoteBalRaw) : 0;

  // Price the shortfall swap so the CTA can show "~N SOL". Debounced so typing
  // in the dev-buy field doesn't spray Jupiter quote requests.
  useEffect(() => {
    if (!activeQuote || shortfallRaw <= 0) {
      setSwapEst(null);
      return;
    }
    let cancelled = false;
    const mint = activeQuote.mint;
    const t = setTimeout(() => {
      planSwapForTarget(mint, shortfallRaw)
        .then((q) => !cancelled && setSwapEst(q))
        .catch(() => !cancelled && setSwapEst(null));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuote?.mint, shortfallRaw]);

  async function acquireQuoteToken() {
    if (!adapterPk || !adapterSign || !activeQuote || shortfallRaw <= 0) return;
    setSwapping(true);
    try {
      const plan = await planSwapForTarget(activeQuote.mint, shortfallRaw);
      if (!plan) throw new Error("No swap route available right now — try again.");
      const sig = await executeSwap({
        connection,
        publicKey: adapterPk,
        signTransaction: adapterSign,
        plan,
      });
      toast.success(`Swapped for ${activeQuote.symbol}`, { description: `${sig.slice(0, 8)}…` });
      setBalNonce((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Swap failed");
    } finally {
      setSwapping(false);
    }
  }
  const fmtUnits = (raw: number, decimals: number) =>
    (raw / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 4 });

  const currentMid =
    markets.find((m) => m.name === priceFeedSymbol(underlying))?.markPx ??
    pythSnap[priceFeedSymbol(underlying)]?.markPx;
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
    if (quote === "CUSTOM" && !verified) {
      toast.error("Verify the custom pairing token first.");
      return;
    }
    const buyNum = parseFloat(initialBuySol);
    const buyBounds = activeBounds;
    if (!Number.isFinite(buyNum) || buyNum < buyBounds.min || buyNum > buyBounds.max) {
      toast.error(`Initial buy must be between ${buyBounds.min} and ${buyBounds.max}`);
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
        quote,
        quoteMint: quote === "CUSTOM" ? verified!.mint : undefined,
        quoteDecimals: quote === "CUSTOM" ? verified!.decimals : undefined,
        creatorAddress: wallet.address,
        initialBuy: buyNum,
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
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Create a coin</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Launches on Solana via Meteora's bonding curve, quoted in {quote}. Your reserve powers a
            leveraged perp tied to the market you pick, so the coin price tracks it 24/7. Starts
            around $3k market cap and graduates to Meteora DAMM near $40k.
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
                placeholder="PERPSPAD"
                className="mt-1.5 font-mono"
              />
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                maxLength={50}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Perpspad"
                className="mt-1.5"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="desc">Description</Label>
            <Textarea
              id="desc"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this coin about?"
              className="mt-1.5"
              rows={3}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="website">
                Website <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
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
              <Label htmlFor="twitter">
                X / Twitter <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
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
                    const { error } = await supabase.storage
                      .from("token-images")
                      .upload(path, file, { contentType: file.type });
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
                  <button
                    type="button"
                    onClick={() => setImageUrl("")}
                    className="underline hover:text-foreground"
                  >
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
                  <div
                    key={i}
                    className="h-16 animate-pulse border border-border bg-secondary/30"
                  />
                ))
              ) : (
                <>
                  {(showAllMarkets ? top : top.slice(0, 12)).map((m) => {
                    const unlocked = m.supported && !m.unavailable;
                    const label = m.unavailable ? "UNAVAILABLE" : !m.supported ? "SOON" : null;
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
                            <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                              {label}
                            </span>
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
                          <div className="font-mono text-[10px] tabular-nums text-muted-foreground/60 animate-pulse">
                            loading.
                          </div>
                        )}
                        {m.change24h != null ? (
                          <div
                            className={`font-mono text-[10px] tabular-nums ${m.change24h >= 0 ? "text-primary" : "text-destructive"}`}
                          >
                            {m.change24h >= 0 ? "+" : ""}
                            {m.change24h.toFixed(1)}%
                          </div>
                        ) : (
                          <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            &nbsp;
                          </div>
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

          <div>
            <Label>Pair / quote token</Label>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {(["SOL", "USDC", "ANSEM", "UWU", "CUSTOM"] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => selectQuote(q)}
                  className={`border py-2.5 text-sm font-medium transition-all ${
                    quote === q
                      ? "border-foreground bg-accent"
                      : "border-border hover:border-foreground/40"
                  }`}
                >
                  {q === "CUSTOM" ? "Custom" : q}
                </button>
              ))}
            </div>

            {quote === "CUSTOM" && (
              <div className="mt-3 space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
                <Label htmlFor="customMint">Paste any SPL / Token-2022 mint to pair with</Label>
                <div className="flex gap-2">
                  <Input
                    id="customMint"
                    placeholder="Mint address"
                    value={customMint}
                    onChange={(e) => {
                      setCustomMint(e.target.value);
                      setVerified(null);
                      setVerifyErr(null);
                    }}
                    className={`font-mono text-xs ${
                      customMint && !isLikelySolanaAddress(customMint) ? "border-destructive" : ""
                    }`}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={verifying || !isLikelySolanaAddress(customMint)}
                    onClick={verifyCustom}
                  >
                    {verifying ? "Verifying…" : "Verify"}
                  </Button>
                </div>
                {customMint && !isLikelySolanaAddress(customMint) && (
                  <p className="text-[11px] text-destructive">Not a valid mint address format.</p>
                )}
                {verifyErr && <p className="text-[11px] text-destructive">{verifyErr}</p>}
                {verified && (
                  <div className="rounded border border-primary/40 bg-primary/5 p-2 text-[11px]">
                    <div className="font-medium text-primary">
                      ✓ {verified.name ?? "Pairable"}
                      {verified.symbol ? ` ($${verified.symbol})` : ""}
                    </div>
                    <div className="text-muted-foreground">
                      {verified.program}, {verified.decimals} decimals · $
                      {verified.priceUsd.toFixed(6)} · fee→SOL impact{" "}
                      {(verified.priceImpactPct * 100).toFixed(2)}%
                      {verified.hasFreezeAuthority ? " · ⚠ freeze authority set" : ""}
                      {verified.hasMintAuthority ? " · ⚠ mint authority set" : ""}
                    </div>
                  </div>
                )}
              </div>
            )}

            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              The bonding curve and graduated pool are denominated in{" "}
              {quote === "CUSTOM" ? "your chosen token" : quote}.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <div className="flex h-5 items-center">
                <Label>Direction</Label>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(["long", "short"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`border py-2.5 text-sm font-medium capitalize transition-all ${
                      direction === d
                        ? "border-foreground bg-accent"
                        : "border-border hover:border-foreground/40"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex h-5 items-center justify-between">
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
                  This market's venue caps below 2x. Enable Degen mode to see higher options, or
                  pick a different perp.
                </p>
              ) : (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {baseOpts.map((l) => (
                    <button
                      key={l}
                      type="button"
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
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {degenOpts.map((l) => (
                      <button
                        key={l}
                        type="button"
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
                  <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                    {underlying} routes through Phoenix with a venue cap of {maxLev}x. Only
                    leverages at or below the cap are shown.
                  </p>
                </>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="initialBuy">Initial buy ({quoteUnitLabel})</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Your dev buy on launch. Min {activeBounds.min}, max {activeBounds.max}{" "}
              {quoteUnitLabel}. Seeds the curve and gives you the first bag.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Input
                id="initialBuy"
                type="number"
                min={activeBounds.min}
                max={activeBounds.max}
                step={activeBounds.step}
                required
                value={initialBuySol}
                onChange={(e) => setInitialBuySol(e.target.value)}
                className="font-mono"
              />
              <div className="flex gap-1">
                {activeBounds.presets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setInitialBuySol(v)}
                    className={`border px-2.5 py-2 font-mono text-[11px] transition-all ${
                      initialBuySol === v
                        ? "border-foreground bg-accent"
                        : "border-border hover:border-foreground/40"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            {activeQuote && shortfallRaw > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2 text-[11px]">
                <span className="text-muted-foreground">
                  You hold {fmtUnits(quoteBalRaw ?? 0, activeQuote.decimals)} {activeQuote.symbol} —{" "}
                  {fmtUnits(shortfallRaw, activeQuote.decimals)} more needed for this dev-buy.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={swapping || !adapterPk}
                  onClick={acquireQuoteToken}
                  className="shrink-0"
                >
                  {swapping
                    ? "Swapping…"
                    : `Get ${fmtUnits(shortfallRaw, activeQuote.decimals)} ${activeQuote.symbol}${
                        swapEst ? ` (~${(swapEst.inLamports / 1e9).toFixed(3)} SOL)` : ""
                      }`}
                </Button>
              </div>
            )}
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
              Dev buy: {initialBuySol || "0"} {quote}
            </div>
          </div>

          <Button
            type="submit"
            size="lg"
            className="w-full rounded-none"
            disabled={submitting || !wallet || !isAllowed}
          >
            {submitting ? (
              launchStatus === "awaiting-signature" ? (
                "Awaiting wallet…"
              ) : launchStatus === "sending-prefund" ? (
                "Sending funds to treasury…"
              ) : launchStatus === "confirming-prefund" ? (
                "Confirming transfer…"
              ) : launchStatus === "launching" ? (
                "Treasury deploying pool…"
              ) : (
                "Preparing…"
              )
            ) : !wallet ? (
              "Connect wallet to deploy"
            ) : (
              <>
                Deploy coin <ArrowRight className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
          <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Creator pays 0.02 SOL launch fee + ~0.012 SOL mint and ATA rent + your initial buy.
            Supply locked at 1B.
          </p>
        </form>
      </div>
    </div>
  );
}
