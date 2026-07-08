# Mainnet Deploy — perpspad

Bare runbook. For the *why*, gotchas, and first-time setup, see
**[MAINNET_DEPLOY_DETAILED.md](MAINNET_DEPLOY_DETAILED.md)**.

Stack: Supabase migrations → Cloudflare Worker (app) → Fly.io keeper (`perpspad-keeper`).

---

## 0. Secrets

Generate:
```bash
openssl rand -hex 32                                              # KEEPER_SECRET (same on Worker + keeper)
solana-keygen new --no-bip39-passphrase --outfile treasury.json  # treasury wallet; fund the pubkey with SOL
```

Obtain: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase dashboard);
`SOLANA_RPC_URL` (mainnet RPC provider). For the collab onboarding (`/onboarding`):
`TELEGRAM_BOT_TOKEN` + the bot username from **@BotFather** — and in @BotFather run **`/setdomain`
→ `perpspad.xyz`** (the Telegram Login Widget is rejected otherwise); `TELEGRAM_CHAT_ID` = your
channel/group (`@handle` or numeric id) with **the bot added as an ADMIN**.

Where each goes:
- **Worker:** `KEEPER_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `TREASURY_SECRET_KEY`, `PUBLIC_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` [, `LAUNCH_CLAIM_SECRET`, `PUBLIC_LAUNCH_FEE_SOL`]
- **Build env:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_TELEGRAM_BOT_USERNAME`
- **Keeper:** `KEEPER_SECRET`, `PERPAD_BASE_URL`, `SOLANA_RPC_URL`, `TREASURY_SOLANA_PRIVATE_KEY` [, `KEEPER_MINT_ALLOWLIST`]

---

## 1. Migrations

```bash
bunx supabase login
bunx supabase link --project-ref <PROD_PROJECT_REF>
bunx supabase db push
```

> Applies all pending migrations, including `20260629120000_collab_onboarding.sql`, which
> **auto-seeds 1,000 invite codes** (idempotent — only seeds when the pool is empty). Verify:
> `select count(*) from collab_codes;` → `1000`, and `... where assigned` → `0`.

---

## 2. Deploy app (Cloudflare Worker)

```bash
npx wrangler login
# set "name": "perpspad" in wrangler.jsonc
npm ci
npm run build
npx wrangler deploy

npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put KEEPER_SECRET
npx wrangler secret put TREASURY_SECRET_KEY
npx wrangler secret put PUBLIC_BASE_URL
npx wrangler secret put TELEGRAM_BOT_TOKEN     # collab onboarding (/onboarding)
npx wrangler secret put TELEGRAM_CHAT_ID       # channel/group; bot must be an admin
```

> **⚠️ `VITE_*` are build-time, NOT Worker secrets.** Vite find-and-replaces `import.meta.env.VITE_X`
> with its literal value during `npm run build` and bakes the result into the **client bundle** (so
> they're public — fine for a bot username / Supabase URL). Two consequences:
> 1. Set `VITE_TELEGRAM_BOT_USERNAME` (and the other `VITE_*`) in the build environment (`.env` / CI)
>    **before** `npm run build`. If it's missing at build time the bundle ships `undefined`, and no
>    later `wrangler secret`/dashboard change fixes it **without a rebuild**.
> 2. `wrangler secret put VITE_…` does nothing — the browser never reads Worker secrets at runtime.
>
> Worker secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SUPABASE_SERVICE_ROLE_KEY`, …) are the
> opposite: read at runtime on the server via `process.env`, never in the bundle.
> Also: @BotFather `/setdomain → perpspad.xyz`, or the Login Widget won't load.

Custom domain: Cloudflare → Add site `perpspad.xyz` → point registrar nameservers → Worker → Settings
→ Domains & Routes → Custom Domain → `perpspad.xyz`.

---

## 3. Deploy keeper (Fly)

```bash
cd keeper
fly secrets set \
  KEEPER_SECRET="<match app>" \
  PERPAD_BASE_URL="https://perpspad.xyz" \
  SOLANA_RPC_URL="<mainnet rpc>" \
  TREASURY_SOLANA_PRIVATE_KEY="<treasury>" \
  --app perpspad-keeper
fly deploy --app perpspad-keeper
```

Optional TP knobs: `TP_TRIGGER_RATIO=0.25 TP_CLOSE_FRACTION=0.20 TP_MASTER_SHARE_RATIO=0.25 IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix`.

---

## 4. Smoke

```bash
curl -sI https://perpspad.xyz/ | head -1
S=<KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" "https://perpspad.xyz/api/public/keeper/workflows?limit=3" | head
fly logs --app perpspad-keeper | head -50
```

---

## 5. Rollback

```bash
npx wrangler deployments list && npx wrangler rollback [<id>]   # app
fly releases rollback --app perpspad-keeper                     # keeper
```

---

## 6. API endpoints

```
GET  /api/v1/markets
POST /api/v1/launch                       x-keeper-secret = admin mode; ?dryRun=1 = preview
GET  /api/v1/launch/<tokenId>
GET  /api/v1/launch/<tokenId>/metadata
GET  /api/v1/openapi      GET /api/docs
POST /api/admin/reconcile-launches        keeper, x-keeper-secret
# keeper GETs/POSTs under /api/public/keeper/* require x-keeper-secret
```
