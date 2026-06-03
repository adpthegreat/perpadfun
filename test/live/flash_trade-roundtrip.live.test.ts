// Live round-trip on flash_trade — PHASE B VERIFICATION GATE.
//
// Same expectation as phoenix-roundtrip.live.test.ts: FAILS pre-Phase-B,
// PASSES once the flash_trade-specific accounts (`marketAddress`,
// `poolAddress`, `targetCustody`, `collateralCustody`, `targetOracle`,
// per-side row selection) are wired into buildOrderBody.
//
// Flash_trade has an additional gotcha: rows in /flash/markets are
// side-specific. resolveMarket() already keys by `${symbol}:${side}:${venue}`
// so the right row is picked, but the (`side` body field === picked row's
// `side`) consistency needs to hold after Phase B. The roundtrip helper
// uses `side: "long"` here; running the same test with `LIVE_TEST_FLIP_SIDE=1`
// (TODO in helpers/live.ts) would test the short path.
//
// PYTH is the chosen symbol: /route always picks flash_trade for PYTH
// because it's the only venue that supports 2x for PYTH.
//
// Cost: ~$0.20 per run after it works; $0 pre-Phase-B (silent no-op).
import { it, expect, beforeAll } from "vitest";
import { flashSuite, warnCostOnce } from "./helpers/live.js";
import { runRoundtrip } from "./helpers/roundtrip.js";

flashSuite("Imperial round-trip — flash_trade (Phase B verification gate)", () => {
  beforeAll(() => warnCostOnce());

  it("opens PYTH long via flash_trade, verifies on-chain fill, closes", async () => {
    const result = await runRoundtrip({
      venue: "flash_trade",
      symbol: "PYTH",
      side: "long",
    });
    expect(result.usdcDrainOnOpen).toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
