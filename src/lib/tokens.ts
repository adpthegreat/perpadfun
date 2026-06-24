// Mock data for perpspad coins. Wire to real data later.
export type AltToken = {
  id: string;
  ticker: string;
  name: string;
  underlying: string;
  leverage: number;
  direction: "long" | "short";
  priceUsd: number;
  change24h: number;
  marketCap: number;
  reserveProgress: number; // 0-1, % of curve sold
  graduationProgress: number; // 0-1, toward $12k LT or supply
  createdAt: string;
};

const tickers = [
  ["HYPED", "Hyped", "HYPE", 5, "long"],
  ["BERRY", "Berryfi", "BTC", 3, "long"],
  ["GIGA", "Giga", "ETH", 5, "long"],
  ["DOWN", "Downbad", "SOL", 3, "short"],
  ["GOLDX", "GoldX", "PAXG", 2, "long"],
  ["NVDA5", "Nvidiamax", "NVDA", 5, "long"],
  ["OILZ", "Oilz", "WTI", 3, "short"],
  ["SPYL", "Spylong", "SPY", 2, "long"],
  ["ARBL", "Arblong", "ARB", 5, "long"],
  ["BONKS", "Bonkshort", "BONK", 3, "short"],
  ["MEMEX", "Memex", "PEPE", 5, "long"],
  ["KORE", "Korean", "KRW", 2, "short"],
] as const;

export const MOCK_TOKENS: AltToken[] = tickers.map(([t, n, u, l, d], i) => ({
  id: t.toLowerCase(),
  ticker: t,
  name: n,
  underlying: u,
  leverage: l as number,
  direction: d as "long" | "short",
  priceUsd: 0.00001 * (1 + i * 0.4) * (1 + Math.sin(i) * 0.3),
  change24h: (Math.cos(i * 1.3) * 40),
  marketCap: 4000 + i * 1800 + Math.abs(Math.sin(i * 2)) * 4000,
  reserveProgress: Math.min(0.98, (i + 1) / 13),
  graduationProgress: Math.min(0.98, ((i + 1) / 13) * 0.9),
  createdAt: new Date(Date.now() - i * 3600_000).toISOString(),
}));

export function formatUsd(n: number) {
  if (!isFinite(n) || n === 0) return "$0.00";
  const neg = n < 0;
  const v = Math.abs(n);
  let s: string;
  if (v >= 1000) s = v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  else if (v >= 1) s = v.toFixed(2);
  else if (v >= 0.01) s = v.toFixed(4);
  else if (v >= 0.0001) s = v.toFixed(6);
  else s = v.toFixed(8);
  return (neg ? "-$" : "$") + s;
}

