# Keeper test suite — how to run

Automated, local, no-mainnet tests that prove the keeper can't fall back into the bad states the
refactor fixed. Full design: [`TEST_PLAN.md`](./TEST_PLAN.md).

There are **two layers** in every suite:

| Layer | Needs a DB? | What it covers |
|---|---|---|
| **T1 — pure logic** | No | gate/decision functions in isolation (`gateImperialFunding`, `classifyState`, …). Always runs. |
| **e2e — simulated lifecycle** | **Yes** | drives a token *created → fees accrue → claimed → routed → deposited → opened → ticks* against a real Postgres, resetting the DB after every test. Skips automatically when no DB is configured. |

So `bun run test` always works — the e2e tests just **skip** until you point `TEST_DATABASE_URL` at a database.

---

## Quick start (pure-logic only, zero setup)

```bash
bun run test
```

You'll see the T1 tests pass and the e2e tests skipped:

```
Tests  5 passed | 5 skipped (10)
```

---

## Full run (with the e2e DB tests)

### Prerequisites
- **Docker Desktop running** (Windows) with **WSL integration enabled** for this distro.
  Verify in this shell: `docker ps` returns (even an empty table).
- The supabase CLI is already installed as a devDep (`bunx supabase`).

### 1. Start the local Postgres (one-time per machine boot)
```bash
bunx supabase start      # first run pulls images — a few minutes
```

### 2. Apply the real migrations
```bash
bunx supabase db reset    # applies supabase/migrations/* to the local DB
```

### 3. Get the connection string and export it
```bash
bunx supabase status      # shows "DB URL"
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```
(`54322` is the supabase-local default DB port; use whatever `supabase status` prints.)

### 4. Run the tests
```bash
bun run test
```
Now the e2e tests execute against the real schema. The harness **truncates all per-token tables after
every `it()`**, so each test starts from a clean DB — order-independent and repeatable.

One-liner (after `supabase start` is up once):
```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" bun run test
```

---

## Handy variations

```bash
# one file
bunx vitest run test/phase1-fee-routing/fee_routing_reliability.test.ts

# watch mode (re-runs on save)
bunx vitest

# filter by test name
bunx vitest run -t "double-route"
```

Point at any other Postgres (e.g. a throwaway cloud Supabase project per
[`../plan/LOCAL_TESTING_GUIDE.md`](../plan/LOCAL_TESTING_GUIDE.md)) by setting `TEST_DATABASE_URL` to its
connection string — no local Docker needed. If the schema isn't already there, the harness applies
[`helpers/schema.sql`](./helpers/schema.sql) automatically.

---

## Layout

```
test/
  README.md                         ← this file
  TEST_PLAN.md                      ← phased plan + the 5 problems under test
  helpers/
    setup-env.ts                    ← dummy keeper env (so config.js loads; no real keys/RPC)
    db.ts                           ← DB harness: connect, resetDb (per-test), seed/apply helpers
    schema.sql                      ← test schema for a bare Postgres (fallback when not migrated)
  phase1-fee-routing/
    fee_routing_reliability.test.ts ← problem #1
  …                                 ← further phases land here, in TEST_PLAN.md order
```

---

## Troubleshooting

- **e2e tests are skipped** → `TEST_DATABASE_URL` isn't set, or the DB isn't reachable. Do steps 1–3.
- **`Cannot connect` / `ECONNREFUSED 127.0.0.1:54322`** → `bunx supabase start` hasn't finished, or
  Docker isn't running. Check `docker ps` and `bunx supabase status`.
- **`supabase start` hangs / fails** → Docker daemon down or WSL integration off. Start Docker Desktop,
  enable WSL integration, retry.
- **A keeper import throws on missing env** → `helpers/setup-env.ts` injects dummies; it must stay in
  `vitest.config.ts` `setupFiles`.
- **Flaky FK / "violates foreign key" errors** → the DB-backed suites share one Postgres and TRUNCATE
  between tests, so files must run **serially** (`fileParallelism: false` in `vitest.config.ts`). Don't
  re-enable file parallelism without giving each worker its own database/schema.

## Teardown
```bash
bunx supabase stop        # stops the local stack (keeps data)
bunx supabase stop --no-backup   # stops and wipes
```
