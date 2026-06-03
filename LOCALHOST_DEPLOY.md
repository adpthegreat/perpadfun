# Localhost Deploy — Serve Seeded Data from the Local Database

Operate the perpad application against the local Supabase stack with representative seed data for
verification of the keeper-refactor changes prior to mainnet rollout. Two surfaces are exposed:
- The existing UI (`/`, `/tokens`, `/token/$id`) reads from the `tokens` table and `treasury_events`.
- The keeper JSON APIs (`/api/public/keeper/workflows`, `stuck-tokens`, `workflow-report`,
  `workflow-locks`) are **JSON-only, no React UI surface** (the per-token workflow/log UI is a
  deferred follow-up; reference [plan/KEEPER_PER_TOKEN_LOGS.md](plan/KEEPER_PER_TOKEN_LOGS.md)).

## Pre-flight (verified on this branch)
- `npm run build` produces a clean Cloudflare Worker bundle; new routes are registered in
  `src/routeTree.gen.ts`.
- `node --check` passes on every file under `keeper/src/*.js`.
- vitest: **60 passed / 40 skipped without DB** (12 test files passed, 1 skipped). With
  `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` set, the previously
  skipped 40 DB-bound tests become eligible; total ~100 with the local stack online. The prior
  figures ("89 with DB / 52 without") reflected the pre-Phoenix-migration state; the +8 delta
  corresponds to `test/phase2-imperial-deposit/imperial_price_scaling.test.ts` shipped with
  [plan/KEEPER_PHOENIX_LOCK.md](plan/KEEPER_PHOENIX_LOCK.md). Re-confirm the with-DB total after
  `bunx supabase start`.
- `test/live/` is gated by `IMPERIAL_LIVE_TESTS=1` and excluded from `npm test`. Phoenix
  round-trip verified on-chain; signatures recorded in `test/live/txns.txt`.

## 1. Prerequisites
```bash
# Docker must be running — Supabase local stack runs in Docker.
docker info >/dev/null 2>&1 || {
  echo "Docker is not running."
  echo "  Linux:   sudo systemctl start docker"
  echo "  macOS:   open -a 'Docker'"
  exit 1
}

# Supabase local stack running (Postgres :54322, API :54321)
bunx supabase status            # if down: bunx supabase start
# Apply the migrations locally:
bunx supabase migration up
```

## 2. Seed the Local Database
[scripts/seed-keeper.ts](scripts/seed-keeper.ts) reuses the test helpers
([test/helpers/db.ts](test/helpers/db.ts) and [test/helpers/fleet.ts](test/helpers/fleet.ts)) to remain
in lockstep with the migrated schema. The script seeds: 10 UI-visible showcase tokens (each populated
with workflows, treasury_events, keeper_actions, and keeper_logs), 9 state-coverage tokens (one per
workflow state, named as standard meme tokens), 24 stuck scenarios for `/stuck-tokens`, and a 20-token
cadence mix.

The script **TRUNCATES all tokens prior to seeding** and is local-only. Execution is refused unless
`TEST_DATABASE_URL` points at a `127.0.0.1` or `localhost` host AND `--yes` is supplied. Never point it
at a production database.

```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  bun run scripts/seed-keeper.ts --yes
```
Expected: `tokens: 63, workflows: 63, actions: 27, logs: 29, events: 52, txlog: 6` and
`UI-visible tokens: 19`.

## 3. Serve the Application Against the Local Database
The feed and treasury server functions use `supabaseAdmin`, which requires the **local** Supabase
service environment on the dev server. The keeper APIs additionally require `KEEPER_SECRET`. The local
service-role JWT is obtained from `bunx supabase status -o env`.

```bash
SUPABASE_URL="http://127.0.0.1:54321" \
SUPABASE_SERVICE_ROLE_KEY="<local service_role JWT from: bunx supabase status -o env>" \
KEEPER_SECRET="localtestsecret" \
  npm run dev -- --port 8080 --host
```

## 4. Verification Surfaces
Browser:
- `http://localhost:8080/` — token cards, open-perp sidebar, protocol-stats footer.
- `http://localhost:8080/tokens` — full feed (19 cards).
- `http://localhost:8080/token/<mint or id>` — treasury panel, live feed, buyback/burn.

Note: USD prices may floor locally because Jupiter and Hyperliquid are remote services and the seeded
mints are not real. `sol_raised`-driven graduation bars and DB-backed treasury data render correctly.

New keeper APIs (JSON, `x-keeper-secret` required):
```bash
S=localtestsecret
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/stuck-tokens" | head
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/workflows?limit=5" | head
# per-token timeline (workflow state + recent_logs + recent_actions):
ID=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -A -c "select id from public.tokens where ticker='DEGEN'")
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/workflows?token_id=$ID"
```

## 5. Re-seed and Teardown
- Re-execute step 2 at any time; the script resets state before seeding.
- Stop the dev server with `Ctrl-C` or `pkill -f "vite dev --port 8080"`.

> The stuck and cadence tokens are intentionally not UI-visible (no `mint_address`) so they exercise
> the keeper APIs without populating the feed. Only the 10 showcase tokens and 9 state-coverage tokens
> (all named as standard meme tokens) appear in the UI.

## 6. API Endpoints (JSON) — Localhost

Base URL: `http://localhost:8080`.
Authentication: every `keeper` and `admin` endpoint requires the header `x-keeper-secret:
localtestsecret` (the value supplied to the dev server in step 3). `/api/public/solana/rpc` is the only
endpoint without a secret requirement.

GET endpoints — supply the URL to an API client (Postman, Insomnia, Thunder) with the
`x-keeper-secret` header, or use the provided curl commands. A browser address bar returns `401`
because it cannot send the header.
```
GET  http://localhost:8080/api/public/keeper/tokens
GET  http://localhost:8080/api/public/keeper/workflows
GET  http://localhost:8080/api/public/keeper/workflows?limit=50
GET  http://localhost:8080/api/public/keeper/workflows?token_id=<uuid>
GET  http://localhost:8080/api/public/keeper/stuck-tokens
GET  http://localhost:8080/api/public/keeper/external-routers
GET  http://localhost:8080/api/public/keeper/logs
GET  http://localhost:8080/api/public/keeper/logs?token_id=<uuid>
GET  http://localhost:8080/api/public/keeper/logs?level=error&limit=100
GET  http://localhost:8080/api/public/keeper/logs?token_id=<uuid>&before=<iso-cursor>
```

POST endpoints (keeper and admin writes — require a JSON body and the secret header):
```
POST http://localhost:8080/api/public/keeper/report                 body: {token_id, router, ...}
POST http://localhost:8080/api/public/keeper/workflow-report        body: {workflows:[], actions:[], logs:[]}
POST http://localhost:8080/api/public/keeper/workflow-locks         body: {token_ids:[], owner, stale_after_seconds}
POST http://localhost:8080/api/public/keeper/external-sweep-report  body: {token_id, sweeps:[]}
POST http://localhost:8080/api/public/keeper/external-router-seen   body: {token_ids:[]}
POST http://localhost:8080/api/admin/backfill-treasury-wallets      (add ?dryRun=1 for a no-write count)
POST http://localhost:8080/api/public/solana/rpc                    body: JSON-RPC request (NO secret)
```

Ready-to-execute curl commands (read endpoints):
```bash
S=localtestsecret
curl -s -H "x-keeper-secret: $S" http://localhost:8080/api/public/keeper/tokens
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/workflows?limit=10"
curl -s -H "x-keeper-secret: $S" http://localhost:8080/api/public/keeper/stuck-tokens
curl -s -H "x-keeper-secret: $S" http://localhost:8080/api/public/keeper/external-routers
```

Per-token keeper logs — use the dedicated endpoint `GET /api/public/keeper/logs`. This endpoint reads
the `keeper_logs` table directly: returns log rows only, supports `token_id`, `level`, `event`,
`limit`, and `before` filters, and reaches global `token_id IS NULL` rows that the `recent_logs` field
on `/workflows` cannot return.
```bash
S=localtestsecret
# Note: data values are seed-dependent. The token_ids below are a snapshot of the current seed;
# re-running scripts/seed-keeper.ts regenerates them. Use the by-ticker form below for stability.

# Current seed inventory (29 logs across 10 tokens plus 1 global token_id=NULL row):
#   WOJAK  error, info   — contains one level=error row (imperial open failed)
#   CHAD   warn, info    — contains one level=warn  row (blocked: capacity-below-floor)
#   DEGEN, MOON, BEAR, HYPER, SAFE, GRAD   info  (3 each: open + claim + tick)
#   CHOP, PEPE2                            info  (2 each: claim + tick)

# 6 currently seeded tokens (point-in-time IDs):
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=79a478d8-0dd1-46a9-9030-38f2255a8f52"  # WOJAK (has ERROR)
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=14e62282-49b2-436a-bfee-1e70b9f20e32"  # CHAD  (has WARN)
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=c8667802-eb9d-4247-91a2-655d416bbcbd"  # DEGEN
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=6ebe9a30-ecc5-4a52-8a3f-c7de6be91dcd"  # MOON
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=02c50e09-26ce-43b3-b58c-f7dff8e22e0e"  # BEAR
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=f9b38173-9b69-4942-91df-3e8fa4d92bc2"  # HYPER

# re-seed-stable: resolve the id by ticker, then fetch its logs:
ID=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -A -c "select id from public.tokens where ticker='WOJAK'")
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=$ID"

# ALL keeper_logs across every token (incl. global token_id=NULL rows):
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?limit=200"

# errors only (across every token):
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?level=error&limit=100"

# warns only:
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?level=warn&limit=100"

# Enumerate all tokens that have logs (ticker — id — log count) via direct DB query:
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -A -F'  ' -c \
  "select t.ticker, t.id, count(*) from public.tokens t join public.keeper_logs kl on kl.token_id=t.id group by t.ticker, t.id order by count(*) desc, t.ticker"

# page older (cursor): take next_before from a response, pass it back as ?before= (URL-safe, ends in Z):
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/logs?token_id=$ID&limit=2&before=2026-05-29T18:17:58.063322Z"
```

## 7. Local Verification

Local verification is structured in three layers. **Layer 1 (the automated suite) is the authoritative
proof** — it exercises the pure logic and DB invariants for all five problem domains against the local
Postgres instance. **Layer 2** is a runtime smoke against the seeded, running application (observable
behavior). **Layer 3** enumerates items local verification cannot prove (the live trading path; that is
devnet, Gate 1 in `MAINNET_DEPLOY.md`).

### Layer 1 — Automated Suite (Authoritative)
Executed against the local Supabase Postgres instance. Each test maps to a problem domain via
`test/TEST_PLAN.md`.
```bash
# whole suite (run from repo root, supabase local must be up):
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm test
# same, but with keeper console output visible:
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:logs
# one problem at a time, e.g. reconciliation:
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npx vitest run test/phase8-reconcile
```
Expected output (post Phoenix-migration additions): `Test Files 12 passed, Tests ~100 passed` with DB.
Without `TEST_DATABASE_URL`, the DB tier skips and the result is **60 passed / 40 skipped**. The
environment variable is the toggle that activates the DB-bound tests. The prior figures
("89 / 52 / 37") were valid before the Phoenix migration; the +8 delta corresponds to the per-venue
scaling unit tests shipped with [plan/KEEPER_PHOENIX_LOCK.md](plan/KEEPER_PHOENIX_LOCK.md). Re-execute
after `bunx supabase start` to confirm the with-DB total.

> IMPORTANT: the DB-tier tests `TRUNCATE` all tokens on every test (per-test reset), so executing the
> suite **invalidates the step-2 seed**. Execute Layer 1 first, then re-run step 2 to re-seed before
> proceeding to Layer 2 or browsing the UI.

| Problem domain addressed | Proven by (vitest phase folders) |
|---|---|
| 1. Fee-routing reliability (dust floors, stranded reserve, visibility) | `phase1-fee-routing`, `phase2-dust-floors`, `phase9-observability`, `phase10-error-injection` |
| 2. Imperial deposit gating (atomic and idempotent chain) | `phase2-imperial-deposit`, `phase1-db-invariants`, `phase4-rpc-pressure`, `phase8-reconcile`, `phase10-error-injection` |
| 3. PnL accounting (server-side windowed entry-mid) | `phase3-pnl` |
| 4. RPC pressure / 429 handling (global rate limiter and backoff) | `phase4-rpc-pressure` |
| 5. Unified state model and reconciliation | `phase5-unified-state`, `phase7-state-enum`, `phase8-reconcile` |
| Idempotent state transitions | `phase1-db-invariants`, `phase4-rpc-pressure` |
| Reconciliation job for stuck-token recovery | `phase8-reconcile` |
| Observability via durable per-token logs | `phase9-observability` |
| Launch invariants and market validation | `phase3-launch`, `phase1-db-invariants` |
| Error capture and recovery (cross-cutting) | `phase10-error-injection` |

### Layer 2 — Runtime Smoke on the Seeded Deployment
With the seeded DB (step 2) and the dev server running (step 3), the following commands demonstrate
end-to-end runtime behavior through the production route handlers. `S=localtestsecret`.

```bash
S=localtestsecret
export PGPASSWORD=postgres
PSQL="psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -t -A -c"

# (5) UNIFIED STATE MODEL — verify all 9 states are present and queryable:
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/workflows?limit=200" \
  | python3 -c "import sys,json; print('states:', sorted({w['state'] for w in json.load(sys.stdin)['workflows']}))"
#   Expected 9 states: blocked, error, fees_claimed, idle, imperial_deposited, position_open,
#                      position_open_pending, split_reserved, topup_pending

# (5) RECONCILIATION QUERY — returns only stuck candidates; idle and live states are excluded:
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/stuck-tokens" \
  | python3 -c "import sys,json; ts=json.load(sys.stdin)['tokens']; print('stuck:', len(ts), 'states:', sorted({(t['token_workflows'] if isinstance(t['token_workflows'],dict) else t['token_workflows'][0])['state'] for t in ts}))"
#   Expected states: error, blocked, position_open_pending, topup_pending

# OBSERVABILITY — a per-token log written via the report path is queryable on the timeline:
ID=$($PSQL "select id from public.tokens where ticker='DEGEN'")
curl -s -X POST -H "x-keeper-secret: $S" -H "Content-Type: application/json" \
  -d "{\"logs\":[{\"token_id\":\"$ID\",\"level\":\"error\",\"event\":\"open\",\"message\":\"smoke: open failed\",\"fields\":{\"error\":\"sim 503\"}}]}" \
  http://localhost:8080/api/public/keeper/workflow-report
curl -s -H "x-keeper-secret: $S" "http://localhost:8080/api/public/keeper/workflows?token_id=$ID" \
  | python3 -c "import sys,json; w=json.load(sys.stdin)['workflows'][0]; print('recent_logs:', [l['message'] for l in w['recent_logs']])"
#   Output includes "smoke: open failed" (durable, attributable to the token).

# (2) IDEMPOTENT LEDGER — submitting the same action twice collapses to one row:
B="{\"actions\":[{\"token_id\":\"$ID\",\"action_kind\":\"imperial_open\",\"intent_hash\":\"idem-001\",\"status\":\"confirmed\"}]}"
curl -s -X POST -H "x-keeper-secret: $S" -H "Content-Type: application/json" -d "$B" http://localhost:8080/api/public/keeper/workflow-report >/dev/null
curl -s -X POST -H "x-keeper-secret: $S" -H "Content-Type: application/json" -d "$B" http://localhost:8080/api/public/keeper/workflow-report >/dev/null
$PSQL "select count(*) from public.keeper_actions where token_id='$ID' and action_kind='imperial_open' and intent_hash='idem-001'"
#   Expected count: 1 (the unique (token_id, action_kind, intent_hash) constraint deduplicates).
# Remove the smoke rows:
$PSQL "delete from public.keeper_actions where intent_hash='idem-001'"; $PSQL "delete from public.keeper_logs where message='smoke: open failed'"
```

### Layer 3 — Items Local Verification Cannot Prove (Requires Devnet)
The local application serves seeded data and pure logic; the keeper trade loop is not executed. The
following require a devnet keeper run (Gate 1 in `MAINNET_DEPLOY.md`) because they depend on real
Solana RPC, Imperial, and wallet interactions:
- Actual perp open, top-up, and close operations, plus the anti-double-open guard against a real
  venue read.
- Real RPC 429 recovery against a live provider; local verification covers only the retry and backoff
  logic.
- Real Imperial deposits and the on-chain atomic funding chain.
- PnL against a live mark; local verification covers only the entry-capture math.
