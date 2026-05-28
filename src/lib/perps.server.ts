// Live perp market data feed. Public REST/WS (no auth) used purely
// to render prices and charts in the UI. The treasury executes on Drift
// via the off-app keeper service.

const FEED = "https://api.hyperliquid.xyz/info";

type AssetCtx = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
};

type Universe = { name: string; szDecimals: number; maxLeverage: number }[];

export type PerpMarket = {
  name: string;
  markPx: number;
  midPx: number;
  prevDayPx: number;
  change24h: number;
  dayNtlVlm: number;
  openInterest: number;
  funding: number;
  maxLeverage: number;
};

let cache: { ts: number; data: PerpMarket[] } | null = null;
const TTL_MS = 4000;

export async function fetchAllMarkets(): Promise<PerpMarket[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.data;
  const res = await fetch(FEED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
  });
  if (!res.ok) throw new Error(`perp feed ${res.status}`);
  const json = (await res.json()) as [{ universe: Universe }, AssetCtx[]];
  const [meta, ctxs] = json;
  const out: PerpMarket[] = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    const mark = Number(c.markPx);
    const prev = Number(c.prevDayPx);
    const mid = c.midPx ? Number(c.midPx) : mark;
    out.push({
      name: u.name,
      markPx: mark,
      midPx: mid,
      prevDayPx: prev,
      change24h: prev > 0 ? ((mark - prev) / prev) * 100 : 0,
      dayNtlVlm: Number(c.dayNtlVlm),
      openInterest: Number(c.openInterest),
      funding: Number(c.funding),
      maxLeverage: u.maxLeverage,
    });
    // Hyperliquid quotes some meme markets per 1000 tokens (kBONK, kPEPE, kSHIB, kBOME, kFLOKI).
    // Also surface them under their canonical display symbol with per-token pricing.
    if (u.name.startsWith("k") && u.name.length > 1 && u.name[1] === u.name[1].toUpperCase()) {
      const display = u.name.slice(1);
      out.push({
        name: display,
        markPx: mark / 1000,
        midPx: mid / 1000,
        prevDayPx: prev / 1000,
        change24h: prev > 0 ? ((mark - prev) / prev) * 100 : 0,
        dayNtlVlm: Number(c.dayNtlVlm),
        openInterest: Number(c.openInterest),
        funding: Number(c.funding),
        maxLeverage: u.maxLeverage,
      });
    }
  });
  cache = { ts: now, data: out };
  return out;
}

export async function fetchCandles(coin: string, interval: string, lookbackMs: number) {
  const endTime = Date.now();
  const startTime = endTime - lookbackMs;
  const res = await fetch(FEED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`perp candles ${res.status}`);
  return (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
}

export async function fetchMid(coin: string): Promise<number> {
  const res = await fetch(FEED, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!res.ok) throw new Error(`perp mid ${res.status}`);
  const mids = (await res.json()) as Record<string, string>;
  const v = mids[coin];
  if (!v) throw new Error(`Unknown perp market: ${coin}`);
  return Number(v);
}
