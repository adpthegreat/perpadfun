// Per-venue marketPrice scaling — Stage 1 of the Phoenix migration.
//
// Background: Imperial's /mark-prices returns prices in a uniform 1e9 scale.
// Each venue's downstream order processor expects a different on-chain layout:
//   - gmtrade / jupiter: read raw 1e9                     -> no scaling
//   - phoenix:           frontend sends 1e6; downstream ×1000 makes 1e9 on-chain
//   - flash_trade:       per-market exponent (FLASH_PRICE_EXPONENTS env)
//
// Without this scaling, Phoenix sees prices ~1000× too large and CLOB rejects
// IOC orders. Flash sees an oracle mismatch and the open fails.
// See plan/KEEPER_PHOENIX_MIGRATION.md §1 for the full bug history.
import { describe, it, expect } from "vitest";

// `__scaleMarketPriceForVenue` is exported from imperial.js for testing.
import { __scaleMarketPriceForVenue, __FLASH_PRICE_EXPONENTS } from "../../keeper/src/imperial.js";

const ONE_E9 = 1_000_000_000;
const ONE_E6 = 1_000_000;

describe("scaleMarketPriceForVenue", () => {
  // SOL @ $82.375 in canonical 1e9 oracle scale.
  const SOL_BASE = Math.round(82.375 * ONE_E9); // 82_375_000_000

  it("passes through 1e9 unchanged for gmtrade", () => {
    const out = __scaleMarketPriceForVenue(SOL_BASE, "gmtrade", "SOL");
    expect(out).toBe(SOL_BASE);
  });

  it("passes through 1e9 unchanged for jupiter", () => {
    const out = __scaleMarketPriceForVenue(SOL_BASE, "jupiter", "SOL");
    expect(out).toBe(SOL_BASE);
  });

  it("divides by 1000 for phoenix (so downstream ×1000 produces 1e9 on-chain)", () => {
    const out = __scaleMarketPriceForVenue(SOL_BASE, "phoenix", "SOL");
    expect(out).toBe(Math.round(SOL_BASE / 1000));
    // Should land in the 1e6 ballpark
    expect(out).toBeGreaterThan(8 * ONE_E6);
    expect(out).toBeLessThan(83 * ONE_E6);
  });

  it("passes through raw 1e9 for flash_trade by default", () => {
    // Empirically flash_trade accepts raw 1e9, same as gmtrade/jupiter.
    // The FLASH_PRICE_EXPONENTS override is kept for safety only.
    const out = __scaleMarketPriceForVenue(SOL_BASE, "flash_trade", "SOL");
    expect(out).toBe(SOL_BASE);
  });

  it("returns null when mp is null", () => {
    expect(__scaleMarketPriceForVenue(null, "phoenix", "SOL")).toBeNull();
    expect(__scaleMarketPriceForVenue(0, "phoenix", "SOL")).toBeNull();
    expect(__scaleMarketPriceForVenue(undefined, "phoenix", "SOL")).toBeNull();
  });

  it("handles BTC at 1e9 base scale for phoenix correctly", () => {
    // BTC @ $68,000
    const BTC_BASE = Math.round(68_000 * ONE_E9);
    const out = __scaleMarketPriceForVenue(BTC_BASE, "phoenix", "BTC");
    // Expected: 68_000 * 1e6 = 68_000_000_000
    expect(out).toBe(68_000 * ONE_E6);
  });

  it("rounds to integer", () => {
    // A price that doesn't divide cleanly by 1000.
    const PRICE = 82_375_500_003; // would be 82375500.003 if divided
    const out = __scaleMarketPriceForVenue(PRICE, "phoenix", "SOL");
    expect(Number.isInteger(out)).toBe(true);
    expect(out).toBe(82_375_500);
  });
});

describe("FLASH_PRICE_EXPONENTS parser", () => {
  it("starts empty when env var not set", () => {
    // Under vitest the env is not set; parser returns {}
    expect(__FLASH_PRICE_EXPONENTS).toEqual({});
  });
});
