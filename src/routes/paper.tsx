import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";

export const Route = createFileRoute("/paper")({
  component: PaperPage,
  head: () => ({
    meta: [
      { title: "perpad whitepaper. coins backed by a live perp position." },
      { name: "description", content: "How perpad coins work. Meteora bonding curves, per-token sub-wallet treasuries, Imperial-routed perps across 50+ markets, and burns funded by fees and realized PnL." },
      { property: "og:title", content: "perpad whitepaper" },
      { property: "og:description", content: "Coins, sub-wallet treasuries, the keeper loop, Imperial routing, and the burn flywheel, end to end." },
    ],
  }),
});

const MASTER_TREASURY = "9Kxfhk9JMckpzAmGm1hXFjdfdL4VjpHvBKu9p4kJWHB7";
const MASTER_URL = `https://solscan.io/account/${MASTER_TREASURY}`;


function PaperPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <article className="mx-auto max-w-2xl px-6 py-16">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">whitepaper v5, May 2026</div>
        <h1 className="font-display mt-2 text-4xl leading-[1.05] tracking-tight">perpad. coins backed by a live perp.</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          perpad is a Solana launchpad where every coin runs a real leveraged perpetual, routed through Imperial across the best available venue, owned by that coin's on-chain sub-wallet. Trading fees feed the position, a slice of every fee buys back and burns supply, and the position stays open for the life of the token.
        </p>

        <div className="prose-content mt-12 space-y-10 text-[15px] leading-relaxed text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">1. Token</h2>
            <p className="mt-3 text-muted-foreground">
              A standard SPL token on Solana mainnet. Fixed 1,000,000,000 supply. Mint and freeze authorities are revoked at creation. No admin key, no upgrade path, no team multisig that can mint, freeze, or claw back a holder's balance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">2. Curve</h2>
            <p className="mt-3 text-muted-foreground">
              Trading happens against a Meteora Dynamic Bonding Curve quoted in native SOL. Buys and sells are normal Solana swaps, routable through Jupiter, Axiom, Phantom, or any aggregator. perpad never custodies user balances.
            </p>
            <p className="mt-3 text-muted-foreground">
              The trade fee starts at 2.5% and decays to 1% over the first 24 hours. 100% of fees route to the coin's own sub-wallet (see below). Once the curve fills, the pool migrates to a Meteora DAMM v2 pool and fees keep flowing to the same sub-wallet.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">3. Sub-wallet treasuries</h2>
            <p className="mt-3 text-muted-foreground">
              Each coin gets its own deterministically-derived Solana sub-wallet at launch. That sub-wallet is the fee claimer on Meteora and the owner of the perp position. Funds for one coin can never touch another coin's position.
            </p>
            <p className="mt-3 text-muted-foreground">
              All sub-wallets are derived from one master treasury (the keeper's signer) so they can be operated by a single bot, but each address is public and viewable on chain. The master address is:
            </p>
            <p className="mt-2 break-all font-mono text-xs">
              <a href={MASTER_URL} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">{MASTER_TREASURY}</a>
            </p>
            <p className="mt-3 text-muted-foreground">
              Each coin's own sub-wallet address and live perp portfolio are linked directly from that coin's page on perpad. Click any token to see its treasury balance, claimed fees, open position, and burn history with one click out to Solscan or the routing venue.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">4. Market universe</h2>
            <p className="mt-3 text-muted-foreground">
              At launch the creator picks any supported market as the underlying. Imperial routing currently covers 50+ markets across five asset classes:
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
              <li><span className="text-foreground">Crypto majors and L1s.</span> BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, TON, NEAR, SUI, TRX, LTC, DOT, BCH, XLM, HYPE, LINK, APE, ZEC.</li>
              <li><span className="text-foreground">DeFi and Sol-eco.</span> JUP, PYTH, JTO, KMNO, AAVE, UNI, ARB, GMX, ENA.</li>
              <li><span className="text-foreground">Memes.</span> BONK, PEPE, SHIB, WIF, FARTCOIN, PUMP, PENGU, BOME, TRUMP, MELANIA.</li>
              <li><span className="text-foreground">Stocks.</span> TSLA, GOOGL, NVDA, AAPL, AMD, MU, AMZN, SPY.</li>
              <li><span className="text-foreground">Commodities and FX.</span> XAU, XAG, WTI, NATGAS, COPPER, EUR, GBP, USDJPY, USDCHF, USDCAD, AUD, NZD.</li>
            </ul>
            <p className="mt-3 text-muted-foreground">
              Leverage tiers are split into Base (2x, 3x, 5x) and Degen (10x, 25x, 50x, 100x). The Degen tier is capped by the venue's reported max for that market, so a creator can never pick a leverage Imperial would reject at open.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">5. Imperial routing</h2>
            <p className="mt-3 text-muted-foreground">
              Every open, top-up, and close is quoted through Imperial and executed on Phoenix Trade (a Solana CLOB). Phoenix is currently the exclusive venue for new positions — the CLOB gives the keeper deterministic slippage and the lowest round-trip cost we&apos;ve measured across Imperial&apos;s supported venues. The keeper records the chosen venue with every action so the route is auditable per claim.
            </p>
            <p className="mt-3 text-muted-foreground">
              Sub-wallets post USDC as collateral. The keeper swaps SOL to USDC on Jupiter on the same tick that it deposits, so the position is always denominated in dollars and the venue choice is independent of which SPL token the coin is.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">6. Fee split</h2>
            <p className="mt-3 text-muted-foreground">
              Every fee claim that lands in a coin's sub-wallet is split three ways on the same tick:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
              <li><span className="text-foreground">50% to the perp.</span> Counts toward the open gate, then feeds collateral top-ups on the live position.</li>
              <li><span className="text-foreground">25% to buyback and burn.</span> Accrues in a per-token reserve. Once the reserve crosses $10, the keeper swaps that SOL to the coin on Jupiter and burns it on-chain. Smaller amounts wait in the reserve until they cross the floor.</li>
              <li><span className="text-foreground">25% to the treasury reserve.</span> Stays as SOL in the sub-wallet as a runway buffer for tx fees, rent, and future top-ups.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">7. The keeper loop</h2>
            <p className="mt-3 text-muted-foreground">
              A keeper bot ticks once per minute. For every active coin, each tick:
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
              <li>Confirms any perp request from the previous tick.</li>
              <li>Claims trading fees from Meteora (DBC pre-graduation, DAMM v2 after) into the coin's sub-wallet, then applies the 50 / 25 / 25 split above.</li>
              <li>Drains the buyback reserve when it crosses $10. Jupiter swap to the coin, on-chain SPL burn.</li>
              <li>Quotes Imperial for the current decision (open, top-up, or take-profit) and routes to the winning venue.</li>
              <li>Marks the live perp to market and decides whether to open, top up, or take profit.</li>
            </ol>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">8. Position lifecycle</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
              <li><span className="text-foreground">Open.</span> Once $100 of total fees have accrued, the keeper opens the position with $25 collateral at the creator's chosen leverage and direction.</li>
              <li><span className="text-foreground">Top up.</span> Every additional $100 of fees claimed adds +$50 collateral to the same position, at the same leverage.</li>
              <li><span className="text-foreground">Take profit.</span> The keeper watches realized PnL each tick. The base profit-slice threshold is +$5, and it scales up by +$5 for every $1,000 of position size (e.g. $5 at &lt;$1k, $10 at $1k to $2k, $15 at $2k to $3k, and so on). When PnL crosses the current threshold, just enough size is closed to lock in that slice. The released funds are swapped to the coin on Jupiter and burned on-chain. The cycle repeats.</li>
              <li><span className="text-foreground">Losses.</span> If price moves against the position, PnL goes negative. Nothing closes, nothing burns from PnL. Top-ups keep extending runway. The 25% buyback slice still burns from fees regardless.</li>
              <li><span className="text-foreground">Liquidation safety.</span> Each top-up checks effective leverage and liquidation buffer first. If a top-up would push the position above the safety cap or shrink the liq buffer below 25% of collateral, it's skipped and the fees stay queued for the next tick.</li>
              <li><span className="text-foreground">Permanence.</span> The position stays open for the life of the token. There is no graduation event that unwinds it. The coin remains backed by a live leveraged perp on the creator's chosen market, growing with fees, shaving profits into burns, forever.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">9. External tokens (pump.fun)</h2>
            <p className="mt-3 text-muted-foreground">
              perpad also adopts tokens that were launched elsewhere. A pump.fun creator can point their fee receiver at a perpad sub-wallet (one click from the token's page on perpad), pick an underlying market, side, and leverage, and the same keeper loop runs for that coin. To keep the homepage clean, an external token only appears once the first fee claim has actually been routed on-chain. Pending claims and spam mints stay hidden.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">10. The burn flywheel</h2>
            <p className="mt-3 text-muted-foreground">
              Burns leave circulation through two independent paths, both signed by the coin's sub-wallet:
            </p>
            <p className="mt-3 font-mono text-xs text-foreground/80">
              fees claimed, 25% reserve, $10 floor, Jupiter swap to coin, on-chain burn tx
            </p>
            <p className="mt-3 font-mono text-xs text-foreground/80">
              fees claimed, 50% perp margin, position realizes profit threshold (+$5 base, +$5 per $1k of size), slice closed via Imperial, Jupiter swap to coin, on-chain burn tx
            </p>
            <p className="mt-3 text-muted-foreground">
              The first path burns from every fee, win or lose. The second path adds burns on top whenever the perp prints profit. Every step in either chain is a public Solana transaction.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">11. What you can verify</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
              <li>Every SPL mint, pool, fee claim, perp action, buyback swap, and burn is a confirmed mainnet transaction.</li>
              <li>Each coin's sub-wallet is one public address. SOL in matches Meteora fee claims and realized perp profits. SOL out matches Jupiter swaps and margin top-ups, which match on-chain burns and venue position deltas.</li>
              <li>Open perp positions are visible on the routing venue linked from each coin and queryable through the public API at <code className="font-mono text-foreground">/api/public/keeper/tokens</code>.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">12. Risks</h2>
            <p className="mt-3 text-muted-foreground">
              Leverage cuts both ways. A high-leverage (Degen tier) position on the wrong side of a fast move can be liquidated by the venue, in which case the token loses its perp-PnL burn stream until fees rebuild enough to open a new one. The 25% fee-funded buyback keeps burning regardless. The keeper, RPC providers, Meteora, Imperial, and each underlying perp venue are all live dependencies and outages on any of them can pause claims, top-ups, or burns. Pick a market, a side, a leverage, and a coin you actually believe in.
            </p>
          </section>
        </div>

        <div className="mt-12 flex gap-4 font-mono text-[11px] uppercase tracking-[0.18em]">
          <Link to="/launch" className="text-primary hover:underline">launch a coin</Link>
          <Link to="/" className="text-muted-foreground hover:text-foreground">market</Link>

        </div>
      </article>
    </div>
  );
}
