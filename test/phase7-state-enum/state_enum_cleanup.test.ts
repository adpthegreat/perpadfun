// TEST_PLAN.md Phase 7 - State-enum cleanup (no dead states, no drift).
//
// The 3 dead states (fees_pending, imperial_deposit_pending, profit_realize_pending)
// were removed. This proves they're gone from ALL THREE definitions and that the
// three stay in lockstep:
//   - keeper/src/workflow.js   State enum + classifyState (T1)
//   - src/lib/keeperWorkflowStates.ts  app Zod enum (T1)
//   - token_workflows.state    DB CHECK constraint (T2, e2e)
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { classifyState, State } from "../../keeper/src/workflow.js";
import { WorkflowState, WORKFLOW_STATES } from "../../src/lib/keeperWorkflowStates.ts";
import { dbAvailable, ensureSchema, resetDb, seedToken, query, closeDb } from "../helpers/db.ts";

const DEAD = ["fees_pending", "imperial_deposit_pending", "profit_realize_pending"];
const LIVE = Object.values(State) as string[];
const ISO = new Date().toISOString();

describe("Phase 7: state-enum cleanup - no dead states, no drift (T1)", () => {
  it("7.1 classifyState NEVER emits a deleted state - even when the OLD trigger flags are set", () => {
    let count = 0;
    for (const position_opened_at of [null, ISO])
      for (const pending_drift_sig of [null, "sig"])
        for (const fees_accrued_usd of [0, 5, 50])
          for (const buyback_reserve_usd of [0, 10])
            for (const blockedReason of [null, "gate"])
              for (const error of [null, "boom"])
                for (const claimedFeesUsd of [0, 5])
                  for (const imperialDepositedThisTickUsd of [0, 50])
                    for (const profitPending of [false, true]) // old trigger for profit_realize_pending
                      for (const depositPending of [false, true]) {
                        // old trigger for imperial_deposit_pending
                        const s = classifyState(
                          { position_opened_at, pending_drift_sig, fees_accrued_usd, buyback_reserve_usd },
                          {},
                          { blockedReason, error, claimedFeesUsd, imperialDepositedThisTickUsd, profitPending, depositPending },
                        );
                        expect(DEAD).not.toContain(s);
                        expect(LIVE).toContain(s);
                        count++;
                      }
    expect(count).toBeGreaterThan(1000); // the exhaustive sweep actually ran
  });

  it("7.2 the keeper State enum has exactly the 9 live values", () => {
    expect(LIVE).toHaveLength(9);
    for (const d of DEAD) expect(LIVE).not.toContain(d);
    expect([...LIVE].sort()).toEqual([
      "blocked",
      "error",
      "fees_claimed",
      "idle",
      "imperial_deposited",
      "position_open",
      "position_open_pending",
      "split_reserved",
      "topup_pending",
    ]);
  });

  it("7.3 the app Zod enum accepts the 9 and rejects the 3 deleted", () => {
    for (const s of WORKFLOW_STATES) expect(WorkflowState.safeParse(s).success).toBe(true);
    for (const d of DEAD) expect(WorkflowState.safeParse(d).success).toBe(false);
  });

  it("7.3 keeper State enum and app Zod enum agree (no drift)", () => {
    expect([...WORKFLOW_STATES].sort()).toEqual([...LIVE].sort());
  });
});

describe.skipIf(!dbAvailable)("Phase 7: DB CHECK matches the enum (e2e, T2)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("7.3 token_workflows.state CHECK accepts the 9 and rejects the 3 deleted", async () => {
    for (const s of LIVE) {
      const id = await seedToken();
      await query("insert into public.token_workflows (token_id, state) values ($1, $2)", [id, s]);
    }
    for (const d of DEAD) {
      const id = await seedToken();
      await expect(query("insert into public.token_workflows (token_id, state) values ($1, $2)", [id, d])).rejects.toThrow();
    }
  });
});
