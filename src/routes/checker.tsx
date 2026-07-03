import { createFileRoute, ClientOnly, Link } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import logo from "@/assets/logo.png";
import logoDark from "@/assets/logo-dark.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWallet, truncateAddress } from "@/lib/wallet/WalletContext";
import { toast } from "sonner";
import { Loader2, Wallet, PartyPopper, SearchX } from "lucide-react";

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
        content: "Check if you're eligible for the $PERPAD airdrop as a former PerpsPad holder.",
      },
    ],
  }),
});

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
  const { wallet } = useWallet();
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // remember which address we auto-checked so a re-render doesn't loop
  const autoCheckedRef = useRef<string | null>(null);

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

  const eligible = status === "done" && result?.eligible === true;

  return (
    <div className="min-h-screen bg-background">
      {/* minimal header — just branding + wallet connect (no stale trading nav) */}
      <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-2xl items-center px-6">
          <Link to="/" className="flex items-center">
            <img src={logo} alt="perpspad" className="h-8 w-8 object-contain block dark:hidden" />
            <img src={logoDark} alt="perpspad" className="h-8 w-8 object-contain hidden dark:block" />
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <ConnectWalletButton />
          </div>
        </div>
      </header>

      {/* hero */}
      <div className="relative overflow-hidden border-b border-border/60">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#9d4eff]/25 via-[#08080a]/60 to-[#16e0a3]/20"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_35%,var(--background)_88%)]"
        />
        <div className="relative mx-auto max-w-2xl px-6 pb-14 pt-16 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            former perpspad holders
          </span>
          <h1 className="mt-3 font-sans text-4xl font-semibold tracking-tight md:text-5xl">
            $PERPAD airdrop checker
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
            Held $PERPAD back on PerpsPad? You already earned an allocation. Paste your wallet or
            connect it to see what you&apos;re owed.
          </p>
        </div>
      </div>

      <main className="mx-auto max-w-2xl px-6 py-12">
        {/* check card */}
        <section className="rounded-none border border-border/60 bg-card/40 p-6 backdrop-blur">
          <label
            htmlFor="checker-address"
            className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground"
          >
            your solana address
          </label>

          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <Input
              id="checker-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runCheck(address);
              }}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="paste a wallet address…"
              className="h-10 rounded-none border-border bg-secondary/40 font-mono text-sm placeholder:text-muted-foreground/60"
            />
            <Button
              onClick={() => void runCheck(address)}
              disabled={status === "loading"}
              className="h-10 shrink-0 rounded-none px-6 font-mono text-[11px] uppercase tracking-[0.2em]"
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  checking
                </>
              ) : (
                "check"
              )}
            </Button>
          </div>

          {/* connect-wallet affordance */}
          <div className="mt-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border/60" />
            <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
              or
            </span>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <div className="mt-4">
            {wallet ? (
              <button
                type="button"
                onClick={() => {
                  autoCheckedRef.current = null; // allow a manual re-check
                  void runCheck(wallet.address);
                }}
                className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#16e0a3] transition-colors hover:text-foreground"
              >
                <Wallet className="h-3.5 w-3.5" />
                check connected wallet ({truncateAddress(wallet.address)})
              </button>
            ) : (
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                connect a wallet from the top-right to check it automatically.
              </p>
            )}
          </div>

          {/* result region */}
          {status === "done" && result && (
            <div className="mt-6">
              {result.eligible ? (
                <div className="rounded-none border border-[#16e0a3]/40 bg-[#16e0a3]/[0.06] p-5">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[#16e0a3]">
                    <PartyPopper className="h-3.5 w-3.5" />
                    eligible
                  </div>
                  <div className="mt-3 font-mono text-3xl font-bold tabular-nums text-foreground md:text-4xl">
                    {formatPerpad(result.amountUi)}{" "}
                    <span className="text-base text-[#16e0a3]">$PERPAD</span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] text-muted-foreground sm:grid-cols-3">
                    <div>
                      <dt className="uppercase tracking-[0.18em] text-muted-foreground/70">
                        held balance
                      </dt>
                      <dd className="mt-0.5 tabular-nums text-foreground/90">
                        {formatPerpad(result.breakdown.perpadBalance)}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.18em] text-muted-foreground/70">
                        base (1:1)
                      </dt>
                      <dd className="mt-0.5 tabular-nums text-foreground/90">
                        {formatPerpad(result.breakdown.base1to1)}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.18em] text-muted-foreground/70">
                        hold bonus
                      </dt>
                      <dd className="mt-0.5 tabular-nums text-foreground/90">
                        {formatPerpad(result.breakdown.daysBonus)}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-[0.18em] text-muted-foreground/70">
                        days held
                      </dt>
                      <dd className="mt-0.5 tabular-nums text-foreground/90">
                        {result.breakdown.holdDays}
                      </dd>
                    </div>
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
                <div className="rounded-none border border-border/60 bg-secondary/20 p-5">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                    <SearchX className="h-3.5 w-3.5" />
                    not in the snapshot
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    <span className="font-mono text-foreground/80">
                      {truncateAddress(result.address, 6)}
                    </span>{" "}
                    isn&apos;t on the list of eligible former holders. This tool checks a fixed
                    snapshot — if you held under a different wallet, check that one instead.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* eligibility criteria — DRAFT copy, flagged for review */}
        <section className="mt-8 rounded-none border border-border/60 bg-card/30 p-6 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-sans text-lg font-semibold tracking-tight text-foreground">
              Who qualifies
            </h2>
            <span className="rounded-none border border-[#9d4eff]/50 bg-[#9d4eff]/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.24em] text-[#9d4eff]">
              draft · pending review
            </span>
          </div>

          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            The $PERPAD airdrop rewards the people who held $PERPAD back on PerpsPad. If you were a
            holder, you already earned an allocation — just check your wallet above to see it.
          </p>

          <ul className="mt-4 space-y-2.5 text-[15px] leading-relaxed text-muted-foreground">
            <li className="flex gap-3">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#16e0a3]" />
              <span>
                You held $PERPAD on PerpsPad during the snapshot period.{" "}
                <span className="text-muted-foreground/60">
                  (snapshot window — to be confirmed)
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#16e0a3]" />
              <span>
                Your allocation has two parts: a 1:1 base match of your held $PERPAD balance, plus a
                holding-time bonus that grows the longer you held.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#16e0a3]" />
              <span>
                The longer you held and the larger your balance, the bigger your allocation.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#16e0a3]" />
              <span>
                This tool checks a fixed snapshot of eligible former holders. If your address
                isn&apos;t listed, it wasn&apos;t captured in the snapshot — nothing to sign up for
                and nothing to buy now.
              </span>
            </li>
          </ul>

          <p className="mt-5 border-t border-border/50 pt-4 font-mono text-[11px] leading-relaxed text-muted-foreground/70">
            Draft criteria — exact minimum balance, snapshot dates, and the &quot;former
            holder&quot; definition to be confirmed by the team. Note for review: allocations
            shown here follow the final snapshot data (base is a 1:1 match of held balance);
            an earlier methodology draft described a 1:10 base — copy tracks the shipped data.
          </p>
        </section>
      </main>

      {/* celebration — client-only; only mounts once we have an eligible result */}
      {eligible && result?.eligible && (
        <ClientOnly fallback={null}>
          <Suspense fallback={null}>
            <CelebrationModal
              open={modalOpen}
              onOpenChange={setModalOpen}
              amountUi={result.amountUi}
            />
          </Suspense>
        </ClientOnly>
      )}
    </div>
  );
}
