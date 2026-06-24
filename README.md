# perpspad

Solana launchpad where every coin ships with a public, leveraged perp treasury that earns trading fees, claims them on-chain, and uses them to buy back and burn its own supply.

- Live site: https://perpspad.fun
- Whitepaper: https://perpspad.fun/paper

## What it is

Each perpspad coin is:

- a real SPL token on Solana mainnet, 1B supply, mint and freeze authorities revoked at creation
- traded on a Meteora Dynamic Bonding Curve quoted in native SOL, then graduated into a Meteora DAMM v2 pool at 85 SOL raised
- backed by a leveraged perp position on a chosen underlying (BTC, ETH, SOL, HYPE, gold, oil, NVDA, etc.)
- repriced live on every perp tick, not just on trades

100% of trade fees (2.5% decaying to 1% over 24h) accrue to one public Solana treasury and are used to:

1. claim fees on-chain through the Meteora SDK (DBC pre-graduation, DAMM v2 post-graduation)
2. update the perp factor that backs the coin's price
3. sweep realized PnL and claimed SOL into a buyback reserve
4. buy back the coin through Jupiter and burn the result

Every step is a verifiable mainnet transaction.

## Repo layout

- `src/` web app (TanStack Start v1 on Cloudflare Workers, Vite 7, React 19, Tailwind v4, shadcn/ui)
- `src/routes/` file-based routes (home, tokens, launch, token detail, paper, docs, portfolio, api/public/*)
- `src/lib/*.functions.ts` server functions called from the client via `useServerFn`
- `src/integrations/supabase/` typed clients (browser, admin, auth middleware)
- `keeper/` long-running keeper process that runs the tick loop: claim fees, update marks, rebalance, buyback, burn
- `supabase/migrations/` database schema

## Public API

- `GET /api/public/keeper/tokens` list of active coins with treasury state for the keeper

## Stack

- TanStack Start v1 (SSR + server functions on Cloudflare Workers)
- Lovable Cloud (Supabase: Postgres + Storage + Auth)
- Meteora DBC + DAMM v2 for liquidity
- Hyperliquid for perp marks and execution
- Jupiter for buyback routing
- Pyth for mark price publication

## License

MIT.
