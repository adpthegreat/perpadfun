// Live round-trip on phoenix — PHASE B VERIFICATION GATE.
//
// This test is EXPECTED TO FAIL today and EXPECTED TO PASS after Phase B
// of plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md wires the venue-specific
// account fields (`orderbook`, `perpAssetMap`, `subaccountIndex`, etc.)
// into the /mobile/orders body.
//
// Pre-Phase-B failure modes (all of which the helper output will surface):
//   1. SUPPORTED_OPEN_VENUES gate trips → `venue phoenix not yet supported`
//      error. Fix: edit imperialPerps.js:254 to include 'phoenix'.
//   2. Order 200-OKs but no on-chain fill → USDC-drain refund detection
//      fires → "silent no-op detected" assertion failure. Fix: wire the
//      Phase A spec into buildOrderBody.
//   3. Position appears but with wrong size → the position-row assertions
//      catch the discrepancy.
//
// Cost: ~$0.20 per run AFTER it works. Pre-Phase-B, the failed open does
// NOT cost money (silent no-op = no on-chain side effect).
import { it, expect, beforeAll } from "vitest";
import { liveSuite, warnCostOnce } from "./helpers/live.js";
import { runRoundtrip } from "./helpers/roundtrip.js";

liveSuite("Imperial round-trip — phoenix (Phase B verification gate)", () => {
  beforeAll(() => warnCostOnce());

  it("opens SOL long via phoenix, verifies on-chain fill, closes", async () => {
    // SOL is the safest phoenix test target: highest liquidity, tightest
    // spreads, and /route's preferred venue for SOL is phoenix today.
    const result = await runRoundtrip({
      venue: "phoenix",
      symbol: "SOL",
      side: "long",
    });
    expect(result.usdcDrainOnOpen).toBeGreaterThan(0);
    expect(result.positionAfterOpen.sizeUsd).toBeGreaterThan(0);
    expect(result.positionAfterOpen.collateralUsd).toBeGreaterThan(0);
    expect(result.usdcReturnOnClose).toBeGreaterThan(0);
  }, 240_000);
});
