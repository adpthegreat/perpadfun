import { createFileRoute } from "@tanstack/react-router";

// GET /api/v1/openapi — the OpenAPI 3.1 spec (served as JSON). Hand-authored for v1;
// keep in sync with the zod bodies in the route files. Rendered by /api/docs (Scalar).
// PUBLIC DOC: documents only the keyless public flow. Do NOT describe the privileged
// admin mode / its auth here — this spec is served publicly.
const spec = {
  openapi: "3.1.0",
  info: {
    title: "perpspad Launch API",
    version: "1.0.0",
    description:
      "Permissionless token launches on perpspad. **No API key** — the caller's wallet is the identity and a 0.01 SOL fee (charged on-chain) is the rate-limiter.\n\nFlow: 1) POST /launch → get unsigned `config` + `pool` txs. 2) sign + send both with your wallet (pays rent, dev-buy, and the 0.01 SOL fee). The launch is recorded server-side and promoted to `live` once the pool confirms on-chain — no callback needed. Poll GET /launch/{tokenId} for status.",
  },
  servers: [{ url: "https://perpspad.fun" }],
  paths: {
    "/api/v1/markets": {
      get: { summary: "List launchable markets + leverage caps", responses: { "200": { description: "markets" } } },
    },
    "/api/v1/launch": {
      post: {
        summary: "Launch a token (returns unsigned config + pool txs to sign)",
        description: "Returns unsigned config + pool txs; the caller signs both as payer/buyer and the pool tx carries the 0.01 SOL fee. A row is recorded and promoted to `live` when the pool confirms on-chain.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ticker", "name", "underlying", "leverage", "direction", "creatorAddress", "devBuy"],
                properties: {
                  ticker: { type: "string" },
                  name: { type: "string" },
                  underlying: { type: "string", description: "market symbol, e.g. SOL/BTC/GOOGL" },
                  leverage: { type: "integer" },
                  direction: { type: "string", enum: ["long", "short"] },
                  quote: { type: "string", enum: ["SOL", "USDC"], default: "SOL" },
                  creatorAddress: { type: "string", description: "your wallet — signer, payer, buyer, dev-buy recipient" },
                  devBuy: { type: "number", description: "dev-buy in quote UI units (SOL 0.1–5, USDC 5–5000)" },
                  imageUrl: { type: "string" },
                  websiteUrl: { type: "string" },
                  twitterUrl: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ tokenId, mint, configAddress, poolAddress, transactions[], supplyBreakdown, protocolFeeSol }" },
          "422": { description: "validation error" },
          "429": { description: "IP-throttled" },
        },
      },
    },
    "/api/v1/launch/{tokenId}": {
      get: {
        summary: "Launch status",
        parameters: [{ name: "tokenId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "status" }, "404": { description: "not found" } },
      },
    },
    "/api/v1/launch/{tokenId}/metadata": {
      get: {
        summary: "Token metadata JSON (the on-chain uri target)",
        parameters: [{ name: "tokenId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Metaplex metadata" }, "404": { description: "not yet confirmed" } },
      },
    },
  },
} as const;

export const Route = createFileRoute("/api/v1/openapi")({
  server: {
    handlers: {
      GET: async () => new Response(JSON.stringify(spec), { headers: { "content-type": "application/json" } }),
    },
  },
});
