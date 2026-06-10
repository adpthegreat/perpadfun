import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { ArrowDownUp, Copy, Check } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getToken, getMyBalance } from "@/lib/tokens.functions";
import { useOnChainTrade } from "@/hooks/useOnChain";
import { BirdeyeChart } from "@/components/BirdeyeChart";
import { refreshPoolState } from "@/lib/meteora/dbc.functions";
import { formatUsd } from "@/lib/tokens";

import { useWallet } from "@/lib/wallet/WalletContext";
import { toast } from "sonner";

import { usePerpMid } from "@/hooks/usePerpMid";
import { SeedPoolPanel } from "@/components/SeedPoolPanel";
import { TreasuryPanel } from "@/components/TreasuryPanel";
import { SubWalletPanel } from "@/components/SubWalletPanel";
import { OnChainProofPanel } from "@/components/OnChainProofPanel";

export const Route = createFileRoute("/token/$id")({
  component: TokenPage,
  loader: async ({ params }) => {
    // light loader just for 404 detection — full data fetched client-side via useQuery
    const { token, error } = await getToken({ data: { id: params.id } });
    if (error || !token) throw notFound();
    return { token };
  },
  notFoundComponent: () => (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Token not found</h1>
        <Button asChild className="mt-4"><Link to="/tokens">Browse tokens</Link></Button>
      </div>
    </div>
  ),
  errorComponent: ({ error }) => <div className="p-8">{error.message}</div>,
  head: ({ loaderData }) => ({
    meta: [
      { title: `$${loaderData?.token.ticker} · perpad` },
      { name: "description", content: `${loaderData?.token.name}, a ${loaderData?.token.leverage}x ${loaderData?.token.direction} ${loaderData?.token.underlying} coin on perpad.` },
    ],
  }),
});

function TokenPage() {
  const { token: initial } = Route.useLoaderData();
  const { wallet } = useWallet();
  const qc = useQueryClient();

  const getTokenFn = useServerFn(getToken);
  const { trade, status: tradeStatus } = useOnChainTrade();
  const balanceFn = useServerFn(getMyBalance);
  const refreshPoolFn = useServerFn(refreshPoolState);

  const tokenQuery = useQuery({
    queryKey: ["token", initial.id],
    queryFn: () => getTokenFn({ data: { id: initial.id } }),
    refetchInterval: 4000,
    initialData: { token: initial, error: null },
  });
  const token = tokenQuery.data?.token ?? initial;

  // Keep on-chain reserve (sol_raised) fresh so market cap reflects reality.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      refreshPoolFn({ data: { tokenId: initial.id } })
        .then(() => { if (!cancelled) qc.invalidateQueries({ queryKey: ["token", initial.id] }); })
        .catch(() => {});
    };
    run();
    const t = setInterval(run, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [initial.id, refreshPoolFn, qc]);

  const balanceQuery = useQuery({
    queryKey: ["balance", token.id, wallet?.address],
    queryFn: () => (wallet ? balanceFn({ data: { tokenId: token.id, address: wallet.address } }) : Promise.resolve({ balance: 0 })),
    enabled: !!wallet,
    refetchInterval: 12000,
  });

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const mintAddress = ((token as any).mintAddress as string | null) ?? ((token as any).externalMint as string | null);
  const shortCA = mintAddress ? `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}` : null;
  const copyCA = async () => {
    if (!mintAddress) return;
    try {
      await navigator.clipboard.writeText(mintAddress);
      setCopied(true);
      toast.success("Contract address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  // Live mid from perp WS feed, falls back to last server-polled value
  const liveMid = usePerpMid(token.underlying, token.currentMid) ?? token.currentMid;
  
  void token.changePct;

  // Liveness UX: flash market cap when it changes, and tick a "Xs ago" counter
  // so users on flat tokens (e.g. pump.fun pre-graduation) can see the keeper
  // is still polling.
  const [mcFlash, setMcFlash] = useState<"up" | "down" | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [secondsAgo, setSecondsAgo] = useState(0);
  useEffect(() => {
    setLastUpdated((prev) => {
      // Only bump when the underlying query actually refetched.
      if (tokenQuery.dataUpdatedAt && tokenQuery.dataUpdatedAt !== prev) {
        return tokenQuery.dataUpdatedAt;
      }
      return prev;
    });
  }, [tokenQuery.dataUpdatedAt]);
  useEffect(() => {
    const t = setInterval(() => {
      setSecondsAgo(Math.max(0, Math.floor((Date.now() - lastUpdated) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [lastUpdated]);
  const [prevMc, setPrevMc] = useState(token.marketCap);
  useEffect(() => {
    if (token.marketCap !== prevMc) {
      setMcFlash(token.marketCap > prevMc ? "up" : "down");
      setPrevMc(token.marketCap);
      const t = setTimeout(() => setMcFlash(null), 900);
      return () => clearTimeout(t);
    }
  }, [token.marketCap, prevMc]);




  // est receive (accounts for 2% trade fee on the USDC notional)
  const TRADE_FEE = 0.02;
  const estReceive = (() => {
    const a = parseFloat(amount);
    if (!a || a <= 0) return 0;
    if (side === "buy") {
      // Input is total USDC out; curve sees a / (1 + fee)
      const net = a / (1 + TRADE_FEE);
      return net / token.priceUsd;
    }
    // Sell: input is tokens; receive notional minus fee
    const gross = a * token.priceUsd;
    return gross * (1 - TRADE_FEE);
  })();

  async function onTrade() {
    if (!wallet) {
      toast.error("Connect a wallet first");
      return;
    }
    const a = parseFloat(amount);
    if (!a || a <= 0) {
      toast.error("Enter an amount");
      return;
    }
    setSubmitting(true);
    try {
      toast.message("Approve the transaction in your wallet…");
      // On buy, user input is total USDC out (curve + 2% fee). Server applies
      // fee on top of the curve amount, so divide here to keep total = input.
      const curveAmount = side === "buy" ? a / (1 + TRADE_FEE) : a;
      const res = await trade({ tokenId: token.id, side, amount: curveAmount });
      toast.success(
        side === "buy"
          ? `Bought ${res.amountTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token.ticker}`
          : `Sold for $${res.amountUsdc.toFixed(2)}`,
      );
      setAmount("");
      qc.invalidateQueries({ queryKey: ["token", token.id] });
      qc.invalidateQueries({ queryKey: ["trades", token.id] });
      qc.invalidateQueries({ queryKey: ["balance", token.id] });
      if (res.graduated) toast.success("🎓 Token graduated!");
    } catch (err: any) {
      toast.error(err?.message ?? "Trade failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="mx-auto max-w-6xl px-6 py-10">
        <Link to="/" className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground">← all coins</Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center bg-accent text-base font-semibold text-accent-foreground">
              {token.imageUrl ? <img src={token.imageUrl} alt={token.ticker} className="h-full w-full object-cover" /> : token.ticker.slice(0, 2)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-semibold tracking-tight">${token.ticker}</h1>
                <Badge variant="outline" className="rounded-none font-mono text-[10px]">
                  {token.leverage}x {token.direction} {token.underlying}
                </Badge>
                {token.graduated && <Badge className="rounded-none bg-primary text-primary-foreground">graduated</Badge>}
              </div>
              <div className="text-sm text-muted-foreground">{token.name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {mintAddress && (
                  <button
                    onClick={copyCA}
                    className="inline-flex items-center gap-1.5 border border-border bg-secondary/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
                    title={mintAddress}
                  >
                    <span>CA: {shortCA}</span>
                    {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
                  </button>
                )}
                {(token as any).websiteUrl && (
                  <a
                    href={(token as any).websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 border border-border bg-secondary/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    website ↗
                  </a>
                )}
                {(token as any).twitterUrl && (
                  <a
                    href={(token as any).twitterUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 border border-border bg-secondary/50 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    x / twitter ↗
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">market cap</div>
            <div
              className={`text-3xl font-semibold tabular-nums transition-colors duration-700 ${
                mcFlash === "up" ? "text-emerald-400" : mcFlash === "down" ? "text-red-400" : ""
              }`}
            >
              {formatUsd(token.marketCap)}
            </div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">
              {(token.graduationProgress * 100).toFixed(1)}% to graduation
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {token.underlying} mid ${liveMid.toLocaleString(undefined, { maximumFractionDigits: liveMid > 100 ? 0 : 4 })}
              <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary align-middle" />
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span className="mr-1.5 inline-block h-1 w-1 animate-pulse rounded-full bg-emerald-400 align-middle" />
              updated {secondsAgo}s ago
            </div>
          </div>


        </div>

        <div className="mt-10">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            {/* The token's own market (Birdeye). */}
            <div className="border border-border bg-card p-6">
              <div className="mb-4 flex items-center justify-between">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  ${token.ticker} · token chart
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Birdeye
                </span>
              </div>
              <BirdeyeChart
                mint={token.mintAddress ?? (token as any).externalMint ?? null}
                height={420}
              />
            </div>

            <div className="grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
              {[
                ["Market cap", formatUsd(token.marketCap)],
                ["Underlying", `${token.underlying}`],
              ].map(([k, v]) => (
                <div key={k} className="bg-card p-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{k}</div>
                  <div className="mt-1 font-mono text-sm">{v}</div>
                </div>
              ))}
            </div>


            <TreasuryPanel
              tokenId={token.id}
              ticker={token.ticker}
              pumpFunMint={
                (token as any).externalPlatform === "pump_fun"
                  ? ((token as any).externalMint as string | null)
                  : null
              }
            />

            <OnChainProofPanel
              tokenId={token.id}
              ticker={token.ticker}
              mintAddress={token.mintAddress ?? (token as any).externalMint ?? null}
              subWallet={token.treasuryWalletAddress ?? null}
            />

            <SubWalletPanel tokenId={token.id} />


            <SeedPoolPanel
              token={{
                id: token.id,
                ticker: token.ticker,
                name: token.name,
                creatorAddress: token.creatorAddress,
                basePriceUsd: token.basePriceUsd,
                raydiumPoolId: (token as any).raydiumPoolId ?? null,
                mintAddress: (token as any).mintAddress ?? null,
              }}
            />
          </div>
        </div>

      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{children}</div>;
}

