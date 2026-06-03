// Problem #1 — Fee routing reliability (TEST_PLAN.md §0.5).
//
// Two layers:
//   1. Pure gate logic (T1, no DB) — the thresholds/decisions in isolation.
//   2. e2e simulated lifecycle (T2/T3) — drive a token as if it were created,
//      accrued fees, claimed, and routed; assert at each step that we can't fall
//      into a bad state (stranded-and-invisible, double-route, lost fees). The DB
//      is RESET after every it() so one test's mutations never leak into the next.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { gateImperialFunding } from "../../keeper/src/imperialDeposit.js";
import { SWEEP_THRESHOLD_USD } from "../../keeper/src/externalRouters.js";
import { classifyState } from "../../keeper/src/workflow.js";
import { blockedReasonFromEvents } from "../../keeper/src/loop.js";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  getToken,
  getWorkflow,
  setFees,
  applyWorkflow,
  recordAction,
  recordTx,
  countActions,
  closeDb,
} from "../helpers/db.ts";

describe("fee routing reliability — gates (T1, no DB)", () => {
  it("never sweeps sub-threshold stranded SOL: the route gate is $25", () => {
    expect(SWEEP_THRESHOLD_USD).toBe(25);
    expect(24 < SWEEP_THRESHOLD_USD).toBe(true);
    expect(26 >= SWEEP_THRESHOLD_USD).toBe(true);
  });

  it("withholds Imperial funding below the open gate WITH a determinable reason", () => {
    const r = gateImperialFunding({ token: { fees_accrued_usd: 5 }, kind: "open", requestedUsd: 5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/gate/i);
  });

  it("below the viable swap floor it accumulates (awaiting_swap_size), not a hard error", () => {
    const r = gateImperialFunding({ token: { fees_accrued_usd: 30 }, kind: "topup", requestedUsd: 0.5 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/awaiting_swap_size/i);
  });

  it("never funds more than the token has earned — master principal is not subsidized", () => {
    const r = gateImperialFunding({ token: { fees_accrued_usd: 60 }, kind: "open", requestedUsd: 999 });
    expect(r.allow).toBe(true);
    expect(r.allowedUsd).toBeLessThanOrEqual(60);
  });

  it("rejects malformed requests explicitly (no silent pass)", () => {
    expect(gateImperialFunding({ token: null, kind: "open", requestedUsd: 100 }).allow).toBe(false);
    expect(gateImperialFunding({ token: { fees_accrued_usd: 100 }, kind: "bogus", requestedUsd: 100 }).allow).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("fee routing reliability — e2e simulated lifecycle (DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb(); // clear ALL per-token state after every single it()
  });
  afterAll(async () => {
    await closeDb();
  });

  it("a freshly-created token with no fees sits idle — nothing is routed", async () => {
    const id = await seedToken({ fees_accrued_usd: 0 });
    const token = await getToken(id);
    const state = classifyState(token, {}, { feesAccruedAfter: 0 });
    await applyWorkflow(id, { state });
    expect((await getWorkflow(id)).state).toBe("idle");
    expect(await countActions(id, "imperial_deposit")).toBe(0);
  });

  it("sub-$25 accrued fees are NOT routed — token accrues, with a queryable state (not a silent stall)", async () => {
    const id = await seedToken({ fees_accrued_usd: 0 });
    await setFees(id, 10); // fees drip in over a tick
    const token = await getToken(id);
    const gate = gateImperialFunding({ token, kind: "open", requestedUsd: Number(token.fees_accrued_usd) });
    expect(gate.allow).toBe(false); // below gate → nothing deployed
    await applyWorkflow(id, { state: classifyState(token, {}, { feesAccruedAfter: 10 }) });
    expect(["idle", "split_reserved"]).toContain((await getWorkflow(id)).state);
    expect(await countActions(id, "imperial_deposit")).toBe(0);
  });

  it("once fees cross the gate, routing deploys EXACTLY once — a duplicate intent cannot double-route", async () => {
    const id = await seedToken({ fees_accrued_usd: 30 });
    const token = await getToken(id);
    const gate = gateImperialFunding({ token, kind: "open", requestedUsd: Number(token.fees_accrued_usd) });
    expect(gate.allow).toBe(true);
    expect(gate.allowedUsd).toBeLessThanOrEqual(30);

    const intent = "route:bucket-1";
    await recordAction(id, { action_kind: "imperial_deposit", intent_hash: intent, status: "confirmed" });
    await applyWorkflow(id, { state: "imperial_deposited" });
    // a re-tick re-derives the SAME intent → the unique ledger key blocks a 2nd deposit
    await expect(recordAction(id, { action_kind: "imperial_deposit", intent_hash: intent })).rejects.toThrow();
    expect(await countActions(id, "imperial_deposit")).toBe(1);
    expect((await getWorkflow(id)).state).toBe("imperial_deposited");
  });

  it("claim succeeds but the route fails → reason is DERIVED from the keeper's failure note (not lost); fees preserved + retry", async () => {
    const id = await seedToken({ fees_accrued_usd: 40 });
    await recordTx(id, { kind: "fee_claim_dbc", intent_hash: "claim:1", status: "confirmed" }); // claim landed

    // The keeper's actual tick events: claim ok, then the route/deposit leg fails.
    // blockedReasonFromEvents is the REAL mechanism that turns notes into the
    // workflow blocked_reason (it never invents a string).
    const events = [
      { kind: "open", note: "[imperial] long SOL 5x ..." },
      { kind: "tick", note: "[imperial:deposit] TEST topup failed: swap reverted" },
    ];
    const reason = blockedReasonFromEvents(events);
    expect(reason).toMatch(/failed/i); // a determinable cause surfaced from the note

    await applyWorkflow(id, {
      state: "blocked",
      blocked_reason: reason,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const wf = await getWorkflow(id);
    expect(wf.state).toBe("blocked");
    expect(wf.blocked_reason).toBe(reason); // WHY is in the DB, derived from the keeper's own note
    expect(wf.next_retry_at).toBeTruthy(); // will be retried, not stuck forever
    expect(Number((await getToken(id)).fees_accrued_usd)).toBe(40); // fees still on the books
  });

  it("invariant: the workflow can never be written into a removed/invalid state", async () => {
    const id = await seedToken();
    await expect(applyWorkflow(id, { state: "fees_pending" })).rejects.toThrow(); // CHECK rejects the deleted state
  });
});
