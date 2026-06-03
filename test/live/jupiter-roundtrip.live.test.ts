// Live round-trip on jupiter — CONTROL VENUE (post-gmtrade fallback).
//
// **JUPITER DOES NOT LIST HYPE.** Jupiter's perp universe is limited to BTC,
// ETH, and SOL. So while every other live test in this directory uses
// HYPE LONG at max leverage, this one stays on BTC LONG at jupiter's max
// (typically 50x). It exists as a control: when phoenix/flash_trade tests
// fail with venue-specific issues, this proves the rig itself works.
//
// LIQUIDATION RISK: at jupiter max leverage a 1-2% mark move between open
// and close can liquidate the position.
//
// Cost expectation: $0.10-$0.30 per run.
import { it, expect, beforeAll } from "vitest";
import { legacyVenueSuite, warnCostOnce } from "./helpers/live.js";
import { runRoundtrip } from "./helpers/roundtrip.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";

// BTC because jupiter doesn't support HYPE. Override via FORCE_SYMBOL only
// if you know jupiter routes it.
const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "BTC";

legacyVenueSuite(`Imperial round-trip — jupiter ${SYMBOL} (control)`, () => {
  beforeAll(() => warnCostOnce());

  it("opens BTC long at jupiter max lev (HYPE n/a), verifies fill, partial closes, full closes", async () => {
    const leverage = await getVenueMaxLeverageTruncated("jupiter", SYMBOL);
    console.log(`[jupiter-roundtrip] using ${SYMBOL} @ ${leverage}x (live venue max)`);

    const result = await runRoundtrip({
      venue: "jupiter",
      symbol: SYMBOL,
      side: "long",
      leverage,
    });
    expect(result.usdcDrainOnOpen).toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
