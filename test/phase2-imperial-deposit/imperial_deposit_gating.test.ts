// Problem #2 - Imperial deposit gating: atomicity & idempotency of the chain
// fees claimed -> routed -> deposited -> position_open (TEST_PLAN.md 0.5).
//
// The chain isn't a single atomic op - it's a durable, resumable STATE MACHINE
// where every step is idempotent. These tests drive the full lifecycle and prove:
//   - each step has a named, persisted checkpoint (a mid-chain failure is visible,
//     not a silent stall);
//   - the keeper_actions ledger makes deposit/open idempotent (no double-execute);
//   - the 3a workflow guard blocks a double-open even when the venue read lags,
//     and even after a crash between the open send and recording the result (3b);
//   - a failed step resumes WITHOUT redoing prior steps.
// DB is reset after every it().
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { gateImperialFunding } from "../../keeper/src/imperialDeposit.js";
import { workflowBlocksOpen, State } from "../../keeper/src/workflow.js";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  getToken,
  getWorkflow,
  applyWorkflow,
  recordAction,
  countActions,
  query,
  closeDb,
} from "../helpers/db.ts";

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

describe("imperial deposit gating - guards (T1, no DB)", () => {
  it("the deposit gate withholds below the accrual gate, allows above it", () => {
    expect(gateImperialFunding({ token: { fees_accrued_usd: 5 }, kind: "open", requestedUsd: 5 }).allow).toBe(false);
    expect(gateImperialFunding({ token: { fees_accrued_usd: 60 }, kind: "open", requestedUsd: 60 }).allow).toBe(true);
  });

  it("anti-double-open guard (3a) - full truth table", () => {
    expect(workflowBlocksOpen({ state: State.IDLE, hasLivePosition: false })).toBe(false);
    expect(workflowBlocksOpen({ state: State.IMPERIAL_DEPOSITED, hasLivePosition: false })).toBe(false); // ready to open
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN, hasLivePosition: false })).toBe(true); // durable says live
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN_PENDING, nextRetryAt: future(), hasLivePosition: false })).toBe(true); // in-flight
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN_PENDING, nextRetryAt: past(), hasLivePosition: false })).toBe(false); // stale -> allow retry
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN, hasLivePosition: true })).toBe(false); // live -> caller's gate handles it
  });
});

describe.skipIf(!dbAvailable)("imperial deposit gating - atomic & idempotent chain (DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  // Simulate one keeper open attempt against current durable state. Mirrors the
  // loop.js gate: refuse if a position is live, a sig is pending, or the 3a guard
  // blocks; otherwise write the 3b pre-send marker, then record the open.
  async function attemptOpen(id: string, intent: string): Promise<boolean> {
    const token = await getToken(id);
    const wf = await getWorkflow(id);
    const hasLive = !!token.position_opened_at;
    const pendingSig = !!token.pending_drift_sig;
    const blocked =
      hasLive ||
      pendingSig ||
      workflowBlocksOpen({ state: wf?.state ?? null, nextRetryAt: wf?.next_retry_at, hasLivePosition: hasLive });
    if (blocked) return false;
    await applyWorkflow(id, { state: "position_open_pending", next_retry_at: future() }); // 3b: durable BEFORE the send
    await recordAction(id, { action_kind: "imperial_open", intent_hash: intent, status: "confirmed" });
    return true;
  }

  it("the chain advances through named, durable checkpoints - a mid-chain stop is a named state", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    for (const s of ["fees_claimed", "split_reserved", "imperial_deposited", "position_open_pending", "position_open"]) {
      await applyWorkflow(id, { state: s });
      expect((await getWorkflow(id)).state).toBe(s); // each step is a valid, persisted checkpoint
    }
  });

  it("deposit is idempotent: the same deposit intent cannot fund the profile twice", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    const intent = "deposit:bucket-1";
    await recordAction(id, { action_kind: "imperial_deposit", intent_hash: intent, status: "confirmed" });
    await applyWorkflow(id, { state: "imperial_deposited" });
    await expect(recordAction(id, { action_kind: "imperial_deposit", intent_hash: intent })).rejects.toThrow();
    expect(await countActions(id, "imperial_deposit")).toBe(1);
  });

  it("open is idempotent: a second open is refused while one is pending within its retry window (lag-immune)", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    await applyWorkflow(id, { state: "imperial_deposited" });
    expect(await attemptOpen(id, "open:1")).toBe(true); // first open proceeds
    // re-tick before the venue indexes the position (no position_opened_at yet) -> guard blocks
    expect(await attemptOpen(id, "open:2")).toBe(false);
    expect(await countActions(id, "imperial_open")).toBe(1); // exactly ONE open
  });

  it("crash after the open send still cannot double-open (3b durable pre-send marker)", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    await applyWorkflow(id, { state: "imperial_deposited" });
    // marker written + send happened, then CRASH before recording the result:
    await applyWorkflow(id, { state: "position_open_pending", next_retry_at: future() });
    // next (fresh) tick sees the durable marker -> refuses to re-send
    expect(await attemptOpen(id, "open:after-crash")).toBe(false);
  });

  it("a failed open resumes WITHOUT re-depositing (atomicity via resumable state)", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    await recordAction(id, { action_kind: "imperial_deposit", intent_hash: "dep:1", status: "confirmed" });
    await applyWorkflow(id, { state: "imperial_deposited" }); // deposit landed
    // open FAILS this tick -> token stays at the named, recoverable checkpoint
    expect((await getWorkflow(id)).state).toBe("imperial_deposited");
    // resume: the deposit is NOT redone (same intent -> ledger blocks; keeper reuses parked USDC)
    await expect(recordAction(id, { action_kind: "imperial_deposit", intent_hash: "dep:1" })).rejects.toThrow();
    expect(await countActions(id, "imperial_deposit")).toBe(1);
    // and the open can now proceed exactly once
    expect(await attemptOpen(id, "open:retry")).toBe(true);
    expect(await countActions(id, "imperial_open")).toBe(1);
  });

  it("once the position is live, neither the gate nor a re-tick can re-deposit or re-open", async () => {
    const id = await seedToken({ fees_accrued_usd: 60 });
    await recordAction(id, { action_kind: "imperial_deposit", intent_hash: "dep:1", status: "confirmed" });
    await attemptOpen(id, "open:1");
    // venue confirms the position -> durable live state
    await query("update public.tokens set position_opened_at = now(), position_collateral_usd = 20 where id = $1", [id]);
    await applyWorkflow(id, { state: "position_open" });
    // re-tick: open refused (live), and re-running the same chain intents is a no-op
    expect(await attemptOpen(id, "open:1")).toBe(false);
    await expect(recordAction(id, { action_kind: "imperial_deposit", intent_hash: "dep:1" })).rejects.toThrow();
    expect(await countActions(id, "imperial_deposit")).toBe(1);
    expect(await countActions(id, "imperial_open")).toBe(1);
  });
});
