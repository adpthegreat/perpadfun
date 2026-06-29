import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Loader2, Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQuestFlow } from "@/lib/quest/useQuestFlow";
import { xFollowUrl, xRetweetUrl } from "@/lib/quest/config";

// perpspad landing: the spinning donut (hero-bg.mp4) centered behind the wordmark, brand
// purple→teal gradient over it, ambient perp tickers drifting around, and the pre-launch
// quest funnel (follow X, retweet, join TG, submit SOL) rendered as glassy step-pills.

type Ticker = { s: string; l: number; d: "LONG" | "SHORT"; top: string; left: string; dur: string; delay: string; hot?: boolean };

// Mix of equities, crypto, commodities + the soft-launching Pokemon-card perps (hot).
// Positions kept off the center band so they don't fight the wordmark. Fixed (not
// random) so SSR + client markup match.
const TICKERS: Ticker[] = [
  { s: "GOOGL", l: 20, d: "LONG", top: "12%", left: "9%", dur: "7s", delay: "0s" },
  { s: "NVDA", l: 20, d: "LONG", top: "9%", left: "44%", dur: "9s", delay: "1.1s" },
  { s: "TSLA", l: 20, d: "LONG", top: "16%", left: "79%", dur: "8s", delay: "0.6s" },
  { s: "PL500", l: 20, d: "LONG", top: "25%", left: "24%", dur: "8.8s", delay: "1s", hot: true },
  { s: "SV151", l: 10, d: "LONG", top: "23%", left: "66%", dur: "7.1s", delay: "0.25s", hot: true },
  { s: "SPCX", l: 15, d: "SHORT", top: "31%", left: "90%", dur: "7.5s", delay: "0.3s" },
  { s: "GOLD", l: 10, d: "LONG", top: "44%", left: "6%", dur: "8.2s", delay: "0.4s" },
  { s: "MU", l: 15, d: "LONG", top: "40%", left: "18%", dur: "6.5s", delay: "1.2s" },
  { s: "SOL", l: 20, d: "LONG", top: "56%", left: "85%", dur: "7.8s", delay: "0.5s" },
  { s: "MODERN-INDEX", l: 15, d: "LONG", top: "60%", left: "7%", dur: "6.9s", delay: "1.4s", hot: true },
  { s: "HYPE", l: 25, d: "LONG", top: "70%", left: "20%", dur: "7.2s", delay: "0.9s" },
  { s: "WTI", l: 10, d: "SHORT", top: "78%", left: "34%", dur: "7.7s", delay: "0.7s" },
  { s: "BTC", l: 10, d: "LONG", top: "74%", left: "83%", dur: "8.5s", delay: "0.2s" },
  { s: "ETH", l: 10, d: "SHORT", top: "82%", left: "71%", dur: "6.8s", delay: "1.5s" },
  { s: "META", l: 20, d: "LONG", top: "87%", left: "49%", dur: "7.4s", delay: "0.8s" },
];

// A glassy quest step rendered as a pill. Turns teal + check when done; spins while verifying.
function StepPill({
  done,
  busy,
  label,
  doneLabel,
  onClick,
  disabled,
}: {
  done: boolean;
  busy: boolean;
  label: string;
  doneLabel: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={done || busy || disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] backdrop-blur transition-colors disabled:cursor-default ${
        done
          ? "border-[#16e0a3]/60 bg-[#16e0a3]/10 text-[#16e0a3] shadow-[0_0_22px_-8px_#16e0a3]"
          : "border-border bg-card/70 text-foreground hover:border-foreground disabled:opacity-70"
      }`}
    >
      {done ? (
        <Check className="h-3.5 w-3.5" />
      ) : busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : null}
      {done ? doneLabel : label}
    </button>
  );
}

export function ComingSoon() {
  const q = useQuestFlow();

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground">
      {/* spinning donut */}
      <video
        src="/hero-bg.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-50"
      />
      {/* brand wash: purple → void → teal, then a vignette to focus the center */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#9d4eff]/30 via-[#08080a]/70 to-[#16e0a3]/30" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_20%,var(--background)_78%)]" />

      {/* ambient perp tickers drifting around the screen */}
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

      <div className="relative z-10 flex w-full max-w-xl flex-col items-center gap-5 px-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
          solana · perp backed
        </span>
        <h1 className="font-sans text-6xl font-medium tracking-tight md:text-8xl">perpspad</h1>
        <p className="font-display text-xl text-muted-foreground md:text-2xl">
          coins with a <em className="text-foreground">heartbeat</em>.
        </p>

        <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          complete the quest · qualify for the <span className="text-foreground">$PERPAD</span> airdrop
        </p>

        {q.isError ? (
          <p className="font-mono text-xs text-destructive">couldn’t start the quest — refresh to retry.</p>
        ) : (
          <>
            {/* Steps 1–3: follow X, retweet, join TG */}
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <StepPill
                done={q.follow.status === "done"}
                busy={q.follow.status === "awaiting" || q.follow.status === "verifying"}
                label="follow on X →"
                doneLabel="followed"
                disabled={!q.sid}
                onClick={() => q.follow.open(xFollowUrl())}
              />
              <StepPill
                done={q.retweet.status === "done"}
                busy={q.retweet.status === "awaiting" || q.retweet.status === "verifying"}
                label="retweet →"
                doneLabel="retweeted"
                disabled={!q.sid}
                onClick={() => q.retweet.open(xRetweetUrl())}
              />
              <StepPill
                done={q.tg.joined}
                busy={q.tg.active && !q.tg.joined}
                label="join TG →"
                doneLabel="joined TG"
                disabled={!q.sid}
                onClick={q.tg.join}
              />
            </div>

            {/* Step 4: submit SOL address */}
            {q.walletDone ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-[#16e0a3]/60 bg-[#16e0a3]/10 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-[#16e0a3] shadow-[0_0_22px_-8px_#16e0a3]">
                <Check className="h-3.5 w-3.5" /> wallet saved · {q.savedAddr!.slice(0, 4)}…
                {q.savedAddr!.slice(-4)}
              </div>
            ) : (
              <div className="flex w-full max-w-sm items-center gap-2">
                <Input
                  value={q.walletInput}
                  onChange={(e) => q.setWalletInput(e.target.value)}
                  placeholder="your SOL address"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={!q.sid || q.walletSubmitting}
                  className="rounded-full border-border bg-card/70 text-center font-mono text-xs backdrop-blur"
                />
                <Button
                  size="sm"
                  className="shrink-0 rounded-full"
                  disabled={!q.sid || q.walletSubmitting || !q.walletInput.trim()}
                  onClick={q.submitWalletAddr}
                >
                  {q.walletSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "submit"}
                </Button>
              </div>
            )}

            {/* Referral link + progress */}
            {q.referralUrl && (
              <div className="flex w-full max-w-sm items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-full border border-border bg-card/50 px-3 py-1.5 text-left font-mono text-[11px] text-muted-foreground backdrop-blur">
                  {q.referralUrl}
                </code>
                <button
                  type="button"
                  onClick={q.copyReferral}
                  aria-label="copy referral link"
                  className="shrink-0 rounded-full border border-border bg-card/70 p-2 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                >
                  {q.copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}

            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
              {q.completed} / {q.totalSteps} complete
              {q.allDone ? " · you’re in" : ""} · <Link to="/paper" className="hover:text-foreground">read the paper →</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
