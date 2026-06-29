import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";

// perpspad coming-soon landing: the spinning donut (hero-bg.mp4) centered behind
// the wordmark, brand purple→teal gradient layered over it, ambient perp tickers
// drifting around the screen, links to socials only.
const X_URL = "https://x.com/perpspadfun";
const TG_URL = "https://t.me/+Uq5NsdlR0So1YWNk";

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

export function ComingSoon() {
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

      <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
          solana · perp backed
        </span>
        <h1 className="font-sans text-6xl font-medium tracking-tight md:text-8xl">perpspad</h1>
        <p className="font-display text-xl text-muted-foreground md:text-2xl">
          coins with a <em className="text-foreground">heartbeat</em>.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-foreground px-6 py-3 font-mono text-[13px] font-medium uppercase tracking-[0.18em] text-background shadow-[0_2px_28px_-6px_rgba(255,255,255,0.45)] transition-transform hover:-translate-y-0.5"
          >
            follow on X →
          </a>
          <a
            href={TG_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-[#16e0a3]/60 bg-[#16e0a3]/15 px-6 py-3 font-mono text-[13px] font-medium uppercase tracking-[0.18em] text-[#16e0a3] shadow-[0_0_26px_-8px_#16e0a3] backdrop-blur transition-colors hover:bg-[#16e0a3]/25"
          >
            join TG →
          </a>
          <Link
            to="/paper"
            className="inline-flex items-center gap-2 rounded-full border border-foreground/25 bg-card/80 px-6 py-3 font-mono text-[13px] uppercase tracking-[0.18em] text-foreground backdrop-blur transition-colors hover:border-foreground hover:bg-card"
          >
            read the paper →
          </Link>
        </div>
      </div>
    </div>
  );
}
