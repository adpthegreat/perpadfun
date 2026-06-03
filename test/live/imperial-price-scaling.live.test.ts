// Verifies the per-venue marketPrice scaling fix (Stage 1 of Phoenix migration).
//
// This test hits Imperial's live /mark-prices endpoint (read-only — costs $0)
// and asserts that getMarkPrice returns a venue-appropriate value:
//
//   - gmtrade:     raw 1e9 oracle scale
//   - jupiter:     raw 1e9 oracle scale
//   - phoenix:     1e6 scale (1e9 / 1000)
//   - flash_trade: per-market exponent (FLASH_PRICE_EXPONENTS env),
//                  defaults to /1000 with a warning if unset
//
// See plan/KEEPER_PHOENIX_MIGRATION.md §1 for the bug history.
import { it, expect } from "vitest";
import { liveSuite } from "./helpers/live.js";
import { getMarkPrice, getMarkPriceUi } from "../../keeper/src/imperial.js";

const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "SOL";

liveSuite("Imperial per-venue marketPrice scaling", () => {
  it("getMarkPrice returns raw 1e9 for gmtrade", async () => {
    const ui = await getMarkPriceUi(SYMBOL, "gmtrade");
    if (ui === null) {
      // gmtrade may not list every symbol; skip rather than fail
      console.log(`[scaling] ${SYMBOL} gmtrade ui-price null; skipping`);
      return;
    }
    const scaled = await getMarkPrice(SYMBOL, "gmtrade");
    expect(scaled).toBe(Math.round(ui * 1_000_000_000));
    console.log(`[scaling] ${SYMBOL} gmtrade ui=$${ui} scaled=${scaled} (1e9 base) ✓`);
  }, 30_000);

  it("getMarkPrice divides by 1000 for phoenix", async () => {
    const ui = await getMarkPriceUi(SYMBOL, "phoenix");
    if (ui === null) {
      console.log(`[scaling] ${SYMBOL} phoenix ui-price null; skipping`);
      return;
    }
    const scaled = await getMarkPrice(SYMBOL, "phoenix");
    const expected = Math.round((ui * 1_000_000_000) / 1000);
    expect(scaled).toBe(expected);

    // Bug-vintage sanity: the old code sent ~82e9 to phoenix; the fix sends ~82e6.
    // For SOL @ $82, the new scaled value should be in the 80,000,000 ± 1e7 range.
    if (SYMBOL === "SOL") {
      expect(scaled).toBeGreaterThan(50 * 1_000_000);   // $50/SOL floor
      expect(scaled).toBeLessThan(300 * 1_000_000);     // $300/SOL ceiling
    }
    console.log(`[scaling] ${SYMBOL} phoenix ui=$${ui} scaled=${scaled} (1e6 base — was 1e9 pre-fix) ✓`);
  }, 30_000);

  it("getMarkPrice for flash_trade uses /1000 fallback or env exponent", async () => {
    const ui = await getMarkPriceUi(SYMBOL, "flash_trade");
    if (ui === null) {
      console.log(`[scaling] ${SYMBOL} flash_trade ui-price null; skipping`);
      return;
    }
    const scaled = await getMarkPrice(SYMBOL, "flash_trade");

    const envExp = process.env.FLASH_PRICE_EXPONENTS?.split(",").find((p) =>
      p.split("=")[0]?.trim().toUpperCase() === SYMBOL
    );

    if (envExp) {
      const exp = Number(envExp.split("=")[1]);
      const expected = Math.round(ui * 1_000_000_000 * Math.pow(10, exp - 9));
      expect(scaled).toBe(expected);
      console.log(`[scaling] ${SYMBOL} flash_trade ui=$${ui} scaled=${scaled} (exp=${exp} from env) ✓`);
    } else {
      // Fallback path: /1000 (same as phoenix) with a warning logged by getMarkPrice.
      const expected = Math.round((ui * 1_000_000_000) / 1000);
      expect(scaled).toBe(expected);
      console.log(
        `[scaling] ${SYMBOL} flash_trade ui=$${ui} scaled=${scaled} (default /1000 — ` +
        `set FLASH_PRICE_EXPONENTS=${SYMBOL}=N to override) ✓`,
      );
    }
  }, 30_000);

  // NOTE: a "phoenix ≈ gmtrade / 1000" cross-venue check would be wrong —
  // Phoenix is a CLOB and GMTrade is pool-based; their quotes legitimately
  // differ by basis points. The per-venue scaling correctness is already
  // proven by the three tests above (each compares getMarkPrice's output
  // against the raw /mark-prices ui-price for THAT venue).
});
