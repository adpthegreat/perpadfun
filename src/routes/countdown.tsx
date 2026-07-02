import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Target launch time, in UTC. Leave empty ("") to show a 00:00:00:00 placeholder
// (time TBD). Set to an ISO-8601 UTC string (…Z) to start the live countdown.
export const LAUNCH_TARGET_UTC = "";
// ─────────────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/countdown")({
  component: CountdownPage,
  head: () => ({
    meta: [
      { title: "launching soon · perpspad" },
      { name: "description", content: "perpspad launches soon. Coins backed by a live perp, on Solana." },
    ],
  }),
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

function CountdownPage() {
  // Tick only after mount so SSR + client render the same thing (no hydration
  // mismatch on the digits).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Empty target = "time TBD" → frozen 00:00:00:00, no "we're live" flip.
  const hasTarget = LAUNCH_TARGET_UTC.trim().length > 0;
  const target = hasTarget ? new Date(LAUNCH_TARGET_UTC).getTime() : 0;
  const diff = !hasTarget ? 0 : now == null ? null : Math.max(0, target - now);
  const done = hasTarget && diff === 0;

  const units =
    diff == null
      ? null
      : {
          days: Math.floor(diff / DAY),
          hrs: Math.floor((diff % DAY) / HOUR),
          min: Math.floor((diff % HOUR) / MIN),
          sec: Math.floor((diff % MIN) / 1000),
        };

  const targetLabel = hasTarget
    ? new Date(LAUNCH_TARGET_UTC).toLocaleString(undefined, {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC"
    : "date TBD";

  const cells: [string, number | undefined][] = [
    ["days", units?.days],
    ["hrs", units?.hrs],
    ["min", units?.min],
    ["sec", units?.sec],
  ];

  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background text-foreground">
      {/* spinning donut */}
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

      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
          solana · perp backed
        </span>
        <h1 className="font-sans text-6xl font-medium tracking-tight md:text-8xl">perpspad</h1>
        <p className="font-display text-xl text-muted-foreground md:text-2xl">
          {done ? (
            <>
              we&apos;re <em className="text-foreground">live</em>.
            </>
          ) : (
            "launching in"
          )}
        </p>

        {!done && (
          <div className="mt-1 flex items-start gap-2 md:gap-4">
            {cells.map(([label, val], i) => (
              <div key={label} className="flex items-start gap-2 md:gap-4">
                <div className="flex min-w-[64px] flex-col items-center md:min-w-[92px]">
                  <span className="font-mono text-5xl font-semibold tabular-nums md:text-7xl">
                    {val == null ? "––" : String(val).padStart(2, "0")}
                  </span>
                  <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                    {label}
                  </span>
                </div>
                {i < cells.length - 1 && (
                  <span className="font-mono text-4xl font-semibold text-muted-foreground/40 md:text-6xl">:</span>
                )}
              </div>
            ))}
          </div>
        )}

        <span className="font-mono text-sm tracking-[0.2em] text-foreground/80">{targetLabel}</span>

        <div className="mt-2">
          {done ? (
            <Link
              to="/tokens"
              className="inline-flex items-center gap-2 rounded-full border border-[#16e0a3]/70 bg-[#16e0a3]/15 px-6 py-3 font-mono text-xs uppercase tracking-[0.18em] text-foreground backdrop-blur transition-colors hover:bg-[#16e0a3]/30"
            >
              enter perpspad →
            </Link>
          ) : (
            <Link
              to="/onboarding"
              className="inline-flex items-center gap-2 rounded-full border border-[#9d4eff]/70 bg-gradient-to-r from-[#9d4eff]/25 to-[#16e0a3]/25 px-6 py-3 font-mono text-xs uppercase tracking-[0.18em] text-foreground backdrop-blur transition-colors hover:border-[#16e0a3] hover:from-[#9d4eff]/40 hover:to-[#16e0a3]/40"
            >
              claim a founding code →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
