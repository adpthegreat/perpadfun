# Mainnet Deploy — perpspad (fork of perpad)

**Stack:** Supabase migrations → Cloudflare Workers application → Fly.io keeper (`perpspad-keeper`).
Configuration files: [keeper/fly.toml](keeper/fly.toml), [keeper/Dockerfile](keeper/Dockerfile).

---

## Table of Contents

- ★ [Deploy & test checklist](#deploy--test-checklist)
0. [Secrets & credentials](#0-secrets--credentials--how-to-generate--obtain-each)
1. [Apply migrations](#1-apply-migrations)
2. [Deploy the application](#2-deploy-the-application)
   - 2a. [First-time Cloudflare setup](#2a-first-time-cloudflare-setup-once-per-account)
   - 2b. [Build + deploy](#2b-build--deploy)
   - 2c. [Serve at perpspad.fun](#2c-serve-at-perpspadfun)
   - 2d. [Worker secrets](#2d-worker-secrets)
3. [Deploy the keeper](#3-deploy-the-keeper)
   - 3a. [Required secrets](#3a-required-secrets)
   - 3b. [Mechanism knobs](#3b-mechanism-knobs)
   - 3c. [Optional and rollback knobs](#3c-optional-and-rollback-knobs)
   - 3d. [Ship](#3d-ship)
4. [Post-deploy smoke](#4-post-deploy-smoke)
   - 4a. [Phoenix lock verification](#4a-phoenix-lock-verification)
   - 4b. [Take-profit verification](#4b-take-profit-verification)
   - 4c. [Per-venue marketPrice scaling sanity](#4c-per-venue-marketprice-scaling-sanity)
5. [Rollback](#5-rollback)
6. [API endpoints reference](#6-api-endpoints-reference)

---

## Deploy & Test Checklist

The condensed runbook; each item links to its detailed section below.

### Pre-deploy
- [ ] **Everything committed**, including `package-lock.json`. It's currently untracked — with `^`
  version ranges, dev / build / deploy can each resolve different `@tanstack/*` versions (the
  source of "it built last week" surprises). Commit the lockfile for reproducible builds.
- [ ] **`npm run build` is GREEN locally.** Always gate on a real build — `vite dev` skips the
  bundle-time checks (e.g. server/client import-protection), so dev passing ≠ deploy passing.
- [ ] **Migrations pushed to prod** — `bunx supabase login` then `bunx supabase db push` ([§1](#1-apply-migrations)).
- [ ] **Worker secrets set** ([§0](#0-secrets--credentials--how-to-generate--obtain-each) / [§2](#2-deploy-the-application)):
  `KEEPER_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
  `TREASURY_SECRET_KEY` (the launch API needs it), `PUBLIC_BASE_URL`. Build env (baked, not secrets):
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
- [ ] **Keeper secrets set** ([§3a](#3a-required-secrets)): `KEEPER_SECRET` (must match the Worker),
  `PERPAD_BASE_URL`, `SOLANA_RPC_URL`, `TREASURY_SOLANA_PRIVATE_KEY` (**same wallet** as `TREASURY_SECRET_KEY`).
- [ ] **Treasury wallet funded with SOL** — admin launch pays rent + dev-buy from it; the keeper opens positions from it.

### Deploy
- [ ] **Deploy BOTH the app ([§2](#2-deploy-the-application)) and the keeper ([§3](#3-deploy-the-keeper)).**
  Public launches only flip `launching → live` via the keeper's reconcile tick — a Worker-only deploy
  leaves launched tokens stuck in `launching`.

### Test
- [ ] **Devnet first (recommended)** — point `SOLANA_RPC_URL` at devnet, launch once, watch it reach
  `live` + render at `/token/<id>`, then switch to mainnet. The Meteora multi-sig build + 0.01 SOL fee
  instruction + reconcile path compiles + builds but is otherwise on-chain-unverified.
- [ ] **Launch the platform token** via `POST /api/v1/launch` (admin mode, `x-keeper-secret`;
  body `{ticker,name,underlying,leverage,direction,quote,devBuy}`, optional `leftoverTokens`). The
  **`quote`** field picks the pairing asset (`SOL` or `USDC`) ([§6](#6-api-endpoints-reference)).
- [ ] **View at `/token/<token-id>`** and confirm the keeper promotes + manages it.
- [ ] **Gate sanity** (pre-launch coming-soon): `/` = coming-soon, `/launch` → redirects to `/`,
  `/token/<id>` + `/api/*` live. Flip `COMING_SOON = false` in `src/lib/coming-soon.ts` to open the
  full app when ready.

### Known issues / optional
- `/token/<malformed-id>` (non-uuid) returns `500` instead of a clean not-found — real ids are fine.
- Cloudflare WAF rate-limit rule on `/api/v1/*` (optional edge throttle; the on-chain 0.01 SOL fee is the real gate).

---

## What This Fork Adds (Beyond the Original Refactor)

| Change | Specification | Env vars (all optional; defaults in `keeper/src/config.js`) |
|---|---|---|
| Proportional-incremental take-profit (skim `tpCloseFraction` each time floating PnL grows `tpTriggerRatio` × current collateral above the last lock-in; realized profit splits 75% buyback / 25% master) — **replaces the old backstop TP** | [plan/KEEPER_TP_REWRITE.md](plan/KEEPER_TP_REWRITE.md) | `TP_TRIGGER_RATIO`, `TP_CLOSE_FRACTION`, `TP_MASTER_SHARE_RATIO`, `TP_MIN_CLOSE_USD`, `TP_MIN_REALIZE_USD` |
| perpspad rebrand + hardcoded RPC key removed (`solanaConfig.ts` → env/proxy/public) | [plan/PERPSPAD_FORK_TECHNICAL.md](plan/PERPSPAD_FORK_TECHNICAL.md) | — |
| keeper-logs admin page via `x-keeper-secret` (keeper_logs stays non-public) | — | — |

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

## 0. Secrets & Credentials — How to Generate / Obtain Each

Set these as **Worker secrets** (`npx wrangler secret put NAME`) and/or **Fly secrets**
(`fly secrets set NAME=…`) per the table at the end. `VITE_*` vars are the exception — they're
**build-time** (baked into the browser bundle by `npm run build`), so they live in the build
environment (`.env` / CI), **not** `wrangler secret put`.

### Secrets you generate yourself

**`KEEPER_SECRET`** — the shared secret the Worker and keeper use to authenticate to each other
(and to gate admin launches). Any high-entropy random string; generate one with:
```bash
openssl rand -hex 32
# no openssl handy?
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Use the **same value** for the Worker's `KEEPER_SECRET` and the keeper's `KEEPER_SECRET`.

**`LAUNCH_CLAIM_SECRET`** *(optional)* — signs the public-launch claim tokens. If unset it falls
back to `KEEPER_SECRET`, so you only set it to rotate it independently. Generate the same way.

### Treasury / master wallet keypair

The master wallet that funds positions, signs admin launches, receives the 0.01 SOL launch fee, and
seeds every derived sub-wallet. **One wallet, two env-var names** (two runtimes):
- Worker → **`TREASURY_SECRET_KEY`** (the launch API reads this)
- Keeper → **`TREASURY_SOLANA_PRIVATE_KEY`**

Generate a fresh one (or reuse an existing wallet's key):
```bash
solana-keygen new --no-bip39-passphrase --outfile treasury.json
solana-keygen pubkey treasury.json   # the ADDRESS — fund it with SOL before launching/opening
cat treasury.json                    # the [64-int] array — valid as the secret value as-is
```
The value can be the JSON array (`[12,34,…]`) **or** a base58 string (e.g. Phantom → Settings →
Export Private Key). ⚠️ Rotating `TREASURY_SECRET_KEY` re-derives all sub-wallets and orphans every
existing token's signer — set it once and never rotate.

### Supabase keys (Supabase dashboard → your project)

- **`SUPABASE_URL`** / **`VITE_SUPABASE_URL`** — Project Settings → API → **Project URL**
  (`https://<project-ref>.supabase.co`).
- **`SUPABASE_PUBLISHABLE_KEY`** / **`VITE_SUPABASE_PUBLISHABLE_KEY`** — Project Settings → API Keys →
  the **publishable** key (`sb_publishable_…`; on older projects this is the **anon / public** key).
  Safe to expose in the browser.
- **`SUPABASE_SERVICE_ROLE_KEY`** — Project Settings → API Keys → the **secret / service_role** key
  (`sb_secret_…`). ⚠️ Full database access, **bypasses RLS** — server-only, never in the browser or
  git. If it ever leaks, rotate it on that same page.

### Solana RPC

- **`SOLANA_RPC_URL`** — a **mainnet** RPC endpoint from a provider (Helius, QuickNode, Triton,
  Alchemy): sign up → create a mainnet endpoint → copy the HTTPS URL (it embeds your key). Public
  RPCs work but rate-limit hard; don't use them in production.

### Launch API config (optional; sensible defaults)

- **`PUBLIC_BASE_URL`** — site origin baked into each token's on-chain metadata URI, e.g.
  `https://perpspad.fun`. Falls back to `PERPAD_BASE_URL` then `https://perpspad.fun`.
- **`PUBLIC_LAUNCH_FEE_SOL`** — public launch fee in SOL (default `0.01`).
- **`PERPAD_BASE_URL`** *(keeper)* — base URL the keeper calls back, `https://perpspad.fun`.

### Where each secret goes

| Secret | Worker | Keeper (Fly) | Build env (`VITE_*`) |
|---|:--:|:--:|:--:|
| `KEEPER_SECRET` (same value both sides) | ✅ | ✅ | |
| `SUPABASE_URL` | ✅ | | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | | |
| `SUPABASE_PUBLISHABLE_KEY` | ✅ | | |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | | | ✅ |
| Treasury key (`TREASURY_SECRET_KEY` Worker / `TREASURY_SOLANA_PRIVATE_KEY` keeper) | ✅ | ✅ | |
| `SOLANA_RPC_URL` | ✅ | ✅ | |
| `PUBLIC_BASE_URL` / `PUBLIC_LAUNCH_FEE_SOL` | ✅ | | |
| `PERPAD_BASE_URL` | | ✅ | |
| `LAUNCH_CLAIM_SECRET` (optional) | ✅ | | |

---

## 1. Apply Migrations

This creates the database schema — tables, constraints, RLS policies — on the production Supabase
project by replaying every file in `supabase/migrations/` in order. Do it **first**: both the app and
the keeper read/write these tables.

`<PROD_PROJECT_REF>` is your production Supabase **project ref**, a ~20-char ID. Find it in the
dashboard URL (`https://supabase.com/dashboard/project/<ref>`), under **Project Settings → General →
Reference ID**, or via `bunx supabase projects list`. `link` only needs to run once per machine — it
points the CLI at prod; `db push` then applies any migrations the remote doesn't have yet.

```bash
bunx supabase link --project-ref <PROD_PROJECT_REF>   # one-time: point the CLI at the prod project
bunx supabase db push                                  # replay pending migrations onto prod
```

Key migrations:
- `20260528140414_keeper_workflows.sql` — `token_workflows`, `keeper_actions`, widens `tx_log` CHECK, RLS read policies.
- `20260529120000_token_invariants.sql` — `imperial_profile_index` DEFAULT 1 → NOT NULL.
- `20260529160000_token_wallet_not_null.sql` — `treasury_wallet_address` NOT NULL (clean on an empty DB).
- `20260529170000_keeper_logs.sql` — durable per-token log table with index.

Verify the tables exist (a count of `0` is fine — it just proves the table is there). The
`<DB_HOST>/<DB_PORT>/<DB_USER>/<DB_NAME>` come from the dashboard → **Project Settings → Database →
Connection string**:
```bash
PSQL="psql -h <DB_HOST> -p <DB_PORT> -U <DB_USER> -d <DB_NAME> -t -A -c"
$PSQL "select count(*) from public.token_workflows;"
$PSQL "select count(*) from public.keeper_actions;"
$PSQL "select count(*) from public.keeper_logs;"
```

---

## 2. Deploy the Application

The app is the web frontend + the `/api/*` routes (including the Launch API), bundled and run as a
**Cloudflare Worker** (entry `src/server.ts`, see `wrangler.jsonc`). `wrangler deploy` uploads the
built bundle to **your Cloudflare account**, where Cloudflare runs it across its global edge — it's
not a server you host. Secrets are stored encrypted on the Worker (never baked into the bundle).

### 2a. First-time Cloudflare setup (once per account)

1. **Create a Cloudflare account** (free) at cloudflare.com.
2. **Authenticate wrangler to it:**
   ```bash
   npx wrangler login          # opens a browser to authorize (local dev)
   # CI/headless instead: export CLOUDFLARE_API_TOKEN=... (+ CLOUDFLARE_ACCOUNT_ID=...)
   ```
   `wrangler deploy` ships to whichever account you're authenticated as.
3. **Name the Worker** — in `wrangler.jsonc`, set `"name": "perpspad"` (it's the deploy identity +
   the default `*.workers.dev` subdomain; the template ships as `tanstack-start-app`).

### 2b. Build + deploy

```bash
npm ci            # clean install from the committed lockfile
npm run build     # build the client + Worker bundle (must be GREEN — see the checklist)
npx wrangler deploy
```

With no custom domain configured this goes live at
`https://perpspad.<your-subdomain>.workers.dev` (you choose `<your-subdomain>` once in the dashboard).

> ⚠️ **Worker size limit.** This is a heavy app (Solana + Meteora SDKs). Cloudflare **Free** caps a
> Worker at **1 MB gzipped**; **Workers Paid** ($5/mo) raises it to **10 MB**. If `wrangler deploy`
> fails with a script-size error, that's the cause — upgrade to Workers Paid, it's not a code bug.

### 2c. Serve at `perpspad.fun`

The `*.workers.dev` URL works immediately. To use the real domain:
1. **Add `perpspad.fun` to Cloudflare** (Dashboard → Add a site) and **point your registrar's
   nameservers** to the two NS records Cloudflare gives you. This makes Cloudflare manage the domain (a "zone").
2. **Bind the Worker to the domain** — Worker → **Settings → Domains & Routes → Add → Custom Domain →
   `perpspad.fun`**. Cloudflare auto-provisions SSL + the DNS record. (The optional WAF rate-limit
   rule on `/api/v1/*` from the checklist also lives on this zone.)

### 2d. Worker secrets

Set Worker secrets (see §0 for how to obtain each; skip values already in `npx wrangler secret list`):

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put KEEPER_SECRET          # MUST match the keeper's KEEPER_SECRET
npx wrangler secret put TREASURY_SECRET_KEY    # master wallet; the launch API signs + reads the fee recipient from it
npx wrangler secret put PUBLIC_BASE_URL        # e.g. https://perpspad.fun (baked into launch metadata URIs)
# Optional: LAUNCH_CLAIM_SECRET (defaults to KEEPER_SECRET), PUBLIC_LAUNCH_FEE_SOL (default 0.01)
# VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are BUILD-TIME (set before `npm run build`), not secrets.
```

Verify the application is reachable:

```bash
curl -sI https://perpspad.fun/ | head -1
# expect: HTTP/2 200
```

---

## 3. Deploy the Keeper

The keeper is the always-on bot (hosted on Fly.io) that opens, manages, and closes the hedge
positions backing each launched token, and runs the launch reconciler. It needs the treasury signer,
a mainnet RPC, and the **same** `KEEPER_SECRET` as the Worker so the two can authenticate to each
other.

### 3a. Required Secrets

```bash
cd keeper
fly secrets set \
  KEEPER_SECRET="<must match app>" \
  PERPAD_BASE_URL="https://perpspad.fun" \
  SOLANA_RPC_URL="<mainnet rpc>" \
  TREASURY_SOLANA_PRIVATE_KEY="<treasury signer>" \
  KEEPER_MINT_ALLOWLIST="<optional>" \
  --app perpspad-keeper
```

> The env var is still named **`PERPAD_BASE_URL`** (only the value changed to `https://perpspad.fun`) — `config.js` reads `process.env.PERPAD_BASE_URL`.
> **`IMPERIAL_API_KEY` is NOT required** — the keeper does its own Solana-signature → JWT handshake per sub-wallet (`imperial.js:authenticate`, `/mobile/connect` + `/mobile/exchange`) and caches it. Set it only to pin a pre-issued, wallet-matched JWT.
> `TREASURY_SOLANA_PRIVATE_KEY` is the master key — must be funded with SOL before opens.

### 3b. Mechanism Knobs (optional — defaults live in `keeper/src/config.js`)

Proportional-incremental TP ([plan/KEEPER_TP_REWRITE.md](plan/KEEPER_TP_REWRITE.md)) and Phoenix
lock ([plan/KEEPER_PHOENIX_LOCK.md](plan/KEEPER_PHOENIX_LOCK.md)). All have safe defaults — set
only to override:

```bash
fly secrets set \
  TP_TRIGGER_RATIO=0.25 \
  TP_CLOSE_FRACTION=0.20 \
  TP_MASTER_SHARE_RATIO=0.25 \
  IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix \
  --app perpspad-keeper
```

| Variable | Default | Effect |
|---|---|---|
| `TP_TRIGGER_RATIO` | `0.25` | Fire TP each time floating PnL grows by this × **current** collateral above the last lock-in. |
| `TP_CLOSE_FRACTION` | `0.20` | Fraction of the position closed per fire (size + collateral scale together → nominal leverage preserved). |
| `TP_MASTER_SHARE_RATIO` | `0.25` | Master-treasury share of realized profit; the rest (75%) → buyback reserve. |
| `TP_MIN_CLOSE_USD` / `TP_MIN_REALIZE_USD` | `5` / `1` | Floors below which a TP won't fire. |
| `IMPERIAL_SUPPORTED_OPEN_VENUES` | `phoenix` | Comma-separated venues allowed for opens. |

TP only **skims profit** (never withdraws principal), so there's no kill-switch to ship inert —
the defaults are the intended live behavior.

### 3c. Optional and Rollback Knobs

Pre-existing tunables (safe defaults; set only to override):
- `STATE_RECONCILE_ENABLED` (default `true`)
- `COLD_PROBE_INTERVAL_MS`
- `ENTRY_CAPTURE_WINDOW_MS`
- `WORKFLOW_TOKEN_RECENT_MS`

Rollback knobs:

```bash
# Re-enable multi-venue dispatch:
fly secrets set IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix --app perpspad-keeper

# Restore the per-symbol SUPPORTED_MARKETS lookup:
fly secrets set IMPERIAL_VENUE_OVERRIDE=auto --app perpspad-keeper
```

| Variable | Default | Effect |
|---|---|---|
| `IMPERIAL_VENUE_OVERRIDE` | unset | `auto` restores the original `SUPPORTED_MARKETS`-based venue resolution. Any other venue name forces that venue. |

> Secret names are derived from [keeper/src/config.js](keeper/src/config.js) and
> [src/integrations/supabase/client.server.ts](src/integrations/supabase/client.server.ts). Reconcile
> against `fly secrets list` and `wrangler secret list` rather than treating this list as exhaustive.

### 3d. Ship

```bash
fly deploy --app perpspad-keeper
```

Verify the keeper is running:

```bash
fly status --app perpspad-keeper
fly logs --app perpspad-keeper | head -50
```

---

## 4. Post-deploy Smoke

Confirm the application is reachable and the keeper is ticking:

```bash
S=<PROD_KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/workflows?limit=3" | head
fly logs --app perpspad-keeper        # expect structured tick_summary lines; keeper_logs row count climbing
```

### 4a. Phoenix Lock Verification

```bash
# Any "skip: venue=... not in SUPPORTED_OPEN_VENUES" lines indicate /route picked a non-Phoenix
# venue and the keeper declined. Small count = healthy. Constant stream = /route cannot find a
# Phoenix candidate for the asset; investigate (reference plan/KEEPER_PHOENIX_LOCK.md §3).
fly logs --app perpspad-keeper | grep "imperial:open.*skip.*not in SUPPORTED_OPEN_VENUES" | tail

# First open per profile invokes /phoenix/register exactly once (idempotent and cached).
fly logs --app perpspad-keeper | grep "imperial:phoenix-register" | tail
```

A successful Phoenix open produces the following sequence per token:
```
[imperial:phoenix-register] wallet=... profile=...      # only on cold cache
imperial:open <symbol> ... success=true
```

### 4b. Take-profit Verification

```bash
# Fires only once a live position's floating PnL grows >= TP_TRIGGER_RATIO x current collateral
# above the last lock-in. Each fire logs realized USD, applied fraction, and the trigger.
fly logs --app perpspad-keeper | grep '"tp fired"' | tail
# The 75/25 split then routes: 75% -> buyback reserve, 25% (swapped to SOL) -> master treasury.
fly logs --app perpspad-keeper | grep -E "tp split|tp profit split" | tail
```

This is **not yet validated against a live position** ([plan/KEEPER_TP_REWRITE.md](plan/KEEPER_TP_REWRITE.md)):
the unit tests are green but the venue-crossing path is unproven. Watch the first real position that
crosses the threshold and confirm the partial-close lands, size/collateral scale proportionally, the
split routes, and it does **not** re-fire next tick (high-water gate).

### 4c. Per-venue marketPrice Scaling Sanity

Each Phoenix `/mobile/orders` body must carry `marketPrice ≈ uiPrice × 1e6` (1e9 oracle scale divided
by 1000; the downstream order bot multiplies by ×1000 on the wire).

```bash
# Sample several /mobile/orders requests; confirm marketPrice is in the 1e6 range
# (10–500 million for assets priced $10–$500), NOT 1e9.
fly logs --app perpspad-keeper | grep "POST /mobile/orders" | tail
```

---

## 5. Rollback

| Layer | Command |
|---|---|
| Application | `npx wrangler deployments list` then `npx wrangler rollback [<id>]` |
| Keeper | `fly releases --app perpspad-keeper` then `fly deploy --image <previous>` (or `fly releases rollback`) |
| Take-profit | Tune via `TP_TRIGGER_RATIO` / `TP_CLOSE_FRACTION` (no kill-switch — TP only skims profit). Raise `TP_TRIGGER_RATIO` to make it fire less often. |
| Phoenix lock | `fly secrets set IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix,flash_trade,jupiter --app perpspad-keeper` |
| Venue resolution | `fly secrets set IMPERIAL_VENUE_OVERRIDE=auto --app perpspad-keeper` |
| Migrations | Additive tables are forward-safe; retain them. The two NOT NULL constraints require manual reversal: `ALTER TABLE public.tokens ALTER COLUMN <col> DROP NOT NULL` |

---

## 6. API Endpoints Reference

Base URL: `https://perpspad.fun`.
Authentication: every `keeper` and `admin` endpoint requires `x-keeper-secret: <PROD_KEEPER_SECRET>`
(matches the Worker and the keeper). `/api/public/solana/rpc` is the only endpoint without a secret
requirement.

### GET Endpoints

```
GET  https://perpspad.fun/api/public/keeper/tokens
GET  https://perpspad.fun/api/public/keeper/workflows
GET  https://perpspad.fun/api/public/keeper/workflows?limit=50
GET  https://perpspad.fun/api/public/keeper/workflows?token_id=<uuid>
GET  https://perpspad.fun/api/public/keeper/stuck-tokens
GET  https://perpspad.fun/api/public/keeper/external-routers
GET  https://perpspad.fun/api/public/keeper/logs
GET  https://perpspad.fun/api/public/keeper/logs?token_id=<uuid>
GET  https://perpspad.fun/api/public/keeper/logs?level=error&limit=100
GET  https://perpspad.fun/api/public/keeper/logs?token_id=<uuid>&before=<iso-cursor>
```

### POST Endpoints (JSON body required)

```
POST https://perpspad.fun/api/public/keeper/report                 body: {token_id, router, ...}
POST https://perpspad.fun/api/public/keeper/workflow-report        body: {workflows:[], actions:[], logs:[]}
POST https://perpspad.fun/api/public/keeper/workflow-locks         body: {token_ids:[], owner, stale_after_seconds}
POST https://perpspad.fun/api/public/keeper/external-sweep-report  body: {token_id, sweeps:[]}
POST https://perpspad.fun/api/public/keeper/external-router-seen   body: {token_ids:[]}
POST https://perpspad.fun/api/public/solana/rpc                    body: JSON-RPC request (NO secret)
```

### Launch API (see plan/PERPSPAD_LAUNCH.md)

```
# ONE launch route. Mode chosen by the x-keeper-secret header (absent = public, present = admin).
# Public is KEYLESS + permissionless; the 0.01 SOL on-chain fee is the rate-limit.
GET  https://perpspad.fun/api/v1/markets                  launchable markets + leverage caps
POST https://perpspad.fun/api/v1/launch                   public: unsigned config+pool txs | admin: executes
GET  https://perpspad.fun/api/v1/launch/<tokenId>         launch status (launching → live)
GET  https://perpspad.fun/api/v1/launch/<tokenId>/metadata token metadata JSON (on-chain uri target)
GET  https://perpspad.fun/api/v1/openapi                  OpenAPI 3.1 spec
GET  https://perpspad.fun/api/docs                        Scalar API reference (browser)
POST https://perpspad.fun/api/admin/reconcile-launches    (x-keeper-secret) keeper calls each tick

# Public flow: build → caller signs+sends both txs (pays rent + dev-buy + 0.01 SOL fee). A transient
# `launching` row is recorded; the keeper reconciler promotes it to `live` once the pool is on-chain,
# or deletes it past TTL. No client callback. Atomic: a row means a real launch, else it's removed.
# Admin: same route + x-keeper-secret → treasury-signed, recorded only on success; ?dryRun=1 previews.
# CLI: KEEPER_SECRET=… node scripts/admin-launch.mjs --ticker=… --leftover=… [--commit]
# Env: PUBLIC_BASE_URL (metadata uri), PUBLIC_LAUNCH_FEE_SOL (default 0.01). Optional WAF on /api/v1/*.
```

### Ready-to-execute curl commands

```bash
S=<PROD_KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" https://perpspad.fun/api/public/keeper/tokens
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/workflows?limit=10"
curl -s -H "x-keeper-secret: $S" https://perpspad.fun/api/public/keeper/stuck-tokens
curl -s -H "x-keeper-secret: $S" https://perpspad.fun/api/public/keeper/external-routers
```

### Per-token Log Triage

`GET /api/public/keeper/logs` reads `keeper_logs` directly: log rows only, supports `token_id`,
`level`, `event`, `limit`, and `before` filters, and returns global `token_id IS NULL` rows that the
`/workflows` `recent_logs` field cannot return.

```bash
S=<PROD_KEEPER_SECRET>

# 1) Discover token_ids (ticker → id):
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/workflows?limit=20" \
  | python3 -c "import sys,json; [print((w.get('tokens') or {}).get('ticker'), w['token_id']) for w in json.load(sys.stdin)['workflows']]"

# 2) Triage by level — identify token_ids with errors / warns:
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/logs?level=error&limit=200" \
  | python3 -c "import sys,json,collections
rows=json.load(sys.stdin)['logs']
c=collections.Counter(r.get('token_id') for r in rows)
print('errors:',c.most_common(10))"

curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/logs?level=warn&limit=200" \
  | python3 -c "import sys,json,collections
rows=json.load(sys.stdin)['logs']
c=collections.Counter(r.get('token_id') for r in rows)
print('warns:',c.most_common(10))"

# 3) Per-token timeline for an id from step 1 or 2:
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/logs?token_id=<uuid>"

# 4) All logs, including global (token_id=NULL) rows:
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/logs?limit=200"

# 5) Page older (cursor): use next_before from a response as ?before= (URL-safe Z form):
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/logs?token_id=<uuid>&before=<next_before>"
```
