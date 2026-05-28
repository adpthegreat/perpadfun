import { useEffect, useRef } from "react";

// Pixelated logo-inspired "stars" that smoothly parallax toward the cursor
// using a requestAnimationFrame lerp loop, contained within the hero box.
const STARS: { x: number; y: number; size: number; depth: number; opacity: number }[] = [
  { x: 72, y: 28, size: 6, depth: 34, opacity: 0.9 },
  { x: 86, y: 62, size: 4, depth: 22, opacity: 0.7 },
  { x: 58, y: 80, size: 5, depth: 28, opacity: 0.55 },
  { x: 92, y: 18, size: 3, depth: 16, opacity: 0.5 },
  { x: 66, y: 48, size: 8, depth: 44, opacity: 1 },
  { x: 78, y: 88, size: 3, depth: 14, opacity: 0.45 },
  { x: 50, y: 22, size: 4, depth: 24, opacity: 0.6 },
];

export function HeroStars() {
  const containerRef = useRef<HTMLDivElement>(null);
  const starRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // target mouse pos (-1..1) and current eased pos
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // ease toward target
      current.current.x += (target.current.x - current.current.x) * 0.08;
      current.current.y += (target.current.y - current.current.y) * 0.08;
      const cx = current.current.x;
      const cy = current.current.y;
      for (let i = 0; i < starRefs.current.length; i++) {
        const el = starRefs.current[i];
        if (!el) continue;
        const d = STARS[i].depth;
        el.style.transform = `translate3d(${cx * d}px, ${cy * d}px, 0)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    target.current.x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    target.current.y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
  };

  const handleLeave = () => {
    target.current.x = 0;
    target.current.y = 0;
  };

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className="absolute inset-0 overflow-hidden"
    >
      {STARS.map((s, i) => (
        <span
          key={i}
          ref={(el) => {
            starRefs.current[i] = el;
          }}
          className="absolute bg-foreground"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            opacity: s.opacity,
            imageRendering: "pixelated",
            boxShadow: `0 0 ${s.size * 2}px rgba(255,255,255,0.25)`,
            willChange: "transform",
          }}
        />
      ))}
    </div>
  );
}
