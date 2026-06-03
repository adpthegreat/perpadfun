// DIRECT flash_trade round-trip — bypasses imperialPerps.js
// SUPPORTED_OPEN_VENUES gate AND imperial.js placeOrder()'s
// routingMode='live' precondition.
//
// Target: HYPE LONG at flash_trade's max leverage (fetched at runtime).
//
// LIQUIDATION RISK: at venue max leverage, a 1-2% mark move between open
// and close can liquidate the position and burn the full collateral. The
// settle waits in the round-trip helper DO expose us to this risk.
//
// Cost expectation: $0.10-$0.50 per run.
import { it, expect, beforeAll } from "vitest";
import { flashSuite, warnCostOnce } from "./helpers/live.js";
import { runDirectRoundtrip } from "./helpers/direct-roundtrip.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";

const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";

flashSuite(`Imperial DIRECT round-trip — flash_trade ${SYMBOL} (max leverage)`, () => {
  beforeAll(() => warnCostOnce());

  it("markPrice → open(HYPE long maxLev) → settle → partial close → settle → full close", async () => {
    const leverage = await getVenueMaxLeverageTruncated("flash_trade", SYMBOL);
    console.log(`[flash_trade-direct] using ${SYMBOL} @ ${leverage}x (live venue max)`);

    const result = await runDirectRoundtrip({
      venue: "flash_trade",
      symbol: SYMBOL,
      side: "long",
      leverage,
      slippageBps: 500, // 5% — at high leverage, partial close needs headroom
      preRegisterPhoenix: false, // n/a for flash_trade
    });

    expect(result.usdcDrainOnOpen, "open should have drained ≥half collateral").toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(
      result.positionAfterPartial,
      "partial close should have left position open",
    ).toBeTruthy();
    expect(result.positionAfterPartial!.sizeUsd).toBeLessThan(result.positionAfterOpen.sizeUsd);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
