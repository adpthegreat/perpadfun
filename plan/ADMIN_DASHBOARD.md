# Unified admin dashboard (`/admin`)

One secret-gated page that gives a whole-app overview — system health, token activity, keeper logs,
workflow states, economics, and onboarding — with drill-down links to the existing detail pages
(`/stats`, `/admin/keeper-logs`, `/admin/logs`, `/token/$id`). It's a **cockpit**, not a replacement:
it surfaces the top-line numbers + anything wrong, and links out for depth.

## What already exists (reuse, don't rebuild)
- **Auth pattern:** admin pages take the `x-keeper-secret` via a password input stored in
  `localStorage`, sent as the `x-keeper-secret` header. (`admin.keeper-logs.tsx` / `admin.logs.tsx`.)
- **Keeper API (all secret-gated):** `/api/public/keeper/{tokens, logs, workflows, stuck-tokens,
  external-routers}`.
- **Stats aggregation:** `src/lib/stats.functions.ts` `getStats` → distributions, leaderboards,
  launches, fees/day (public; powers `/stats`).
- **Detail pages:** `/stats`, `/admin/keeper-logs(_/$tokenId)`, `/admin/logs(_/$tokenId)`, `/token/$id`.
- **Collab:** `getCollabStatus` (code counts) + the `collab_signups` funnel.

## Sections (top → bottom)
1. **Health strip** — keeper alive? (age of the newest `last_tick_at`), # active tokens, # stuck
   (from `stuck-tokens`), # warn/error logs in the last hour (from `logs?level=warn`), burn-sweep on.
   Red/green dots so a glance tells you if the keeper is ticking.
2. **Token activity table** — every managed token from `/keeper/tokens`: ticker, workflow state,
   `underlying/lev/dir`, position size / collateral / treasury PnL, fees accrued, buyback reserve,
   tokens burned, last-tick age. Sortable; each row links to `/token/$id` + `/admin/keeper-logs_/$tokenId`.
3. **Workflow states** — count per `token_workflows.state` (idle / split_reserved / position_open /
   topup_pending / blocked / …) + the stuck list with `blocked_reason`.
4. **Recent keeper logs** — last ~25 `warn`/`error` rows (message + token + age), link to
   `/admin/keeper-logs`.
5. **Economics** — totals summed over `/keeper/tokens` (Σ fees accrued, Σ buyback reserve, Σ tokens
   burned, Σ treasury PnL) + the `getStats` fees/day + launches/buyback mini-charts. Link to `/stats`.
6. **Onboarding funnel** — from a new gated endpoint: signups total / wallet_verified / x_followed /
   tg_joined / claimed / waitlisted, plus codes remaining (`collab_codes`). Per-day sparkline optional.
7. **Quick links** — `/stats`, `/admin/keeper-logs`, `/admin/logs`.

## Data sources
| Section | Source | New? |
|---|---|---|
| Health, token table, workflow states, economics totals | `GET /api/public/keeper/tokens` (one call — has state, positions, fees, reserves, burns) | reuse |
| Stuck list | `GET /api/public/keeper/stuck-tokens` | reuse |
| Recent logs | `GET /api/public/keeper/logs?level=warn&limit=25` | reuse |
| Distributions / fees-day / launches charts | `getStats` (public) | reuse |
| Onboarding funnel + codes | **NEW** `GET /api/public/keeper/overview` (secret-gated) — returns the `collab_signups` funnel counts + `collab_codes` remaining | new (small) |

One new endpoint keeps the collab counts server-side (service role) and secret-gated, consistent with
the other admin data. Everything else is already available.

## Auth
Reuse the exact `x-keeper-secret` + `localStorage` pattern (same storage key as the existing admin
pages, so it's entered once and shared). All fetches send the header; the new `/overview` endpoint
validates `x-keeper-secret === KEEPER_SECRET` like the others. `getStats` stays public (already is).

## Files
- **NEW** `src/routes/admin.tsx` → `/admin` (the dashboard; sections above).
- **NEW** `src/routes/api/public/keeper/overview.ts` → the gated onboarding-funnel + code counts.
- **NEW (optional)** `src/hooks/useKeeperSecret.ts` — extract the localStorage-secret + gated-fetch
  helper so the dashboard and the existing admin pages share it (refactor later; inline for v1).
- **EDIT** `src/lib/coming-soon.ts` → allowlist `/admin` (the `startsWith("/admin/keeper-logs")` rule
  doesn't cover bare `/admin`).

## Layout / craft
- Responsive card grid (like `/stats` `Panel`s). Reuse the stats page's `Panel` visual language for
  consistency. Health strip full-width at top; token table full-width; the rest in a 2-col grid.
- Everything client-fetched with the secret; a single "enter x-keeper-secret" gate covers the page.
- Auto-refresh the health strip + logs (React Query `refetchInterval` ~15s); heavier queries manual.

## Build order
1. `coming-soon.ts` allowlist `/admin`.
2. `overview.ts` endpoint (collab funnel + codes, gated).
3. `admin.tsx` — secret gate + the sections, reusing the keeper endpoints + `getStats`.
4. `npm run build` + `tsc` clean.

## Non-goals (v1)
- No keeper-service `/status` (it's on the Fly host, cross-origin) — infer health from `last_tick_at`.
- No write actions (force-open, pause, etc.) — read-only cockpit. Add later behind confirmations.
