"use client";

// Celebration modal for an eligible $PERPAD airdrop check.
//
// CLIENT-ONLY. This is the ONLY module that touches `three` / `@react-three/fiber`
// / `canvas-confetti`. It must be reached exclusively via `lazy(() => import(...))`
// behind <ClientOnly> (see src/routes/checker.tsx). That dynamic import is what
// keeps `three` out of both the entry chunk AND the SSR/Worker eval path — never
// add a static top-level import of this file anywhere in the route graph.
import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Mesh } from "three";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// A shaded torus (the "$PERPAD donut") that slowly tumbles. r3f auto-disposes the
// geometry/material/renderer and stops its RAF loop on unmount — no manual cleanup.
function Donut({ reduced }: { reduced: boolean }) {
  const ref = useRef<Mesh>(null);
  useFrame((_, dt) => {
    if (!ref.current || reduced) return;
    // clamp dt so a backgrounded tab doesn't fling the mesh on refocus
    const step = Math.min(dt, 0.05);
    ref.current.rotation.x += step * 0.55;
    ref.current.rotation.y += step * 0.85;
  });
  return (
    <mesh ref={ref} rotation={[0.4, 0.2, 0]}>
      {/* radius, tube, radialSegments, tubularSegments */}
      <torusGeometry args={[1, 0.42, 40, 128]} />
      <meshStandardMaterial
        color="#9d4eff"
        metalness={0.55}
        roughness={0.25}
        emissive="#16e0a3"
        emissiveIntensity={0.28}
      />
    </mesh>
  );
}

export default function CelebrationModal({
  open,
  onOpenChange,
  amountUi,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** UI decimal allocation, e.g. 46499698.213797. Shown large. */
  amountUi: number;
}) {
  // Stagger the amount reveal in after the donut/headline for a beat of anticipation.
  const [revealAmount, setRevealAmount] = useState(false);

  // Confetti burst — canvas-confetti touches `document` at import time, so it's
  // dynamically imported inside this effect (never a top-level import) and only
  // when the modal actually opens.
  useEffect(() => {
    if (!open) {
      setRevealAmount(false);
      return;
    }

    const revealTimer = window.setTimeout(() => setRevealAmount(true), 420);

    if (prefersReducedMotion()) {
      return () => window.clearTimeout(revealTimer);
    }

    let cancelled = false;
    (async () => {
      const confetti = (await import("canvas-confetti")).default;
      if (cancelled) return;
      // zIndex above the Radix dialog overlay (z-50) so it bursts in front.
      const fire = (ratio: number, opts: Record<string, unknown>) =>
        confetti({
          origin: { y: 0.62 },
          zIndex: 200,
          colors: ["#9d4eff", "#16e0a3", "#23e3a0", "#e7e7ea"],
          disableForReducedMotion: true,
          particleCount: Math.floor(220 * ratio),
          ...opts,
        });
      fire(0.25, { spread: 26, startVelocity: 55 });
      fire(0.2, { spread: 60 });
      fire(0.35, { spread: 100, decay: 0.91, scalar: 0.9 });
      fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
      fire(0.1, { spread: 120, startVelocity: 45 });
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(revealTimer);
      // stop / clear any in-flight confetti on close or unmount
      import("canvas-confetti").then((m) => m.default.reset()).catch(() => {});
    };
  }, [open]);

  const formatted = amountUi.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden rounded-none border-border/60 bg-card/80 text-center backdrop-blur-xl">
        <DialogTitle className="sr-only">You are eligible for the $PERPAD airdrop</DialogTitle>
        <DialogDescription className="sr-only">
          Your $PERPAD airdrop allocation as a former PerpsPad holder.
        </DialogDescription>

        {/* ambient brand glow behind the whole card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#9d4eff]/25 via-transparent to-[#16e0a3]/25"
        />

        <div className="relative flex flex-col items-center gap-7 px-2 pt-6 pb-4">
          {/* the tumbling donut */}
          <div className="relative h-52 w-full">
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#9d4eff]/25 blur-3xl" />
            <Canvas camera={{ position: [0, 0, 3.2], fov: 45 }} dpr={[1, 2]}>
              <ambientLight intensity={0.65} />
              <directionalLight position={[3, 4, 5]} intensity={1.4} />
              <directionalLight position={[-4, -2, -3]} intensity={0.4} color="#16e0a3" />
              <Donut reduced={prefersReducedMotion()} />
            </Canvas>
          </div>

          <div className="flex flex-col items-center gap-2 px-2">
            <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#23e3a0]" />
              airdrop confirmed
            </span>
            <h2 className="font-sans text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              Congratulations
            </h2>
            <p className="max-w-xs text-sm text-muted-foreground">
              You held $PERPAD on PerpsPad — your allocation is locked in.
            </p>
          </div>

          {/* the allocation, shown large, revealed a beat later */}
          <div
            className={`flex flex-col items-center gap-1 transition-all duration-700 ease-out ${
              revealAmount ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
            }`}
          >
            <div className="font-mono text-4xl font-bold tabular-nums text-foreground drop-shadow-[0_0_24px_rgba(157,78,255,0.55)] md:text-5xl">
              {formatted}
            </div>
            <div className="font-mono text-xs uppercase tracking-[0.32em] text-[#16e0a3]">
              $PERPAD
            </div>
          </div>

          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="mt-1 h-9 rounded-none border-foreground/40 px-6 font-mono text-[10px] uppercase tracking-[0.24em] hover:border-[#9d4eff] hover:text-[#9d4eff]"
          >
            nice
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
