// Live round-trip on gmtrade — CONTROL VENUE (deprecated).
//
// Target: HYPE LONG at gmtrade's max leverage (fetched at runtime).
//
// LIQUIDATION RISK: at max leverage a 1% mark move between open and close
// can liquidate the position and burn the full collateral.
//
// Cost expectation: $0.10-$0.30 per run.
import { it, expect, beforeAll } from "vitest";
import { legacyVenueSuite, warnCostOnce } from "./helpers/live.js";
import { runRoundtrip } from "./helpers/roundtrip.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";

const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";

legacyVenueSuite(`Imperial round-trip — gmtrade ${SYMBOL} (control / max leverage)`, () => {
  beforeAll(() => warnCostOnce());

  it("opens HYPE long at gmtrade max lev, verifies on-chain fill, partial closes, full closes", async () => {
    const leverage = await getVenueMaxLeverageTruncated("gmtrade", SYMBOL);
    console.log(`[gmtrade-roundtrip] using ${SYMBOL} @ ${leverage}x (live venue max)`);

    const result = await runRoundtrip({
      venue: "gmtrade",
      symbol: SYMBOL,
      side: "long",
      leverage: 10,
    });
    expect(result.usdcDrainOnOpen).toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
