import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useWallet as useSolanaAdapterWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import { toast } from "sonner";
import { useWallet, truncateAddress, type SolanaWalletName } from "@/lib/wallet/WalletContext";
import {
  getCollabStatus,
  verifyWallet,
  confirmXFollow,
  verifyTelegram,
  claimCode,
} from "@/lib/collab.functions";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
  head: () => ({
    meta: [
      { title: "Onboarding, perpspad" },
      {
        name: "description",
        content:
          "Join the founding community of perpspad. 500 early community partner codes for early access and an exclusive $PERPSPAD token allocation.",
      },
    ],
  }),
});

const X_URL = "https://x.com/perpspadfun";
const TG_URL = "https://t.me/+Uq5NsdlR0So1YWNk";
const TG_BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as string | undefined;

// Telegram Login Widget payload (client side mirror of the server type).
type TelegramAuth = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

// Ambient perp tickers drifting around the screen — same system as the landing
// page. Fixed (not random) so SSR + client markup match.
type Ticker = { s: string; l: number; d: "LONG" | "SHORT"; top: string; left: string; dur: string; delay: string; hot?: boolean };
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

const reveal = (delay: number): CSSProperties => ({ "--reveal-delay": `${delay}ms` } as CSSProperties);

const WALLET_OPTIONS: SolanaWalletName[] = ["Phantom", "Solflare", "Backpack"];

function OnboardingPage() {
  const { wallet, connectSolanaWith } = useWallet();
  const { publicKey, signMessage } = useSolanaAdapterWallet();
  const address = wallet?.address ?? null;

  const statusFn = useServerFn(getCollabStatus);
  const verifyWalletFn = useServerFn(verifyWallet);
  const confirmXFn = useServerFn(confirmXFollow);
  const verifyTgFn = useServerFn(verifyTelegram);
  const claimFn = useServerFn(claimCode);

  const status = useQuery({
    queryKey: ["collab-status", address],
    queryFn: () => statusFn({ data: address ? { wallet: address } : {} }),
    refetchInterval: 15000,
  });

  const counts = status.data?.counts ?? { claimed: 0, remaining: 500, total: 500 };
  const state = status.data?.state;
  const [busy, setBusy] = useState<string | null>(null);

  // Sign a message bound to (action, wallet) so the server can prove ownership.
  const sign = useCallback(
    async (action: string): Promise<{ message: string; signature: string } | null> => {
      if (!publicKey || !signMessage) {
        toast.error("Connect a wallet that supports message signing");
        return null;
      }
      const message = `perpspad-collab:${action}:${publicKey.toBase58()}:ts:${Date.now()}`;
      const sigBytes = await signMessage(new TextEncoder().encode(message));
      return { message, signature: bs58.encode(sigBytes) };
    },
    [publicKey, signMessage],
  );

  async function handleConnect(name: SolanaWalletName) {
    try {
      await connectSolanaWith(name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    }
  }

  async function handleVerifyWallet() {
    if (!address) return;
    setBusy("wallet");
    try {
      const signed = await sign("wallet");
      if (!signed) return;
      const res = await verifyWalletFn({ data: { wallet: address, ...signed } });
      if (!res.ok) return toast.error(res.error ?? "Verification failed");
      toast.success("Wallet verified");
      status.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmX() {
    if (!address) return;
    window.open(X_URL, "_blank", "noopener");
    setBusy("x");
    try {
      const signed = await sign("x-follow");
      if (!signed) return;
      const res = await confirmXFn({ data: { wallet: address, ...signed } });
      if (!res.ok) return toast.error(res.error ?? "Could not confirm");
      toast.success("X follow confirmed");
      status.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not confirm");
    } finally {
      setBusy(null);
    }
  }

  const handleTelegramAuth = useCallback(
    async (auth: TelegramAuth) => {
      if (!address) return;
      setBusy("tg");
      try {
        const res = await verifyTgFn({ data: { wallet: address, auth } });
        if (!res.ok) return toast.error(res.error ?? "Telegram verification failed");
        toast.success("Telegram verified");
        status.refetch();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Telegram verification failed");
      } finally {
        setBusy(null);
      }
    },
    [address, verifyTgFn, status],
  );

  async function handleClaim() {
    if (!address) return;
    setBusy("claim");
    try {
      const signed = await sign("claim");
      if (!signed) return;
      const res = await claimFn({ data: { wallet: address, ...signed } });
      if (!res.ok) return toast.error(res.error ?? "Claim failed");
      if (res.waitlisted) toast("All 500 codes are claimed — you're on the waitlist.");
      else toast.success("Code claimed!");
      status.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setBusy(null);
    }
  }

  const walletVerified = state?.walletVerified ?? false;
  const xFollowed = state?.xFollowed ?? false;
  const tgJoined = state?.tgJoined ?? false;
  const allDone = walletVerified && xFollowed && tgJoined;
  const claimedCode = state?.code ?? null;
  const waitlisted = state?.waitlisted ?? false;

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
              t.hot ? "border-[#16e0a3]/60 bg-[#16e0a3]/10 shadow-[0_0_18px_-4px_#16e0a3]" : "border-border/60 bg-card/40"
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
        {/* eyebrow + live counter */}
        <span
          className="reveal-up inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground backdrop-blur"
          style={reveal(0)}
        >
          <span className="h-1 w-1 animate-pulse rounded-full bg-[#16e0a3]" />
          {counts.remaining} / {counts.total} codes left
        </span>

        <div className="reveal-up flex flex-col items-center gap-3" style={reveal(80)}>
          <h1 className="font-sans text-5xl font-medium tracking-tight md:text-7xl">perpspad</h1>
          <p className="font-display text-xl text-muted-foreground md:text-2xl">
            collaborators, <em className="text-foreground">welcome aboard</em>.
          </p>
        </div>

        {/* offer (informational) */}
        <div className="reveal-up w-full rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10" style={reveal(160)}>
          <div className="rounded-[calc(2rem-0.375rem)] bg-card/70 p-7 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)] backdrop-blur-xl md:p-9">
            <div className="flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#9d4eff]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                collab offer for community
              </span>
            </div>
            <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <div className="leading-none">
                <div className="font-sans text-6xl font-semibold tracking-tight md:text-7xl">
                  <span className="bg-gradient-to-br from-[#c79bff] via-foreground to-[#16e0a3] bg-clip-text text-transparent">
                    500
                  </span>
                </div>
                <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
                  early partner codes
                </div>
              </div>
              <span className="inline-flex w-fit items-center gap-2 self-start rounded-full border border-[#9d4eff]/40 bg-[#9d4eff]/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#c79bff] sm:self-end">
                <span className="h-1 w-1 rounded-full bg-[#9d4eff]" />
                exclusive $PERPSPAD allocation
              </span>
            </div>
            <p className="mt-6 border-t border-white/5 pt-6 text-[15px] leading-relaxed text-foreground/85">
              The first 500 collaborators to follow us on X, join Telegram, and connect a Solana
              wallet receive an invite code and an exclusive{" "}
              <span className="font-semibold text-[#9d4eff]">$PERPSPAD</span> allocation — reserved
              for the people here first.
            </p>
          </div>
        </div>

        {/* tasks (interactive) */}
        <div className="reveal-up w-full rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10" style={reveal(240)}>
          <div className="rounded-[calc(2rem-0.375rem)] bg-card/70 p-7 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)] backdrop-blur-xl md:p-9">
            <div className="flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16e0a3]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                complete to claim
              </span>
            </div>

            {claimedCode ? (
              <ClaimedCard code={claimedCode} />
            ) : waitlisted ? (
              <div className="mt-6 rounded-xl border border-[#9d4eff]/30 bg-[#9d4eff]/5 p-6 text-center">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#c79bff]">
                  waitlisted
                </div>
                <p className="mt-2 text-[14px] text-foreground/85">
                  All 500 codes are claimed. You're on the waitlist — we'll reach out if more open up.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-2.5">
                {/* step 1 — connect + verify wallet */}
                <TaskRow n={1} label="Connect & verify your Solana wallet" done={walletVerified}>
                  {!address ? (
                    <div className="flex flex-wrap gap-2">
                      {WALLET_OPTIONS.map((name) => (
                        <button
                          key={name}
                          onClick={() => handleConnect(name)}
                          className={pillBtn}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  ) : walletVerified ? (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {truncateAddress(address)}
                    </span>
                  ) : (
                    <button onClick={handleVerifyWallet} disabled={busy === "wallet"} className={pillBtnPrimary}>
                      {busy === "wallet" ? "signing…" : "verify (sign)"}
                    </button>
                  )}
                </TaskRow>

                {/* step 2 — follow on X */}
                <TaskRow n={2} label="Follow @perpspadfun on X" done={xFollowed} locked={!walletVerified}>
                  {xFollowed ? null : (
                    <button
                      onClick={handleConfirmX}
                      disabled={!walletVerified || busy === "x"}
                      className={pillBtn}
                    >
                      {busy === "x" ? "confirming…" : "follow → confirm"}
                    </button>
                  )}
                </TaskRow>

                {/* step 3 — join Telegram */}
                <TaskRow n={3} label="Join the Telegram channel" done={tgJoined} locked={!walletVerified}>
                  {tgJoined ? null : walletVerified && TG_BOT_USERNAME ? (
                    <TelegramLoginButton botUsername={TG_BOT_USERNAME} onAuth={handleTelegramAuth} />
                  ) : (
                    <a href={TG_URL} target="_blank" rel="noreferrer" className={pillBtn}>
                      open telegram →
                    </a>
                  )}
                </TaskRow>

                {/* claim */}
                <button
                  onClick={handleClaim}
                  disabled={!allDone || busy === "claim"}
                  className="group mt-4 inline-flex w-full items-center justify-center rounded-full border border-[#9d4eff]/60 bg-[#9d4eff]/15 py-3 pl-6 pr-3 font-mono text-xs uppercase tracking-[0.18em] text-foreground transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#9d4eff]/25 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === "claim" ? "claiming…" : allDone ? "claim my code" : "complete all tasks to claim"}
                  <span className="ml-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-3.5 w-3.5">
                      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* earn more (informational) */}
        <div className="reveal-up w-full rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10" style={reveal(320)}>
          <div className="rounded-[calc(2rem-0.375rem)] bg-card/70 p-7 text-left shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)] backdrop-blur-xl md:p-9">
            <div className="flex items-center gap-2.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#16e0a3]" />
              <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                earn more
              </span>
            </div>
            <div className="mt-6 grid gap-px overflow-hidden rounded-xl border border-white/5 bg-white/5">
              <div className="bg-card/80 p-5">
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#16e0a3]">points / xp</div>
                <p className="mt-2.5 text-[14px] leading-relaxed text-foreground/85">
                  Earn by trading, holding, referring friends, and completing campaigns.
                </p>
              </div>
            </div>
          </div>
        </div>

        <Link
          to="/paper"
          className="reveal-up inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-6 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground backdrop-blur transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-foreground hover:text-foreground active:scale-[0.98]"
          style={reveal(380)}
        >
          read the paper →
        </Link>
      </main>
    </div>
  );
}

const pillBtn =
  "inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:border-foreground active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";
const pillBtnPrimary =
  "inline-flex items-center gap-2 rounded-full border border-[#16e0a3]/60 bg-[#16e0a3]/15 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-[#16e0a3]/25 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40";

function TaskRow({
  n,
  label,
  done,
  locked,
  children,
}: {
  n: number;
  label: string;
  done: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-white/5 bg-card/80 p-4 sm:flex-row sm:items-center sm:justify-between ${
        locked ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${
            done
              ? "border-[#16e0a3]/60 bg-[#16e0a3]/15 text-[#16e0a3]"
              : "border-border bg-background/40 text-muted-foreground"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <span className="text-[14px] text-foreground/90">{label}</span>
      </div>
      {!done && <div className="sm:ml-4 sm:shrink-0">{children}</div>}
    </div>
  );
}

function ClaimedCard({ code }: { code: string }) {
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => toast.success("Code copied"),
      () => toast.error("Copy failed"),
    );
  };
  return (
    <div className="mt-6 rounded-xl border border-[#16e0a3]/30 bg-[#16e0a3]/5 p-6 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#16e0a3]">
        your invite code
      </div>
      <button
        onClick={copy}
        className="mt-3 inline-flex items-center gap-3 rounded-xl border border-[#16e0a3]/40 bg-background/60 px-5 py-3 font-mono text-2xl tracking-[0.2em] text-foreground transition-colors hover:border-[#16e0a3]"
        title="Click to copy"
      >
        {code}
        <span className="font-sans text-[10px] uppercase tracking-[0.18em] text-muted-foreground">copy</span>
      </button>
      <p className="mt-4 text-[13px] text-foreground/75">
        You're in the founding community. Your $PERPSPAD allocation is tied to this wallet.
      </p>
    </div>
  );
}

// Telegram Login Widget. Renders Telegram's own button; on success it calls
// onAuth with the signed payload, which the server verifies with the bot token.
function TelegramLoginButton({
  botUsername,
  onAuth,
}: {
  botUsername: string;
  onAuth: (auth: TelegramAuth) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onAuth);
  cb.current = onAuth;

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const w = window as unknown as { __perpspadTgAuth?: (u: TelegramAuth) => void };
    w.__perpspadTgAuth = (u) => cb.current(u);

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "medium");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "__perpspadTgAuth(user)");
    host.innerHTML = "";
    host.appendChild(script);

    return () => {
      host.innerHTML = "";
    };
  }, [botUsername]);

  return <div ref={ref} className="flex justify-center sm:justify-end" />;
}
