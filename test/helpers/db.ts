// DB harness for the keeper test suite. Backed by any Postgres reachable via
// TEST_DATABASE_URL (locked target: the supabase CLI local stack — real
// migrations). When no URL is set, `dbAvailable` is false and DB-backed suites
// skip, so `vitest run` stays green on pure-logic tests. See test/TEST_PLAN.md §1.
//
// Designed for STATEFUL e2e simulation: each it() drives a token through its
// lifecycle, so call resetDb() in afterEach to clear state between tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
export const dbAvailable = !!URL;

// Tables the suite touches; truncated between tests (order/CASCADE safe).
const TABLES = ["keeper_logs", "keeper_actions", "tx_log", "treasury_events", "token_workflows", "tokens"];

let client: InstanceType<typeof pg.Client> | null = null;

export async function getClient(): Promise<InstanceType<typeof pg.Client>> {
  if (!dbAvailable) throw new Error("TEST_DATABASE_URL not set");
  if (!client) {
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  }
  return client;
}

export async function query(sql: string, params: unknown[] = []) {
  return (await getClient()).query(sql, params);
}

// Apply the test schema only if the migrations haven't already created it (so we
// work against the real supabase-migrated schema when present, or a bare PG via
// schema.sql otherwise). Call once in beforeAll.
export async function ensureSchema(): Promise<void> {
  const { rows } = await query("select to_regclass('public.token_workflows') as t");
  if (!rows[0].t) await query(readFileSync(join(here, "schema.sql"), "utf8"));
}

// Clear all per-token state. Call in afterEach — the e2e flow mutates state, so
// each it() must start from a clean DB.
export async function resetDb(): Promise<void> {
  await query(`truncate ${TABLES.map((t) => `public.${t}`).join(", ")} restart identity cascade`);
}

function upsertSql(table: string, cols: Record<string, unknown>, conflictKey: string) {
  const keys = Object.keys(cols);
  const ph = keys.map((_, i) => `$${i + 1}`).join(", ");
  const updates = keys
    .filter((k) => k !== conflictKey)
    .map((k) => `${k} = excluded.${k}`)
    .concat("updated_at = now()")
    .join(", ");
  return {
    sql: `insert into public.${table} (${keys.join(", ")}) values (${ph}) on conflict (${conflictKey}) do update set ${updates}`,
    values: keys.map((k) => cols[k]),
  };
}

// --- lifecycle simulation helpers (mirror what the keeper persists) -----------

// Unique-per-call so the tokens.treasury_wallet_address UNIQUE constraint is
// never violated when a single test seeds many tokens.
let _seedSeq = 0;

// "Someone created a token" — a live, imperial-routed token with no fees yet.
export async function seedToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const seq = _seedSeq++;
  const cols: Record<string, unknown> = {
    ticker: `TEST${seq}`, // unique per call (tokens_ticker_perpspad_active_unique)
    name: "Test Token",
    underlying: "SOL",
    leverage: 5,
    direction: "long",
    router: "imperial",
    status: "live",
    source: "perpspad",
    fees_accrued_usd: 0,
    treasury_wallet_address: `TestWa11et${String(seq).padStart(34, "0")}`, // unique (column is UNIQUE)
    ...overrides,
  };
  const keys = Object.keys(cols);
  const ph = keys.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await query(
    `insert into public.tokens (${keys.join(", ")}) values (${ph}) returning id`,
    keys.map((k) => cols[k]),
  );
  return rows[0].id as string;
}

export async function getToken(id: string) {
  return (await query("select * from public.tokens where id = $1", [id])).rows[0];
}

export async function getWorkflow(id: string) {
  return (await query("select * from public.token_workflows where token_id = $1", [id])).rows[0] ?? null;
}

// Simulate fee accrual over a tick.
export async function setFees(id: string, usd: number) {
  await query("update public.tokens set fees_accrued_usd = $2 where id = $1", [id, usd]);
}

// Mirror the keeper's end-of-tick workflow write (upsert).
export async function applyWorkflow(id: string, patch: Record<string, unknown> = {}) {
  const { sql, values } = upsertSql("token_workflows", { token_id: id, ...patch }, "token_id");
  await query(sql, values);
}

// Append to the idempotent action ledger — throws on a duplicate intent.
export async function recordAction(
  id: string,
  a: { action_kind: string; intent_hash: string; status?: string },
) {
  await query(
    "insert into public.keeper_actions (token_id, action_kind, intent_hash, status) values ($1, $2, $3, $4)",
    [id, a.action_kind, a.intent_hash, a.status ?? "pending"],
  );
}

export async function recordTx(
  id: string,
  t: { kind: string; intent_hash: string; status?: string; error?: string | null },
) {
  await query(
    "insert into public.tx_log (token_id, kind, intent_hash, status, error) values ($1, $2, $3, $4, $5)",
    [id, t.kind, t.intent_hash, t.status ?? "pending", t.error ?? null],
  );
}

// Insert a workflow row with a controlled age (updated_at = now() - ageMin min),
// so reconcile staleness thresholds can be exercised deterministically.
export async function seedWorkflow(
  tokenId: string,
  wf: { state: string; blocked_reason?: string | null; next_retry_at?: string | null; ageMin?: number },
) {
  await query(
    "insert into public.token_workflows (token_id, state, blocked_reason, next_retry_at, updated_at) " +
      "values ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)",
    [tokenId, wf.state, wf.blocked_reason ?? null, wf.next_retry_at ?? null, String(wf.ageMin ?? 0)],
  );
}

// Mirrors the GET /api/public/keeper/stuck-tokens endpoint query: tokens INNER
// JOIN token_workflows filtered to the stuck candidate states (the supabase-js
// `.in("token_workflows.state", […])` embedded filter, verified equivalent).
export async function queryStuckTokens() {
  const { rows } = await query(
    "select t.id, t.ticker, t.router, t.position_opened_at, t.pending_drift_sig, t.imperial_profile_index, " +
      "tw.state, tw.blocked_reason, tw.next_retry_at, tw.updated_at " +
      "from public.tokens t join public.token_workflows tw on tw.token_id = t.id " +
      "where tw.state in ('error','blocked','position_open_pending','topup_pending') " +
      "and t.status not in ('deprecated','failed') limit 500",
  );
  return rows as Array<{
    id: string;
    ticker: string;
    router: string;
    position_opened_at: string | null;
    pending_drift_sig: string | null;
    state: string;
    blocked_reason: string | null;
    next_retry_at: string | null;
    updated_at: string;
  }>;
}

// Mirror the /workflow-report keeper_logs insert (same column mapping). ageSec
// backdates created_at so a test can order rows on the timeline deterministically
// (older = larger ageSec).
export async function insertKeeperLog(
  tokenId: string | null,
  log: {
    tick_id?: string | null;
    level?: string;
    event?: string | null;
    message: string;
    fields?: Record<string, unknown>;
    ageSec?: number;
  },
): Promise<void> {
  await query(
    "insert into public.keeper_logs (token_id, tick_id, level, event, message, fields, created_at) " +
      "values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' seconds')::interval)",
    [
      tokenId,
      log.tick_id ?? null,
      log.level ?? "info",
      log.event ?? null,
      log.message,
      JSON.stringify(log.fields ?? {}),
      String(log.ageSec ?? 0),
    ],
  );
}

// Mirror the workflows.ts per-token log read: filter strictly by token_id,
// newest-first, capped. This is the per-token timeline a UI will render.
export async function queryTokenLogs(tokenId: string, limit = 200) {
  const { rows } = await query(
    "select token_id, tick_id, level, event, message, fields, created_at from public.keeper_logs " +
      "where token_id = $1 order by created_at desc limit $2",
    [tokenId, limit],
  );
  return rows as Array<{
    token_id: string;
    tick_id: string | null;
    level: string;
    event: string | null;
    message: string;
    fields: Record<string, unknown>;
    created_at: string;
  }>;
}

// Mirrors GET /api/public/keeper/logs: reads keeper_logs directly (NOT joined to
// token_workflows), with the same optional filters + newest-first + limit. token_id
// omitted -> all tokens incl. global (token_id IS NULL) rows.
export async function queryKeeperLogs(
  opts: { tokenId?: string; level?: string; event?: string; before?: string; limit?: number } = {},
) {
  let sql =
    "select id, token_id, tick_id, level, event, message, fields, created_at from public.keeper_logs where 1=1";
  const params: unknown[] = [];
  let i = 1;
  if (opts.tokenId) {
    sql += ` and token_id = $${i++}`;
    params.push(opts.tokenId);
  }
  if (opts.level) {
    sql += ` and level = $${i++}`;
    params.push(opts.level);
  }
  if (opts.event) {
    sql += ` and event = $${i++}`;
    params.push(opts.event);
  }
  if (opts.before) {
    sql += ` and created_at < $${i++}`;
    params.push(opts.before);
  }
  sql += ` order by created_at desc limit $${i++}`;
  params.push(Math.min(1000, Math.max(1, opts.limit ?? 100)));
  const { rows } = await query(sql, params);
  return rows as Array<{
    id: number;
    token_id: string | null;
    tick_id: string | null;
    level: string;
    event: string | null;
    message: string;
    fields: Record<string, unknown>;
    created_at: string;
  }>;
}

export async function countActions(id: string, action_kind: string): Promise<number> {
  const { rows } = await query(
    "select count(*)::int as n from public.keeper_actions where token_id = $1 and action_kind = $2",
    [id, action_kind],
  );
  return rows[0].n as number;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}
