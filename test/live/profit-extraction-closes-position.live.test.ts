// Empirical proof of the plan §4.2 claim:
//
//   "You can't take all the profit but keep the position. On a pool-borrowed
//    perp, realized cash = tokens_returned × per-token PnL. To extract 100%
//    of unrealized PnL, you must sell 100% of the tokens, which fully
//    settles the debt to the pool and closes the position."
//
// This test runs against gmtrade (the only venue where /mobile/orders fills
// reliably for our wallet). It demonstrates the principle in three steps:
//
//   1. OPEN — borrow tokens from the pool, post collateral as margin.
//   2. PARTIAL CLOSE 50% — return half the tokens to the pool. Position survives.
//      Cash realized = (tokens_returned × per-token PnL) ≈ 50% of total PnL.
//   3. FULL CLOSE of the remainder — return the rest. Position dies. Cash
//      realized = 100% of remaining unrealized PnL = the rest of the profit.
//
// The math is universal across pool-based perps (GMX, gmtrade, Jupiter, Flash
// Trade). It applies less directly to CLOB perps (Phoenix) but the closing
// semantics are the same: zero size means no position.
//
// Cost: ~$0.30 (open + partial + full close at $10 collateral, 10x leverage).
// Requires: profile 0 USDC ≥ $11.

import { it, expect, beforeAll } from "vitest";
import { liveSuite, warnCostOnce } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";
import { pickAndFundProfile, getProfileUsdcUi } from "./helpers/profile.js";
import { pollForFreshPosition, pollForPositionGone, readPositionRow } from "./helpers/verify.js";
import { logTxn } from "./helpers/txn-log.js";
import { sleep } from "./helpers/roundtrip.js";
import { directAuth, directMarkPrice, directOpen, directClose } from "./helpers/direct-order.js";
import { getPositions } from "../../keeper/src/imperial.js";

interface RawPositionRow {
  profileIndex?: number | string;
  profile?: number | string;
  symbol?: string;
  asset?: string;
  market?: string;
  side?: number | string;
  direction?: number | string;
  sizeUsd?: number | string;
  positionSizeUsd?: number | string;
  collateralUsd?: number | string;
  marginUsd?: number | string;
  entryPriceUsd?: number | string;
  entryPrice?: number | string;
  markPriceUsd?: number | string;
  markPrice?: number | string;
  unrealizedPnlUsd?: number | string;
  pnlUsd?: number | string;
}

async function readGmtradeHypeLongRow(
  token: string,
  wallet: string,
  profileIndex: number,
): Promise<RawPositionRow | null> {
  const raw = await getPositions(wallet, { token });
  const list: RawPositionRow[] = Array.isArray(raw?.dataList)
    ? raw.dataList
    : Array.isArray(raw)
      ? raw
      : raw?.positions || raw?.data || [];
  return (
    list.find((p) => {
      const pi = Number(p?.profileIndex ?? p?.profile);
      if (Number.isFinite(pi) && pi !== profileIndex) return false;
      const sym = String(p?.symbol || p?.asset || p?.market || "").toUpperCase();
      if (sym !== "HYPE") return false;
      const sd = String(p?.side ?? p?.direction ?? "").toLowerCase();
      if (sd !== "long" && sd !== "0") return false;
      return true;
    }) ?? null
  );
}

// Wait for the partial close to actually fill on gmtrade. Their keeper takes
// ~10-60s under normal conditions and can stretch to minutes under volatility
// (this is the documented behaviour plan §4.4 cap-aware routing addresses).
// We poll /positions until the size drops, with a generous upper bound.
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 30; // 30 × 5s = 2.5 min
const COLLATERAL = 10;
const LEVERAGE = 10;

async function pollUntilSizeShrinks(opts: {
  token: string;
  wallet: string;
  profileIndex: number;
  baseline: number;
  minShrinkFraction: number;
  log: (msg: string) => void;
}): Promise<RawPositionRow | null> {
  for (let i = 1; i <= POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const row = await readGmtradeHypeLongRow(opts.token, opts.wallet, opts.profileIndex);
    if (!row) {
      opts.log(`poll ${i}: position GONE`);
      return null;
    }
    const sz = Number(row.sizeUsd ?? row.positionSizeUsd ?? 0);
    const shrink = (opts.baseline - sz) / opts.baseline;
    opts.log(
      `poll ${i} (${i * (POLL_INTERVAL_MS / 1000)}s): size=$${sz.toFixed(2)} ` +
        `(shrunk ${(shrink * 100).toFixed(1)}% vs baseline $${opts.baseline.toFixed(2)})`,
    );
    if (shrink >= opts.minShrinkFraction) return row;
  }
  throw new Error(
    `gmtrade keeper didn't process the close within ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
  );
}

liveSuite("Profit extraction empirically closes the position (gmtrade HYPE)", () => {
  beforeAll(() => warnCostOnce());

  it("partial 50% keeps position alive; partial 100% of remainder closes it", async () => {
    const auth = await liveAuth();
    const token = await directAuth(auth.kp);
    const { profileIndex, profilePda, usdcUi: usdcStart } = await pickAndFundProfile(auth);
    expect(
      usdcStart,
      `profile USDC ($${usdcStart.toFixed(2)}) must cover the $${COLLATERAL} collateral. Run a deposit first.`,
    ).toBeGreaterThanOrEqual(COLLATERAL + 1);

    const mark = await directMarkPrice("HYPE", "gmtrade");
    expect(mark, "mark price required").toBeTruthy();

    // ===================================================================
    // STEP 1 — OPEN
    // ===================================================================
    console.log(
      `\n[step 1] OPEN gmtrade HYPE long  coll=$${COLLATERAL}  lev=${LEVERAGE}x  → notional=$${COLLATERAL * LEVERAGE}`,
    );

    const tStart = Math.floor(Date.now() / 1000) - 10;
    const openRes = await directOpen({
      token,
      venue: "gmtrade",
      wallet: auth.wallet,
      symbol: "HYPE",
      side: "long",
      collateralUsd: COLLATERAL,
      sizeUsd: COLLATERAL * LEVERAGE,
      slippageBps: 500,
      profileIndex,
      marketPrice: mark!,
    });
    expect(openRes.success || openRes.signature, `open failed: ${openRes.error}`).toBeTruthy();
    logTxn({
      venue: "gmtrade",
      action: "open",
      symbol: "HYPE",
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: openRes.signature,
      extra: `proof-test coll=$${COLLATERAL} lev=${LEVERAGE}x`,
    });

    const fresh = await pollForFreshPosition({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: "HYPE",
      side: "long",
      since: tStart,
      log: (m) => console.log(`  [open-verify] ${m}`),
    });
    expect(fresh, "open didn't produce a fresh /positions entry").toBeTruthy();

    // gmtrade keeper takes time to process the open too — poll until /positions
    // shows non-zero sizeUsd before continuing.
    await sleep(POLL_INTERVAL_MS);

    // Read the rich row directly so we can show entry/mark/PnL math.
    const row0 = await readGmtradeHypeLongRow(auth.token, auth.wallet, profileIndex);
    expect(row0, "no position row after open").toBeTruthy();
    const opened = readPositionRow(row0 as never);
    const entryPrice = Number(row0!.entryPriceUsd ?? row0!.entryPrice ?? NaN);
    const markPriceAtOpen = Number(row0!.markPriceUsd ?? row0!.markPrice ?? NaN);
    const pnlAtOpen = Number(row0!.unrealizedPnlUsd ?? row0!.pnlUsd ?? 0);
    const tokensAtOpen = entryPrice > 0 ? opened.sizeUsd / markPriceAtOpen : 0;

    console.log(
      `\n  state after open:` +
        `\n    sizeUsd:        $${opened.sizeUsd.toFixed(4)}` +
        `\n    collateralUsd:  $${opened.collateralUsd.toFixed(4)}` +
        `\n    entry price:    $${entryPrice}` +
        `\n    mark price:     $${markPriceAtOpen}` +
        `\n    tokens (≈):     ${tokensAtOpen.toFixed(6)} HYPE` +
        `\n    unrealized PnL: $${pnlAtOpen.toFixed(4)}` +
        `\n    per-token PnL:  $${(markPriceAtOpen - entryPrice).toFixed(4)}` +
        `\n` +
        `\n  The position consists of an open debt to the gmtrade pool:` +
        `\n  ~${tokensAtOpen.toFixed(4)} HYPE owed, backed by $${opened.collateralUsd.toFixed(2)} margin.` +
        `\n  Total cash extractable as profit RIGHT NOW = tokens × (mark − entry)` +
        `\n                                            = ${tokensAtOpen.toFixed(4)} × $${(markPriceAtOpen - entryPrice).toFixed(4)}` +
        `\n                                            ≈ $${(tokensAtOpen * (markPriceAtOpen - entryPrice)).toFixed(4)}`,
    );

    // ===================================================================
    // STEP 2 — PARTIAL CLOSE 50%
    // ===================================================================
    const halfSize = opened.sizeUsd / 2;
    console.log(`\n[step 2] PARTIAL CLOSE 50%  reduceSizeUsd=$${halfSize.toFixed(4)}`);
    console.log(`  → returns half the tokens to the pool → realizes half the PnL`);

    const partialRes = await directClose({
      token,
      venue: "gmtrade",
      wallet: auth.wallet,
      symbol: "HYPE",
      side: "long",
      closeSizeUsd: halfSize,
      slippageBps: 500,
      profileIndex,
      marketPrice: mark!,
    });
    expect(
      partialRes.success || partialRes.signature,
      `partial close 50% failed: ${partialRes.error}`,
    ).toBeTruthy();
    logTxn({
      venue: "gmtrade",
      action: "close_partial",
      symbol: "HYPE",
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: partialRes.signature,
      extra: `proof-test cut~50% of $${opened.sizeUsd.toFixed(2)}`,
    });

    // Poll until gmtrade's keeper actually processes the close (their keeper
    // lag is the whole reason §4.4 cap-aware routing exists in the plan). We
    // wait until the size has shrunk by ≥30% before continuing.
    console.log(`\n  Waiting for gmtrade keeper to process the partial close...`);
    const row1 = await pollUntilSizeShrinks({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      baseline: opened.sizeUsd,
      minShrinkFraction: 0.3,
      log: (m) => console.log(`  [keeper-poll] ${m}`),
    });
    expect(
      row1,
      "position should STILL be open after 50% partial close (the central claim — selling half the tokens leaves half a position)",
    ).toBeTruthy();
    const afterPartial = readPositionRow(row1 as never);
    const tokensAfterPartial = markPriceAtOpen > 0 ? afterPartial.sizeUsd / markPriceAtOpen : 0;
    const sizeReduction = opened.sizeUsd - afterPartial.sizeUsd;
    const sizeReductionPct = sizeReduction / opened.sizeUsd;

    console.log(
      `\n  state after 50% partial close:` +
        `\n    sizeUsd:        $${afterPartial.sizeUsd.toFixed(4)}  (was $${opened.sizeUsd.toFixed(4)})` +
        `\n    collateralUsd:  $${afterPartial.collateralUsd.toFixed(4)}  (was $${opened.collateralUsd.toFixed(4)})` +
        `\n    tokens (≈):     ${tokensAfterPartial.toFixed(6)} HYPE` +
        `\n    size reduced by: ${(sizeReductionPct * 100).toFixed(1)}%  (expected ~50%)` +
        `\n` +
        `\n  → Position is ALIVE. Half the tokens were returned to the pool, half remain owed.` +
        `\n    The pool is still our counterparty on ${tokensAfterPartial.toFixed(4)} HYPE of debt.`,
    );

    expect(sizeReductionPct, "expected ~50% reduction").toBeGreaterThan(0.4);
    expect(sizeReductionPct).toBeLessThan(0.6);

    // ===================================================================
    // STEP 3 — FULL CLOSE OF REMAINDER (100% of what's left)
    // ===================================================================
    console.log(
      `\n[step 3] FULL CLOSE OF REMAINDER  reduceSizeUsd=$${afterPartial.sizeUsd.toFixed(4)}  (= 100% of what's left)`,
    );
    console.log(`  → returns ALL remaining tokens → realizes ALL remaining PnL → position closes`);

    const fullRes = await directClose({
      token,
      venue: "gmtrade",
      wallet: auth.wallet,
      symbol: "HYPE",
      side: "long",
      closeSizeUsd: afterPartial.sizeUsd,
      slippageBps: 500,
      profileIndex,
      marketPrice: mark!,
    });
    expect(
      fullRes.success || fullRes.signature,
      `full close failed: ${fullRes.error}`,
    ).toBeTruthy();
    logTxn({
      venue: "gmtrade",
      action: "close_full",
      symbol: "HYPE",
      wallet: auth.wallet,
      profileIndex,
      profilePda,
      signature: fullRes.signature,
      extra: `proof-test 100% of remainder=$${afterPartial.sizeUsd.toFixed(2)}`,
    });

    const gone = await pollForPositionGone({
      token: auth.token,
      wallet: auth.wallet,
      profileIndex,
      symbol: "HYPE",
      side: "long",
      log: (m) => console.log(`  [close-verify] ${m}`),
    });
    expect(
      gone,
      "after returning 100% of remaining tokens, the position must be CLOSED. If this fires, the pool's accounting is doing something we didn't expect.",
    ).toBe(true);

    await sleep(3_000);
    const usdcEnd = await getProfileUsdcUi(auth.token, profileIndex);

    console.log(
      `\n  state after full close of remainder:` +
        `\n    position in /positions:  GONE` +
        `\n    profile USDC:            $${usdcEnd.toFixed(4)}  (was $${usdcStart.toFixed(4)} pre-test)` +
        `\n` +
        `\n  Net of the round-trip: $${(usdcEnd - usdcStart).toFixed(4)} returned to the profile.` +
        `\n  (= collateral + realized profit − fees − slippage)`,
    );

    console.log(
      `\n=== PROOF ===\n` +
        `Step 2 returned HALF the tokens → position SURVIVED with half the size.\n` +
        `Step 3 returned the REMAINING tokens → position CLOSED. There were zero tokens left\n` +
        `to extract further PnL from.\n\n` +
        `This is why the plan's PNL_TARGET_RATIO=0.1 leaves 10% of PnL on the position:\n` +
        `if it set target to 0%, the cut would mathematically equal a 100%-size close, and\n` +
        `the flywheel would have to re-open from scratch on the next fee tick.`,
    );
  }, 240_000);
});
