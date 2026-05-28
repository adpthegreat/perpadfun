import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { fetchAllMarkets, fetchCandles, type PerpMarket } from "./perps.server";

export type { PerpMarket } from "./perps.server";

export const getPerpMarkets = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const data = await fetchAllMarkets();
    return { markets: data, error: null as string | null };
  } catch (e) {
    console.error("getPerpMarkets failed", e);
    return { markets: [] as PerpMarket[], error: "Perp feed unavailable" };
  }
});

export const getPerpMarket = createServerFn({ method: "GET" })
  .inputValidator((d: { name: string }) => z.object({ name: z.string().min(1).max(20) }).parse(d))
  .handler(async ({ data }) => {
    try {
      const all = await fetchAllMarkets();
      const m = all.find((x) => x.name.toLowerCase() === data.name.toLowerCase());
      return { market: m ?? null, error: null as string | null };
    } catch (e) {
      console.error("getPerpMarket failed", e);
      return { market: null, error: "Perp feed unavailable" };
    }
  });

export const getPerpCandles = createServerFn({ method: "GET" })
  .inputValidator((d: { coin: string; interval?: string; lookbackMs?: number }) =>
    z
      .object({
        coin: z.string().min(1).max(20),
        interval: z.string().default("15m"),
        lookbackMs: z.number().min(60_000).max(30 * 24 * 3600_000).default(24 * 3600_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const json = await fetchCandles(data.coin, data.interval, data.lookbackMs);
      return {
        candles: json.map((k) => ({
          t: k.t,
          o: Number(k.o),
          h: Number(k.h),
          l: Number(k.l),
          c: Number(k.c),
          v: Number(k.v),
        })),
        error: null as string | null,
      };
    } catch (e) {
      console.error("getPerpCandles failed", e);
      return { candles: [], error: "Chart unavailable" };
    }
  });
