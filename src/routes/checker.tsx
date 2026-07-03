import { createFileRoute, ClientOnly, Link } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWallet, truncateAddress, type SolanaWalletName } from "@/lib/wallet/WalletContext";
import { toast } from "sonner";
import { Loader2, Wallet, PartyPopper, SearchX, Copy, LogOut } from "lucide-react";

// lazy => the celebration module (and its `three` / confetti deps) is code-split
// into an async chunk and is NOT evaluated during SSR / on the Worker. Never turn
// this into a static import — that is what keeps `three` out of the entry chunk
// and off the Worker eval path.
const CelebrationModal = lazy(() => import("@/components/checker/CelebrationModal"));

export const Route = createFileRoute("/checker")({
  component: CheckerPage,
  head: () => ({
    meta: [
      { title: "$PERPAD airdrop checker" },
      {
        name: "description",
        content: "Check if you're eligible for the $PERPAD airdrop as a former Perpad holder.",
      },
    ],
  }),
});

// Ambient perp tickers drifting around the screen — same system as the onboarding
// / landing page. Fixed (not random) so SSR + client markup match.
type Ticker = {
  s: string;
  l: number;
  d: "LONG" | "SHORT";
  top: string;
  left: string;
  dur: string;
  delay: string;
  hot?: boolean;
};
const TICKERS: Ticker[] = [
  { s: "GOOGL", l: 20, d: "LONG", top: "11%", left: "8%", dur: "7s", delay: "0s" },
  { s: "NVDA", l: 20, d: "LONG", top: "8%", left: "46%", dur: "9s", delay: "1.1s" },
  { s: "TSLA", l: 20, d: "LONG", top: "15%", left: "82%", dur: "8s", delay: "0.6s" },
  { s: "PL500", l: 20, d: "LONG", top: "27%", left: "20%", dur: "8.8s", delay: "1s", hot: true },
  { s: "SV151", l: 10, d: "LONG", top: "24%", left: "70%", dur: "7.1s", delay: "0.25s", hot: true },
  { s: "GOLD", l: 10, d: "LONG", top: "46%", left: "5%", dur: "8.2s", delay: "0.4s" },
  { s: "SOL", l: 20, d: "LONG", top: "58%", left: "88%", dur: "7.8s", delay: "0.5s" },
  { s: "HYPE", l: 25, d: "LONG", top: "72%", left: "16%", dur: "7.2s", delay: "0.9s" },
  { s: "WTI", l: 10, d: "SHORT", top: "80%", left: "30%", dur: "7.7s", delay: "0.7s" },
  { s: "BTC", l: 10, d: "LONG", top: "76%", left: "86%", dur: "8.5s", delay: "0.2s" },
  { s: "ETH", l: 10, d: "SHORT", top: "85%", left: "72%", dur: "6.8s", delay: "1.5s" },
];

const WALLETS: SolanaWalletName[] = ["Phantom", "Solflare", "Backpack"];

const reveal = (delay: number): CSSProperties =>
  ({ "--reveal-delay": `${delay}ms` } as CSSProperties);

const pillBtn =
  "inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-foreground active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";
const pillBtnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-full border border-[#16e0a3]/60 bg-[#16e0a3]/15 px-6 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#16e0a3]/25 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";

// Loose client-side sanity check so we can flag obvious junk before hitting the
// API. The server does the authoritative validation (base58 + PublicKey).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Breakdown = {
  perpadBalance: number;
  holdDays: number;
  base1to1: number;
  daysBonus: number;
};

type CheckResult =
  | { eligible: true; address: string; amountUi: number; breakdown: Breakdown }
  | { eligible: false; address: string };

function formatPerpad(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function CheckerPage() {
  const { wallet, connecting, connectSolanaWith, disconnect } = useWallet();
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [eligibleTotal, setEligibleTotal] = useState<number | null>(null);
  // remember which address we auto-checked so a re-render doesn't loop
  const autoCheckedRef = useRef<string | null>(null);

  // one-shot: how many former holders are eligible (count only, never the list)
  useEffect(() => {
    let alive = true;
    fetch("/api/checker")
      .then((r) => r.json())
      .then((j) => {
        if (alive && j?.ok && typeof j.data?.eligibleCount === "number") {
          setEligibleTotal(j.data.eligibleCount);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const runCheck = useCallback(async (raw: string) => {
    const addr = raw.trim();
    if (!addr) {
      toast.error("Paste a Solana address or connect your wallet.");
      return;
    }
    if (!BASE58_RE.test(addr)) {
      toast.error("That doesn't look like a Solana address.");
      return;
    }
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch("/api/checker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const json = (await res.json()) as
        | { ok: true; data: CheckResult }
        | { ok: false; error: { message: string } };

      if (!json.ok) {
        setStatus("idle");
        toast.error(json.error?.message ?? "Could not check that address.");
        return;
      }

      setResult(json.data);
      setStatus("done");
      if (json.data.eligible) {
        setModalOpen(true);
      }
    } catch {
      setStatus("idle");
      toast.error("Network error — please try again.");
    }
  }, []);

  // When a wallet connects, prefill its address and auto-check it once.
  useEffect(() => {
    const connected = wallet?.address;
    if (!connected) return;
    if (autoCheckedRef.current === connected) return;
    autoCheckedRef.current = connected;
    setAddress(connected);
    void runCheck(connected);
  }, [wallet?.address, runCheck]);

  const handleConnect = async (name: SolanaWalletName) => {
    try {
      await connectSolanaWith(name);
      toast.success(`Connected to ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  const eligible = status === "done" && result?.eligible === true;

  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background text-foreground">
      <video
        src="/hero-bg.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-50"
      />
      <div className="absolute inset-0 bg-gradient-to-br from-[#9d4eff]/30 via-[#08080a]/75 to-[#16e0a3]/30" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_18%,var(--background)_80%)]" />

      <div aria-hidden className="pointer-events-none absolute inset-0 z-[5]">
        {TICKERS.map((t, i) => (
          <div
            key={i}
            className={`ticker-chip absolute hidden items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] whitespace-nowrap backdrop-blur-sm sm:flex md:text-[11px] ${
              t.hot
                ? "border-[#16e0a3]/60 bg-[#16e0a3]/10 shadow-[0_0_18px_-4px_#16e0a3]"
                : "border-border/60 bg-card/40"
            }`}
            style={{ top: t.top, left: t.left, "--dur": t.dur, "--delay": t.delay } as CSSProperties}
          >
            {t.hot && <span className="h-1 w-1 animate-pulse rounded-full bg-[#16e0a3]" />}
            <span className="text-foreground/85">{t.s}</span>
            <span className="text-[#9d4eff]">{t.l}x</span>
            <span className={t.d === "LONG" ? "text-[#23e3a0]" : "text-[#ff5c7a]"}>{t.d}</span>
          </div>
        ))}
      </div>

      <main className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center gap-7 px-5 py-20 text-center">
        {/* eyebrow */}
        <span
          className="reveal-up inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground backdrop-blur"
          style={reveal(0)}
        >
          <span className="h-1 w-1 animate-pulse rounded-full bg-[#16e0a3]" />
          {eligibleTotal ? `${eligibleTotal} eligible wallets` : "former perpad holders"}
        </span>

        <div className="reveal-up flex flex-col items-center gap-3" style={reveal(80)}>
          <h1 className="font-sans text-5xl font-medium tracking-tight md:text-7xl">
            airdrop checker
          </h1>
          <p className="font-display text-xl text-muted-foreground md:text-2xl">
            held <span className="text-foreground">$PERPAD</span>?{" "}
            <em className="text-foreground">welcome back</em>.
          </p>
        </div>

        {/* checker card (interactive) */}
        <div
          className="reveal-up w-full rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10"
          style={reveal(160)}
        >
          <div className="rounded-[calc(2rem-0.375rem)] bg-card/70 p-7 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)] backdrop-blur-xl md:p-9">
            <div className="flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16e0a3]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                check your allocation
              </span>
            </div>

            <p className="mt-4 text-[15px] leading-relaxed text-foreground/85">
              Paste your Solana wallet or connect it. If you held{" "}
              <span className="font-semibold text-[#9d4eff]">$PERPAD</span> back on Perpad, you
              already earned an allocation.
            </p>

            {/* paste address */}
            <label htmlFor="checker-address" className="sr-only">
              your solana address
            </label>
            <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
              <input
                id="checker-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runCheck(address);
                }}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="paste your Solana address"
                className="w-full flex-1 rounded-full border border-border bg-card/60 px-5 py-2.5 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-[#9d4eff]"
              />
              <button
                onClick={() => void runCheck(address)}
                disabled={status === "loading"}
                className={`${pillBtnPrimary} shrink-0`}
              >
                {status === "loading" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    checking
                  </>
                ) : (
                  "check"
                )}
              </button>
            </div>

            {/* or */}
            <div className="mt-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                or
              </span>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            {/* connect wallet */}
            <div className="mt-5">
              {wallet ? (
                <div className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-card/80 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-[#16e0a3]/60 bg-[#16e0a3]/15 text-[#16e0a3]">
                      <Wallet className="h-3 w-3" />
                    </span>
                    <span className="font-mono text-[12px] text-foreground/90">
                      {truncateAddress(wallet.address)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        autoCheckedRef.current = null; // allow a manual re-check
                        void runCheck(wallet.address);
                      }}
                      className={pillBtn}
                    >
                      re-check
                    </button>
                    <button
                      type="button"
                      onClick={disconnect}
                      title="Disconnect"
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card/60 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" disabled={connecting} className={pillBtn}>
                      <Wallet className="h-3.5 w-3.5" />
                      {connecting ? "connecting…" : "connect wallet"}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="rounded-xl font-mono text-[10px] uppercase tracking-[0.18em]"
                  >
                    {WALLETS.map((name) => (
                      <DropdownMenuItem key={name} onClick={() => handleConnect(name)}>
                        {name.toLowerCase()}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            {/* result region */}
            {status === "done" && result && (
              <div className="mt-6">
                {result.eligible ? (
                  <div className="rounded-2xl border border-[#16e0a3]/40 bg-[#16e0a3]/[0.06] p-6">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[#16e0a3]">
                      <PartyPopper className="h-3.5 w-3.5" />
                      you&apos;re eligible
                    </div>
                    <div className="mt-4 font-sans text-4xl font-semibold leading-none tracking-tight md:text-5xl">
                      <span className="bg-gradient-to-br from-[#c79bff] via-foreground to-[#16e0a3] bg-clip-text tabular-nums text-transparent">
                        {formatPerpad(result.amountUi)}
                      </span>
                      <span className="ml-2 align-baseline font-mono text-sm text-[#16e0a3]">
                        $PERPAD
                      </span>
                    </div>
                    <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/5 bg-white/5 sm:grid-cols-4">
                      {[
                        { k: "held balance", v: formatPerpad(result.breakdown.perpadBalance) },
                        { k: "base (1:1)", v: formatPerpad(result.breakdown.base1to1) },
                        { k: "hold bonus", v: formatPerpad(result.breakdown.daysBonus) },
                        { k: "days held", v: String(result.breakdown.holdDays) },
                      ].map((cell) => (
                        <div key={cell.k} className="bg-card/80 p-3.5">
                          <dt className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/70">
                            {cell.k}
                          </dt>
                          <dd className="mt-1 font-mono text-[13px] tabular-nums text-foreground/90">
                            {cell.v}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <button
                      type="button"
                      onClick={() => setModalOpen(true)}
                      className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-[#9d4eff] transition-colors hover:text-foreground"
                    >
                      view celebration →
                    </button>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-white/5 bg-card/80 p-6">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                      <SearchX className="h-3.5 w-3.5" />
                      not in the snapshot
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-foreground/80">
                      <span className="font-mono text-foreground/90">
                        {truncateAddress(result.address, 6)}
                      </span>{" "}
                      isn&apos;t on the list of eligible former holders. This tool checks a fixed
                      snapshot — if you held under a different wallet, check that one instead.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* context note */}
        <div
          className="reveal-up w-full rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10"
          style={reveal(240)}
        >
          <div className="rounded-[calc(2rem-0.375rem)] bg-card/70 p-7 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)] backdrop-blur-xl md:p-9">
            <div className="flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#9d4eff]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                note
              </span>
            </div>

            <p className="mt-5 text-[15px] leading-relaxed text-foreground/85">
              Tested with a dummy launch to see how the anti snipe mechanism and supply control works
              and how it plays out on the new PERPSPAD platform and made a decoy launch so the chart
              doesn&apos;t get fucked, no CA has been posted, clearly there was no dev buy and supply
              control on this launch, more details will be shared.
            </p>
          </div>
        </div>

        <Link
          to="/paper"
          className="reveal-up inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-6 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground backdrop-blur transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-foreground hover:text-foreground active:scale-[0.98]"
          style={reveal(320)}
        >
          read the paper →
        </Link>
      </main>

      {/* celebration — client-only; only mounts once we have an eligible result */}
      {eligible && result?.eligible && (
        <ClientOnly fallback={null}>
          <Suspense fallback={null}>
            <CelebrationModal open={modalOpen} onOpenChange={setModalOpen} amountUi={result.amountUi} />
          </Suspense>
        </ClientOnly>
      )}
    </div>
  );
}
