import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, Settings2, Loader2, ExternalLink } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet/WalletContext";
import { getQuote, buildSwapWithFeeTx, getSolUsd, SOL_MINT, FEE_BPS, type JupQuote } from "@/lib/jupiter";
import { meteoraQuote, meteoraSwapTx } from "@/lib/meteora-swap";

// Buy/Sell widget for /token/$id. Buy = swap SOL -> token, Sell = swap token ->
// SOL, both routed through Jupiter and signed by the user's own wallet in the
// browser. perpspad earns nothing on the swap itself — revenue is the Meteora
// DBC curve fee the keeper claims, which this swap already pays into.

// External-venue referral links. None of these platforms have per-token pages
// that preserve a referral code, so linking per-token would just drop the ref —
// we link to the perpspad referral landing on each instead.
const AXIOM_URL = "https://axiom.trade/@perpspad";
const FOMO_URL = "https://fomo.family/r/perpspad";
const GMGN_URL = "https://gmgn.ai/?ref=hi3mJAFp";

// Where the embedded 1% fee lands. Override with VITE_FEE_WALLET (build env);
// defaults to the perpspad master treasury.
const FEE_WALLET =
  (import.meta.env.VITE_FEE_WALLET as string | undefined) ||
  "FHmBz4SnZ5r6Rws958S8WJ5ymnrvUdwjgrVQ3BVeBH95";

type Side = "buy" | "sell";

const fmt = (n: number, max = 6) =>
  n.toLocaleString(undefined, { maximumFractionDigits: max });

export function TradeWidget({
  token,
}: {
  token: {
    id: string;
    ticker: string;
    mintAddress: string | null;
    priceUsd: number;
    graduated: boolean;
    externalPlatform: string | null;
    dbcPoolAddress: string | null;
    graduatedPoolAddress: string | null;
  };
}) {
  const mint = token.mintAddress;
  const poolAddress = token.graduated ? token.graduatedPoolAddress : token.dbcPoolAddress;
  // Route: external pump.fun coins have no Meteora pool -> Jupiter (they're only
  // ever fee-routed once graduated, so they're liquid + Jupiter-indexed). Native
  // coins swap directly against their own Meteora pool (DBC pre-graduation, DAMM
  // v2 post-graduation), which works even before Jupiter indexes a brand-new pool.
  const isPumpFun = token.externalPlatform === "pump_fun";
  const route: "jup" | "dbc" | "damm" =
    isPumpFun || !poolAddress ? "jup" : token.graduated ? "damm" : "dbc";
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useAdapterWallet();
  const { connectSolana, connecting } = useWallet();
  const qc = useQueryClient();

  const [side, setSide] = useState<Side>("buy");
  const [buyUnit, setBuyUnit] = useState<"usd" | "sol">("usd");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [showSettings, setShowSettings] = useState(false);

  const [decimals, setDecimals] = useState<number | null>(null);
  const [solUsd, setSolUsd] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);

  const [quote, setQuote] = useState<{ outAmount: number; minOut: number; jup?: JupQuote } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "signing" | "sending" | "confirming">("idle");

  // token decimals (program-agnostic via parsed mint account)
  useEffect(() => {
    if (!mint) return;
    let off = false;
    connection
      .getParsedAccountInfo(new PublicKey(mint))
      .then((info) => {
        const dec = (info.value?.data as any)?.parsed?.info?.decimals;
        if (!off && typeof dec === "number") setDecimals(dec);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [mint, connection]);

  // SOL/USD for the USD<->SOL conversion + receive value
  useEffect(() => {
    let off = false;
    const run = () => getSolUsd().then((p) => !off && p > 0 && setSolUsd(p)).catch(() => {});
    run();
    const t = setInterval(run, 30_000);
    return () => {
      off = true;
      clearInterval(t);
    };
  }, []);

  // wallet token balance (for Sell % presets), refreshed on connect + after trades
  const refreshBalance = useCallback(() => {
    if (!publicKey || !mint) return;
    connection
      .getParsedTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) })
      .then((res) => {
        const bal = res.value.reduce(
          (s, a) => s + Number((a.account.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
          0,
        );
        setBalance(bal);
      })
      .catch(() => setBalance(null));
  }, [publicKey, mint, connection]);
  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // gross input the user commits, in base units of the input mint
  const grossIn = (() => {
    const a = parseFloat(amount);
    if (!a || a <= 0) return 0;
    if (side === "buy") {
      const sol = buyUnit === "usd" ? (solUsd > 0 ? a / solUsd : 0) : a;
      return Math.floor(sol * 1e9);
    }
    if (decimals == null) return 0;
    return Math.floor(a * 10 ** decimals);
  })();
  // Buy: 1% fee comes out of the SOL input, so the swap routes 99%.
  // Sell: swap the full token; the 1% comes off the SOL output (post-quote).
  const buyFeeLamports = side === "buy" ? Math.floor((grossIn * FEE_BPS) / 10000) : 0;
  const swapIn = side === "buy" ? grossIn - buyFeeLamports : grossIn;

  // debounced quote
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!mint || swapIn <= 0 || (side === "sell" && decimals == null)) {
      setQuote(null);
      setQuoteErr(null);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    setQuoting(true);
    debounce.current = setTimeout(() => {
      const p =
        route === "jup"
          ? getQuote({
              inputMint: side === "buy" ? SOL_MINT : mint!,
              outputMint: side === "buy" ? mint! : SOL_MINT,
              amount: swapIn,
              slippageBps,
            }).then((j) => ({
              outAmount: Number(j.outAmount),
              minOut: Number(j.otherAmountThreshold),
              jup: j,
            }))
          : meteoraQuote({
              connection,
              mode: route,
              poolAddress: poolAddress!,
              tokenMint: mint!,
              side,
              amountIn: swapIn,
              slippageBps,
            });
      p
        .then((q) => {
          setQuote(q);
          setQuoteErr(null);
        })
        .catch((e) => {
          setQuote(null);
          setQuoteErr(e?.message ?? "No route");
        })
        .finally(() => setQuoting(false));
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [mint, swapIn, side, slippageBps, decimals, route, poolAddress, connection]);

  // human-readable "you receive"
  const receive = (() => {
    if (!quote) return null;
    const out = Number(quote.outAmount);
    if (side === "buy") {
      const t = decimals != null ? out / 10 ** decimals : 0;
      return { amount: t, label: token.ticker, usd: t * token.priceUsd };
    }
    const sellFee = Math.floor((out * FEE_BPS) / 10000);
    const sol = (out - sellFee) / 1e9;
    return { amount: sol, label: "SOL", usd: sol * solUsd };
  })();

  const buyPresets = [25, 100, 250];
  const sellPctPresets = [0.25, 0.5, 1];

  function applyBuyPreset(usd: number) {
    setBuyUnit("usd");
    setAmount(String(usd));
  }
  function applySellPct(pct: number) {
    if (balance == null) {
      toast.error("Connect a wallet to use %");
      return;
    }
    setAmount(String(+(balance * pct).toFixed(decimals ?? 6)));
  }

  async function onSwap() {
    if (!publicKey || !signTransaction) {
      toast.error("Connect a wallet first");
      return;
    }
    if (!quote) {
      toast.error("No quote — adjust the amount");
      return;
    }
    try {
      setStatus("signing");
      const feeLamports =
        side === "buy"
          ? buyFeeLamports
          : Math.floor((quote.outAmount * FEE_BPS) / 10000);
      const tx =
        route === "jup"
          ? await buildSwapWithFeeTx({
              quoteResponse: quote.jup!,
              userPublicKey: publicKey.toBase58(),
              connection,
              feeWallet: FEE_WALLET,
              feeLamports,
            })
          : await meteoraSwapTx({
              connection,
              mode: route,
              poolAddress: poolAddress!,
              tokenMint: mint!,
              user: publicKey.toBase58(),
              side,
              amountIn: swapIn,
              minOut: quote.minOut,
              feeWallet: FEE_WALLET,
              feeLamports,
            });
      const signed = await signTransaction(tx);
      setStatus("sending");
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      setStatus("confirming");
      const deadline = Date.now() + 45_000;
      for (;;) {
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error("Transaction failed on-chain");
        const cs = st?.value?.confirmationStatus;
        if (cs === "confirmed" || cs === "finalized") break;
        if (Date.now() > deadline) throw new Error("Confirmation timed out");
        await new Promise((r) => setTimeout(r, 1500));
      }
      toast.success(
        side === "buy"
          ? `Bought ${fmt(receive?.amount ?? 0, 2)} ${token.ticker}`
          : `Sold ${token.ticker} for ≈ ${fmt(receive?.amount ?? 0, 4)} SOL`,
      );
      setAmount("");
      setQuote(null);
      refreshBalance();
      qc.invalidateQueries({ queryKey: ["token", token.id] });
    } catch (e: any) {
      toast.error(e?.message ?? "Swap failed");
    } finally {
      setStatus("idle");
    }
  }

  const busy = status !== "idle";
  const isBuy = side === "buy";
  const accent = isBuy ? "#16e0a3" : "#ff5c7a";

  // Pre-launch / no mint yet: only external venues are tradable.
  if (!mint) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">trade</div>
        <p className="mt-3 text-sm text-muted-foreground">
          On-chain trading opens once this coin's mint is live. Until then, trade on:
        </p>
        <ExternalVenues />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      {/* Buy / Sell + settings */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex w-full max-w-[280px] rounded-full bg-secondary/40 p-1">
          {(["buy", "sell"] as Side[]).map((s) => {
            const active = side === s;
            const c = s === "buy" ? "#16e0a3" : "#ff5c7a";
            return (
              <button
                key={s}
                onClick={() => {
                  setSide(s);
                  setAmount("");
                  setQuote(null);
                }}
                className="flex-1 rounded-full py-2 text-sm font-semibold capitalize transition-colors"
                style={
                  active
                    ? { backgroundColor: c, color: "#08080a" }
                    : { color: "var(--muted-foreground)" }
                }
              >
                {s}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground"
          title="Slippage"
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>

      {showSettings && (
        <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            max slippage
          </div>
          <div className="mt-2 flex items-center gap-2">
            {[50, 100, 300].map((bps) => (
              <button
                key={bps}
                onClick={() => setSlippageBps(bps)}
                className={`rounded-full px-3 py-1 font-mono text-xs transition-colors ${
                  slippageBps === bps
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {bps / 100}%
              </button>
            ))}
            <input
              type="number"
              value={slippageBps / 100}
              onChange={(e) => setSlippageBps(Math.max(1, Math.round(parseFloat(e.target.value || "1") * 100)))}
              className="w-16 rounded-full border border-border bg-transparent px-3 py-1 text-right font-mono text-xs outline-none focus:border-primary"
            />
            <span className="font-mono text-xs text-muted-foreground">%</span>
          </div>
        </div>
      )}

      {/* amount */}
      <div className="mt-5 flex items-center justify-center gap-3 py-6">
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full bg-transparent text-center text-5xl font-semibold tabular-nums outline-none placeholder:text-muted-foreground/40"
        />
        <button
          onClick={() => isBuy && setBuyUnit((u) => (u === "usd" ? "sol" : "usd"))}
          disabled={!isBuy}
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-1.5 font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-70"
          title={isBuy ? "Switch USD / SOL" : "Selling in token units"}
        >
          {isBuy ? buyUnit : token.ticker}
          {isBuy && <ArrowDownUp className="h-3 w-3" />}
        </button>
      </div>

      {/* receive / status line */}
      <div className="min-h-[20px] text-center font-mono text-xs text-muted-foreground">
        {quoting ? (
          "fetching best price…"
        ) : quoteErr ? (
          <span className="text-[#ff5c7a]">{quoteErr}</span>
        ) : receive ? (
          <>
            You receive ≈ <span className="text-foreground">{fmt(receive.amount, isBuy ? 2 : 5)} {receive.label}</span>
            {receive.usd > 0 && <span> · ≈ ${fmt(receive.usd, 2)}</span>}
          </>
        ) : side === "sell" && balance != null ? (
          <>balance: {fmt(balance, 4)} {token.ticker}</>
        ) : (
          " "
        )}
      </div>

      {/* action */}
      {!connected ? (
        <button
          onClick={() => connectSolana()}
          disabled={connecting}
          className="mt-4 w-full rounded-full py-3.5 text-sm font-semibold text-[#08080a] transition-opacity hover:opacity-90 disabled:opacity-60"
          style={{ backgroundColor: accent }}
        >
          {connecting ? "Connecting…" : "Connect wallet to trade"}
        </button>
      ) : (
        <button
          onClick={onSwap}
          disabled={busy || !quote}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-sm font-semibold text-[#08080a] transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: accent }}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {status === "signing"
            ? "Approve in wallet…"
            : status === "sending"
              ? "Sending…"
              : status === "confirming"
                ? "Confirming…"
                : isBuy
                  ? `Buy ${token.ticker}`
                  : `Sell ${token.ticker}`}
        </button>
      )}

      {/* presets */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {isBuy
          ? buyPresets.map((p) => (
              <button
                key={p}
                onClick={() => applyBuyPreset(p)}
                className="rounded-full border border-[#16e0a3]/40 bg-[#16e0a3]/10 py-2 font-mono text-xs text-[#16e0a3] transition-colors hover:bg-[#16e0a3]/20"
              >
                ${p}
              </button>
            ))
          : sellPctPresets.map((p) => (
              <button
                key={p}
                onClick={() => applySellPct(p)}
                className="rounded-full border border-[#ff5c7a]/40 bg-[#ff5c7a]/10 py-2 font-mono text-xs text-[#ff5c7a] transition-colors hover:bg-[#ff5c7a]/20"
              >
                {p * 100}%
              </button>
            ))}
      </div>

      <ExternalVenues />
    </div>
  );
}

function ExternalVenues() {
  return (
    <div className="mt-4 flex items-center justify-center gap-3 border-t border-white/5 pt-4">
      <a
        href={AXIOM_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-[#9d4eff]"
      >
        trade on axiom <ExternalLink className="h-3 w-3" />
      </a>
      <span className="text-muted-foreground/30">·</span>
      <a
        href={FOMO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-[#16e0a3]"
      >
        fomo.family <ExternalLink className="h-3 w-3" />
      </a>
      <span className="text-muted-foreground/30">·</span>
      <a
        href={GMGN_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-[#9d4eff]"
      >
        gmgn <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
