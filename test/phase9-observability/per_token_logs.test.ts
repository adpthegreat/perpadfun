// TEST_PLAN.md Phase 9 - observability (benji req): the durable, per-token,
// queryable log store (keeper_logs). See KEEPER_PER_TOKEN_LOGS.md section 5.
//
// The point of this phase is the NEW durable half of observability: instead of
// grepping the ephemeral, interleaved Fly stdout, a token's full timeline (events,
// decisions, and the failure logs that were previously stdout-only) is captured
// through an explicit sink and persisted so it can be queried by token_id.
//
//   T1 (no DB): the keeper-side sink - buildLogRow shape + level clamp, queueLog's
//       null/empty guards, keeperLog's dual-write (stdout line kept for live grep
//       AND a durable row buffered).
//   T3 (real migrated keeper_logs): a token's timeline reads back newest-first,
//       filters STRICTLY by token_id (no cross-token bleed), and the DB enforces
//       attribution integrity (level CHECK + token FK) - not just app code.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { buildLogRow, queueLog, keeperLog, _drainLogs } from "../../keeper/src/workflow.js";
import {
  dbAvailable,
  ensureSchema,
  resetDb,
  seedToken,
  insertKeeperLog,
  queryTokenLogs,
  queryKeeperLogs,
  closeDb,
} from "../helpers/db.ts";

const TOKEN = { id: "11111111-1111-1111-1111-111111111111", ticker: "ABC" };

describe("Phase 9: per-token log sink (T1, no DB)", () => {
  beforeEach(() => {
    _drainLogs(); // clear any residue buffered by another suite in the shared worker
  });

  it("9.1 buildLogRow shapes a row: token_id, promoted tick_id/event, level clamp, stringified message", () => {
    const row = buildLogRow(TOKEN, "warn", "fee claim failed", {
      tick_id: "tk1",
      event: "fee_claim",
      error: "boom",
    });
    expect(row.token_id).toBe(TOKEN.id);
    expect(row.tick_id).toBe("tk1"); // promoted to a column for filtering
    expect(row.event).toBe("fee_claim"); // promoted to a column
    expect(row.level).toBe("warn");
    expect(row.message).toBe("fee claim failed");
    expect(row.fields.error).toBe("boom"); // full context kept in fields

    // level clamps to the 3 allowed values; anything unknown becomes info
    expect(buildLogRow(TOKEN, "debug", "x").level).toBe("info");
    expect(buildLogRow(TOKEN, "error", "x").level).toBe("error");

    // missing tick_id/event default to null; non-string message is stringified
    const bare = buildLogRow(TOKEN, "info", 123);
    expect(bare.tick_id).toBeNull();
    expect(bare.event).toBeNull();
    expect(bare.message).toBe("123");
  });

  it("9.2 queueLog stores only per-token rows; _drainLogs returns then empties", () => {
    queueLog(buildLogRow(TOKEN, "info", "ok"));
    queueLog({ token_id: null, message: "no token" }); // dropped - not attributable
    queueLog({ token_id: TOKEN.id, message: "" }); // dropped - empty message
    const drained = _drainLogs();
    expect(drained.length).toBe(1);
    expect(drained[0].message).toBe("ok");
    expect(_drainLogs().length).toBe(0); // drain emptied the buffer
  });

  it("9.3 keeperLog dual-writes: structured stdout line (live grep) AND a durable buffered row", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    keeperLog(TOKEN, "error", "open failed", { tick_id: "tk9", error: "rpc down" });

    // stdout half: one structured JSON line carrying token attribution
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.token_id).toBe(TOKEN.id);
    expect(line.ticker).toBe("ABC");
    expect(line.level).toBe("error");
    spy.mockRestore();

    // durable half: the matching row is buffered for the batched flush
    const drained = _drainLogs();
    expect(drained.length).toBe(1);
    expect(drained[0]).toMatchObject({ token_id: TOKEN.id, level: "error", message: "open failed" });
    expect(drained[0].fields.error).toBe("rpc down");
  });
});

describe.skipIf(!dbAvailable)("Phase 9: per-token timeline read (T3, real keeper_logs, DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("9.4 a token's timeline reads back newest-first", async () => {
    const id = await seedToken();
    await insertKeeperLog(id, { message: "oldest", tick_id: "t1", ageSec: 30 });
    await insertKeeperLog(id, { message: "middle", tick_id: "t2", ageSec: 20 });
    await insertKeeperLog(id, { message: "newest", tick_id: "t3", level: "warn", ageSec: 10 });

    const rows = await queryTokenLogs(id);
    console.log(`\n  [timeline] token ${rows.length} rows, newest-first: ${rows.map((r) => r.message).join(" -> ")}\n`);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.message)).toEqual(["newest", "middle", "oldest"]);
  });

  it("9.5 the read filters STRICTLY by token_id (no cross-token bleed)", async () => {
    const a = await seedToken();
    const b = await seedToken();
    await insertKeeperLog(a, { message: "A-only-1", level: "error" });
    await insertKeeperLog(a, { message: "A-only-2" });
    await insertKeeperLog(b, { message: "B-only-1" });

    const aRows = await queryTokenLogs(a);
    const msgs = aRows.map((r) => r.message);
    console.log(`  [isolation] token A timeline = ${JSON.stringify(msgs)} (B's log must be absent)`);
    expect(aRows.every((r) => r.token_id === a)).toBe(true);
    expect(aRows.length).toBe(2);
    expect(msgs).toContain("A-only-1");
    expect(msgs).not.toContain("B-only-1"); // B never bleeds into A's timeline
  });

  it("9.6 the DB enforces attribution integrity: level CHECK + token FK", async () => {
    const id = await seedToken();
    // level outside (info,warn,error) -> CHECK rejects (no silent bad-level rows)
    await expect(insertKeeperLog(id, { message: "x", level: "debug" })).rejects.toThrow();
    // a log for a token that does not exist -> FK rejects (every row is attributable)
    await expect(
      insertKeeperLog("00000000-0000-0000-0000-000000000000", { message: "orphan" }),
    ).rejects.toThrow();
    // the valid path still works after the rejections (autocommit, connection intact)
    await insertKeeperLog(id, { message: "valid", level: "info" });
    expect((await queryTokenLogs(id)).length).toBe(1);
  });
});

// The dedicated GET /api/public/keeper/logs endpoint (KEEPER_LOGS_ENDPOINT.md):
// reads keeper_logs directly (NOT joined to token_workflows), so unlike the
// /workflows recent_logs it can return a token's timeline, all tokens, AND global
// (token_id IS NULL) rows, with level/event filters + a time cursor. queryKeeperLogs
// mirrors the endpoint's exact query.
describe.skipIf(!dbAvailable)("Phase 9: dedicated /keeper/logs endpoint query (T3, DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("9.7 reaches GLOBAL (token_id IS NULL) rows that /workflows cannot", async () => {
    const a = await seedToken();
    await insertKeeperLog(a, { message: "token row", level: "info" });
    await insertKeeperLog(null, { message: "keeper booted", level: "warn", event: "boot" });

    // the dedicated endpoint (no token_id filter) returns BOTH the token row and the global row
    const all = await queryKeeperLogs({});
    const msgs = all.map((r) => r.message);
    expect(msgs).toContain("keeper booted");
    expect(all.some((r) => r.token_id === null)).toBe(true);

    // the /workflows-style read (queryTokenLogs requires a token_id) can NEVER surface the global row
    const viaWorkflows = await queryTokenLogs(a);
    expect(viaWorkflows.some((r) => r.message === "keeper booted")).toBe(false);
  });

  it("9.8 filters by token_id, level, and event", async () => {
    const a = await seedToken();
    const b = await seedToken();
    await insertKeeperLog(a, { message: "a-info", level: "info", event: "tick" });
    await insertKeeperLog(a, { message: "a-err", level: "error", event: "open" });
    await insertKeeperLog(b, { message: "b-err", level: "error", event: "open" });

    expect((await queryKeeperLogs({ tokenId: a })).every((r) => r.token_id === a)).toBe(true);
    const errs = await queryKeeperLogs({ level: "error" });
    expect(errs.length).toBe(2);
    expect(errs.every((r) => r.level === "error")).toBe(true);
    const aErr = await queryKeeperLogs({ tokenId: a, level: "error", event: "open" });
    expect(aErr.map((r) => r.message)).toEqual(["a-err"]);
  });

  it("9.9 newest-first ordering + before cursor pages older rows", async () => {
    const a = await seedToken();
    await insertKeeperLog(a, { message: "oldest", ageSec: 30 });
    await insertKeeperLog(a, { message: "middle", ageSec: 20 });
    await insertKeeperLog(a, { message: "newest", ageSec: 10 });

    const page1 = await queryKeeperLogs({ tokenId: a, limit: 2 });
    expect(page1.map((r) => r.message)).toEqual(["newest", "middle"]);

    // cursor = created_at of the last row on page 1; page 2 is strictly older
    const cursor = page1[page1.length - 1].created_at;
    const page2 = await queryKeeperLogs({ tokenId: a, limit: 2, before: cursor });
    expect(page2.map((r) => r.message)).toEqual(["oldest"]);
    expect(page2.every((r) => r.created_at < cursor)).toBe(true);
  });
});
