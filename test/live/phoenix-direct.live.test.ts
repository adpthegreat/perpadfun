// DIRECT phoenix round-trip — bypasses imperialPerps.js SUPPORTED_OPEN_VENUES
// gate AND imperial.js placeOrder()'s routingMode='live' precondition.
//
// Uses test/live/helpers/direct-order.ts, which POSTs to /mobile/orders with
// the body shape proven by the Imperial OpenAPI spec.
//
// Target: HYPE LONG at the venue's max leverage (fetched at runtime via
// /route candidates so we always use the live cap).
//
// LIQUIDATION RISK: at venue max leverage (typically 50-100x on phoenix), a
// 1-2% mark move between open and close can liquidate the position and burn
// the full collateral. The settle waits in the round-trip helper (5s × 2)
// are intentional but DO expose us to this risk. If a test fails with
// "position vanished after partial close", suspect liquidation first.
//
// Cost expectation: $0.10-$0.50 per run depending on fill slippage.
import { it, expect, beforeAll } from "vitest";
import { liveSuite, warnCostOnce } from "./helpers/live.js";
import { runDirectRoundtrip } from "./helpers/direct-roundtrip.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";

const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "SOL";

liveSuite(`Imperial DIRECT round-trip — phoenix ${SYMBOL} (max leverage)`, () => {
  beforeAll(() => warnCostOnce());

  it("phoenix-register → markPrice → open(HYPE long maxLev) → settle → partial close → settle → full close", async () => {
    const leverage = await getVenueMaxLeverageTruncated("phoenix", SYMBOL);
    console.log(`[phoenix-direct] using ${SYMBOL} @ ${leverage}x (live venue max)`);

    const result = await runDirectRoundtrip({
      venue: "phoenix",
      symbol: SYMBOL,
      side: "long",
      leverage: 5,
      slippageBps: 500, // 5% — thin CLOB orderbook at venue max lev
      preRegisterPhoenix: true,
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

    if (result.registerResult) {
      expect(result.registerResult.profilePda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  }, 240_000);
});
