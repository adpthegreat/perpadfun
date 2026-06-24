import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () => ({
    meta: [
      { title: "How it works, perpspad" },
      { name: "description", content: "perpspad is a Solana launchpad where every coin runs a real Imperial-routed perp on the creator's market of choice. 50+ markets, fee-funded burns, public on-chain treasuries." },
    ],
  }),
});

function DocsPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <article className="mx-auto max-w-2xl px-6 py-16">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">How it works, May 2026</div>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">A Solana launchpad with a live perp on every coin.</h1>

        <div className="prose-content mt-10 space-y-8 text-[15px] leading-relaxed text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">1. The idea</h2>
            <p className="mt-3 text-muted-foreground">
              Most launchpads look the same. Fixed supply, bonding curve, an idle reserve. perpspad keeps the launchpad shape but puts the fees to work. Every coin has its own on-chain sub-wallet that collects 100% of trade fees, opens a leveraged perpetual on the creator's chosen market, and burns supply from both the fee stream and realized profits.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">2. The stack</h2>
            <p className="mt-3 text-muted-foreground">
              Every launch is a real SPL token on Solana mainnet. One billion supply, mint and freeze authority revoked at creation, so the cap is fixed and nobody (including us) can mint more or freeze a holder. Trading runs through a Meteora Dynamic Bonding Curve quoted in SOL, then migrates to Meteora DAMM v2 once the curve fills. Buys and sells are normal Solana swaps, routable through Jupiter, Axiom, or any aggregator.
            </p>
            <p className="mt-3 text-muted-foreground">
              The perp side is routed through Imperial, a meta-router that picks the best venue per trade across Jupiter Perps, Drift, Phoenix, GMX-style and Flash-style books, and others. The position is owned by the coin's public sub-wallet, not by perpspad.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">3. Markets and leverage</h2>
            <p className="mt-3 text-muted-foreground">
              At launch you pick the underlying market and the leverage. Imperial currently covers 50+ markets across crypto majors, Sol-eco / DeFi, memes, US stocks (TSLA, GOOGL, NVDA, AAPL, AMD, MU, MSFT, META, AMZN, SNDK, INTC, CRWV, SPY), commodities (XAU, XAG, WTI, NATGAS, COPPER), and major FX pairs.
            </p>
            <p className="mt-3 text-muted-foreground">
              Leverage is split into two tiers. Base is 2x, 3x, 5x. Degen is 10x, 25x, 50x, 100x, capped by the venue's reported max for that market so you can't pick a leverage Imperial would reject at open. Degen tokens are flagged with a red outline on the homepage.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">4. The fee split</h2>
            <p className="mt-3 text-muted-foreground">
              Every fee claim is split three ways on the same tick.
            </p>
            <ul className="mt-3 space-y-2 text-muted-foreground">
              <li><span className="text-foreground">50% to the perp.</span> Feeds the open gate, then top-ups.</li>
              <li><span className="text-foreground">25% to buyback and burn.</span> Reserved per token, drains to a Jupiter swap and on-chain SPL burn once it crosses $10.</li>
              <li><span className="text-foreground">25% to the treasury reserve.</span> Stays as SOL in the sub-wallet for tx fees, rent, and future top-ups.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">5. The position lifecycle</h2>
            <p className="mt-3 text-muted-foreground">
              The keeper opens once $100 of fees have accrued, with $25 of collateral at the creator's chosen leverage. Every additional $100 of fees adds +$50 collateral to the same position at the same leverage. When realized PnL crosses the profit threshold (+$5 base, +$5 per $1k of size), the keeper closes just enough size to lock in that slice, swaps it to the coin on Jupiter, and burns it on-chain.
            </p>
            <p className="mt-3 text-muted-foreground">
              The position stays open for the life of the token. There is no graduation event that unwinds it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">6. External tokens</h2>
            <p className="mt-3 text-muted-foreground">
              pump.fun creators can adopt perpspad without re-launching. Point your fee receiver at a perpspad sub-wallet, pick a market, side, and leverage, and the same keeper loop runs for your coin. External tokens only show up on the homepage once the first fee claim has actually been routed on-chain.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">7. How it behaves</h2>
            <p className="mt-3 text-muted-foreground">
              <strong className="text-foreground">Leverage cuts both ways.</strong> Pick the side and size you actually believe in. Degen tier (10x and up) can liquidate on the wrong side of a fast move.
            </p>
            <p className="mt-3 text-muted-foreground">
              <strong className="text-foreground">Burns either way.</strong> The 25% buyback path burns from every fee, win or lose. The perp-PnL path adds extra burns on top whenever the position prints profit.
            </p>
            <p className="mt-3 text-muted-foreground">
              <strong className="text-foreground">Fully auditable.</strong> Each coin's sub-wallet is one public address. SOL in matches Meteora fee claims and realized profits. SOL out matches Jupiter swaps and margin top-ups, which match on-chain burns and venue position deltas.
            </p>
          </section>
        </div>

        <div className="mt-12 flex gap-3">
          <Link to="/launch" className="text-sm text-primary hover:underline">Create a coin</Link>
          <Link to="/tokens" className="text-sm text-muted-foreground hover:text-foreground">Browse market</Link>
          <Link to="/paper" className="text-sm text-muted-foreground hover:text-foreground">Whitepaper</Link>
        </div>
      </article>
    </div>
  );
}
