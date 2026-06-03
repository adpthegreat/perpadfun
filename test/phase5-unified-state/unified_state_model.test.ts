// Problem #5 - No unified state model (TEST_PLAN.md 0.5).
//
// Before: fee state lived on-chain (sub-wallets), position state in Imperial's
// API, accounting in Postgres - three sources, no single truth, no reconciliation.
// After: classifyState() collapses all of those facts into ONE deterministic
// canonical state on the token_workflows row, and that state is re-derivable
// (reconcilable) from the facts at any time.
//
// This proves the unified model:
//   1. classifyState is a deterministic, total function of the token's facts;
//   2. its priority cascade resolves conflicting multi-source signals to exactly
//      ONE canonical state (never an ambiguous/contradictory state);
//   3. the persisted token_workflows.state equals the derived state, and
//      re-deriving from the row yields the same state (idempotent reconciliation);
//   4. the reconciliation job's SAFETY invariant holds: a recovered token can
//      re-open, but a confirmed/pending one cannot be double-opened.
// (The full reconcile-job recovery wiring - error->idle, stale-pending clear,
//  escalation - is exercised in the dedicated Phase 8 reconcile suite.)
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { classifyState, workflowBlocksOpen, State } from "../../keeper/src/workflow.js";
import { dbAvailable, ensureSchema, resetDb, seedToken, getToken, getWorkflow, applyWorkflow, closeDb } from "../helpers/db.ts";

const ISO = () => new Date().toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();
const VALID_STATES = Object.values(State);

describe("Problem #5: unified state model - classifyState is the single source of truth", () => {
  it("is deterministic: identical facts always yield the same state", () => {
    const token = { position_opened_at: ISO(), fees_accrued_usd: 50, pending_drift_sig: "s" };
    expect(classifyState(token)).toBe(classifyState(token));
    expect(classifyState(token)).toBe(classifyState({ ...token }));
  });

  it("is total: every distinct fact-set maps to exactly one of the 9 canonical states", () => {
    expect(classifyState({}, {}, { blockedReason: "gate" })).toBe(State.BLOCKED);
    expect(classifyState({}, {}, { error: "boom" })).toBe(State.ERROR);
    expect(classifyState({ position_opened_at: ISO(), pending_drift_sig: "s" })).toBe(State.TOPUP_PENDING);
    expect(classifyState({ pending_drift_sig: "s" })).toBe(State.POSITION_OPEN_PENDING);
    expect(classifyState({ position_opened_at: ISO() })).toBe(State.POSITION_OPEN);
    expect(classifyState({}, {}, { imperialDepositedThisTickUsd: 50 })).toBe(State.IMPERIAL_DEPOSITED);
    expect(classifyState({ fees_accrued_usd: 5 })).toBe(State.SPLIT_RESERVED);
    expect(classifyState({}, {}, { claimedFeesUsd: 5 })).toBe(State.FEES_CLAIMED);
    expect(classifyState({})).toBe(State.IDLE);
  });

  it("never emits a state outside the canonical enum (across a fact sweep)", () => {
    const facts = [
      {},
      { position_opened_at: ISO() },
      { pending_drift_sig: "s" },
      { fees_accrued_usd: 12 },
      { buyback_reserve_usd: 7 },
      { position_opened_at: ISO(), pending_drift_sig: "s", fees_accrued_usd: 99 },
    ];
    const ctxs = [{}, { blockedReason: "x" }, { error: "x" }, { imperialDepositedThisTickUsd: 30 }, { claimedFeesUsd: 4 }];
    for (const f of facts) for (const c of ctxs) expect(VALID_STATES).toContain(classifyState(f, {}, c));
  });

  it("collapses conflicting multi-source signals to ONE canonical state by priority", () => {
    // on-chain position + Postgres fees -> the live position wins (not split_reserved)
    expect(classifyState({ position_opened_at: ISO(), fees_accrued_usd: 100 })).toBe(State.POSITION_OPEN);
    // an in-flight sig on a live position -> topup_pending (not position_open)
    expect(classifyState({ position_opened_at: ISO(), pending_drift_sig: "s" })).toBe(State.TOPUP_PENDING);
    // a keeper gate (blocked) overrides every on-chain/accounting fact
    expect(classifyState({ position_opened_at: ISO(), fees_accrued_usd: 100 }, {}, { blockedReason: "market_unsupported" })).toBe(State.BLOCKED);
  });

  it("reconciliation SAFETY: recovered tokens can re-open; confirmed/pending ones cannot be double-opened", () => {
    // error -> idle recovery target: re-open allowed (token unstuck)
    expect(workflowBlocksOpen({ state: State.IDLE, hasLivePosition: false })).toBe(false);
    // recon confirms a real position -> a re-open is refused (no double-open)
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN, hasLivePosition: false })).toBe(true);
    // a stale pending past its retry deadline is recoverable (retry allowed, not stuck forever)
    expect(workflowBlocksOpen({ state: State.POSITION_OPEN_PENDING, nextRetryAt: past(), hasLivePosition: false })).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("Problem #5: token_workflows is the single persisted truth, reconcilable from facts", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("the persisted state equals the state derived from the token's facts", async () => {
    const id = await seedToken({ fees_accrued_usd: 0, position_opened_at: ISO() });
    const derived = classifyState(await getToken(id));
    await applyWorkflow(id, { state: derived });
    expect((await getWorkflow(id)).state).toBe(derived);
    expect(derived).toBe(State.POSITION_OPEN); // on-chain position is the canonical truth
  });

  it("re-deriving from the row yields the same canonical state (idempotent reconciliation, no drift)", async () => {
    const id = await seedToken({ fees_accrued_usd: 8 }); // recorded fees -> split_reserved
    const first = classifyState(await getToken(id));
    await applyWorkflow(id, { state: first });
    // a second reconciliation pass reads the row and re-derives -> identical, no drift
    const second = classifyState(await getToken(id));
    expect(second).toBe(first);
    expect(second).toBe(State.SPLIT_RESERVED);
    await applyWorkflow(id, { state: second });
    expect((await getWorkflow(id)).state).toBe(first);
  });

  it("three previously-scattered sources resolve into one row state", async () => {
    // fees (Postgres) + an in-flight sig (keeper) + no position (Imperial) -> one state
    const id = await seedToken({ fees_accrued_usd: 40, pending_drift_sig: "sig-x", position_opened_at: null });
    const derived = classifyState(await getToken(id));
    await applyWorkflow(id, { state: derived });
    expect(derived).toBe(State.POSITION_OPEN_PENDING); // pending sig + no live position wins
    expect((await getWorkflow(id)).state).toBe(State.POSITION_OPEN_PENDING);
  });
});
