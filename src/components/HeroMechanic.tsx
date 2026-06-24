import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPerpMarkets } from "@/lib/perps.functions";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Zap } from "lucide-react";

/**
 * Visual showcase of the core mechanic:
 *   live perp  ->  Nx leverage  ->  on-curve token price
 * Pulls live perp marks, renders a streaming sparkline + delta readout.
 */
export function HeroMechanic() {
  const getPerps = useServerFn(getPerpMarkets);
  const q = useQuery({
    queryKey: ["perp-markets"],
    queryFn: () => getPerps(),
    refetchInterval: 10000,
  });

  const markets = q.data?.markets ?? [];
  const featured = useMemo(() => {
    const pick = ["BTC", "ETH", "HYPE", "SOL"];
    return pick
      .map((p) => markets.find((m) => m.name === p))
      .filter((m): m is NonNullable<typeof m> => !!m);
  }, [markets]);

  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    if (!featured.length) return;
    const id = setInterval(() => setActiveIdx((i) => (i + 1) % featured.length), 4200);
    return () => clearInterval(id);
  }, [featured.length]);

  const active = featured[activeIdx];
  const leverage = 3;

  // Rolling price buffer for sparkline
  const bufRef = useRef<number[]>([]);
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    bufRef.current = [];
    force((n) => n + 1);
  }, [active?.name]);
  useEffect(() => {
    if (!active) return;
    const buf = bufRef.current;
    if (buf.length === 0 || buf[buf.length - 1] !== active.markPx) {
      buf.push(active.markPx);
      if (buf.length > 48) buf.shift();
      force((n) => n + 1);
    }
  }, [active?.markPx]);

  const spark = useMemo(() => sparkPath(bufRef.current, 280, 56), [bufRef.current.length, active?.markPx]);
  const tokenDelta = active ? active.change24h * leverage : 0;
  const up = tokenDelta >= 0;

  return (
    <div className="relative h-full w-full">
      {/* faint grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          color: "hsl(var(--foreground))",
          maskImage: "radial-gradient(ellipse at center, black 40%, transparent 80%)",
        }}
      />

      <div className="relative grid h-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-6 md:gap-8 md:px-8">
        {/* Perp side */}
        <div className="border border-border bg-background/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
            <span>live perp</span>
            <span className="flex items-center gap-1.5 text-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              live
            </span>
          </div>
          <div className="mt-3 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums">
              {active?.name ?? "—"}
            </span>
            <span className="font-mono text-sm tabular-nums">
              {active ? fmt(active.markPx) : "—"}
            </span>
          </div>
          <svg viewBox="0 0 280 56" className="mt-3 h-12 w-full" preserveAspectRatio="none">
            <path
              d={spark}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              className={active && active.change24h >= 0 ? "text-primary" : "text-destructive"}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] tabular-nums">
            <span className="text-muted-foreground">24h</span>
            <span className={active && active.change24h >= 0 ? "text-primary" : "text-destructive"}>
              {active ? `${active.change24h >= 0 ? "+" : ""}${active.change24h.toFixed(2)}%` : "—"}
            </span>
          </div>
        </div>

        {/* Leverage operator */}
        <div className="flex flex-col items-center gap-2">
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="flex items-center gap-1 border border-foreground bg-foreground px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-background">
            <Zap className="h-3 w-3" />
            {leverage}x
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </div>

        {/* Token side */}
        <div className="border border-foreground bg-background/60 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
            <span>perpspad token</span>
            <span className="text-foreground">non-liq</span>
          </div>
          <div className="mt-3 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums">
              ${active?.name ?? "—"}3L
            </span>
            <span className={`font-mono text-sm tabular-nums ${up ? "text-primary" : "text-destructive"}`}>
              {up ? "+" : ""}{tokenDelta.toFixed(2)}%
            </span>
          </div>
          <div className="mt-3 h-12 w-full">
            <LeverageBars delta={tokenDelta} />
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>backed reserve</span>
            <span className="text-foreground">{leverage}x long</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmt(n: number) {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function sparkPath(buf: number[], w: number, h: number) {
  if (buf.length < 2) return `M0 ${h / 2} L${w} ${h / 2}`;
  const min = Math.min(...buf);
  const max = Math.max(...buf);
  const range = max - min || 1;
  const step = w / (buf.length - 1);
  return buf
    .map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function LeverageBars({ delta }: { delta: number }) {
  const up = delta >= 0;
  const magnitude = Math.min(Math.abs(delta) / 15, 1); // cap visual at 15%
  const bars = 18;
  const active = Math.max(2, Math.round(magnitude * bars));
  return (
    <div className="flex h-full items-end gap-[3px]">
      {Array.from({ length: bars }).map((_, i) => {
        const isOn = i < active;
        const heightPct = 25 + (i / bars) * 75;
        return (
          <div
            key={i}
            className={`flex-1 transition-all duration-300 ${
              isOn ? (up ? "bg-primary" : "bg-destructive") : "bg-border"
            }`}
            style={{ height: `${heightPct}%` }}
          />
        );
      })}
    </div>
  );
}
