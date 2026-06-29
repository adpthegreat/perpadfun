# Perpspad Keeper

Tiny Node service that backs every Perpspad coin with a **live leveraged perp on
Imperial** (routing to Phoenix) — one position per coin, funded by the coin's own
trading fees and held for the life of the token.

It lives on Fly.io (not in the Cloudflare Worker) because the perp + Meteora SDKs
pull in `@solana/kit`, anchor, and a chunk of dependencies too big for the Worker
bundle.

It talks to Perpspad over HTTP (`/api/public/keeper/tokens` and
`/api/public/keeper/report`), authenticated with a shared `KEEPER_SECRET`. No
database credentials live on the keeper.

## What it does, every tick

For each active coin returned by Perpspad:

1. **Confirm** any perp request sent on the previous tick.
2. **Claim** trading fees from Meteora (DBC creator fees pre-graduation, DAMM v2 LP
   fees after) into the coin's deterministic sub-wallet, then apply the **50 / 25 / 25**
   split:
   - **50% → perp margin** — counts toward the open gate, then funds collateral top-ups.
   - **25% → buyback** — accrues in a per-token reserve; once it crosses **$10**, the
     keeper swaps that SOL to the coin on **Jupiter** and **burns** it onchain. Smaller
     amounts wait in the reserve until they cross the floor.
   - **25% → treasury reserve** — stays as SOL in the sub-wallet as runway for tx fees,
     rent, and future top-ups.
3. **Mark** the live perp to market and decide **open / top-up / take-profit**, routed
   through Imperial:
   - **Open** — once **$20** of perp-margin fees have accrued, open the position with
     **$20 collateral** at the creator's chosen market, leverage, and direction.
   - **Top-up** — every additional **$20** of fees adds **+$20 collateral** at the same
     leverage. Each top-up checks effective leverage and liquidation buffer first; if it
     would breach the safety cap or shrink the liq buffer below 25% of collateral, it's
     skipped and the fees stay queued for the next tick.
   - **Take-profit** — each time floating (unrealized) PnL climbs another **25% of the
     position's current collateral** above the last lock-in, close a proportional slice
     (size + collateral scale down together, so nominal leverage is preserved). The
     realized SOL is swapped to the coin on Jupiter and burned onchain; the cycle repeats
     from the new high-water mark.

The position **stays open for the life of the coin** — there is no graduation event that
unwinds it. On a drawdown nothing closes from PnL; top-ups keep extending runway, and the
25% buyback slice keeps burning from fees regardless.

## Markets

Backed markets are Imperial's catalog — crypto majors (BTC, ETH, SOL, BNB, XRP, DOGE,
ADA, TON, NEAR, SUI, TRX, XLM, HYPE, ZEC, …) and tokenized stocks (TSLA, GOOGL, NVDA,
AAPL, AMD, MSFT, META, AMZN, INTC, …). A coin whose `underlying` isn't an Imperial market
is reported as unavailable and its perp slice is redirected to buyback.

## Venue is a thin adapter (multi-venue ready)

The loop trades through a venue adapter (`src/venue.js`, `resolveVenue(token)`), which
wraps `src/imperialPerps.js`. Adding another venue later is a new adapter + a resolver
case — no loop changes. (The legacy Jupiter-perps venue was removed; see
`plan/REMOVE_JUPITER_PERPS.md`. Jupiter is still used for the buyback **swap**, a
different product from Jupiter Perps.)

## Trading modes

The keeper only sends real trades when explicitly enabled — everything defaults to `off`:

- `IMPERIAL_ENABLED=true` — master switch for the Imperial venue.
- `IMPERIAL_ROUTING_MODE=live`
- `IMPERIAL_POSITION_MODE=full` — allow open + top-up + take-profit/close.
- `IMPERIAL_DEPOSIT_MODE=live` — actually deposit USDC into the Imperial profile.
- `PERP_HEDGE_MODE=live` — global execution switch (`off` = stub, `simulate` = build +
  RPC-simulate but never submit, `live` = build → simulate → submit).

## One-time setup

```bash
cd keeper
fly launch --copy-config --no-deploy
fly secrets set \
  TREASURY_SOLANA_PRIVATE_KEY="<base58 key>" \
  KEEPER_SECRET="<same string saved in the app>" \
  SOLANA_RPC_URL="<your mainnet RPC, e.g. Helius>" \
  IMPERIAL_ENABLED=true \
  IMPERIAL_ROUTING_MODE=live \
  IMPERIAL_POSITION_MODE=full \
  IMPERIAL_DEPOSIT_MODE=live \
  PERP_HEDGE_MODE=live
fly deploy
```

Check it:

```bash
fly logs
curl https://perpspad-keeper.fly.dev/health
curl https://perpspad-keeper.fly.dev/status
```

## Local dev

```bash
cp .env.example .env   # fill in values
npm install
npm run dev
```

Endpoints:
- `GET  /health` last run timestamp + result.
- `GET  /status` venue + fee-gate / take-profit config + sweep / reconcile status.
- `POST /tick`   force a run now.
