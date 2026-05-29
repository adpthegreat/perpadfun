# Keeper Test Plan (DRAFT)

Automated tests that **prove we cannot fall back into the bad states/situations** the refactor set
out to fix. Phased in the **order we wrote the fixes**; each phase is built, run, and made green
**before** the next — we do not write/run everything at once.

> This is the *automated, local, no-mainnet* counterpart to [`LOCAL_TESTING_GUIDE.md`](../plan/LOCAL_TESTING_GUIDE.md)
> (which is a *manual, real-RPC, funded-wallet, mainnet* smoke flow). These tests **never** touch
> mainnet, Imperial, Jupiter, or real money. Where logic needs an external call, we stub the boundary
> or extract the decision into a pure function.

---

## 0. Philosophy

Each test is **adversarial**: it recreates the precondition that *used* to produce a wrong state and
asserts the fix makes that state unreachable. "Prove we can't double-open" means: set up two open
attempts and assert exactly one fires — not "open works."

**These are e2e *simulated lifecycle* tests, not query smoke-tests.** A test drives a token the way it
really moves — *created → fees accrue → claimed → routed → deposited → position opened → ticks* — using
the keeper's real decision functions (`gateImperialFunding`, `classifyState`, the 3a guard, the recon
decision) and writing the resulting state to the DB exactly as the keeper's report would. At each step
we assert a bad state is unreachable. Because the flow **mutates** token/workflow/ledger state, **the DB
is reset (`resetDb()` truncate) in `afterEach` — every single `it()` starts from a clean DB** so one
test's writes can never change another's outcome.

Three test **tiers** (cheapest/most-valuable first):

| Tier | What | How | Needs |
|---|---|---|---|
| **T1 — pure logic** | decision functions with no I/O (`classifyState`, gates, the 3a guard, cadence classifier, `backOff`, retry predicates, recon decision) | call directly, assert output | nothing — no DB, no network |
| **T2 — DB invariants** | migration CHECKs, NOT NULL, unique `(token_id, action_kind, intent_hash)` | apply `supabase/migrations/` to a local PG, run SQL, assert it rejects/accepts | local Supabase/PG |
| **T3 — boundary integration** | `tick()`, `runStateReconcileTick()`, claim/deposit flows | stub `fetch`/`conn()`/imperial `call()`/perpad `call()`; assert state transitions | stubs/fakes only |

**Rule:** prefer T1. Several fixes have their decision logic inline in `loop.js`/`stateReconcile.js`;
each phase below flags a small **testability extraction** (pull the pure decision into an exported
function) so we can prove it at T1 instead of mocking the world at T3.

---

## 0.5 The FIVE problems under test (PRIMARY — named by the project owner)

These are the exact issues the owner flagged under *"What's actually broken / unclear."* They are the
**primary** test targets; the tiered phases in §2 are merely *how* we implement the proofs. Every
secondary test and the phase table exists to serve these five.

1. **Fee routing reliability** — sub-wallets strand SOL below the sweep minimum ($25), or a claim
   succeeds but the route to Imperial never fires; gates exist (min vault $100, min route $25) but
   there's **no clean visibility into why a given token is stuck.**
   - *Addressed by:* Fix 1 dust/floor gates + structured `token_tick`/`blocked_reason` + `stateReconcile`.
   - *Prove:* sub-threshold dust is never swept **and** the reason is visible (no silent stall); a
     claim-ok/route-fail leaves a determinable `blocked_reason`. → Phases 2, 9, 10.

2. **Imperial deposit gating — atomicity & idempotency** of `fees claimed → routed → deposited →
   position_open`. Needs $50 accrued; the chain **isn't atomic or idempotent**, and a mid-chain
   failure is invisible without digging through Fly logs.
   - *Addressed by:* the `token_workflows` state machine + `keeper_actions` ledger + Fix 3 idempotent
     open + balance-read deposit idempotency + `stateReconcile`.
   - *Prove:* re-running any step never double-claims/deposits/opens; a failed step leaves a
     recoverable, **named** state. → Phases 4, 1, 8, 10.

3. **PnL accounting** — Imperial returns no `launch_mid` on open and writes `pnl=$0` every tick, so
   entry was reconstructed by **fragile client-side replay** of tick history (`coll=$X` parsing).
   - *Addressed by:* server-side entry-mid capture — `launch_mid` ← venue `entryPriceUsd`, else
     `resolveImperialEntryPrice` at open, else a **windowed mark capture** (mark ≈ entry within
     `ENTRY_CAPTURE_WINDOW_MS` of open) so it's **never null for a new position** — plus a computed-PnL
     fallback (mark vs stored entry) when Imperial returns $0, and `entry_mid` in the structured
     summary for visibility. **Status: ✅ implemented** ([KEEPER_PNL.md](../plan/KEEPER_PNL.md)); the fragile
     client-side `coll=$X` replay is now legacy-only (pre-existing rows). **Verify in Phase 3B.**
   - *Prove:* entry-mid is stored on first open (never null for a live position); PnL computes from the
     stored entry when Imperial returns $0; aged-position PnL is never clobbered; basis is auditable. → **Phase 3B**.

4. **RPC pressure** — 429s because every idle token was probed each tick; throttling was added (5-min
   probes, batched `getMultipleAccountsInfo`, per-pool cooldowns) and **needs a proper review.**
   - *Addressed by:* Fix 4a backoff + Fix 4b cold cadence (+ the existing throttles).
   - *Prove:* idle tokens are throttled, hot ones never skipped; 429 storms recover. → Phases 5, 6.

5. **No unified state model** — fee state lives on-chain (sub-wallets), position state in Imperial's
   API, accounting in Postgres; **no single source of truth or reconciliation job.**
   - *Addressed by:* `token_workflows` as the keeper's canonical state machine + `stateReconcile`.
   - *Prove:* `classifyState` is the single source of truth; the reconciliation job recovers **any**
     stuck token (incl. the anti-double-open safety). → Phases 4, 7, 8.

> **Owner's "what I need" → delivered:** audit ✅ ([KEEPER_REFACTOR.md](../plan/KEEPER_REFACTOR.md));
> cleaner architecture = per-token state machine + idempotent transitions + reconciliation job ✅
> (`token_workflows`, Fix 3, `stateReconcile`); better observability ✅ (structured logs); PnL ✅
> (server-side entry-mid, [KEEPER_PNL.md](../plan/KEEPER_PNL.md) — legacy rows aside; verify in Phase 3B).

## 0.6 How we test (two loops)

- **Real-world loop (owner's workflow — the integration truth):** edit `keeper/src/` → `cd keeper &&
  fly deploy` (~90s, single Fly machine) → `fly logs -a perpad-keeper` in another terminal for the
  live signal (every state transition, RPC call, retry, error) → watch the DB in parallel
  (`/admin/logs` on the site, or direct Supabase queries on `tokens` / `treasury_events` / `tx_log`)
  to confirm the log claims landed → flip a token row in Supabase (`status`, null `position_opened_at`,
  bump `last_tick_at` back) to force the next tick to re-process. This stays manual.
- **Automated loop (this plan — local, no mainnet):** own Supabase + our migrations, throwaway wallet,
  `node src/index.js`, a seeded fake token. [`LOCAL_TESTING_GUIDE.md`](../plan/LOCAL_TESTING_GUIDE.md) **is**
  the owner's offered schema dump + sample seed row for exactly this replication.

---

## 1. Infrastructure (Phase 0 — build first)

- **Location:** `test/` at repo root, one folder per phase (`test/phase1-invariants/`, …).
- **Runner:** `vitest` at root **(locked)** — one runner for the keeper's ESM `.js` **and** the app's
  `.ts`, with first-class module mocking for T3.
- **Local DB:** **supabase CLI local stack (locked)**. The **migrations are the source of truth**, not
  LOCAL_TESTING_GUIDE's hand SQL — `supabase db reset` applies `supabase/migrations/*` to the local
  Supabase Postgres (one-time). `TEST_DATABASE_URL` points the harness at it (default
  `postgresql://postgres:postgres@127.0.0.1:54322/postgres`). The harness connects as `postgres`
  (superuser → RLS bypassed). **Schema is created once; `resetDb()` truncates all per-token tables in
  `afterEach`, so every `it()` runs against a clean DB.** A bare Postgres also works (the harness applies
  `test/helpers/schema.sql` when the migrated schema is absent).
- **Testability extractions: approved** — pull the inline 3a guard (`loop.js`), the cadence classifier
  (`shouldSkipColdTick`/`tokenHasWork`), and the recon per-token decision (`stateReconcile.js`) into
  exported pure functions (no behavior change) so they're provable at T1.
- **Env:** a `test/.env.test` / setup file that satisfies `keeper/src/config.js` and the app with
  **dummy** values (no real keys/RPC). Importing a keeper module must not try to reach the network.
- **Helpers (`test/helpers/`):**
  - `db.ts` — connect (pg client), `resetDb()`, `seedToken(overrides)`, `seedWorkflow(overrides)`.
  - `factories.ts` — `makeToken()`, `makeWorkflowRow()`, `makeImperialPosition()`.
  - `fakes.ts` — `fakeFetch(responses)` (drive 429/503/Retry-After/business-error), `fakeConn(accounts)`
    (Solana reads), `fakeImperial(positions)`.
- **Exit criteria for Phase 0:** `vitest` runs, the DB harness applies all migrations cleanly, one
  trivial green test in each tier.

---

## 2. Phases (in fix order)

Each phase: **target** (which cause/problem), **bad states to disprove**, **cases**, **tier**, and any
**extraction** needed.

### Phase 1 — DB invariants & migrations  ·  *cause H + the whole constraint layer*  ·  T2
Proves the durable layer itself can't hold a bad row.

| # | Scenario (must be rejected/enforced) |
|---|---|
| 1.1 | All migrations apply cleanly from scratch (no drift, idempotent re-run). |
| 1.2 | `token_workflows.state` CHECK **rejects** the deleted states (`fees_pending`, `imperial_deposit_pending`, `profit_realize_pending`) and **accepts** the 9 live ones. |
| 1.3 | `keeper_actions` unique `(token_id, action_kind, intent_hash)` — a duplicate insert is a no-op/conflict, never a second row. |
| 1.4 | `tx_log` unique `(token_id, kind, intent_hash)` — same. |
| 1.5 | `token_wallet_not_null` migration: inserting a token without `treasury_wallet_address` fails (post-backfill invariant). |
| 1.6 | `token_invariants` migration constraints hold (e.g. non-negative reserves; whatever it asserts). |

### Phase 2 — Fix 1: dust / collateral floors  ·  *causes A, B, E*  ·  T1
Proves we never swap/deposit sub-viable dust and never strand reserve below the gate.

| # | Scenario |
|---|---|
| 2.1 | `gateImperialFunding` for an **open** requires ≥ `IMPERIAL_MIN_COLLATERAL_USD` (~$10): below → skip with a reason, never a partial deposit. |
| 2.2 | Kind-aware floor (1d): `topup` uses the viable floor, `open` uses the open floor — assert each. |
| 2.3 | Capacity-below-floor (the DUMPED/ELON case): wallet capacity < floor → `skipReason: 'capacity-below-floor'`, no swap attempted. |
| 2.4 | Reserve below gate accumulates (no swap) until ≥ gate, then becomes eligible — assert the boundary. |

### Phase 3 — Fix 2: launch validation / provisioning  ·  *causes F, G, H*  ·  T1 + T2
Proves a token can't be born into an unlaunchable/half-provisioned state.

| # | Scenario |
|---|---|
| 3.1 | `isLaunchableMarket` rejects unsupported markets (→ terminal `market_unsupported`, not a silent stall). |
| 3.2 | `createDraftToken` writes identity (sub-wallet + `imperial_profile_index`) **atomically** — no token row exists with a null wallet mid-create (T2: constraint + T1: the function). |
| 3.3 | `refreshPoolState`: `sol_raised` is preserved (never regresses to a smaller on-chain read) and `migration_status` is **monotonic** (pending→graduating→graduated, never backward). |
| 3.4 | `recoverLaunch` re-drives a half-finished launch to a consistent state. |

### Phase 3B — PnL accounting & entry-mid  ·  *problem #3*  ·  T1 (+ T3)
Proves we no longer depend on Imperial's missing entry price or the fragile client-side `coll=$X` replay.

| # | Scenario |
|---|---|
| 3B.1 | On first open, `launch_mid` / `position_entry_price` is set from the on-chain `entryPriceUsd` — **never null** for a live position. |
| 3B.2 | When Imperial returns `pnl=$0`/broken, PnL is computed from `(mark − stored entry)/entry` — assert it matches a known fixture, **not** `$0`. |
| 3B.3 | `position_entry_source` records the basis (`imperial` / `reconciled` / `perpad_entry_mid`) so PnL is auditable. |
| 3B.4 | The reconcile / late-index path writes back the venue's real entry, correcting an optimistic entry write. |
| 3B.5 | Past `ENTRY_CAPTURE_WINDOW_MS`, `launch_mid` is **never** overwritten from current mark (an aged position's real PnL is preserved). |
| **Status** | ✅ implemented ([KEEPER_PNL.md](../plan/KEEPER_PNL.md)): venue entry → open resolve → windowed mark capture guarantees a non-null entry for new positions; this phase **verifies** that and the aged-position guard. Client-side replay is now legacy-only. |

### Phase 4 — Fix 3: open idempotency — **"cannot double-open"**  ·  *cause I*  ·  T1 (+ T3)
The highest-stakes phase. Proves a second leveraged position can never be opened.

| # | Scenario |
|---|---|
| 4.1 | `classifyState` returns `position_open_pending` iff `pendingSig && !live`; `position_open` iff live — full truth table. |
| 4.2 | **3a guard:** `workflowBlocksOpen` is true when state is `position_open` OR (`position_open_pending` AND now < `next_retry_at`); false once the marker is stale → a re-open is blocked during the window, allowed after. |
| 4.3 | **3b durability:** the pre-send marker is written (awaited) **before** the open; simulate a "crash" (no result recorded) → next evaluation still sees `position_open_pending` and refuses to re-open. |
| 4.4 | `intentHash` is **deterministic** for the same inputs and **distinct** across tokens/kinds/buckets. |
| 4.5 | **3c (T3):** a late-indexed position (venue read returns a position) → recorded, never re-opened. |
| **Extraction** | pull the inline `workflowBlocksOpen` computation (`loop.js:~1386`) into an exported pure `workflowBlocksOpen(state, retryAt, hasLivePosition, now)`. |

### Phase 5 — Fix 4a: rate-limit backoff  ·  *cause J (recovery)*  ·  T1
Proves 429/503 storms recover and business errors aren't masked.

| # | Scenario |
|---|---|
| 5.1 | `limitedFetch`: 429 then 200 → retries and returns 200; honors `Retry-After` (capped). |
| 5.2 | `limitedFetch`: a business 4xx (e.g. 400) is returned to the caller, **not** retried. |
| 5.3 | `withRetry`: retries only transient (`429`/`ETIMEDOUT`/…), surfaces a real error immediately. |
| 5.4 | `backOff`: respects `numOfAttempts`, exponential delay + cap, `retry()=false` short-circuits. (Inject a fake timer / fake fetch — no real sleeps.) |

### Phase 6 — Fix 4b: hot/warm/cold cadence  ·  *cause J (load)*  ·  T1
Proves idle tokens are throttled and tokens with work are never skipped.

| # | Scenario |
|---|---|
| 6.1 | Hot is never skipped: `pending_drift_sig`, live position, fees ≥ gate, or any non-idle/blocked/error state → processed every tick. |
| 6.2 | Cold (`idle`) is skipped within `COLD_PROBE_INTERVAL_MS`, then probed once after it elapses. |
| 6.3 | Deferred: `next_retry_at` in the future → skipped until due. |
| 6.4 | A cold token that *gains* work (fees arrive) is immediately hot again. |
| **Extraction** | export `tokenHasWork` / `shouldSkipColdTick` (currently private in `loop.js`) for direct T1 testing. |

### Phase 7 — State-enum cleanup  ·  *no dead states*  ·  T1 + T2
| # | Scenario |
|---|---|
| 7.1 | `classifyState` never returns any of the 3 deleted states across an exhaustive input sweep. |
| 7.2 | `State` enum has exactly the 9 live values. |
| 7.3 | (T2) DB CHECK + (T1) the app Zod enum both reject the 3 deleted strings. |

### Phase 8 — Reconciliation job: **recover any stuck token**  ·  *cause I / benji's req*  ·  T1 (+ T3)
Proves stuck tokens are recovered AND that recovery can never cause a double-open.

| # | Scenario |
|---|---|
| 8.1 | `error` → reset to `idle` (cleared `next_retry_at`); after `ERROR_MAX_RESETS` → parked `blocked('error_recovery_exhausted')`, not looping. |
| 8.2 | stale `topup_pending` → sig cleared (live position untouched). |
| 8.3 | **Safety (critical):** stale `position_open_pending` + venue read returns **a position** → recorded, **never cleared/re-opened**. |
| 8.4 | **Safety (critical):** venue read **inconclusive** (`undefined`) → token **left untouched** (never risk a double-open). |
| 8.5 | stale `position_open_pending` + venue **confirmed empty** → sig cleared + reset so the tick re-opens exactly once. |
| 8.6 | long-`blocked` (non-terminal) → escalated once per `ESCALATE_REALERT_MS`; `market_unsupported` never auto-touched. |
| **Extraction** | pull the per-token decision out of `runStateReconcileTick` into a pure `decideReconcile(token, wf, venuePos, now)` → `{action, ...}`; T1 covers 8.1–8.6 with fake `venuePos`, a thin T3 verifies the writes are dispatched. |

### Phase 9 — Observability  ·  *benji's req*  ·  T1/T3
| # | Scenario |
|---|---|
| 9.1 | One `token_tick` summary per processed token with the expected fields (`state`, `actions`, `claimed_usd`, `duration_ms`, …). |
| 9.2 | One `tick_summary` per tick with consistent `tick_id`; counts match (processed/errors). |
| 9.3 | A thrown token still emits a structured `token_tick` error (captured by a fake logger). |

### Phase 10 — Error injection: alerting & recovery  ·  *cross-cutting (causes I, J + benji obs)*  ·  T3 + T1
**Intentionally fall into each error path** and prove two things: (a) the error is **captured with a
determinable cause** (the structured log / `blocked_reason` tells you *what* broke, not a silent stall),
and (b) the system **recovers or escalates** rather than getting stuck. This is the end-to-end
error→capture→recover→alert pipeline.

| # | Inject (fault) | Assert — capture + recovery |
|---|---|---|
| 10.1 | fee claim `throws` (fake RPC error) | tick `catch`/event records the error message (cause is determinable); the token is **not** left silently `idle`; tick continues. |
| 10.2 | a token body throws mid-tick | structured `token_tick` error with `tick_id` + `error` + `duration_ms`; `queueBlocked` writes `blocked_reason`; **one bad token never kills the whole tick** (others still processed). |
| 10.3 | token forced into `error` state | `stateReconcile` resets `error → idle` within a tick; after `ERROR_MAX_RESETS` → `blocked('error_recovery_exhausted')` **and** an escalation log fires. |
| 10.4 | venue read throws / inconclusive during recon | token **left untouched** (never a double-open); the inconclusive read is logged. |
| 10.5 | long-`blocked` token | escalation `logWarn` fires once per `ESCALATE_REALERT_MS`, carrying `blocked_reason` — the "what is the error" alert signal. |
| 10.6 | RPC 429 storm (fake) past the retry budget | `backOff` exhausts → the error surfaces **structurally** (logged with cause), not an unhandled crash. |
| **Note** | "Alert" here = the structured `logWarn`/`logError` lines (the alert substrate); a test asserts each carries enough (`token_id`, `state`/`blocked_reason`, `error`) to determine the cause without reading raw stdout. |

---

## 3. Coverage map

### 3.1 Owner's five named problems (primary)
| Problem | Proven in |
|---|---|
| **1. Fee routing reliability** (stranded dust + stuck-and-invisible) | Phases 2, 9, 10 |
| **2. Imperial deposit gating — atomic/idempotent chain** | Phases 4, 1, 8, 10 |
| **3. PnL accounting** (server-side entry-mid) | Phase 3B |
| **4. RPC pressure** (429s) | Phases 5, 6 |
| **5. No unified state model / reconciliation** | Phases 4, 7, 8 |

### 3.2 Internal causes A–J (secondary breakdown)
| Cause / problem | Proven in |
|---|---|
| A, B, E (dust, gating, stranded reserve) | Phase 2 |
| F, G (launch/market validation) | Phase 3 |
| H (provisioning/constraints) | Phase 1, 3 |
| I (double-open / stuck open) | Phase 4, 8 |
| J (RPC 429s — recovery + load) | Phase 5, 6 |
| Benji: idempotent transitions | Phase 4, 1 |
| Benji: reconciliation job | Phase 8 |
| Benji: observability | Phase 9 |
| Benji: PnL accounting | Phase 3B |
| Error capture + recovery + alerting (cross-cutting) | Phase 10 |

---

## 4. Execution protocol

1. Build **Phase 0** (infra) → green.
2. For each phase 1→10: write its tests, make them green, **commit**, then move on. A later phase never
   blocks on an earlier one being perfect, but we go in order so the foundation (DB, pure logic) is
   solid before the integration tiers.
3. Each phase's PR/commit references the cause(s) it closes and links the relevant `KEEPER_*.md`.
4. (Optional) wire `vitest` into CI once Phase 0–4 are green.

## 5. Non-goals
- No mainnet / Imperial / Jupiter / real-money end-to-end — that stays manual in `LOCAL_TESTING_GUIDE.md`.
- No testing of third-party SDK internals (Meteora/Imperial) — we test **our** decisions and guards.
- No load/perf testing in v1.

## 6. Resolved decisions
- **Runner:** `vitest` at root. ✅
- **Local DB:** `supabase` CLI local stack, migrated via `supabase db reset`. ✅
- **Testability extractions** (Phases 4/6/8): approved — pull pure decision functions out of `loop.js`
  & `stateReconcile.js`, no behavior change. ✅

## 7. Breaking-change audit (vs the deployed Fly keeper) — 2026-05-29
Checked whether the refactor breaks the live deployment:
- **No boot crash:** the full keeper import graph (incl. new `stateReconcile.js`) resolves —
  `await import()` smoke test of `structuredLog/workflow/stateReconcile/positionReconcile/loop` prints
  `IMPORTS_OK`. No lingering refs to the 3 deleted `State.*` values.
- **No new required env:** every new knob (`STATE_RECONCILE_ENABLED`, `COLD_PROBE_INTERVAL_MS`,
  `RECONCILE_*`) has a default, so a deploy without them won't crash.
- **API contract unchanged:** the `/tokens` feed embed and the report payloads the keeper sends are
  unchanged; old-keeper↔new-app and new-keeper↔old-app are both compatible (the Zod enum only *removed*
  never-emitted states).
- **Deploy-time risks to manage (not runtime breaks):**
  1. The 3-state removal edited the **already-shipped** `…_keeper_workflows.sql` CHECK — harmless at
     runtime (prod keeps the 12-state superset), but don't re-push that migration to prod; treat it as
     fresh-DB-only.
  2. `…_token_wallet_not_null.sql` must **not** be applied to prod before the 2c backfill runs (existing
     null `treasury_wallet_address` rows would fail it).
  3. **`stateReconcile` activates by default** on deploy. It's passive + venue-guarded, but recommend
     shipping with `STATE_RECONCILE_ENABLED=false` first, watching the `state-reconcile` logs, then
     enabling.
  4. App-side changes (`dbc.functions.ts`, `workflow-report.ts`, `src/lib/backoff.ts`) deploy to
     **Cloudflare**, not Fly — separate target; rolling compat is safe.
- **Behavioral changes (intended, not breaks):** idle tokens now probed ~every 5 min not every tick
  (4b); the `[loop] reported …` line is now structured JSON (any external grep on that exact string
  must update).
