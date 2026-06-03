// Withdraw-collateral flow — BEST-EFFORT.
//
// imperialWithdrawCollateral is marked _TODO_VERIFY_ in imperialPerps.js:31-34:
// the keeper assumes /deposit/build-tx { mode: 'withdraw' } parallels the
// deposit shape, but Imperial may use a different endpoint (the OpenAPI spec
// confirms /mobile/orders/collateral is the right one — see
// test/live/helpers/imperial-order-protocol.ts §/mobile/orders/collateral).
//
// Flow: open → settle → withdraw $5 from the profile → settle → verify
// sub-wallet USDC increased + profile USDC decreased → settle → close.
//
// Expected outcomes:
//   - Imperial returns a signed tx blob → test passes, the guessed contract
//     was correct.
//   - Imperial returns 4xx / no transaction field → test fails with a clear
//     error pointing at the protocol findings file for the right replacement.
//
// Note: per the new plan/KEEPER_PCT_TP_FLYWHEEL.md design, the keeper will
// stop calling withdrawCollateral entirely (partial-close-only policy). So
// this test is mostly about *what Imperial supports* in case we need to fall
// back, not about a production code path the keeper will run regularly.
//
// Cost: ~$0.30 (open + close + withdraw tx fees).
import { it, expect, beforeAll } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import {
  imperialOpenPosition,
  imperialWithdrawCollateral,
  imperialClosePosition,
  imperialReadPosition,
} from "../../keeper/src/imperialPerps.js";
import { liveSuite, warnCostOnce, COLLATERAL_USD } from "./helpers/live.js";
import { liveRpcUrl } from "./helpers/rpc.js";
import { liveAuth } from "./helpers/auth.js";
import { pickAndFundProfile, getProfileUsdcUi } from "./helpers/profile.js";
import { pollForFreshPosition, pollForPositionGone } from "./helpers/verify.js";
import { logTxn } from "./helpers/txn-log.js";
import { getVenueMaxLeverageTruncated } from "./helpers/venue-leverage.js";
import { sleep } from "./helpers/roundtrip.js";

const SETTLE_MS = 5_000;

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;

const VENUE =
  (process.env.FORCE_VENUE as "gmtrade" | "jupiter" | "phoenix" | "flash_trade") || "gmtrade";
const SYMBOL = process.env.FORCE_SYMBOL?.toUpperCase() || "HYPE";
const SIDE: "long" | "short" = "long";

async function readWalletUsdcUi(rpcUrl: string, wallet: string): Promise<number> {
  const conn = new Connection(rpcUrl, "confirmed");
  const ata = await getAssociatedTokenAddress(USDC_MINT, new PublicKey(wallet));
  try {
    const acc = await getAccount(conn, ata, "confirmed");
    return Number(acc.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0;
  }
}

liveSuite(`Imperial — imperialWithdrawCollateral (${VENUE} ${SYMBOL}) [BEST-EFFORT]`, () => {
  beforeAll(() => warnCostOnce());

  it("open → settle → withdraw $5 → settle → wallet grew, profile shrunk → settle → close", async () => {
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
      throw new Error(`open failed before withdraw could run: ${opened.error}`);
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

    console.log(`[settle] ${SETTLE_MS}ms before withdraw...`);
    await sleep(SETTLE_MS);

    // WITHDRAW $5 from the profile (NOT the position margin — this withdraws
    // unutilized profile USDC, separate from position collateral).
    const withdrawUsd = 5;
    const profileUsdcBefore = await getProfileUsdcUi(auth.token, profileIndex);
    const walletUsdcBefore = await readWalletUsdcUi(liveRpcUrl(), auth.wallet);

    const wd = await imperialWithdrawCollateral({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      withdrawUsd,
      rpcUrl: liveRpcUrl(),
    });

    if (wd.error) {
      // Withdraw is _TODO_VERIFY_; failure with a clear error is acceptable
      // for now — surface the error so the operator knows what to fix.
      console.error(`[withdraw] Imperial withdraw failed: ${wd.error}`);
      console.error(
        "[withdraw] The OpenAPI spec confirms /mobile/orders/collateral is the " +
          "right endpoint for collateral changes — see " +
          "test/live/helpers/imperial-order-protocol.ts §/mobile/orders/collateral. " +
          "Current keeper code guesses /deposit/build-tx { mode: 'withdraw' } at " +
          "imperialPerps.js:63-64, which is almost certainly wrong.",
      );
    }
    expect(
      wd.signature,
      `imperialWithdrawCollateral didn't produce a signature. err=${wd.error}. ` +
        "Switch imperialPerps.js to call /mobile/orders/collateral with action=1 " +
        "instead of /deposit/build-tx { mode: 'withdraw' }.",
    ).toBeTruthy();
    logTxn({
      venue: VENUE,
      action: "withdraw_collateral",
      symbol: SYMBOL,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: wd.signature,
      extra: `withdraw=$${withdrawUsd}`,
    });

    // SETTLE — wait for on-chain confirm + indexer.
    console.log(`[settle] ${SETTLE_MS}ms after withdraw...`);
    await sleep(SETTLE_MS);

    const profileUsdcAfter = await getProfileUsdcUi(auth.token, profileIndex);
    const walletUsdcAfter = await readWalletUsdcUi(liveRpcUrl(), auth.wallet);

    expect(
      profileUsdcAfter,
      `profile USDC should have decreased from $${profileUsdcBefore.toFixed(2)} by ~$${withdrawUsd}`,
    ).toBeLessThan(profileUsdcBefore - withdrawUsd * 0.5);
    expect(
      walletUsdcAfter,
      `wallet USDC should have grown from $${walletUsdcBefore.toFixed(2)} by ~$${withdrawUsd}`,
    ).toBeGreaterThan(walletUsdcBefore + withdrawUsd * 0.5);

    // SETTLE before close, same reason as above.
    console.log(`[settle] ${SETTLE_MS}ms before close...`);
    await sleep(SETTLE_MS);

    // CLOSE the position
    const pos = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: SYMBOL,
      side: SIDE,
    });
    if (pos) {
      const closed = await imperialClosePosition({
        authToken: auth.token,
        kp: auth.kp,
        profileIndex,
        symbol: SYMBOL,
        side: SIDE,
        sizeUsd: pos.sizeUsd,
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
        `close failed after withdraw — manually close ${SYMBOL} ${SIDE} on profile ${profileIndex}. err=${closed.error}`,
      ).toBe(true);
      logTxn({
        venue: VENUE,
        action: "close_full",
        symbol: SYMBOL,
        wallet: auth.wallet,
        profileIndex,
        profilePda,
        signature: closed.signature,
        extra: `sizeUsd=$${pos.sizeUsd.toFixed(2)}`,
      });
    }
  }, 240_000);
});
