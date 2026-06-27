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
`SOLANA_RPC_URL` (mainnet RPC provider).

Where each goes:
- **Worker:** `KEEPER_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `TREASURY_SECRET_KEY`, `PUBLIC_BASE_URL` [, `LAUNCH_CLAIM_SECRET`, `PUBLIC_LAUNCH_FEE_SOL`]
- **Build env:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- **Keeper:** `KEEPER_SECRET`, `PERPAD_BASE_URL`, `SOLANA_RPC_URL`, `TREASURY_SOLANA_PRIVATE_KEY` [, `KEEPER_MINT_ALLOWLIST`]

---

## 1. Migrations

```bash
bunx supabase login
bunx supabase link --project-ref <PROD_PROJECT_REF>
bunx supabase db push
```

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
```

Custom domain: Cloudflare → Add site `perpspad.fun` → point registrar nameservers → Worker → Settings
→ Domains & Routes → Custom Domain → `perpspad.fun`.

---

## 3. Deploy keeper (Fly)

```bash
cd keeper
fly secrets set \
  KEEPER_SECRET="<match app>" \
  PERPAD_BASE_URL="https://perpspad.fun" \
  SOLANA_RPC_URL="<mainnet rpc>" \
  TREASURY_SOLANA_PRIVATE_KEY="<treasury>" \
  --app perpspad-keeper
fly deploy --app perpspad-keeper
```

Optional TP knobs: `TP_TRIGGER_RATIO=0.25 TP_CLOSE_FRACTION=0.20 TP_MASTER_SHARE_RATIO=0.25 IMPERIAL_SUPPORTED_OPEN_VENUES=phoenix`.

---

## 4. Smoke

```bash
curl -sI https://perpspad.fun/ | head -1
S=<KEEPER_SECRET>
curl -s -H "x-keeper-secret: $S" "https://perpspad.fun/api/public/keeper/workflows?limit=3" | head
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
