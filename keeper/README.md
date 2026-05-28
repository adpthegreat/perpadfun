# perpad Jupiter Perps Keeper

Tiny Node service that drives every token's treasury hedge on **Jupiter
Perpetuals** (SOL / ETH / BTC). Was previously on Drift; swapped to Jupiter
after the Drift incident in May 2026.

It lives on Fly.io (not in the Cloudflare Worker) because the perp SDK
brings @solana/kit, anchor, and a chunk of dependencies that are too big for
the Worker bundle.

It talks to perpad over HTTP (`/api/public/keeper/tokens` and
`/api/public/keeper/report`), authenticated with a shared `KEEPER_SECRET`.
No database credentials live on the keeper.

## What it does, every minute

For each active token returned by perpad:

1. Claim any DBC creator fees (pre-grad) or DAMM v2 LP fees (post-grad).
2. Split the claimed SOL: 50% earmarked as perp margin, 50% into the
   buyback reserve.
3. Once cumulative fees cross $10, open (or adjust) a Jupiter perp on
   SOL / ETH / BTC matching the token's `underlying` and `direction`.
4. When unrealized PnL crosses a new high-water by >= $25, spend half the
   gain on a Jupiter SOL -> token swap + SPL burn.
5. On graduation, drain the remaining buyback reserve via one final
   buyback + burn. Perp stays open.

Tokens whose `underlying` is not SOL / ETH / BTC are reported as
"venue unavailable" and skipped (no hedge) until another perp venue is
wired up.

## Why not Drift anymore

Drift's mainnet program was taken offline in May 2026 after a security
incident. We can revisit Drift once it's restored.

## One-time setup

```bash
cd keeper
fly launch --copy-config --no-deploy
fly secrets set \
  TREASURY_SOLANA_PRIVATE_KEY="<base58 key>" \
  KEEPER_SECRET="<same string saved in Lovable>" \
  SOLANA_RPC_URL="<your mainnet RPC, e.g. Helius>"
fly deploy
```

Check it:

```bash
fly logs
curl https://perpad-keeper.fly.dev/health
curl https://perpad-keeper.fly.dev/status
```

## Local dev

```bash
cp .env.example .env   # fill in values
npm install
npm run dev
```

Endpoints:
- `GET  /health` last run timestamp + result, plus venue tag
- `GET  /status` treasury USDC balance (Jupiter Perps takes collateral
  inline per-position, so there is no central margin account to read)
- `POST /tick`   force a run now
