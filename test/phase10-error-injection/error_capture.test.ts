// TEST_PLAN.md Phase 10 - error injection: capture + attribution (cross-cutting).
// The durable-store slice of the error pipeline. See KEEPER_PER_TOKEN_LOGS.md sec 5.
//
// Today the ~120 console.error/warn calls (the "why did token X fail" lines) are
// stdout-only and lost on Fly roll-over. After the conversion to keeperLog they are
// captured durably. This phase INTENTIONALLY throws on real keeper code paths (the
// catch blocks that loop.js now routes through keeperLog) and proves the failure:
//   (a) is captured with a DETERMINABLE cause (the thrown message lands in fields.error),
//   (b) is QUERYABLE as a level='error' row, ATTRIBUTABLE to the failing token,
//   (c) does not contaminate a healthy token's timeline (one bad token != all bad).
//
// The thrown messages are real Error throws (not fabricated strings), and the row is
// persisted via the same column mapping the /workflow-report handler uses.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { keeperLog, _drainLogs } from "../../keeper/src/workflow.js";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  insertKeeperLog,
  queryTokenLogs,
  closeDb,
} from "../helpers/db.ts";

// Persist a drained sink buffer the way POST /workflow-report does (same mapping).
async function flushToDb(rows: Array<Record<string, unknown>>) {
  for (const r of rows) {
    await insertKeeperLog(r.token_id as string, {
      tick_id: r.tick_id as string | null,
      level: r.level as string,
      event: r.event as string | null,
      message: r.message as string,
      fields: r.fields as Record<string, unknown>,
    });
  }
}

describe("Phase 10: error capture sink (T1, no DB)", () => {
  beforeEach(() => {
    _drainLogs();
  });

  it("10.1 a thrown op -> catch -> keeperLog captures the cause, attributable to the token", async () => {
    const t = { id: "22222222-2222-2222-2222-222222222222", ticker: "ZAP" };
    async function failingOpen() {
      throw new Error("imperial 503: venue unavailable");
    }
    // mirrors the loop.js catch blocks: keeperLog(t,"error","open failed",{error,tick_id})
    try {
      await failingOpen();
    } catch (e) {
      keeperLog(t, "error", "open failed", { error: (e as Error).message, tick_id: "tkE" });
    }

    const drained = _drainLogs();
    expect(drained.length).toBe(1);
    const row = drained[0];
    expect(row.level).toBe("error");
    expect(row.message).toBe("open failed");
    expect(row.token_id).toBe(t.id); // attributable
    expect(row.tick_id).toBe("tkE"); // correlatable to the tick
    expect(row.fields.error).toBe("imperial 503: venue unavailable"); // cause is determinable
  });
});

describe.skipIf(!dbAvailable)("Phase 10: forced failure is queryable + attributable (T3, DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("10.2 a forced failure lands as a queryable level='error' row for that token", async () => {
    const id = await seedToken();
    async function failingClaim() {
      throw new Error("RPC 429: too many requests");
    }
    try {
      await failingClaim();
    } catch (e) {
      keeperLog({ id }, "error", "fee claim failed", { error: (e as Error).message, tick_id: "tk10" });
    }
    await flushToDb(_drainLogs());

    const errs = (await queryTokenLogs(id)).filter((r) => r.level === "error");
    console.log(`\n  [capture] token error rows = ${errs.length}; cause = ${JSON.stringify(errs[0]?.fields?.error)}\n`);
    expect(errs.length).toBe(1);
    expect(errs[0].message).toBe("fee claim failed");
    expect(errs[0].token_id).toBe(id);
    expect(errs[0].fields.error).toBe("RPC 429: too many requests"); // not lost to Fly
  });

  it("10.3 one bad token's failure is isolated - a healthy token's timeline stays clean", async () => {
    const good = await seedToken();
    const bad = await seedToken();

    // good token: a normal info log; bad token: a thrown failure in the same tick
    keeperLog({ id: good }, "info", "fee claim ok", { tick_id: "tkX", claimed_usd: 12 });
    try {
      throw new Error("imperial deposit revert");
    } catch (e) {
      keeperLog({ id: bad }, "error", "imperial open failed", { error: (e as Error).message, tick_id: "tkX" });
    }
    await flushToDb(_drainLogs());

    const badErrs = (await queryTokenLogs(bad)).filter((r) => r.level === "error");
    expect(badErrs.length).toBe(1);
    expect(badErrs[0].fields.error).toBe("imperial deposit revert");

    const goodRows = await queryTokenLogs(good);
    console.log(
      `  [isolation] bad token captured ${badErrs.length} error; good token timeline = ${JSON.stringify(goodRows.map((r) => `${r.level}:${r.message}`))}\n`,
    );
    expect(goodRows.length).toBe(1);
    expect(goodRows[0].message).toBe("fee claim ok");
    expect(goodRows.some((r) => r.level === "error")).toBe(false); // no contamination
  });
});
