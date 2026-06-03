// Topup-margin flow: open → settle → topup (pure deposit) → settle →
// verify USDC grew but size unchanged → settle → close.
//
// imperialTopUpMargin is a thin wrapper around depositToImperialProfile —
// no /mobile/orders call, no size change. This test pins the contract:
// after a topup, the position's notional MUST be unchanged but the
// profile's USDC grew. (Note: depending on Imperial accounting, the
// collateral attached to the position may or may not increase
// automatically — the deposit lands in the PROFILE balance, not the
// position margin. The keeper's loop subsequently does an
// imperialIncreasePosition with addCollateralUsd to actually attach the
// new collateral.)
//
// Cost: ~$0.30 (open + close + deposit fees).
import { it, expect, beforeAll } from "vitest";
import {
  imperialOpenPosition,
  imperialTopUpMargin,
  imperialClosePosition,
  imperialReadPosition,
} from "../../keeper/src/imperialPerps.js";
import { liveSuite, warnCostOnce, COLLATERAL_USD } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";
import { pickAndFundProfile, getProfileUsdcUi } from "./helpers/profile.js";
import { liveRpcUrl } from "./helpers/rpc.js";
import { pollForFreshPosition, pollForPositionGone } from "./helpers/verify.js";
import { logTxn } from "./helpers/txn-log.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";
import { sleep } from "./helpers/roundtrip.js";

const SETTLE_MS = 5_000;

const VENUE =
  (process.env.FORCE_VENUE as "gmtrade" | "jupiter" | "phoenix" | "flash_trade") || "gmtrade";
const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";
const SIDE: "long" | "short" = "long";

liveSuite(`Imperial — imperialTopUpMargin (${VENUE} ${SYMBOL})`, () => {
  beforeAll(() => warnCostOnce());

  it("open → settle → topup ($5 deposit) → settle → USDC grew, size unchanged → settle → close", async () => {
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
      throw new Error(`open failed before topup could run: ${opened.error}`);
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

    // TOPUP — pure deposit, no size change
    const addCollateralUsd = 5;
    const profileUsdcBefore = await getProfileUsdcUi(auth.token, profileIndex);
    const topup = await imperialTopUpMargin({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      addCollateralUsd,
      solUsd: undefined,
      rpcUrl: liveRpcUrl(),
    });
    expect(
      topup.signature,
      `topup should return a deposit signature. err=${topup.error}`,
    ).toBeTruthy();
    logTxn({
      venue: VENUE,
      action: "topup_margin",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: topup.signature,
      extra: `addColl=$${addCollateralUsd} (deposit only, no size change)`,
    });

    // SETTLE — Imperial indexer needs to see the new balance.
    console.log(`[settle] ${SETTLE_MS}ms after topup...`);
    await sleep(SETTLE_MS);

    const profileUsdcAfter = await getProfileUsdcUi(auth.token, profileIndex);
    expect(
      profileUsdcAfter,
      `profile USDC should have grown from $${profileUsdcBefore.toFixed(2)} by ~$${addCollateralUsd}`,
    ).toBeGreaterThan(profileUsdcBefore + addCollateralUsd * 0.5);

    // Position size should be UNCHANGED (this is the headline contract of
    // imperialTopUpMargin — no /mobile/orders call was made).
    const after = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    expect(after, "position vanished after topup margin").toBeTruthy();
    expect(
      Math.abs(after!.sizeUsd - before!.sizeUsd),
      `size should be unchanged: was $${before!.sizeUsd.toFixed(2)}, now $${after!.sizeUsd.toFixed(2)}`,
    ).toBeLessThan(0.01);

    // SETTLE before close, same reason as above.
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
      `close failed after topup — manually close ${SYMBOL} ${SIDE} on profile ${profileIndex}. err=${closed.error}`,
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
