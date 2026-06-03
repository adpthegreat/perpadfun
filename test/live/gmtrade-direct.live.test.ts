// DIRECT gmtrade round-trip — bypasses imperialPerps.js's
// SUPPORTED_OPEN_VENUES gate AND imperial.js placeOrder()'s
// routingMode='live' precondition.
//
// Purpose: positive control. The working imperial-order-probe.mjs has been
// placing gmtrade orders successfully for months using THE SAME body shape +
// header set we use here. If this test passes, the silent-no-op failure on
// phoenix/flash_trade is venue-specific (Imperial server side), not a
// problem with our client. If this also fails, there's a wallet-level issue
// we haven't identified.
//
// LIQUIDATION RISK: at venue max leverage a 1% mark move between open and
// close can liquidate the position.
//
// Cost expectation: $0.05-$0.20 per run.
import { it, expect, beforeAll } from "vitest";
import { legacyVenueSuite, warnCostOnce } from "./helpers/live.js";
import { runDirectRoundtrip } from "./helpers/direct-roundtrip.js";

const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";

legacyVenueSuite(`Imperial DIRECT round-trip — gmtrade ${SYMBOL} (positive control)`, () => {
  beforeAll(() => warnCostOnce());

  it("markPrice → /route warm → open → settle → partial close → settle → full close", async () => {
    const result = await runDirectRoundtrip({
      venue: "gmtrade",
      symbol: SYMBOL,
      side: "long",
      leverage: 15,
      slippageBps: 500, // 5% — wide tolerance to rule out slippage as the cause
      preRegisterPhoenix: false, // n/a for gmtrade
    });

    expect(result.usdcDrainOnOpen, "open should have drained ≥half collateral").toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(result.positionAfterPartial, "partial close should have left position open").toBeTruthy();
    expect(result.positionAfterPartial!.sizeUsd).toBeLessThan(result.positionAfterOpen.sizeUsd);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
