// Partial-close flow: open at $20 notional → settle → partial close half →
// settle → verify size shrunk by ~50%, position still open → settle →
// full close remainder.
//
// imperialPartialClose has a wrinkle (see imperialPerps.js:426): Imperial
// only documented the FULL-close recipe. We're applying the same body shape
// to partials, which the dev should confirm works. This test exercises that
// path live so any divergence (e.g. partial silently full-closes, or
// rejects) surfaces immediately.
//
// Cost: ~$0.40 (open + partial close + full close).
import { it, expect, beforeAll } from "vitest";
import {
  imperialOpenPosition,
  imperialPartialClose,
  imperialClosePosition,
  imperialReadPosition,
} from "../../keeper/src/imperialPerps.js";
import { liveSuite, warnCostOnce, COLLATERAL_USD } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";
import { pickAndFundProfile } from "./helpers/profile.js";
import { pollForFreshPosition, pollForPositionGone } from "./helpers/verify.js";
import { logTxn } from "./helpers/txn-log.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";
import { sleep } from "./helpers/roundtrip.js";

const SETTLE_MS = 5_000;

const VENUE =
  (process.env.FORCE_VENUE as "gmtrade" | "jupiter" | "phoenix" | "flash_trade") || "gmtrade";
const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";
const SIDE: "long" | "short" = "long";

liveSuite(`Imperial — imperialPartialClose (${VENUE} ${SYMBOL})`, () => {
  beforeAll(() => warnCostOnce());

  it("open → settle → partial close ~50% → settle → size shrunk, still open → settle → close remainder", async () => {
    const auth = await liveAuth();
    const { profileIndex, profilePda } = await pickAndFundProfile(auth);
    const leverage = await getVenueMaxLeverageTruncated(VENUE, SYMBOL);
    console.log(`[${VENUE}-${SYMBOL}] using leverage=${leverage}x (live venue max)`);
    const tStart = Math.floor(Date.now() / 1000) - 10;

    // OPEN — use slightly larger collateral so the partial gets a meaningful
    // notional to cut (slippage on tiny partials can land at 0).
    const opened = await imperialOpenPosition({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      collateralUsd: COLLATERAL_USD,
      leverage,
      slippageBps: undefined,
      venue: VENUE,
    });
    if (opened.error && !opened.signature) {
      throw new Error(`open failed before partial-close could run: ${opened.error}`);
    }
    await pollForFreshPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      since: tStart,
      log: (m) => console.log(`[open-verify] ${m}`),
    });
    logTxn({
      venue: VENUE,
      action: "open",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: opened.signature,
      extra: `coll=$${COLLATERAL_USD} lev=${leverage}x`,
    });

    console.log(`[settle] ${SETTLE_MS}ms before reading position...`);
    await sleep(SETTLE_MS);

    const before = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    expect(before).toBeTruthy();

    // PARTIAL CLOSE — half the size
    const halfSize = before!.sizeUsd / 2;
    const partial = await imperialPartialClose({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      reduceSizeUsd: halfSize,
      currentSizeUsd: before!.sizeUsd,
      slippageBps: undefined,
      venue: VENUE,
    });
    expect(
      partial.signature || !partial.error,
      `partial close should not error. err=${partial.error}`,
    ).toBeTruthy();
    logTxn({
      venue: VENUE,
      action: "close_partial",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: partial.signature,
      extra: `cut=50% halfSize=$${halfSize.toFixed(2)} of $${before!.sizeUsd.toFixed(2)}`,
    });

    // SETTLE — wait for indexer + on-chain to converge before re-reading.
    console.log(`[settle] ${SETTLE_MS}ms after partial close...`);
    await sleep(SETTLE_MS);

    const after = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    expect(
      after,
      "position vanished after partial close — Imperial may have full-closed instead. " +
        "If this fires, imperialPerps.js:426 (`partial body shape is the same as full`) " +
        "is wrong and needs revising.",
    ).toBeTruthy();
    // Size should be ~50% smaller. Wide tolerance (40-60%) for slippage.
    const reduction = before!.sizeUsd - after!.sizeUsd;
    const reductionPct = reduction / before!.sizeUsd;
    expect(
      reductionPct,
      `partial close should have reduced size by ~50%; got ${(reductionPct * 100).toFixed(1)}%`,
    ).toBeGreaterThan(0.4);
    expect(reductionPct).toBeLessThan(0.6);

    // SETTLE before full close, same reason as above.
    console.log(`[settle] ${SETTLE_MS}ms before full close...`);
    await sleep(SETTLE_MS);

    // FULL CLOSE the remainder
    const closed = await imperialClosePosition({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      sizeUsd: after!.sizeUsd,
      leverage,
      slippageBps: undefined,
      venue: VENUE,
    });
    const gone = await pollForPositionGone({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      log: (m) => console.log(`[close-verify] ${m}`),
    });
    expect(
      gone,
      `full close (of remainder) failed — manually close ${SYMBOL} ${SIDE} on profile ${profileIndex}. err=${closed.error}`,
    ).toBe(true);
    logTxn({
      venue: VENUE,
      action: "close_full",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: closed.signature,
      extra: `sizeUsd=$${after!.sizeUsd.toFixed(2)} (remainder after partial)`,
    });
  }, 240_000);
});
