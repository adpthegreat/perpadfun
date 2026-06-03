// Increase position flow: open → settle → increase (+collateral, +size) →
// settle → verify both grew → settle → close.
//
// Mirrors keeper/scripts/imperial-topup-probe.mjs as a structured test.
// Default venue is gmtrade for now (only fully verified open path); flip to
// FORCE_VENUE=phoenix or flash_trade after Phase B passes.
//
// Cost: ~$0.40 (two open-like transactions + close).
import { it, expect, beforeAll } from "vitest";
import {
  imperialOpenPosition,
  imperialIncreasePosition,
  imperialClosePosition,
  imperialReadPosition,
} from "../../keeper/src/imperialPerps.js";
import { liveSuite, warnCostOnce, COLLATERAL_USD } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";
import { pickAndFundProfile } from "./helpers/profile.js";
import { liveRpcUrl } from "./helpers/rpc.js";
import { pollForFreshPosition, pollForPositionGone, snapshotUsdc } from "./helpers/verify.js";
import { logTxn } from "./helpers/txn-log.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";
import { sleep } from "./helpers/roundtrip.js";

const SETTLE_MS = 5_000;

const VENUE =
  (process.env.FORCE_VENUE as "gmtrade" | "jupiter" | "phoenix" | "flash_trade") || "gmtrade";
const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";
const SIDE: "long" | "short" = "long";

liveSuite(`Imperial — imperialIncreasePosition (${VENUE} ${SYMBOL})`, () => {
  beforeAll(() => warnCostOnce());

  it("open → settle → increase (+coll, +size) → settle → verify both grew → settle → close", async () => {
    const auth = await liveAuth();
    const { profileIndex, profilePda } = await pickAndFundProfile(auth);
    const leverage = await getVenueMaxLeverageTruncated(VENUE, SYMBOL);
    console.log(`[${VENUE}-${SYMBOL}] using leverage=${leverage}x (live venue max)`);
    const tStart = Math.floor(Date.now() / 1000) - 10;

    // OPEN
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
      throw new Error(`open failed before increase could run: ${opened.error}`);
    }
    const fresh = await pollForFreshPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      since: tStart,
      log: (m) => console.log(`[open-verify] ${m}`),
    });
    expect(fresh, "open didn't produce a fresh position").toBeTruthy();
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

    // SETTLE before reading the position size — Imperial's indexer can lag
    // the on-chain open by a few seconds and a fast read here can return
    // partial state.
    console.log(`[settle] ${SETTLE_MS}ms before reading position...`);
    await sleep(SETTLE_MS);

    const before = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    expect(before, "position not visible via imperialReadPosition after open").toBeTruthy();

    // INCREASE: add $5 collateral and $10 of size (= $5 × 2x lev)
    const addCollateralUsd = 5;
    const addSizeUsd = addCollateralUsd * leverage;
    const usdcBeforeIncrease = await snapshotUsdc(auth.token, profileIndex);

    const inc = await imperialIncreasePosition({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
      addSizeUsd,
      addCollateralUsd,
      leverage,
      slippageBps: undefined,
      solUsd: undefined,
      rpcUrl: liveRpcUrl(),
      venue: VENUE,
    });
    expect(inc.depositPrep, "depositPrep should be set when addCollateralUsd > 0").toBeTruthy();
    logTxn({
      venue: VENUE,
      action: "increase",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: inc.signature,
      extra: `addColl=$${addCollateralUsd} addSize=$${addSizeUsd}`,
    });

    // SETTLE — let the increase tx confirm + the indexer catch up before
    // re-reading the position.
    console.log(`[settle] ${SETTLE_MS}ms after increase before re-read...`);
    await sleep(SETTLE_MS);

    const after = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    expect(after, "position vanished after increase").toBeTruthy();
    expect(
      after!.sizeUsd,
      `size should have grown from $${before!.sizeUsd.toFixed(2)} by ~$${addSizeUsd}`,
    ).toBeGreaterThan(before!.sizeUsd);
    expect(
      after!.collateralUsd,
      `collateral should have grown from $${before!.collateralUsd.toFixed(2)} by ~$${addCollateralUsd}`,
    ).toBeGreaterThan(before!.collateralUsd);

    const usdcAfterIncrease = await snapshotUsdc(auth.token, profileIndex);
    // Profile USDC should have DECREASED (the deposit went into the position).
    // Wide tolerance: Imperial's accounting can be a few cents off depending
    // on slippage.
    expect(usdcAfterIncrease).toBeLessThanOrEqual(usdcBeforeIncrease + 0.5);

    // SETTLE before the final close, same reason as above.
    console.log(`[settle] ${SETTLE_MS}ms before close...`);
    await sleep(SETTLE_MS);

    // CLOSE
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
      `close failed after increase — manually close ${SYMBOL} ${SIDE} on profile ${profileIndex}. err=${closed.error}`,
    ).toBe(true);
    logTxn({
      venue: VENUE,
      action: "close_full",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: closed.signature,
      extra: `sizeUsd=$${after!.sizeUsd.toFixed(2)}`,
    });
  }, 240_000);
});
