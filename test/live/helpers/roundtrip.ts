// Shared open → settle → partial-close → settle → full-close flow used by
// every *-roundtrip.live.test.ts file. Each per-venue file just plugs in
// (venue, symbol) and reuses this.
//
// SETTLE WAITS between actions:
//   Imperial's indexer + the per-venue on-chain instruction routes are
//   eventually-consistent. After every action we wait SETTLE_MS before
//   reading state, so the next step doesn't read a stale position size /
//   USDC balance and mis-assert. Default 5s; override per-call via opts.
//
// TXN LOGGING:
//   Every successful signature is appended to test/live/txns.txt via the
//   txn-log helper. One line per action, grouped by venue.
import { expect } from "vitest";
import {
  imperialOpenPosition,
  imperialClosePosition,
  imperialPartialClose,
  imperialReadPosition,
} from "../../../keeper/src/imperialPerps.js";
import { COLLATERAL_USD, LEVERAGE } from "./live.js";
import { liveAuth } from "./auth.js";
import { pickAndFundProfile } from "./profile.js";
import {
  pollForFreshPosition,
  pollForPositionGone,
  snapshotUsdc,
  verifyAttachedByUsdcDrain,
  readPositionRow,
} from "./verify.js";
import { logTxn } from "./txn-log.js";

export interface RoundtripOpts {
  venue: "gmtrade" | "jupiter" | "phoenix" | "flash_trade";
  symbol: string;
  side?: "long" | "short";
  // Override per-test if you need to vary; defaults read from env.
  collateralUsd?: number;
  leverage?: number;
  // Wait after each action before reading state. 5s is the default — enough
  // for Imperial's indexer to catch up and for the on-chain confirm to land
  // through the slowest of phoenix/flash_trade/gmtrade. Set higher for
  // congested mainnet windows.
  settleMs?: number;
  // Fraction of size to cut on the partial-close step. Default 0.5 (50%).
  // Slippage at very small fractions can land the realized cut at $0, so
  // don't drop below ~0.25 on a $20 notional.
  partialCloseFraction?: number;
  // If true, skips the partial close step (just open → settle → full close).
  // Useful when a venue's partial-close behaviour is unverified and you want
  // to isolate the full close from a partial-close failure.
  skipPartial?: boolean;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// Run a full open → settle → partial close → settle → full close cycle.
// Throws (via vitest expect) on any step that fails. Returns the verified
// position row + every signature + USDC delta for downstream assertions.
export async function runRoundtrip(opts: RoundtripOpts): Promise<{
  positionAfterOpen: ReturnType<typeof readPositionRow>;
  positionAfterPartial: ReturnType<typeof readPositionRow> | null;
  usdcDrainOnOpen: number;
  usdcReturnOnClose: number;
  openSignature: string | null;
  partialCloseSignature: string | null;
  closeSignature: string | null;
}> {
  const venue = opts.venue;
  const symbol = opts.symbol.toUpperCase();
  const side = opts.side ?? "long";
  const collateralUsd = opts.collateralUsd ?? COLLATERAL_USD;
  const leverage = opts.leverage ?? LEVERAGE;
  const settleMs = opts.settleMs ?? 5_000;
  const partialFraction = opts.partialCloseFraction ?? 0.5;
  const skipPartial = opts.skipPartial ?? false;

  const auth = await liveAuth();
  const { profileIndex, profilePda, usdcUi: usdcStart } = await pickAndFundProfile(auth);
  console.log(
    `[live] venue=${venue} ${symbol}/${side} prof=${profileIndex} ` +
      `coll=$${collateralUsd} lev=${leverage}x usdcStart=$${usdcStart.toFixed(2)} ` +
      `settleMs=${settleMs} partialFrac=${partialFraction}${skipPartial ? " skipPartial=YES" : ""}`,
  );

  // =====================================================================
  // STEP 1 — OPEN
  // =====================================================================
  const tOpenStart = Math.floor(Date.now() / 1000) - 10;
  const usdcBeforeOpen = await snapshotUsdc(auth.token, profileIndex);

  const openRes = await imperialOpenPosition({
    authToken: auth.token,
    kp: auth.kp,
    profileIndex,
    symbol,
    side,
    collateralUsd,
    leverage,
    slippageBps: undefined,
    venue,
  });

  // imperialOpenPosition has a built-in /positions poller. Re-poll ourselves
  // either way so we can capture the exact freshly-opened row for the
  // partial-close step and assert the specific fields the helper normalizes.
  const fresh = await pollForFreshPosition({
    token: auth.token,
    wallet: auth.wallet,
    profileIndex,
    symbol,
    side,
    since: tOpenStart,
    log: (m) => console.log(`[live:open-verify] ${m}`),
  });
  expect(
    fresh,
    `open failed: helper error=${openRes.error}; no fresh ${symbol} ${side} in /positions within 30s`,
  ).toBeTruthy();

  // Refund detection: did profile USDC actually drain?
  const drain = await verifyAttachedByUsdcDrain({
    token: auth.token,
    profileIndex,
    beforeUi: usdcBeforeOpen,
    expectedDrainUsd: collateralUsd,
  });
  expect(
    drain.attached,
    `silent no-op detected: USDC drain $${drain.delta.toFixed(4)} < ` +
      `$${(collateralUsd * 0.5).toFixed(2)} (half of expected $${collateralUsd}). ` +
      `Order signed but venue refunded in same tx. This is the failure mode ` +
      `phoenix/flash_trade exhibit pre-Phase-B.`,
  ).toBe(true);

  // Log the successful open. Helper records 'verified-via-positions' when
  // /mobile/orders returned success:false but /positions saw the fill.
  logTxn({
    venue,
    action: "open",
    symbol,
    wallet: auth.wallet,
    profileIndex,
    profilePda,
    signature: openRes.signature,
    extra: `coll=$${collateralUsd} lev=${leverage}x drain=$${drain.delta.toFixed(2)}`,
  });

  // Read the verified position row
  const positionAfterOpen = await imperialReadPosition({
    token: auth.token,
    wallet: auth.wallet,
    profileIndex,
    symbol,
    side,
  });
  expect(positionAfterOpen, "imperialReadPosition returned null after verified open").toBeTruthy();
  expect(positionAfterOpen!.sizeUsd, "position size is non-zero").toBeGreaterThan(0);
  expect(positionAfterOpen!.collateralUsd, "position collateral is non-zero").toBeGreaterThan(0);

  // SETTLE — let the on-chain state quiet down before partial close. Without
  // this, a fast partial-close call can race the open's confirmation and
  // see stale sizeUsd, which then makes the close use the wrong notional.
  console.log(`[live:settle] waiting ${settleMs}ms before next action...`);
  await sleep(settleMs);

  // =====================================================================
  // STEP 2 — PARTIAL CLOSE (skippable via opts.skipPartial)
  // =====================================================================
  let positionAfterPartial: typeof positionAfterOpen | null = null;
  let partialCloseSignature: string | null = null;
  if (!skipPartial) {
    const reduceSizeUsd = positionAfterOpen!.sizeUsd * partialFraction;
    const partialRes = await imperialPartialClose({
      authToken: auth.token,
      kp: auth.kp,
      profileIndex,
      symbol,
      side,
      reduceSizeUsd,
      currentSizeUsd: positionAfterOpen!.sizeUsd,
      slippageBps: undefined,
      venue,
    });

    // Partial close may legitimately return no signature (Imperial's
    // success:false-but-actually-filled mode). Re-read the position to
    // confirm by size delta.
    await sleep(settleMs);

    positionAfterPartial = await imperialReadPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol,
      side,
    });
    expect(
      positionAfterPartial,
      "position vanished after partial close — Imperial interpreted it as a full close. " +
        "If this fires, imperialPerps.js:426 (partial = full body shape) is wrong.",
    ).toBeTruthy();

    // Size should be ~partialFraction smaller. Wide tolerance for slippage.
    const reduction = positionAfterOpen!.sizeUsd - positionAfterPartial!.sizeUsd;
    const reductionPct = reduction / positionAfterOpen!.sizeUsd;
    expect(
      reductionPct,
      `partial close should reduce size by ~${(partialFraction * 100).toFixed(0)}%; ` +
        `got ${(reductionPct * 100).toFixed(1)}% (before=$${positionAfterOpen!.sizeUsd.toFixed(2)}, ` +
        `after=$${positionAfterPartial!.sizeUsd.toFixed(2)}, ` +
        `partialRes.err=${partialRes.error ?? "none"})`,
    ).toBeGreaterThan(partialFraction * 0.6);
    expect(reductionPct).toBeLessThan(partialFraction * 1.4);

    partialCloseSignature = partialRes.signature;
    logTxn({
      venue,
      action: "close_partial",
      symbol,
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: partialCloseSignature,
      extra:
        `cut=${(partialFraction * 100).toFixed(0)}% ` +
        `sizeBefore=$${positionAfterOpen!.sizeUsd.toFixed(2)} ` +
        `sizeAfter=$${positionAfterPartial!.sizeUsd.toFixed(2)}`,
    });

    // SETTLE — wait again before the full close so it reads the correct
    // remaining sizeUsd from /positions instead of the pre-partial size.
    console.log(`[live:settle] waiting ${settleMs}ms before full close...`);
    await sleep(settleMs);
  }

  // =====================================================================
  // STEP 3 — FULL CLOSE
  // =====================================================================
  // Pick the freshest sizeUsd we have. If we partial-closed, use that; else
  // use the post-open size. Imperial's full-close requires sizeUsd to equal
  // the position's exact remaining notional (imperialPerps.js:418-421).
  const positionForClose = positionAfterPartial ?? positionAfterOpen;
  const usdcBeforeClose = await snapshotUsdc(auth.token, profileIndex);
  const closeRes = await imperialClosePosition({
    authToken: auth.token,
    kp: auth.kp,
    profileIndex,
    symbol,
    side,
    sizeUsd: positionForClose!.sizeUsd,
    leverage,
    slippageBps: undefined,
    venue,
  });
  const gone = await pollForPositionGone({
    token: auth.token,
    wallet: auth.wallet,
    profileIndex,
    symbol,
    side,
    log: (m) => console.log(`[live:close-verify] ${m}`),
  });
  expect(
    gone,
    `close failed: position still open after 30s. helper error=${closeRes.error}. ` +
      `**MANUAL CLEANUP REQUIRED** — close this ${symbol} ${side} position on profile ${profileIndex} via the Imperial frontend.`,
  ).toBe(true);

  // After close, USDC should have grown back (remaining collateral +
  // any realized PnL from the partial + full close).
  await sleep(3_000);
  const usdcAfterClose = await snapshotUsdc(auth.token, profileIndex);
  const returnedUsd = Math.max(0, usdcAfterClose - usdcBeforeClose);

  logTxn({
    venue,
    action: "close_full",
    symbol,
    wallet: auth.wallet,
    profileIndex,
    profilePda,
    signature: closeRes.signature,
    extra:
      `sizeUsd=$${positionForClose!.sizeUsd.toFixed(2)} ` +
      `usdcReturned=$${returnedUsd.toFixed(2)}`,
  });

  return {
    positionAfterOpen: readPositionRow(positionAfterOpen as never),
    positionAfterPartial: positionAfterPartial
      ? readPositionRow(positionAfterPartial as never)
      : null,
    usdcDrainOnOpen: drain.delta,
    usdcReturnOnClose: returnedUsd,
    openSignature: openRes.signature,
    partialCloseSignature,
    closeSignature: closeRes.signature,
  };
}
