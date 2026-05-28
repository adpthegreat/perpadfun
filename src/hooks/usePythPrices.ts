// Live USD price + 24h change for symbols Hyperliquid doesn't list
// (US equities, metals, WTI, KMNO). Fetched server-side via Pyth to
// avoid CORS and to compute 24h change from daily closes.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPythSnapshot, PYTH_SYMBOLS, type PythRow } from "@/lib/pyth-snapshot.functions";

export const PYTH_FEEDS: Record<string, true> = Object.fromEntries(
  PYTH_SYMBOLS.map((s) => [s, true as const]),
);

export function usePythSnapshot(): Record<string, PythRow> {
  const fn = useServerFn(getPythSnapshot);
  const q = useQuery({
    queryKey: ["pyth-snapshot"],
    queryFn: () => fn(),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  return q.data?.data ?? {};
}

// Back-compat for older callers that only need {sym: price}
export function usePythPrices(_symbols?: string[]): Record<string, number> {
  const snap = usePythSnapshot();
  const out: Record<string, number> = {};
  for (const k of Object.keys(snap)) out[k] = snap[k].markPx;
  return out;
}

export function formatUsdPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (abs >= 100)  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (abs >= 1)    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}
