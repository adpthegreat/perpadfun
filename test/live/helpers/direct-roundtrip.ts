// Shared open → settle → partial close → settle → full close flow that uses
// the DIRECT /mobile/orders path (bypasses keeper's SUPPORTED_OPEN_VENUES
// gate and routingMode='live' requirement).
//
// Used by phoenix-direct.live.test.ts and flash_trade-direct.live.test.ts.
import { expect } from "vitest";
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
import { sleep } from "./roundtrip.js";
import {
  directAuth,
  directRegisterPhoenix,
  directMarkPrice,
  directOpen,
  directClose,
  directRouteWarm,
} from "./direct-order.js";
import type { VenueStr } from "./imperial-order-protocol.js";

export interface DirectRoundtripOpts {
  venue: VenueStr;
  symbol: string;
  side?: "long" | "short";
  collateralUsd?: number;
  leverage?: number;
  settleMs?: number;
  partialCloseFraction?: number;
  // Slippage tolerance in basis points. Default 100 (1%). Bump for thin
  // CLOB markets (phoenix HYPE etc.) where the orderbook can't fill within
  // 1% of mark.
  slippageBps?: number;
  // Only meaningful for phoenix — runs /phoenix/register before the open.
  // No-op for other venues. Default true for phoenix, false for others.
  preRegisterPhoenix?: boolean;
}

export async function runDirectRoundtrip(opts: DirectRoundtripOpts): Promise<{
  registerResult?: { activated: boolean; profilePda: string; message: string };
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
  const slippageBps = opts.slippageBps ?? 100;
  const sizeUsd = collateralUsd * leverage;
  const preRegister = opts.preRegisterPhoenix ?? venue === "phoenix";

  const auth = await liveAuth();
  // Re-auth via the direct path so we don't rely on auth.ts's cached token
  // (which may be a few minutes old by the time the direct flow runs).
  const token = await directAuth(auth.kp);
  const { profileIndex, profilePda, usdcUi: usdcStart } = await pickAndFundProfile(auth);
  console.log(
    `[direct] venue=${venue} ${symbol}/${side} prof=${profileIndex} ` +
      `coll=$${collateralUsd} lev=${leverage}x sizeUsd=$${sizeUsd} ` +
      `slippageBps=${slippageBps} usdcStart=$${usdcStart.toFixed(2)} preRegister=${preRegister}`,
  );

  // =====================================================================
  // STEP 0 — optionally pre-activate phoenix
  // =====================================================================
  let registerResult: Awaited<ReturnType<typeof directRegisterPhoenix>> | undefined;
  if (preRegister && venue === "phoenix") {
    console.log(`[direct:phoenix-register] profileIndex=${profileIndex}`);
    try {
      registerResult = await directRegisterPhoenix({ wallet: auth.wallet, profileIndex });
      console.log(
        `[direct:phoenix-register] activated=${registerResult.activated} pda=${registerResult.profilePda.slice(0, 12)}... msg=${registerResult.message}`,
      );
    } catch (e) {
      // Don't fail the test — the OpenAPI says /mobile/orders auto-activates
      // on first use, so this is best-effort. Log and continue.
      console.warn(`[direct:phoenix-register] failed (continuing): ${(e as Error).message}`);
    }
  }

  // =====================================================================
  // STEP 1 — fetch marketPrice (CRITICAL for phoenix)
  // =====================================================================
  const markPrice = await directMarkPrice(symbol, venue);
  expect(
    markPrice,
    `getMarkPrice(${symbol}, ${venue}) returned null. ` +
      "Phoenix is a CLOB and Imperial's market-order instruction needs a " +
      "reference price for slippage enforcement; without one the order " +
      "will silently no-op. Check /mark-prices for this venue.",
  ).toBeTruthy();
  console.log(`[direct:markPrice] ${symbol}/${venue} = ${markPrice} (oracle 1e9)`);

  // =====================================================================
  // STEP 1.5 — warm /route (matches working probe pattern)
  // =====================================================================
  // Both the working imperial-order-probe.mjs AND the production keeper loop
  // call /route immediately before /mobile/orders. Hypothesis: Imperial keeps
  // per-(wallet, profile, asset, venue) server-side state populated by /route
  // that /mobile/orders relies on. Undocumented but worth probing.
  try {
    const routeResp = await directRouteWarm({
      wallet: auth.wallet,
      profileIndex,
      symbol,
      side,
      collateralUsd,
      leverage,
      pinVenue: venue, // exclude all other venues so /route picks ours
    });
    const routeVenue = (routeResp as { venue?: string })?.venue;
    console.log(`[direct:route-warm] /route returned venue=${routeVenue}`);
  } catch (e) {
    console.warn(`[direct:route-warm] failed (continuing): ${(e as Error).message}`);
  }

  // =====================================================================
  // STEP 2 — OPEN
  // =====================================================================
  const tOpenStart = Math.floor(Date.now() / 1000) - 10;
  const usdcBeforeOpen = await snapshotUsdc(auth.token, profileIndex);

  let openRes;
  try {
    openRes = await directOpen({
      token,
      venue,
      wallet: auth.wallet,
      symbol,
      side,
      collateralUsd,
      sizeUsd,
      slippageBps,
      profileIndex,
      marketPrice: markPrice!,
    });
    console.log(
      `[direct:open] resp success=${openRes.success} sig=${openRes.signature?.slice(0, 16)}... err=${openRes.error ?? "none"}`,
    );
  } catch (e) {
    throw new Error(`directOpen threw: ${(e as Error).message}`);
  }

  // /mobile/orders sometimes returns success:false even when it filled.
  // Verify via /positions polling.
  const fresh = await pollForFreshPosition({
    token: auth.token,
    wallet: auth.wallet,
    profileIndex,
    symbol,
    side,
    since: tOpenStart,
    log: (m) => console.log(`[direct:open-verify] ${m}`),
  });
  expect(
    fresh,
    `open failed: /mobile/orders ${openRes.success ? "success=true" : `success=false err=${openRes.error}`}; ` +
      "no fresh position appeared in /positions within 30s. This is the " +
      "exact 'silent no-op' failure phoenix/flash_trade exhibited in the " +
      "previous probes. The body is now confirmed correct by OpenAPI — " +
      "check Imperial dev logs for this wallet / profile.",
  ).toBeTruthy();

  // Refund detection.
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
      `Order signed but venue refunded in same tx.`,
  ).toBe(true);

  logTxn({
    venue,
    action: "open",
    symbol,
    wallet: auth.wallet,
    profileIndex,
    profilePda,
    signature: openRes.signature ?? null,
    extra: `coll=$${collateralUsd} lev=${leverage}x drain=$${drain.delta.toFixed(2)} resp.success=${openRes.success}`,
  });

  // Read the position
  const { getPositions } = await import("../../../keeper/src/imperial.js");
  const rawList = await getPositions(auth.wallet, { token: auth.token });
  const list = Array.isArray(rawList?.dataList)
    ? rawList.dataList
    : Array.isArray(rawList)
      ? rawList
      : rawList?.positions || rawList?.data || [];
  const positionRow = list.find((p: Record<string, unknown>) => {
    const pi = Number(p?.profileIndex ?? p?.profile);
    const psym = String(p?.symbol || p?.asset || p?.market || "").toUpperCase();
    return Number.isFinite(pi) && pi === profileIndex && psym === symbol;
  });
  expect(positionRow, "no position row found after verified open").toBeTruthy();
  const positionAfterOpen = readPositionRow(positionRow as never);
  expect(positionAfterOpen.sizeUsd).toBeGreaterThan(0);

  console.log(`[direct:settle] ${settleMs}ms before partial close...`);
  await sleep(settleMs);

  // =====================================================================
  // STEP 3 — PARTIAL CLOSE
  // =====================================================================
  const reduceSizeUsd = positionAfterOpen.sizeUsd * partialFraction;
  let partialRes;
  try {
    partialRes = await directClose({
      token,
      venue,
      wallet: auth.wallet,
      symbol,
      side,
      closeSizeUsd: reduceSizeUsd,
      slippageBps,
      profileIndex,
      marketPrice: markPrice!,
    });
    console.log(
      `[direct:partial] resp success=${partialRes.success} sig=${partialRes.signature?.slice(0, 16)}... err=${partialRes.error ?? "none"}`,
    );
  } catch (e) {
    throw new Error(`directClose (partial) threw: ${(e as Error).message}`);
  }

  await sleep(settleMs);

  // Re-fetch position to confirm size shrunk
  const rawList2 = await getPositions(auth.wallet, { token: auth.token });
  const list2 = Array.isArray(rawList2?.dataList)
    ? rawList2.dataList
    : Array.isArray(rawList2)
      ? rawList2
      : rawList2?.positions || rawList2?.data || [];
  const partialRow = list2.find((p: Record<string, unknown>) => {
    const pi = Number(p?.profileIndex ?? p?.profile);
    const psym = String(p?.symbol || p?.asset || p?.market || "").toUpperCase();
    return Number.isFinite(pi) && pi === profileIndex && psym === symbol;
  });
  const positionAfterPartial = partialRow ? readPositionRow(partialRow as never) : null;
  expect(
    positionAfterPartial,
    "position vanished after partial close — Imperial interpreted it as a full close. " +
      "If this fires, the partial-vs-full distinction is in sizeUsd matching exactly the " +
      "remaining notional. Our request used sizeUsd < positionAfterOpen.sizeUsd, which " +
      "the OpenAPI implies = partial.",
  ).toBeTruthy();
  const reductionPct =
    (positionAfterOpen.sizeUsd - positionAfterPartial!.sizeUsd) / positionAfterOpen.sizeUsd;
  expect(
    reductionPct,
    `partial close should reduce size by ~${(partialFraction * 100).toFixed(0)}%; ` +
      `got ${(reductionPct * 100).toFixed(1)}%`,
  ).toBeGreaterThan(partialFraction * 0.6);
  expect(reductionPct).toBeLessThan(partialFraction * 1.4);

  logTxn({
    venue,
    action: "close_partial",
    symbol,
    wallet: auth.wallet,
    profileIndex,
    profilePda,
    signature: partialRes.signature ?? null,
    extra:
      `cut=${(partialFraction * 100).toFixed(0)}% ` +
      `sizeBefore=$${positionAfterOpen.sizeUsd.toFixed(2)} ` +
      `sizeAfter=$${positionAfterPartial!.sizeUsd.toFixed(2)} ` +
      `resp.success=${partialRes.success}`,
  });

  console.log(`[direct:settle] ${settleMs}ms before full close...`);
  await sleep(settleMs);

  // =====================================================================
  // STEP 4 — FULL CLOSE
  // =====================================================================
  const usdcBeforeClose = await snapshotUsdc(auth.token, profileIndex);
  let closeRes;
  try {
    closeRes = await directClose({
      token,
      venue,
      wallet: auth.wallet,
      symbol,
      side,
      closeSizeUsd: positionAfterPartial!.sizeUsd,
      slippageBps,
      profileIndex,
      marketPrice: markPrice!,
    });
    console.log(
      `[direct:close] resp success=${closeRes.success} sig=${closeRes.signature?.slice(0, 16)}... err=${closeRes.error ?? "none"}`,
    );
  } catch (e) {
    throw new Error(`directClose (full) threw: ${(e as Error).message}`);
  }

  const gone = await pollForPositionGone({
    token: auth.token,
    wallet: auth.wallet,
    profileIndex,
    symbol,
    side,
    log: (m) => console.log(`[direct:close-verify] ${m}`),
  });
  expect(
    gone,
    `full close failed — position still open after 30s. ` +
      `**MANUAL CLEANUP REQUIRED** — close this ${symbol} ${side} position on profile ${profileIndex} via the Imperial frontend.`,
  ).toBe(true);

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
    signature: closeRes.signature ?? null,
    extra:
      `sizeUsd=$${positionAfterPartial!.sizeUsd.toFixed(2)} ` +
      `usdcReturned=$${returnedUsd.toFixed(2)} resp.success=${closeRes.success}`,
  });

  return {
    registerResult,
    positionAfterOpen,
    positionAfterPartial,
    usdcDrainOnOpen: drain.delta,
    usdcReturnOnClose: returnedUsd,
    openSignature: openRes.signature ?? null,
    partialCloseSignature: partialRes.signature ?? null,
    closeSignature: closeRes.signature ?? null,
  };
}
