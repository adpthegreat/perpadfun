# Landing Quest Funnel — Phase 0 (relaunch GTM §3)

Pre-launch acquisition funnel: re-aggregate prior $PERPAD holders + capture new wallets
before the token is live. Four quest steps:

1. **Follow @perpspad on X** — *honorary* (click → opens X → on return, ~1s spinner → done)
2. **Retweet the pinned post** — *honorary* (same pattern)
3. **Join Telegram** — *real* server-side verification via the bot + `getChatMember`
4. **Submit SOL address** — wallet bind + prior-holder detection

## Scope of this PR (where we stop)
Steps 1–3 end-to-end, **through the server-side Telegram check**. Step 4 (SOL submit),
referral UI, live counters, and sybil hardening are designed below and tasked, but built
in the next pass. "Honorary" = recorded with a server timestamp, no real X verification
(X follow/RT cannot be verified without paid X API + OAuth; deferred by design).

## Architecture
Session-anchored. On page load the server issues a `session_id` (stored in `localStorage`);
every step is recorded against it; the wallet (step 4) binds last. Frontend talks to plain
`/api/public/quest/*` routes (createFileRoute server handlers) via react-query + fetch —
matching the keeper API style, not the `useServerFn` data path.

### Data model — `quest_entries` (one row per participant)
| column | type | note |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| session_id | uuid UNIQUE | server-issued anchor, returned to client |
| sol_address | text | nullable until step 4; validated app-side (PublicKey) |
| telegram_user_id | bigint | **UNIQUE** (one claim per TG identity); null until bind |
| telegram_username | text | |
| x_followed / x_retweeted | boolean | honorary flags + `*_at` timestamps |
| tg_joined | boolean | set true only by getChatMember success |
| tg_verified_at | timestamptz | last membership check |
| referral_code | text UNIQUE | this entrant's own shareable code |
| referred_by | text | referrer's referral_code (nullable, not self) |
| ip_hash / user_agent | text | sybil signal (nullable) |
| status | text | pending \| completed \| claimed \| disqualified |
| created_at / updated_at | timestamptz | `touch_updated_at()` trigger |

RLS **enabled, no policies** → direct client access denied; all reads/writes go through the
service-role server (bypasses RLS). Aggregate counters will be a server endpoint, not a
client read. Types hand-added to `integrations/supabase/types.ts` (regen from live DB after
the migration applies there).

### Endpoints (`src/routes/api/public/quest/`)
- `POST session.ts` — `{ session_id?, ref? }` → create-or-resume; issue `referral_code`; bind
  `referred_by` from a valid `ref`; return `{ session_id, referral_code, steps }`. IP rate-limited.
- `POST step.ts` — `{ session_id, step: 'x_follow'|'x_retweet' }` → set honorary flag + timestamp.
- `POST telegram/webhook.ts` — Telegram updates; guarded by `X-Telegram-Bot-Api-Secret-Token`.
  On `/start <session_id>`: bind `telegram_user_id`/username to the session, reply with a
  "Join the channel" button.
- `GET telegram/status.ts` — `?session_id` → if bound, call `getChatMember(channel, user_id)`;
  on member status persist `tg_joined`; return `{ bound, joined }`. Frontend polls this.

### Frontend (`src/routes/quest.tsx` + `src/lib/quest/`)
Page shell modeled on `/launch` (`min-h-screen bg-background`, `<Header/>`, centered card,
`font-display` title, `border border-border bg-card`). One `QuestStep` row component with
states: `idle → opening → verifying(spinner ~1s) → done(check)`. lucide icons, sonner toasts.
- X steps: `window.open(intent_url)`; on window refocus → 1s spinner → `POST step` → check.
- TG step: `window.open(t.me/<bot>?start=<session_id>)`; poll `telegram/status` until joined.

### Env / config
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_WEBHOOK_SECRET` (server);
`VITE_PERPSPAD_X_HANDLE`, `VITE_PERPSPAD_X_TWEET_ID`, `VITE_TELEGRAM_BOT_USERNAME` (client).
Webhook registered once via Telegram `setWebhook` (command documented in the route file).

### Sybil posture (full gates = next pass)
TG membership is the *weakest* signal (free accounts; TG exposes no account-age via Bot API).
Load-bearing gates are wallet-side (age, prior on-chain activity) + `UNIQUE(telegram_user_id)`
+ per-IP rate limit + **re-check TG membership at claim time** (join→quest→leave farm).

## Task list
- [x] Map ADP conventions (routes, UI, supabase)
- [x] This design doc
- [ ] Migration: `quest_entries` + RLS + trigger; verify it applies
- [ ] `POST /quest/session` (create/resume + referral binding)
- [ ] `POST /quest/step` (honorary X follow/retweet)
- [ ] `POST /quest/telegram/webhook` (bind via /start)
- [ ] `GET /quest/telegram/status` (getChatMember)  ← **server-side TG check (stop point)**
- [ ] Frontend `/quest` shell + steps; honorary 1s-spinner pattern; TG poll  ← stop point
- [ ] Verify: typecheck + build + migration apply + TG logic smoke
- [ ] **[next]** Step 4 SOL submit (wallet/paste + base58 + prior-holder detection)
- [ ] **[next]** Referral link/copy, live wallets-joined counter, prior-holder allocation preview
- [ ] **[next]** Sybil hardening (per-IP caps, claim-time re-verify, unclaimed-reserve rule)

## Deploy & verify (for the live instance)

This migration only **adds** a table (`CREATE TABLE IF NOT EXISTS` + indexes + RLS + trigger);
it does not touch existing `tokens` rows, so it is safe to apply to the live, populated
Supabase (unlike `token_wallet_not_null`).

1. Apply the migration to live Supabase; confirm `public.quest_entries` exists.
2. (optional) Regenerate `integrations/supabase/types.ts` from the live DB to supersede the
   hand-added `quest_entries` block.
3. @BotFather → create the bot, get `TELEGRAM_BOT_TOKEN`, set `VITE_TELEGRAM_BOT_USERNAME`.
4. **Add the bot as an admin of the channel** — required for getChatMember to resolve users.
5. Set env and redeploy:
   - server: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` (e.g. `@perpspad` or `-100…`),
     `TELEGRAM_CHANNEL_URL`, `TELEGRAM_WEBHOOK_SECRET` (`SUPABASE_URL`/`SERVICE_ROLE_KEY` already set).
   - client (build-time): `VITE_PERPSPAD_X_HANDLE`, `VITE_PERPSPAD_X_TWEET_ID`,
     `VITE_TELEGRAM_BOT_USERNAME`, `VITE_TELEGRAM_CHANNEL_URL`.
6. Register the webhook:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=https://<host>/api/public/quest/telegram/webhook -d secret_token=<TELEGRAM_WEBHOOK_SECRET>`
7. E2E: open `/quest` → honorary X steps (spinner→done) → Join Telegram → bot `/start` binds →
   join channel → page poll flips to verified. Confirm the `quest_entries` row in Supabase.

**Verified locally:** vite build, `tsc --noEmit`, migration applies on local Postgres (full
chain + behavioral smoke of the trigger and the unique-telegram-id gate), routing/validation/
error-envelope via curl, and 11 vitest tests — getChatMember status mapping + referral codes,
plus a jsdom + Testing Library test of the honorary step (open → return → 1s spinner → done,
with a regression case that re-renders mid-spinner). Full suite 100 passed / 40 skipped (DB-bound).
**Needs the live stack:** the getChatMember round-trip against a real bot+channel, and an
end-to-end browser pass against the deployed Supabase (local Supabase stack was Docker-blocked).
