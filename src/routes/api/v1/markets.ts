import { createFileRoute } from "@tanstack/react-router";
import { ALLOWED_LEVERAGES, launchableMarketsInOrder, maxLeverageFor } from "@/lib/imperial-markets";
import { apiOk } from "@/lib/api/respond";

// GET /api/v1/markets — launchable markets + per-market leverage caps + allowed tiers. Public.
export const Route = createFileRoute("/api/v1/markets")({
  server: {
    handlers: {
      GET: async () => {
        const markets = launchableMarketsInOrder().map((symbol) => {
          const cap = maxLeverageFor(symbol);
          return { symbol, maxLeverage: cap, allowedLeverages: ALLOWED_LEVERAGES.filter((l) => l <= cap) };
        });
        return apiOk({ markets, quotes: ["SOL", "USDC"] });
      },
    },
  },
});
