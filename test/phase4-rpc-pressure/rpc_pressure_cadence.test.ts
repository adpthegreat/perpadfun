// Problem #4 - RPC pressure (TEST_PLAN.md 0.5). The keeper used to probe EVERY
// token every tick, so idle "PEND-*" spam dominated the per-tick RPC budget and
// caused 429s. The 4b hot/warm/cold cadence filter (shouldSkipColdTick) fixes it.
//
// This is pure logic (no DB): the cadence is computed in-memory on the loaded
// feed BEFORE any RPC, which is exactly the point - it decides what NOT to probe.
// We generate a randomized 100-token fleet, run the REAL exported filter over a
// sequence of ticks, and prove idle tokens are NOT probed every tick while tokens
// with the hot criteria are.
import { describe, it, expect, beforeEach } from "vitest";
import {
  tokenHasWork,
  shouldSkipColdTick,
  COLD_PROBE_INTERVAL_MS,
  _resetColdProbe,
} from "../../keeper/src/loop.js";
import { makeTokenFleet } from "../helpers/fleet.ts";

beforeEach(() => {
  _resetColdProbe(); // clear the per-token probe clock so ticks are deterministic
});

describe("Problem #4: RPC pressure - hot/warm/cold tick cadence", () => {
  it("classifies a randomized 100-token fleet on a fresh tick (hot=process, deferred=skip, idle=first-probe)", () => {
    const fleet = makeTokenFleet(100);
    const now = Date.now();
    for (const t of fleet) {
      const skipped = shouldSkipColdTick(t, now);
      if (t._expect === "process") expect(skipped).toBe(false); // hot -> always processed
      else if (t._expect === "defer") expect(skipped).toBe(true); // future next_retry_at -> skipped
      else expect(skipped).toBe(false); // idle -> first probe of a fresh clock runs
    }
  });

  it("idle tokens are NOT probed every tick; hot tokens ARE (the RPC-pressure proof)", () => {
    const fleet = makeTokenFleet(100);
    const start = Date.now();
    const TICK_MS = 30_000;
    const TICKS = 10;
    // sanity: all ticks fall inside one cold-probe window
    expect(TICK_MS * (TICKS - 1)).toBeLessThan(COLD_PROBE_INTERVAL_MS);

    const probes = new Map<string, number>();
    for (let k = 0; k < TICKS; k++) {
      const now = start + k * TICK_MS;
      for (const t of fleet) {
        if (!shouldSkipColdTick(t, now)) probes.set(t.id, (probes.get(t.id) ?? 0) + 1);
      }
    }

    for (const t of fleet) {
      const n = probes.get(t.id) ?? 0;
      if (t._expect === "process") expect(n).toBe(TICKS); // hot: probed every tick
      else if (t._expect === "throttle") expect(n).toBe(1); // idle: once per interval, NOT every tick
      else expect(n).toBe(0); // deferred: skipped until its retry time
    }

    // Aggregate: idle probing collapses from (count * TICKS) to (count * 1).
    const idle = fleet.filter((t) => t._expect === "throttle");
    const idleProbes = idle.reduce((a, t) => a + (probes.get(t.id) ?? 0), 0);
    expect(idleProbes).toBe(idle.length);
    expect(idleProbes).toBeLessThan(idle.length * TICKS); // strictly fewer than every-tick
  });

  it("a cold token that GAINS work becomes hot immediately (probed every tick thereafter)", () => {
    const idle = makeTokenFleet(12).find((t) => t._expect === "throttle")!;
    const start = Date.now();
    expect(shouldSkipColdTick(idle, start)).toBe(false); // tick 1: first probe
    expect(shouldSkipColdTick(idle, start + 30_000)).toBe(true); // tick 2: throttled (within window)

    // it just opened a position -> now hot
    idle.position_opened_at = new Date().toISOString();
    idle.token_workflows = { state: "position_open", next_retry_at: null };
    expect(tokenHasWork(idle)).toBe(true);
    expect(shouldSkipColdTick(idle, start + 60_000)).toBe(false); // hot now -> processed
    expect(shouldSkipColdTick(idle, start + 90_000)).toBe(false); // and every tick after
  });

  it("a cold token is RE-probed after the interval (still catches new fees - not skipped forever)", () => {
    const idle = makeTokenFleet(12).find((t) => t._expect === "throttle")!;
    const start = Date.now();
    expect(shouldSkipColdTick(idle, start)).toBe(false); // probed
    expect(shouldSkipColdTick(idle, start + COLD_PROBE_INTERVAL_MS - 1)).toBe(true); // throttled within window
    expect(shouldSkipColdTick(idle, start + COLD_PROBE_INTERVAL_MS + 1)).toBe(false); // re-probed after window
  });
});
