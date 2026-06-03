# Mainnet Deploy — Keeper Refactor (`refactor_keeper_system`)

> **Two hard gates before mainnet:**
> 1. **Devnet validation** must pass. A devnet keeper run must demonstrate: no double-open, correct
>    entry-mid capture, stuck-token recovery, and the §6a/§6b/§6c checks. Production deploy is blocked
>    without this.
> 2. **Migration order.** `20260529160000_token_wallet_not_null.sql` (step 4) runs ONLY after the
>    treasury-wallet backfill (step 3) reports zero nulls.

**Stack:** Supabase migrations → Cloudflare Workers application → Fly.io keeper (`perpad-keeper`).
Configuration files: [keeper/fly.toml](keeper/fly.toml), [keeper/Dockerfile](keeper/Dockerfile).

---

## Table of Contents

1. [Apply additive migrations](#1-apply-additive-migrations)
2. [Deploy the application](#2-deploy-the-application)
3. [Backfill treasury wallets](#3-backfill-treasury-wallets)
4. [Apply the deferred NOT NULL migration](#4-apply-the-deferred-not-null-migration)
5. [Deploy the keeper](#5-deploy-the-keeper)
   - 5a. [Required secrets](#5a-required-secrets)
   - 5b. [New mechanism knobs (this deploy)](#5b-new-mechanism-knobs-this-deploy)
   - 5c. [Optional and rollback knobs](#5c-optional-and-rollback-knobs)
   - 5d. [Ship](#5d-ship)
6. [Post-deploy smoke](#6-post-deploy-smoke)
   - 6a. [Phoenix lock verification](#6a-phoenix-lock-verification)
   - 6b. [Backstop TP verification](#6b-backstop-tp-verification)
   - 6c. [Per-venue marketPrice scaling sanity](#6c-per-venue-marketprice-scaling-sanity)
7. [Rollback](#7-rollback)
8. [API endpoints reference](#8-api-endpoints-reference)

---

## What This Branch Adds (Beyond the Original Refactor)

| Change | Specification | New env vars |
|---|---|---|
| Backstop take-profit (fires when floating PnL ≥ 50% × coll) | [plan/KEEPER_TP_SAFETY_PATCH.md](plan/KEEPER_TP_SAFETY_PATCH.md) | `BACKSTOP_RATIO`, `BACKSTOP_TARGET_RATIO`, `BACKSTOP_MAX_PER_TICK` |

## Pre-flight (Verified on This Branch)

```bash
npm run build           # clean Worker bundle
npm test                # 60 passed / 40 skipped without DB
node --check keeper/src/*.js   # all green; keeper runs un-transpiled
```

With Docker and Supabase local running, the DB tier becomes eligible:
```bash
TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm test
# expect: ~100 passed
```

---

## 1. Apply Additive Migrations

Link the production project once, then push.

```bash
bunx supabase link --project-ref <PROD_PROJECT_REF>
bunx supabase db push
```

Migrations applied at this step:
- `20260528140414_keeper_workflows.sql` — adds `token_workflows`, `keeper_actions`, widens `tx_log`
  CHECK, backfills from `tokens`, adds RLS read policies.
- `20260529120000_token_invariants.sql` — backfills `imperial_profile_index` → DEFAULT 1 → NOT NULL.
- `20260529170000_keeper_logs.sql` — durable per-token log table with index.

> **STOP** if `db push` attempts to apply `20260529160000_token_wallet_not_null.sql` here. It will
> FAIL because nulls exist in `tokens.treasury_wallet_address`. Move it aside, push the first three,
> run §3, then run §4.

Verify the three tables exist:
```bash
PSQL="psql -h <DB_HOST> -p <DB_PORT> -U <DB_USER> -d <DB_NAME> -t -A -c"
$PSQL "select count(*) from public.token_workflows;"
$PSQL "select count(*) from public.keeper_actions;"
$PSQL "select count(*) from public.keeper_logs;"
```

---

## 2. Deploy the Application

```bash
npm ci
npm run build
npx wrangler deploy
```

Set Worker secrets (skip values already present in `npx wrangler secret list`):

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put KEEPER_SECRET          # MUST match the keeper's KEEPER_SECRET
# Set any SUPABASE_PUBLISHABLE_KEY / VITE_* the application requires.
```

Verify the application is reachable:

```bash
curl -sI https://perpad.fun/ | head -1
# expect: HTTP/2 200
```

---

## 3. Backfill Treasury Wallets

```bash
S=<PROD_KEEPER_SECRET>
curl -s -X POST -H "x-keeper-secret: $S" https://perpad.fun/api/admin/backfill-treasury-wallets
```

Verify zero nulls remain:

```bash
curl -s -X POST -H "x-keeper-secret: $S" \
  "https://perpad.fun/api/admin/backfill-treasury-wallets?dryRun=1"
# expect: "remaining": 0
```

**Do not proceed to §4 until `remaining` is `0`.**

---

## 4. Apply the Deferred NOT NULL Migration

```bash
bunx supabase db push    # applies 20260529160000_token_wallet_not_null.sql
```

Verify the constraint is live:

```bash
$PSQL "select column_name, is_nullable from information_schema.columns
       where table_schema='public' and table_name='tokens'
       and column_name='treasury_wallet_address';"
# expect: treasury_wallet_address | NO
```

---

## 5. Deploy the Keeper

### 5a. Required Secrets

```bash
cd keeper
fly secrets set \
  KEEPER_SECRET="<must match app>" \
  PERPAD_BASE_URL="https://perpad.fun" \
  SOLANA_RPC_URL="<mainnet rpc>" \
  TREASURY_SOLANA_PRIVATE_KEY="<treasury signer>" \
  IMPERIAL_API_KEY="<imperial>" \
  KEEPER_MINT_ALLOWLIST="<optional>" \
  --app perpad-keeper
```

### 5b. New Mechanism Knobs (This Deploy)

Backstop TP ([plan/KEEPER_TP_SAFETY_PATCH.md](plan/KEEPER_TP_SAFETY_PATCH.md)) and Phoenix lock
([plan/KEEPER_PHOENIX_LOCK.md](plan/KEEPER_PHOENIX_LOCK.md)):

```bash
fly secrets set \
  BACKSTOP_RATIO=0.5 \
  BACKSTOP_TARGET_RATIO=0.10 \
  BACKSTOP_MAX_PER_TICK=500 \
  IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix \
  --app perpad-keeper
```

| Variable | Default | Effect |
|---|---|---|
| `BACKSTOP_RATIO` | `0.5` | Fire when floating PnL ≥ this fraction of coll. Set to `999` to disable. |
| `BACKSTOP_TARGET_RATIO` | `0.1` | Reduce PnL to this fraction of coll after a fire (10% buffer). |
| `BACKSTOP_MAX_PER_TICK` | `500` | Per-tick cash cap on backstop fires (USD). |
| `IMPERIAL_SUPPORTED_OPEN_VENUES` | `phoenix` | Comma-separated venues allowed for opens. |

Rollout-safe alternative: ship inert, enable later.
```bash
fly secrets set BACKSTOP_RATIO=999 --app perpad-keeper       # backstop disabled until lowered
```

### 5c. Optional and Rollback Knobs

Pre-existing tunables (safe defaults; set only to override):
- `STATE_RECONCILE_ENABLED` (default `true`)
- `COLD_PROBE_INTERVAL_MS`
- `ENTRY_CAPTURE_WINDOW_MS`
- `WORKFLOW_TOKEN_RECENT_MS`

Rollback knobs:

```bash
# Re-enable multi-venue dispatch:
fly secrets set IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix,flash_trade,jupiter --app perpad-keeper

# Restore the per-symbol SUPPORTED_MARKETS lookup:
fly secrets set IMPERIAL_VENUE_OVERRIDE=auto --app perpad-keeper
```

| Variable | Default | Effect |
|---|---|---|
| `IMPERIAL_VENUE_OVERRIDE` | unset | `auto` restores the original `SUPPORTED_MARKETS`-based venue resolution. Any other venue name forces that venue. |
| `FLASH_PRICE_EXPONENTS` | unset | Per-symbol Flash priceExponent map (e.g., `"HYPE=-8,SOL=-8,BTC=-8,ETH=-8,ZEC=-8,GOLD=-3,SILVER=-5,WTIOIL=-5"`). Required only if Flash is re-enabled via `FLASH_TESTS=1`. The Flash close path is deferred per [plan/KEEPER_PHOENIX_LOCK.md](plan/KEEPER_PHOENIX_LOCK.md) §6c. |

> Secret names are derived from [keeper/src/config.js](keeper/src/config.js) and
> [src/integrations/supabase/client.server.ts](src/integrations/supabase/client.server.ts). Reconcile
> against `fly secrets list` and `wrangler secret list` rather than treating this list as exhaustive.

### 5d. Ship

```bash
fly deploy --app perpad-keeper
```

Verify the keeper is running:

```bash
fly status --app perpad-keeper
fly logs --app perpad-keeper | head -50
```

---

## 6. Post-deploy Smoke

Confirm the application is reachable and the keeper is ticking:

```bash
S=<PROD_KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/workflows?limit=3" | head
fly logs --app perpad-keeper        # expect structured tick_summary lines; keeper_logs row count climbing
```

### 6a. Phoenix Lock Verification

```bash
# Any "skip: venue=... not in SUPPORTED_OPEN_VENUES" lines indicate /route picked a non-Phoenix
# venue and the keeper declined. Small count = healthy. Constant stream = /route cannot find a
# Phoenix candidate for the asset; investigate (reference plan/KEEPER_PHOENIX_LOCK.md §3).
fly logs --app perpad-keeper | grep "imperial:open.*skip.*not in SUPPORTED_OPEN_VENUES" | tail

# First open per profile invokes /phoenix/register exactly once (idempotent and cached).
fly logs --app perpad-keeper | grep "imperial:phoenix-register" | tail
```

A successful Phoenix open produces the following sequence per token:
```
[imperial:phoenix-register] wallet=... profile=...      # only on cold cache
imperial:open <symbol> ... success=true
```

### 6b. Backstop TP Verification

```bash
# Expected on a new mainnet deploy: zero occurrences in the first 24 hours.
# Non-zero occurrences indicate either real runaway PnL or a configuration error.
fly logs --app perpad-keeper | grep "backstop_tp fired" | tail
```

To verify the path is wired (staging only — production execution costs funds): force a position past
50% PnL/coll via a mark mock or by reducing `BACKSTOP_RATIO` below the current real PnL ratio. The
fire must land on the partial-close path (not withdraw).

### 6c. Per-venue marketPrice Scaling Sanity

Each Phoenix `/mobile/orders` body must carry `marketPrice ≈ uiPrice × 1e6` (1e9 oracle scale divided
by 1000; the downstream order bot multiplies by ×1000 on the wire).

```bash
# Sample several /mobile/orders requests; confirm marketPrice is in the 1e6 range
# (10–500 million for assets priced $10–$500), NOT 1e9.
fly logs --app perpad-keeper | grep "POST /mobile/orders" | tail
```

---

## 7. Rollback

| Layer | Command |
|---|---|
| Application | `npx wrangler deployments list` then `npx wrangler rollback [<id>]` |
| Keeper | `fly releases --app perpad-keeper` then `fly deploy --image <previous>` (or `fly releases rollback`) |
| Backstop TP | `fly secrets set BACKSTOP_RATIO=999 --app perpad-keeper` |
| Phoenix lock | `fly secrets set IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix,flash_trade,jupiter --app perpad-keeper` |
| Venue resolution | `fly secrets set IMPERIAL_VENUE_OVERRIDE=auto --app perpad-keeper` |
| Migrations | Additive tables are forward-safe; retain them. The two NOT NULL constraints require manual reversal: `ALTER TABLE public.tokens ALTER COLUMN <col> DROP NOT NULL` |

---

## 8. API Endpoints Reference

Base URL: `https://perpad.fun`.
Authentication: every `keeper` and `admin` endpoint requires `x-keeper-secret: <PROD_KEEPER_SECRET>`
(matches the Worker and the keeper). `/api/public/solana/rpc` is the only endpoint without a secret
requirement.

### GET Endpoints

```
GET  https://perpad.fun/api/public/keeper/tokens
GET  https://perpad.fun/api/public/keeper/workflows
GET  https://perpad.fun/api/public/keeper/workflows?limit=50
GET  https://perpad.fun/api/public/keeper/workflows?token_id=<uuid>
GET  https://perpad.fun/api/public/keeper/stuck-tokens
GET  https://perpad.fun/api/public/keeper/external-routers
GET  https://perpad.fun/api/public/keeper/logs
GET  https://perpad.fun/api/public/keeper/logs?token_id=<uuid>
GET  https://perpad.fun/api/public/keeper/logs?level=error&limit=100
GET  https://perpad.fun/api/public/keeper/logs?token_id=<uuid>&before=<iso-cursor>
```

### POST Endpoints (JSON body required)

```
POST https://perpad.fun/api/public/keeper/report                 body: {token_id, router, ...}
POST https://perpad.fun/api/public/keeper/workflow-report        body: {workflows:[], actions:[], logs:[]}
POST https://perpad.fun/api/public/keeper/workflow-locks         body: {token_ids:[], owner, stale_after_seconds}
POST https://perpad.fun/api/public/keeper/external-sweep-report  body: {token_id, sweeps:[]}
POST https://perpad.fun/api/public/keeper/external-router-seen   body: {token_ids:[]}
POST https://perpad.fun/api/admin/backfill-treasury-wallets      (add ?dryRun=1 for a no-write count)
POST https://perpad.fun/api/public/solana/rpc                    body: JSON-RPC request (NO secret)
```

### Ready-to-execute curl commands

```bash
S=<PROD_KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" https://perpad.fun/api/public/keeper/tokens
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/workflows?limit=10"
curl -s -H "x-keeper-secret: $S" https://perpad.fun/api/public/keeper/stuck-tokens
curl -s -H "x-keeper-secret: $S" https://perpad.fun/api/public/keeper/external-routers
```

### Per-token Log Triage

`GET /api/public/keeper/logs` reads `keeper_logs` directly: log rows only, supports `token_id`,
`level`, `event`, `limit`, and `before` filters, and returns global `token_id IS NULL` rows that the
`/workflows` `recent_logs` field cannot return.

```bash
S=<PROD_KEEPER_SECRET>

# 1) Discover token_ids (ticker → id):
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/workflows?limit=20" \
  | python3 -c "import sys,json; [print((w.get('tokens') or {}).get('ticker'), w['token_id']) for w in json.load(sys.stdin)['workflows']]"

# 2) Triage by level — identify token_ids with errors / warns:
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/logs?level=error&limit=200" \
  | python3 -c "import sys,json,collections
rows=json.load(sys.stdin)['logs']
c=collections.Counter(r.get('token_id') for r in rows)
print('errors:',c.most_common(10))"

curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/logs?level=warn&limit=200" \
  | python3 -c "import sys,json,collections
rows=json.load(sys.stdin)['logs']
c=collections.Counter(r.get('token_id') for r in rows)
print('warns:',c.most_common(10))"

# 3) Per-token timeline for an id from step 1 or 2:
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/logs?token_id=<uuid>"

# 4) All logs, including global (token_id=NULL) rows:
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/logs?limit=200"

# 5) Page older (cursor): use next_before from a response as ?before= (URL-safe Z form):
curl -s -H "x-keeper-secret: $S" "https://perpad.fun/api/public/keeper/logs?token_id=<uuid>&before=<next_before>"
```
