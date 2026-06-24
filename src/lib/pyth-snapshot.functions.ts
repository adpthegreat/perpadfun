// Server function that returns live price + 24h change for the symbols
// Hyperliquid doesn't list (US equities, metals, WTI, KMNO).
// Uses Pyth Hermes (latest) + benchmarks (daily history) to avoid CORS.
import { createServerFn } from "@tanstack/react-start";

const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";
const BENCH = "https://benchmarks.pyth.network/v1/shims/tradingview/history";

// display symbol -> { hermes feed id, benchmarks TradingView symbol }
const FEEDS: Record<string, { id: string; tv: string }> = {
  TSLA: { id: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", tv: "Equity.US.TSLA/USD" },
  GOOGL: { id: "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6", tv: "Equity.US.GOOGL/USD" },
  MU:   { id: "0x152244dc24665ca7dd3f257b8f442dc449b6346f48235b7b229268cb770dda2d", tv: "Equity.US.MU/USD" },
  NVDA: { id: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", tv: "Equity.US.NVDA/USD" },
  AAPL: { id: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", tv: "Equity.US.AAPL/USD" },
  AMD:  { id: "0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e", tv: "Equity.US.AMD/USD" },
  AMZN: { id: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a", tv: "Equity.US.AMZN/USD" },
  MSFT: { id: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1", tv: "Equity.US.MSFT/USD" },
  META: { id: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe", tv: "Equity.US.META/USD" },
  SNDK: { id: "0xc86a1f20cd7d5d07932baea30bcd8e479b775c4f51f82526bf1de6dc79fa3f76", tv: "Equity.US.SNDK/USD" },
  INTC: { id: "0xc1751e085ee292b8b3b9dd122a135614485a201c35dfc653553f0e28c1baf3ff", tv: "Equity.US.INTC/USD" },
  CRWV: { id: "0x2a78b78189d6d6eff30a825e4698fd14a0b1ca659bb0079bb7e80521c0e8c75d", tv: "Equity.US.CRWV/USD" },
  SPY:  { id: "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5", tv: "Equity.US.SPY/USD" },
  XAU:  { id: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", tv: "Metal.XAU/USD" },
  XAG:  { id: "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e", tv: "Metal.XAG/USD" },
  WTI:  { id: "0x17d0b3b03f9ccb6bb6721960f034b8601b3d89ef70743b33f86304a1565cebda", tv: "Commodities.WTIU6/USD" },
  KMNO: { id: "0xb17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0", tv: "Crypto.KMNO/USD" },
};

export const PYTH_SYMBOLS = Object.keys(FEEDS);

export type PythRow = { markPx: number; change24h: number | null };

let cache: { ts: number; data: Record<string, PythRow> } | null = null;
const TTL_MS = 15_000;

async function fetchLatest(): Promise<Record<string, number>> {
  const qs = Object.values(FEEDS).map((f) => `ids[]=${f.id}`).join("&");
  const res = await fetch(`${HERMES}?${qs}`);
  if (!res.ok) return {};
  const json = (await res.json()) as { parsed?: Array<{ id: string; price: { price: string; expo: number } }> };
  const out: Record<string, number> = {};
  for (const row of json.parsed ?? []) {
    const sym = Object.keys(FEEDS).find((k) => FEEDS[k].id.toLowerCase().endsWith(row.id.toLowerCase()));
    if (!sym) continue;
    const px = Number(row.price.price) * Math.pow(10, row.price.expo);
    if (Number.isFinite(px) && px > 0) out[sym] = px;
  }
  return out;
}

async function fetchPrevClose(sym: string): Promise<number | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 10 * 86400; // 10d window handles weekends/holidays
  const url = `${BENCH}?symbol=${encodeURIComponent(FEEDS[sym].tv)}&resolution=D&from=${from}&to=${to}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { s: string; c?: number[] };
    if (json.s !== "ok" || !json.c || json.c.length < 2) return null;
    // Use the second-to-last daily close as the 24h reference.
    return json.c[json.c.length - 2] ?? null;
  } catch {
    return null;
  }
}

export const getPythSnapshot = createServerFn({ method: "GET" }).handler(async () => {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return { data: cache.data };
  try {
    const latest = await fetchLatest();
    const symbols = Object.keys(latest);
    const closes = await Promise.all(symbols.map((s) => fetchPrevClose(s)));
    const data: Record<string, PythRow> = {};
    symbols.forEach((s, i) => {
      const px = latest[s];
      const prev = closes[i];
      data[s] = {
        markPx: px,
        change24h: prev && prev > 0 ? ((px - prev) / prev) * 100 : null,
      };
    });
    cache = { ts: now, data };
    return { data };
  } catch (e) {
    console.error("getPythSnapshot failed", e);
    return { data: cache?.data ?? {} };
  }
});
