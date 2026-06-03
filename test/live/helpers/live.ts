// Live-test gate. Every *.live.test.ts in this folder MUST import `liveSuite`
// and use it instead of `describe` so the tests skip cleanly when the operator
// hasn't opted in.
//
// Opt-in: set IMPERIAL_LIVE_TESTS=1 in the environment.
// Per-venue opt-in: each round-trip file pins FORCE_VENUE internally so it
// runs whenever IMPERIAL_LIVE_TESTS=1.
import { describe } from "vitest";

export const LIVE_OPT_IN = process.env.IMPERIAL_LIVE_TESTS === "1";

// Legacy-venue gate. Per KEEPER_PHOENIX_LOCK.md Phase D, gmtrade/jupiter live
// tests are gated separately. Phoenix tests stay under the main `liveSuite`
// gate. Flash tests are gated under FLASH_TESTS until the polling issue is
// resolved.
export const LEGACY_VENUE_OPT_IN = process.env.LEGACY_VENUE_TESTS === "1";
export const FLASH_OPT_IN = process.env.FLASH_TESTS === "1";

export function liveSuite(name: string, fn: () => void): void {
  if (!LIVE_OPT_IN) {
    describe.skip(`${name} [skipped — set IMPERIAL_LIVE_TESTS=1 to enable]`, fn);
    return;
  }
  describe(name, fn);
}

/** Gate for gmtrade/jupiter legacy venue tests. Requires both opt-ins. */
export function legacyVenueSuite(name: string, fn: () => void): void {
  if (!LIVE_OPT_IN) {
    describe.skip(`${name} [skipped — set IMPERIAL_LIVE_TESTS=1 to enable]`, fn);
    return;
  }
  if (!LEGACY_VENUE_OPT_IN) {
    describe.skip(
      `${name} [LEGACY — set LEGACY_VENUE_TESTS=1 to enable; venue deprecated per KEEPER_PHOENIX_LOCK.md]`,
      fn,
    );
    return;
  }
  describe(name, fn);
}

/** Gate for flash_trade tests. Requires both opt-ins. */
export function flashSuite(name: string, fn: () => void): void {
  if (!LIVE_OPT_IN) {
    describe.skip(`${name} [skipped — set IMPERIAL_LIVE_TESTS=1 to enable]`, fn);
    return;
  }
  if (!FLASH_OPT_IN) {
    describe.skip(
      `${name} [DEFERRED — set FLASH_TESTS=1 to enable; flash partial-close polling issue tracked separately]`,
      fn,
    );
    return;
  }
  describe(name, fn);
}

// Default knobs for round-trip sizing. Lowering collateral below
// MIN_COLLATERAL_USD (10) makes Imperial reject the open; the env override
// lets you scale up but not down.
export const COLLATERAL_USD = Math.max(10, Number(process.env.LIVE_TEST_COLLATERAL_USD || 10));
export const LEVERAGE = Math.max(1, Number(process.env.LIVE_TEST_LEVERAGE || 2));

// Print a one-time cost-warning banner when the live suite is enabled so the
// operator can't say they weren't warned.
let _warned = false;
export function warnCostOnce(): void {
  if (_warned || !LIVE_OPT_IN) return;
  _warned = true;
  // Direct stderr write — vitest swallows stdout from helpers but lets stderr through.
  process.stderr.write(
    "\n[live-suite] IMPERIAL_LIVE_TESTS=1 — round-trip tests will SPEND REAL FUNDS " +
      `(collateral=$${COLLATERAL_USD}, lev=${LEVERAGE}x). Per-test cost ~$0.20-$0.40. ` +
      "Each test ends with a verified close; if a close fails you'll have an open position " +
      "to clean up via the Imperial frontend.\n\n",
  );
}
