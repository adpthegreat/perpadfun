// TEST_PLAN.md Phase 1 - DB invariants & migrations.
//
// These are e2e against the REAL migrated schema (supabase db reset applied
// supabase/migrations/*). They prove the durable layer itself cannot hold a bad
// row - the constraints, not the keeper logic. DB-only; skips without a DB.
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { dbAvailable, ensureSchema, resetDb, seedToken, query, closeDb } from "../helpers/db.ts";

const LIVE_STATES = [
  "idle",
  "fees_claimed",
  "split_reserved",
  "imperial_deposited",
  "position_open_pending",
  "position_open",
  "topup_pending",
  "blocked",
  "error",
];
const DELETED_STATES = ["fees_pending", "imperial_deposit_pending", "profit_realize_pending"];

describe.skipIf(!dbAvailable)("Phase 1: DB invariants & migrations (e2e, real migrated schema)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("1.1 the migrated schema is present (core tables exist)", async () => {
    for (const tbl of ["tokens", "token_workflows", "keeper_actions", "tx_log", "treasury_events"]) {
      const { rows } = await query("select to_regclass($1) as t", [`public.${tbl}`]);
      expect(rows[0].t).not.toBeNull();
    }
  });

  it("1.2 token_workflows.state CHECK accepts the 9 live states", async () => {
    for (const s of LIVE_STATES) {
      const id = await seedToken();
      await query("insert into public.token_workflows (token_id, state) values ($1, $2)", [id, s]);
      const { rows } = await query("select state from public.token_workflows where token_id = $1", [id]);
      expect(rows[0].state).toBe(s);
    }
  });

  it("1.2 token_workflows.state CHECK rejects the 3 deleted states", async () => {
    for (const s of DELETED_STATES) {
      const id = await seedToken();
      await expect(
        query("insert into public.token_workflows (token_id, state) values ($1, $2)", [id, s]),
      ).rejects.toThrow();
    }
  });

  it("1.3 keeper_actions unique (token_id, action_kind, intent_hash) blocks a duplicate", async () => {
    const id = await seedToken();
    await query("insert into public.keeper_actions (token_id, action_kind, intent_hash) values ($1, 'imperial_open', 'h1')", [id]);
    await expect(
      query("insert into public.keeper_actions (token_id, action_kind, intent_hash) values ($1, 'imperial_open', 'h1')", [id]),
    ).rejects.toThrow();
    const { rows } = await query("select count(*)::int n from public.keeper_actions where token_id = $1", [id]);
    expect(rows[0].n).toBe(1);
  });

  it("1.3 keeper_actions allows same token with a different kind or intent_hash", async () => {
    const id = await seedToken();
    await query("insert into public.keeper_actions (token_id, action_kind, intent_hash) values ($1, 'imperial_open', 'h1')", [id]);
    await query("insert into public.keeper_actions (token_id, action_kind, intent_hash) values ($1, 'imperial_topup', 'h1')", [id]);
    await query("insert into public.keeper_actions (token_id, action_kind, intent_hash) values ($1, 'imperial_open', 'h2')", [id]);
    const { rows } = await query("select count(*)::int n from public.keeper_actions where token_id = $1", [id]);
    expect(rows[0].n).toBe(3);
  });

  it("1.4 tx_log unique (token_id, kind, intent_hash) blocks a duplicate", async () => {
    const id = await seedToken();
    await query("insert into public.tx_log (token_id, kind, intent_hash) values ($1, 'fee_claim_dbc', 'h1')", [id]);
    await expect(
      query("insert into public.tx_log (token_id, kind, intent_hash) values ($1, 'fee_claim_dbc', 'h1')", [id]),
    ).rejects.toThrow();
  });

  // tokens has 6 NOT-NULL-no-default columns: ticker, name, underlying, leverage,
  // direction, treasury_wallet_address. Provide all but the one under test.
  const REQUIRED_NO_WALLET = "ticker, name, underlying, leverage, direction";
  const REQUIRED_NO_WALLET_VALS = "'T', 'N', 'SOL', 5, 'long'";

  it("1.5 tokens.treasury_wallet_address is required (no signer-less token)", async () => {
    // every other required col present, treasury_wallet_address omitted -> rejected
    await expect(
      query(`insert into public.tokens (${REQUIRED_NO_WALLET}) values (${REQUIRED_NO_WALLET_VALS})`),
    ).rejects.toThrow();
    // add it -> succeeds, proving that column is the gate (not some other)
    const { rows } = await query(
      `insert into public.tokens (${REQUIRED_NO_WALLET}, treasury_wallet_address) values (${REQUIRED_NO_WALLET_VALS}, 'wallet1') returning id`,
    );
    expect(rows[0].id).toBeTruthy();
  });

  it("1.6 tokens.imperial_profile_index is NOT NULL with default 1", async () => {
    // omitted -> defaults to 1
    const { rows } = await query(
      `insert into public.tokens (${REQUIRED_NO_WALLET}, treasury_wallet_address) values (${REQUIRED_NO_WALLET_VALS}, 'wallet1') returning imperial_profile_index`,
    );
    expect(Number(rows[0].imperial_profile_index)).toBe(1);
    // explicit null -> rejected (distinct wallet so it fails on the index, not the UNIQUE wallet)
    await expect(
      query(
        `insert into public.tokens (${REQUIRED_NO_WALLET}, treasury_wallet_address, imperial_profile_index) values (${REQUIRED_NO_WALLET_VALS}, 'wallet2', null)`,
      ),
    ).rejects.toThrow();
  });
});
