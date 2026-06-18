// Take-profit unit tests — see plan/KEEPER_TP_AUDIT_FIXES.md (F1–F6) and
// plan/KEEPER_TP_REWRITE.md. PURE tests need nothing; FLOW tests mock the venue
// modules. Neither touches Supabase, the network, or a real wallet, so this file
// runs green standalone:  npx vitest run test/keeper/tp.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────
// hedgeMode must be "live" so the accepted-close / profit-split paths execute.
vi.mock("../../keeper/src/config.js", async (importActual) => {
  const actual: any = await importActual();
  return { ...actual, config: { ...actual.config, hedgeMode: "live" } };
});

const venue = vi.hoisted(() => ({
  partialClose: vi.fn(),
  imperialPartialClose: vi.fn(),
  imperialWithdrawCollateral: vi.fn(),
  imperialAddCollateralToPosition: vi.fn(),
  swapUsdcToSol: vi.fn(),
}));

vi.mock("../../keeper/src/jupiterPerps.js", async (importActual) => {
  const actual: any = await importActual();
  return { ...actual, partialClose: venue.partialClose };
});
vi.mock("../../keeper/src/imperialPerps.js", async (importActual) => {
  const actual: any = await importActual();
  return {
    ...actual,
    imperialPartialClose: venue.imperialPartialClose,
    imperialWithdrawCollateral: venue.imperialWithdrawCollateral,
    imperialAddCollateralToPosition: venue.imperialAddCollateralToPosition,
  };
});
vi.mock("../../keeper/src/swap.js", async (importActual) => {
  const actual: any = await importActual();
  return { ...actual, swapUsdcToSol: venue.swapUsdcToSol };
});
// readImperialLiveMarkUsd = imperial.js getMarkPriceUiSafe — keep it offline.
vi.mock("../../keeper/src/imperial.js", async (importActual) => {
  const actual: any = await importActual();
  return { ...actual, getMarkPriceUiSafe: vi.fn(async () => null) };
});

import {
  planTakeProfit,
  applyTakeProfit,
  pnlAndTakeProfitStep,
  confirmPendingSigStep,
} from "../../keeper/src/loop.js";

const CFG = {
  tpTriggerRatio: 0.25,
  tpCloseFraction: 0.2,
  tpMasterShareRatio: 0.25,
  tpMinCloseUsd: 5,
  tpMinRealizeUsd: 1,
};

// ── PURE: planTakeProfit ──────────────────────────────────────────────────────
describe("planTakeProfit (pure)", () => {
  it("fires when floating profit grows ≥ tpTriggerRatio × collAfter above high-water", () => {
    const r = planTakeProfit({ pnlNow: 100, highWater: 0, collAfter: 100, sizeUsd: 1000, cfg: CFG });
    expect(r.fire).toBe(true);
    expect(r.trigger).toBe(25); // 0.25 × 100
    expect(r.frac).toBe(0.2);
    expect(r.closeSizeUsd).toBe(200); // 1000 × 0.2
    expect(r.realizedPnlUsd).toBe(20); // 100 × 0.2
  });

  it("trigger basis scales with current collateral (F4): $100→$25, $200→$50", () => {
    expect(planTakeProfit({ pnlNow: 1, highWater: 0, collAfter: 100, sizeUsd: 1000, cfg: CFG }).trigger).toBe(25);
    expect(planTakeProfit({ pnlNow: 1, highWater: 0, collAfter: 200, sizeUsd: 1000, cfg: CFG }).trigger).toBe(50);
  });

  it("does NOT fire below the trigger", () => {
    // gain since high-water = 20 < 0.25×100 = 25
    expect(planTakeProfit({ pnlNow: 20, highWater: 0, collAfter: 100, sizeUsd: 1000, cfg: CFG }).fire).toBe(false);
  });

  it("uses the gain SINCE high-water, not absolute pnl", () => {
    // pnl 100 but high-water 90 → gain 10 < 25 → no fire
    expect(planTakeProfit({ pnlNow: 100, highWater: 90, collAfter: 100, sizeUsd: 1000, cfg: CFG }).fire).toBe(false);
  });

  it("does NOT fire when close size is below the floor ($5)", () => {
    // size 20 × 0.2 = $4 close < $5
    expect(planTakeProfit({ pnlNow: 100, highWater: 0, collAfter: 100, sizeUsd: 20, cfg: CFG }).fire).toBe(false);
  });

  it("does NOT fire when realized profit is below the floor ($1)", () => {
    // coll 4 → trigger 1; pnl 4 ≥ 1 fires the gate, but realized 4×0.2=$0.80 < $1
    expect(planTakeProfit({ pnlNow: 4, highWater: 0, collAfter: 4, sizeUsd: 1000, cfg: CFG }).fire).toBe(false);
  });

  it("does NOT fire on a non-positive position (collAfter ≤ 0 → trigger Infinity)", () => {
    const r = planTakeProfit({ pnlNow: 100, highWater: 0, collAfter: 0, sizeUsd: 1000, cfg: CFG });
    expect(r.fire).toBe(false);
    expect(r.trigger).toBe(Infinity);
  });

  it("clamps tpCloseFraction into [0, 0.95]", () => {
    const hi = planTakeProfit({ pnlNow: 100, highWater: 0, collAfter: 100, sizeUsd: 1000, cfg: { ...CFG, tpCloseFraction: 2 } });
    expect(hi.frac).toBe(0.95);
  });
});

// ── PURE: applyTakeProfit ─────────────────────────────────────────────────────
describe("applyTakeProfit (pure)", () => {
  it("F1: residual writeback — nextPnlNow === nextHighWater === pnlNow·(1−frac)", () => {
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 1000, collAfter: 100, actualCloseSizeUsd: 200, cfg: CFG });
    // 20% closed → 80% residual on BOTH the writeback and the high-water.
    expect(a.nextPnlNow).toBeCloseTo(80, 10);
    expect(a.nextHighWater).toBeCloseTo(80, 10);
    expect(a.nextPnlNow).toBe(a.nextHighWater); // the regression guard for F1
  });

  it("scales size and collateral by the applied fraction (leverage preserved)", () => {
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 1000, collAfter: 100, actualCloseSizeUsd: 200, cfg: CFG });
    expect(a.nextSize).toBe(800);
    expect(a.nextColl).toBeCloseTo(80, 10);
    // size/coll unchanged: 1000/100 = 10x → 800/80 = 10x
    expect(a.nextSize / a.nextColl).toBeCloseTo(1000 / 100, 10);
  });

  it("splits realized profit 25% master / 75% buyback, summing to realizedActual", () => {
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 1000, collAfter: 100, actualCloseSizeUsd: 200, cfg: CFG });
    expect(a.realizedActual).toBeCloseTo(20, 10);
    expect(a.masterShareUsd).toBeCloseTo(5, 10); // 25%
    expect(a.buybackShareUsd).toBeCloseTo(15, 10); // 75%
    expect(a.masterShareUsd + a.buybackShareUsd).toBeCloseTo(a.realizedActual, 10);
  });

  it("uses the ACTUAL applied close size, not the planned one (partial fill)", () => {
    // venue only filled $100 of the planned $200
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 1000, collAfter: 100, actualCloseSizeUsd: 100, cfg: CFG });
    expect(a.appliedFrac).toBeCloseTo(0.1, 10);
    expect(a.nextSize).toBe(900);
    expect(a.realizedActual).toBeCloseTo(10, 10);
  });

  it("clamps appliedFrac to 1 when the venue closes more than the tracked size", () => {
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 1000, collAfter: 100, actualCloseSizeUsd: 2000, cfg: CFG });
    expect(a.appliedFrac).toBe(1);
    expect(a.nextSize).toBe(0);
    expect(a.nextColl).toBe(0);
    expect(a.nextPnlNow).toBe(0);
  });

  it("is NaN-safe when sizeUsd is 0", () => {
    const a = applyTakeProfit({ pnlNow: 100, sizeUsd: 0, collAfter: 100, actualCloseSizeUsd: 50, cfg: CFG });
    expect(a.appliedFrac).toBe(0);
    expect(a.realizedActual).toBe(0);
    expect(a.nextSize).toBe(0);
  });
});

// ── FLOW helpers ──────────────────────────────────────────────────────────────
function baseCtx(overrides: Record<string, any> = {}) {
  return {
    t: {
      id: "tok-1",
      ticker: "TST",
      treasury_pnl_usd: 0,
      pnl_high_water_usd: 0,
      position_size_usd: 1000,
      position_collateral_usd: 100,
      imperial_profile_index: 0,
      launch_mid: 0,
      ...(overrides.t ?? {}),
    },
    bucket: "b",
    tickId: "tick-1",
    solUsd: 200,
    patch: {},
    events: [],
    txLog: [],
    currentColl: 100,
    currentReserve: 0,
    reserveDelta: 0,
    hasLivePosition: true,
    pendingSig: null,
    chainPos: { sizeUsd: 1000, collateralUsd: 100, markPriceUsd: 1, unrealizedPnlUsd: 100 },
    isImperialRouted: false,
    imperialFullTrade: false,
    imperialTradeEnabled: false,
    underlying: "TST",
    side: "long",
    kp: { publicKey: { toBase58: () => "Wallet1111111111111111111111111111111111111" } },
    buybackMint: null,
    optimisticImperialPositionState: false,
    ensureAuth: async () => "auth-token",
    ...overrides,
  };
}

const REAL_SIG = "5".repeat(88); // passes isRealSolanaSignature

beforeEach(() => {
  vi.clearAllMocks();
});

// ── FLOW: F1 end-to-end (no re-fire) ──────────────────────────────────────────
describe("pnlAndTakeProfitStep — F1 residual writeback (flow)", () => {
  it("after an accepted close, persists the RESIDUAL pnl + high-water and reduces the position", async () => {
    venue.partialClose.mockResolvedValue({ signature: REAL_SIG });
    const ctx = baseCtx(); // pnl 100, coll 100, size 1000, non-imperial
    await pnlAndTakeProfitStep(ctx as any);

    expect(venue.partialClose).toHaveBeenCalledOnce();
    expect(ctx.pnlNow).toBeCloseTo(80, 6); // F1: residual, not the stale 100
    expect(ctx.newHighWater).toBeCloseTo(80, 6);
    expect(ctx.patch.position_size_usd).toBeCloseTo(800, 6);
    expect(ctx.patch.position_collateral_usd).toBeCloseTo(80, 6);
  });

  it("does NOT re-fire on a follow-up tick when the read is missed (pnl falls back to the residual)", async () => {
    venue.partialClose.mockResolvedValue({ signature: REAL_SIG });
    // Simulate the next tick after the close above: DB now carries the residual,
    // and the position read is missing (chainPos null, not re-opened this tick).
    const ctx = baseCtx({
      t: { treasury_pnl_usd: 80, pnl_high_water_usd: 80, position_size_usd: 800, position_collateral_usd: 80 },
      chainPos: null,
      currentColl: 80,
    });
    await pnlAndTakeProfitStep(ctx as any);

    expect(venue.partialClose).not.toHaveBeenCalled(); // 80 − 80 = 0 < trigger
  });
});

// ── FLOW: F2 reserve-credit-after-withdraw ────────────────────────────────────
describe("pnlAndTakeProfitStep — F2 reserve only credited after withdraw (flow)", () => {
  it("does NOT credit reserveDelta when the profile withdraw fails, and records the failure", async () => {
    venue.imperialPartialClose.mockResolvedValue({
      signature: "verified-via-positions",
      verifiedVia: "positions",
      appliedReduceSizeUsd: 200,
    });
    // non-transient rejection → withVenueRetry gives up fast and throws
    venue.imperialWithdrawCollateral.mockRejectedValue(new Error("withdraw rejected: insufficient free margin"));

    const ctx = baseCtx({
      isImperialRouted: true,
      imperialFullTrade: true,
      imperialTradeEnabled: true,
      buybackMint: "BuyBackMint11111111111111111111111111111111",
    });
    await pnlAndTakeProfitStep(ctx as any);

    expect(venue.imperialWithdrawCollateral).toHaveBeenCalled();
    expect(ctx.reserveDelta).toBe(0); // F2: NOT credited because the withdraw failed
    const notes = ctx.events.map((e: any) => e.note ?? "").join(" | ");
    expect(notes).toMatch(/tp profit-route pending/);
    // no buyback-split event was emitted (it lives after the withdraw now)
    expect(ctx.events.some((e: any) => e.kind === "buyback")).toBe(false);
  });

  it("DOES credit reserveDelta after a successful withdraw and emits the split event", async () => {
    venue.imperialPartialClose.mockResolvedValue({
      signature: "verified-via-positions",
      verifiedVia: "positions",
      appliedReduceSizeUsd: 200,
    });
    venue.imperialWithdrawCollateral.mockResolvedValue({ signature: REAL_SIG });
    venue.swapUsdcToSol.mockResolvedValue({ solReceived: 0 }); // skip the SOL transfer leg

    const ctx = baseCtx({
      isImperialRouted: true,
      imperialFullTrade: true,
      imperialTradeEnabled: true,
      buybackMint: "BuyBackMint11111111111111111111111111111111",
    });
    await pnlAndTakeProfitStep(ctx as any);

    // realized ≈ 20 → buyback share 75% ≈ 15
    expect(ctx.reserveDelta).toBeCloseTo(15, 6);
    expect(ctx.events.some((e: any) => e.kind === "buyback")).toBe(true);
  });
});

// ── FLOW: F5 re-fire gate (tp-settle sentinel) ────────────────────────────────
describe("F5 tp-settle sentinel", () => {
  it("pnlAndTakeProfitStep parks the sentinel when a close is accepted without a real signature", async () => {
    venue.imperialPartialClose.mockResolvedValue({
      signature: "verified-via-positions",
      verifiedVia: "positions",
      appliedReduceSizeUsd: 200,
    });
    venue.imperialWithdrawCollateral.mockResolvedValue({ signature: REAL_SIG });
    venue.swapUsdcToSol.mockResolvedValue({ solReceived: 0 });

    const ctx = baseCtx({
      isImperialRouted: true,
      imperialFullTrade: true,
      imperialTradeEnabled: true,
      buybackMint: "BuyBackMint11111111111111111111111111111111",
    });
    await pnlAndTakeProfitStep(ctx as any);
    expect(ctx.patch.pending_drift_sig).toBe("tp-settle");
  });

  it("confirmPendingSigStep defers exactly one tick on the sentinel without polling checkSig", async () => {
    const ctx: any = { t: { ticker: "TST", pending_drift_sig: "tp-settle" }, patch: {}, events: [] };
    await confirmPendingSigStep(ctx);
    expect(ctx.patch.pending_drift_sig).toBeNull(); // cleared from DB (lasts one tick)
    expect(ctx.pendingSig).toBe("tp-settle"); // still truthy → this tick's TP/top-up defer
    expect(ctx.events.some((e: any) => /tp settle/.test(e.note ?? ""))).toBe(true);
  });

  it("confirmPendingSigStep is a no-op when there is no pending sig", async () => {
    const ctx: any = { t: { ticker: "TST" }, patch: {}, events: [] };
    await confirmPendingSigStep(ctx);
    expect(ctx.pendingSig).toBeNull();
    expect(ctx.patch.pending_drift_sig).toBeUndefined();
  });
});
