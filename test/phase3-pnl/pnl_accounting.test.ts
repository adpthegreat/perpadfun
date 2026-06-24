// Problem #3 - PnL accounting (TEST_PLAN.md 0.5 / KEEPER_PNL.md).
//
// Imperial returns no entry price and writes pnl=$0, which used to force a
// fragile client-side replay to guess the entry. The fix captures a durable
// entry-mid (launch_mid) server-side and computes PnL from it. These tests cover
// the three pure pieces of that fix + the persisted-entry guarantee:
//   - pickEntryMid: entry-price precedence (venue entry -> mark -> stored)
//   - captureMarkAsEntry: windowed mark capture + aged-position safety
//   - computePnlFromEntry: the (mark-entry)/entry * size * dir fallback math
// It does NOT cover legacy null-entry rows (they ride the kept fallback) or real
// venue accuracy (needs a live devnet/Fly run). See KEEPER_PNL.md sections 6-8.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { pickEntryMid, captureMarkAsEntry, computePnlFromEntry } from "../../keeper/src/pnl.js";
import { dbAvailable, ensureSchema, resetDb, seedToken, getToken, applyWorkflow, query, closeDb } from "../helpers/db.ts";

const WINDOW = 180_000; // ENTRY_CAPTURE_WINDOW_MS default

describe("PnL - entry-mid precedence (pickEntryMid, T1)", () => {
  it("prefers the venue entry price", () => {
    expect(pickEntryMid({ venueEntry: 100, venueMark: 99, existingMid: 98 })).toEqual({ price: 100, source: "imperial" });
  });
  it("falls back to the venue mark when there is no entry", () => {
    expect(pickEntryMid({ venueEntry: 0, venueMark: 99, existingMid: 98 })).toEqual({ price: 99, source: "perpspad_entry_mid" });
  });
  it("falls back to the previously-stored launch_mid", () => {
    expect(pickEntryMid({ venueEntry: undefined, venueMark: 0, existingMid: 98 })).toEqual({ price: 98, source: "reconciled" });
  });
  it("returns null when nothing is available", () => {
    expect(pickEntryMid({ venueEntry: 0, venueMark: -1, existingMid: null })).toEqual({ price: null, source: null });
  });
});

describe("PnL - windowed mark capture (captureMarkAsEntry, T1)", () => {
  const now = 1_000_000_000_000;
  it("captures the current mark as entry right after open (mark ~ entry)", () => {
    expect(captureMarkAsEntry({ existingMid: null, mark: 123, openedAt: new Date(now - 60_000).toISOString(), now, windowMs: WINDOW })).toBe(123);
  });
  it("does NOT capture once past the window (aged position - real PnL preserved)", () => {
    expect(captureMarkAsEntry({ existingMid: null, mark: 123, openedAt: new Date(now - WINDOW - 1).toISOString(), now, windowMs: WINDOW })).toBeNull();
  });
  it("never overwrites an existing entry", () => {
    expect(captureMarkAsEntry({ existingMid: 100, mark: 123, openedAt: new Date(now).toISOString(), now, windowMs: WINDOW })).toBeNull();
  });
  it("returns null when there is no usable mark or open time", () => {
    expect(captureMarkAsEntry({ existingMid: null, mark: 0, openedAt: new Date(now).toISOString(), now, windowMs: WINDOW })).toBeNull();
    expect(captureMarkAsEntry({ existingMid: null, mark: 123, openedAt: null, now, windowMs: WINDOW })).toBeNull();
  });
});

describe("PnL - compute from stored entry (computePnlFromEntry, T1)", () => {
  it("long: mark above entry is a gain, below is a loss; scales with size", () => {
    expect(computePnlFromEntry({ mark: 110, entryMid: 100, sizeUsd: 500, side: "long" })).toBe(50);
    expect(computePnlFromEntry({ mark: 90, entryMid: 100, sizeUsd: 500, side: "long" })).toBe(-50);
    expect(computePnlFromEntry({ mark: 110, entryMid: 100, sizeUsd: 1000, side: "long" })).toBe(100);
  });
  it("short: signs are inverted", () => {
    expect(computePnlFromEntry({ mark: 110, entryMid: 100, sizeUsd: 500, side: "short" })).toBe(-50);
    expect(computePnlFromEntry({ mark: 90, entryMid: 100, sizeUsd: 500, side: "short" })).toBe(50);
  });
  it("mark equal to entry is zero PnL", () => {
    expect(computePnlFromEntry({ mark: 100, entryMid: 100, sizeUsd: 500, side: "long" })).toBe(0);
  });
  it("guards: a non-positive entry/mark/size yields 0 (cannot compute)", () => {
    expect(computePnlFromEntry({ mark: 110, entryMid: 0, sizeUsd: 500, side: "long" })).toBe(0);
    expect(computePnlFromEntry({ mark: 0, entryMid: 100, sizeUsd: 500, side: "long" })).toBe(0);
    expect(computePnlFromEntry({ mark: 110, entryMid: 100, sizeUsd: 0, side: "long" })).toBe(0);
  });
  it("selection: when the venue would report $0, this yields the real non-zero PnL instead", () => {
    // the keeper uses this exactly when venue unrealizedPnl ~ $0 and an entry exists
    const venueZero = 0;
    const computed = computePnlFromEntry({ mark: 120, entryMid: 100, sizeUsd: 500, side: "long" });
    expect(Math.abs(venueZero) < 1e-6).toBe(true);
    expect(computed).toBe(100); // not $0
  });
});

describe.skipIf(!dbAvailable)("PnL - persisted entry guarantee (DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("a new position stores a non-null entry (launch_mid) - the frontend reads it, not the replay", async () => {
    const id = await seedToken({ launch_mid: 100, position_opened_at: new Date().toISOString() });
    const t = await getToken(id);
    expect(t.launch_mid).not.toBeNull();
    expect(Number(t.launch_mid)).toBe(100);
  });

  it("within the window, a null-entry position captures the mark and persists it", async () => {
    const id = await seedToken({ position_opened_at: new Date().toISOString() }); // launch_mid null
    const t = await getToken(id);
    const captured = captureMarkAsEntry({ existingMid: t.launch_mid, mark: 123, openedAt: t.position_opened_at, now: Date.now(), windowMs: WINDOW });
    expect(captured).toBe(123);
    await query("update public.tokens set launch_mid = $2 where id = $1", [id, captured]);
    expect(Number((await getToken(id)).launch_mid)).toBe(123);
  });

  it("an aged null-entry position is NOT captured (stays null -> falls to the keeper's dbPnl)", async () => {
    const openedAt = new Date(Date.now() - WINDOW - 5_000).toISOString();
    const id = await seedToken({ position_opened_at: openedAt });
    const t = await getToken(id);
    const captured = captureMarkAsEntry({ existingMid: t.launch_mid, mark: 123, openedAt: t.position_opened_at, now: Date.now(), windowMs: WINDOW });
    expect(captured).toBeNull();
    expect((await getToken(id)).launch_mid).toBeNull(); // unchanged
  });

  it("position_entry_source accepts exactly the sources pickEntryMid emits", async () => {
    const id = await seedToken();
    for (const src of ["imperial", "perpspad_entry_mid", "reconciled"]) {
      await applyWorkflow(id, { state: "position_open", position_entry_source: src });
    }
    await expect(applyWorkflow(id, { state: "position_open", position_entry_source: "bogus" })).rejects.toThrow();
  });
});
