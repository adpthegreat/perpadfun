// TEST_PLAN.md Phase 8 - reconciliation: recover ANY stuck token (cause I / benji req).
//
// Drives the WHOLE stateReconcile flow over a randomized 100-token fleet stuck for
// different reasons (error, perp-leg-failed block, dropped open sig, late-indexed
// open, stuck topup, etc.):
//   1. the stuck-query (mirrors GET /api/public/keeper/stuck-tokens) returns the
//      candidate-state tokens and excludes idle/live/split_reserved;
//   2. reconcileNeed() decides the recovery for each (pure);
//   3. resolveStaleOpen() decides the open case from a scripted venue read (the
//      anti-double-open safety);
//   4. applying the recovery reaches a recovered DB state.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  reconcileNeed,
  resolveStaleOpen,
  STALE_PENDING_MS,
  BLOCKED_ESCALATE_MS,
  ERROR_MAX_RESETS,
} from "../../keeper/src/stateReconcile.js";
import { makeStuckFleet } from "../helpers/fleet.ts";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  seedWorkflow,
  queryStuckTokens,
  getToken,
  getWorkflow,
  applyWorkflow,
  query,
  closeDb,
} from "../helpers/db.ts";

describe("Phase 8: reconcile deciders (T1, pure)", () => {
  it("reconcileNeed maps each stuck reason to the right action", () => {
    expect(reconcileNeed({ state: "error", errorResetCount: 0 }).action).toBe("reset-error");
    expect(reconcileNeed({ state: "error", errorResetCount: ERROR_MAX_RESETS }).action).toBe("park-error");
    expect(reconcileNeed({ state: "position_open_pending", hasLivePosition: false, ageMs: STALE_PENDING_MS + 1 }).action).toBe("needs-venue-check");
    expect(reconcileNeed({ state: "position_open_pending", hasLivePosition: false, ageMs: 1000 }).action).toBe("none"); // fresh
    expect(reconcileNeed({ state: "position_open_pending", hasLivePosition: true, ageMs: STALE_PENDING_MS + 1 }).action).toBe("none"); // already live
    expect(reconcileNeed({ state: "topup_pending", ageMs: STALE_PENDING_MS + 1 }).action).toBe("clear-topup");
    expect(reconcileNeed({ state: "blocked", blockedReason: "perp_leg_failed", ageMs: BLOCKED_ESCALATE_MS + 1 }).action).toBe("escalate");
    expect(reconcileNeed({ state: "blocked", blockedReason: "market_unsupported", ageMs: BLOCKED_ESCALATE_MS + 1 }).action).toBe("none"); // terminal
    expect(reconcileNeed({ state: "blocked", blockedReason: "x", ageMs: 1000 }).action).toBe("none"); // fresh
    expect(reconcileNeed({ state: "idle" }).action).toBe("none");
  });

  it("resolveStaleOpen never clears blind (the anti-double-open safety)", () => {
    expect(resolveStaleOpen(undefined).action).toBe("hold"); // couldn't read -> never clear
    expect(resolveStaleOpen({ sizeUsd: 50 }).action).toBe("confirm-open"); // has position -> record it
    expect(resolveStaleOpen(null).action).toBe("clear-open"); // confirmed empty -> clear
    expect(resolveStaleOpen({ sizeUsd: 0 }).action).toBe("clear-open"); // zero size -> empty
  });
});

describe.skipIf(!dbAvailable)("Phase 8: reconcile recovery e2e over a 100-token stuck fleet (DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  async function seedFleet() {
    const fleet = makeStuckFleet(100);
    for (const f of fleet) {
      f._id = await seedToken(f.token);
      await seedWorkflow(f._id, f.wf);
    }
    return fleet;
  }

  it("the stuck-query returns exactly the candidate-state tokens (excludes idle/live/split_reserved)", async () => {
    const fleet = await seedFleet();
    const stuck = await queryStuckTokens();
    const stuckIds = new Set(stuck.map((r) => r.id));
    const byState: Record<string, number> = {};
    for (const r of stuck) byState[r.state] = (byState[r.state] ?? 0) + 1;
    let candidates = 0;
    let nonCandidates = 0;
    for (const f of fleet) {
      expect(stuckIds.has(f._id!), `${f.name} candidacy`).toBe(f.expect.isCandidate);
      f.expect.isCandidate ? candidates++ : nonCandidates++;
    }

    console.log(`\n  [stuck-query] seeded 100 tokens; query returned ${stuck.length}`);
    console.log(`  [stuck-query] returned by workflow state: ${JSON.stringify(byState)}`);
    console.log(
      `  [stuck-query] ${candidates} stuck candidates returned, ${nonCandidates} non-candidates correctly excluded (idle / live / split_reserved)\n`,
    );

    expect(candidates).toBeGreaterThan(0);
    expect(nonCandidates).toBeGreaterThan(0); // proves the query is actually filtering, not returning all
  });

  it("each stuck reason recovers correctly: query -> decide -> resolve -> apply -> final state", async () => {
    const fleet = await seedFleet();
    const byId = new Map((await queryStuckTokens()).map((r) => [r.id, r]));
    const seen = new Set<string>();
    console.log("\n  [reconcile] one row per distinct stuck reason  (state / age -> decision -> recovery):");

    for (const f of fleet) {
      if (!f.expect.isCandidate) continue;
      const row = byId.get(f._id!)!;
      const ageMin = Math.round((Date.now() - new Date(row.updated_at).getTime()) / 60000);
      const need = reconcileNeed({
        state: row.state,
        ageMs: Date.now() - new Date(row.updated_at).getTime(),
        hasLivePosition: !!row.position_opened_at,
        blockedReason: row.blocked_reason,
        errorResetCount: 0,
      });
      expect(need.action, `${f.name} action`).toBe(f.expect.action);
      let recovery = "(no change)";

      switch (need.action) {
        case "reset-error":
          await applyWorkflow(f._id!, { state: "idle", next_retry_at: null });
          expect((await getWorkflow(f._id!)).state).toBe("idle"); // unstuck -> tick re-evaluates
          recovery = "state -> idle (re-driveable)";
          break;
        case "clear-topup":
          await query("update public.tokens set pending_drift_sig = null where id = $1", [f._id]);
          expect((await getToken(f._id!)).pending_drift_sig).toBeNull();
          recovery = "cleared topup sig";
          break;
        case "needs-venue-check": {
          const r = resolveStaleOpen(f.venue);
          expect(r.action, `${f.name} resolve`).toBe(f.expect.resolve);
          if (r.action === "clear-open") {
            await query("update public.tokens set pending_drift_sig = null where id = $1", [f._id]);
            await applyWorkflow(f._id!, { state: "idle", next_retry_at: null });
            expect((await getToken(f._id!)).pending_drift_sig).toBeNull();
            expect((await getWorkflow(f._id!)).state).toBe("idle"); // re-openable, not stuck forever
            recovery = `venue empty -> clear sig + idle (re-openable)`;
          } else if (r.action === "confirm-open") {
            const pos = (r as { pos: { sizeUsd: number; collateralUsd: number } }).pos;
            await query(
              "update public.tokens set position_opened_at = now(), position_size_usd = $2, position_collateral_usd = $3 where id = $1",
              [f._id, pos.sizeUsd, pos.collateralUsd],
            );
            await applyWorkflow(f._id!, { state: "position_open" });
            const t = await getToken(f._id!);
            expect(t.position_opened_at).not.toBeNull(); // recorded -> 3a guard now blocks a re-open
            expect(Number(t.position_size_usd)).toBe(pos.sizeUsd);
            recovery = `venue has size=$${pos.sizeUsd} -> recorded position_open (no re-open)`;
          } else {
            // hold: venue unknown -> untouched, sig intact, still pending (never risk a double-open)
            expect((await getToken(f._id!)).pending_drift_sig).not.toBeNull();
            expect((await getWorkflow(f._id!)).state).toBe("position_open_pending");
            recovery = `venue UNKNOWN -> HELD (no double-open)`;
          }
          break;
        }
        case "escalate":
          recovery = "escalated (logWarn); never auto-unblocked";
          break;
        case "none":
          recovery = "(not actionable yet)";
          break;
      }

      if (!seen.has(f.name)) {
        seen.add(f.name);
        const reason = row.blocked_reason ? ` reason=${row.blocked_reason}` : "";
        console.log(
          `    ${f.name.padEnd(26)} state=${row.state.padEnd(22)} age=${String(ageMin).padStart(3)}m${reason}  ->  ${need.action.padEnd(17)}  ->  ${recovery}`,
        );
      }
    }
    console.log("");
  });
});
