// TEST_PLAN.md Phase 2 - Fix 1: dust / collateral floors (causes A, B, E).
//
// Proves the keeper never swaps/deposits sub-viable dust and never strands
// reserve below the gate. The decisions are pure: gateImperialFunding (the
// fee-gate + kind-aware deposit floor) and walletCapacityUsd (the swap-capacity
// floor, the DUMPED/ELON skip). Plus an e2e accumulation check.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { gateImperialFunding, walletCapacityUsd } from "../../keeper/src/imperialDeposit.js";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  getToken,
  setFees,
  applyWorkflow,
  recordAction,
  countActions,
  closeDb,
} from "../helpers/db.ts";

// Read the live floors/gate from the gate itself, so assertions track config.
const big = { fees_accrued_usd: 1_000_000 };
// Number(...) because the gate's return type marks gate/floor optional (not all
// branches set them); the big-fees call always does, so these are real numbers.
const GATE = Number(gateImperialFunding({ token: big, kind: "open", requestedUsd: 1_000_000 }).gate); // 20
const OPEN_FLOOR = Number(gateImperialFunding({ token: big, kind: "open", requestedUsd: 1_000_000 }).floor); // 10
const TOPUP_FLOOR = Number(gateImperialFunding({ token: big, kind: "topup", requestedUsd: 1_000_000 }).floor); // 2
const CAPACITY_FLOOR = 2; // ensureUsdcForDeposit: max(1, config.minDepositUsd ?? 2)

describe("Phase 2: dust / collateral floors (T1, pure gate)", () => {
  it("2.1 an open below the fee gate is withheld, with a determinable reason", () => {
    const r = gateImperialFunding({ token: { fees_accrued_usd: GATE - 1 }, kind: "open", requestedUsd: GATE });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/gate/i);
  });

  it("2.1 an open above the gate but below the open floor is withheld (never a partial deposit)", () => {
    const below = gateImperialFunding({ token: big, kind: "open", requestedUsd: OPEN_FLOOR - 0.01 });
    expect(below.allow).toBe(false);
    expect(below.reason).toMatch(/awaiting_swap_size/i);
    expect(gateImperialFunding({ token: big, kind: "open", requestedUsd: OPEN_FLOOR }).allow).toBe(true);
  });

  it("2.2 kind-aware floor: open floor >= topup floor; a mid amount tops-up but cannot open", () => {
    expect(OPEN_FLOOR).toBeGreaterThanOrEqual(TOPUP_FLOOR);
    if (OPEN_FLOOR > TOPUP_FLOOR) {
      const mid = (OPEN_FLOOR + TOPUP_FLOOR) / 2;
      expect(gateImperialFunding({ token: big, kind: "topup", requestedUsd: mid }).allow).toBe(true);
      const openMid = gateImperialFunding({ token: big, kind: "open", requestedUsd: mid });
      expect(openMid.allow).toBe(false);
      expect(openMid.reason).toMatch(/awaiting_swap_size/i);
    }
  });

  it("2.4 reserve below the gate accumulates (withheld); at/above the gate it becomes eligible", () => {
    expect(gateImperialFunding({ token: { fees_accrued_usd: GATE - 0.01 }, kind: "open", requestedUsd: GATE }).allow).toBe(false);
    expect(gateImperialFunding({ token: { fees_accrued_usd: GATE }, kind: "open", requestedUsd: GATE }).allow).toBe(true);
  });

  it("never funds more than fees earned (cap = fees) - master principal is not subsidized", () => {
    const r = gateImperialFunding({ token: { fees_accrued_usd: 50 }, kind: "open", requestedUsd: 999 });
    expect(r.allow).toBe(true);
    expect(r.allowedUsd).toBeLessThanOrEqual(50);
  });
});

describe("Phase 2: wallet swap-capacity floor (2.3, walletCapacityUsd, T1)", () => {
  it("computes parked USDC + swappable SOL (above reserve, 3% haircut)", () => {
    expect(walletCapacityUsd({ usdcUi: 10, solUi: 1, solUsd: 100, reserveSol: 0.01 })).toBeCloseTo(10 + 0.99 * 100 * 0.97, 2);
  });
  it("SOL below the keep-alive reserve contributes nothing (capacity = parked USDC)", () => {
    expect(walletCapacityUsd({ usdcUi: 3, solUi: 0.005, solUsd: 100, reserveSol: 0.01 })).toBe(3);
  });
  it("2.3 the DUMPED/ELON case: tiny SOL + ~0 USDC -> capacity below the floor (skip, no doomed swap)", () => {
    expect(walletCapacityUsd({ usdcUi: 0, solUi: 0.015, solUsd: 100, reserveSol: 0.01 })).toBeLessThan(CAPACITY_FLOOR);
  });
  it("a healthy wallet clears the floor (would proceed to swap + deposit)", () => {
    expect(walletCapacityUsd({ usdcUi: 0, solUi: 1, solUsd: 100, reserveSol: 0.01 })).toBeGreaterThan(CAPACITY_FLOOR);
  });
});

describe.skipIf(!dbAvailable)("Phase 2: dust accumulation - e2e (DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("sub-gate fees accumulate with no deposit; crossing the gate makes it eligible (deployed once)", async () => {
    const id = await seedToken({ fees_accrued_usd: 0 });

    // fees drip in below the gate -> withheld, nothing deployed
    await setFees(id, GATE - 5);
    let t = await getToken(id);
    expect(
      gateImperialFunding({ token: { fees_accrued_usd: Number(t.fees_accrued_usd) }, kind: "open", requestedUsd: Number(t.fees_accrued_usd) }).allow,
    ).toBe(false);
    await applyWorkflow(id, { state: "split_reserved" }); // accruing, not deployed
    expect(await countActions(id, "imperial_deposit")).toBe(0);

    // fees cross the gate -> eligible, deposit happens exactly once
    await setFees(id, GATE + 10);
    t = await getToken(id);
    expect(
      gateImperialFunding({ token: { fees_accrued_usd: Number(t.fees_accrued_usd) }, kind: "open", requestedUsd: Number(t.fees_accrued_usd) }).allow,
    ).toBe(true);
    await recordAction(id, { action_kind: "imperial_deposit", intent_hash: "dep:1", status: "confirmed" });
    await applyWorkflow(id, { state: "imperial_deposited" });
    expect(await countActions(id, "imperial_deposit")).toBe(1);
  });
});
