# Remove legacy Jupiter Perps (keep multi-venue)

**Status:** PLAN ONLY — no code changed yet. Review before implementation.

## Goal
Remove the Jupiter Perps venue entirely (the keeper now trades exclusively through **Imperial → Phoenix**),
**while preserving a clean venue abstraction** so new venues can be added later without rewriting the loop.

## Why now
Imperial is live and opening positions. Jupiter is now dead weight and a footgun: the open path's
`else` branch still falls back to Jupiter, which is exactly what produced the `6015`
(`PERPETUALS_ERROR__INVALID_ARGUMENT`) when `IMPERIAL_ENABLED` was off. Removing it deletes the
fallback, the `jup-perps-client` dependency + its postinstall patch, and the dual-path complexity.

## Decisions — LOCKED (2026-06-29)
1. **Venue adapter:** Full adapter now. Introduce the venue-adapter interface, route the loop through
   it, Imperial as the sole implementation.
2. **`externalRouters.js` perp leg:** Migrate to Imperial (reuse `legImperialDeposit`/Imperial ops).
3. **`PERP_HEDGE_MODE` / `config.hedgeMode`:** Leave it completely as-is — keep the flag, keep the name,
   keep every check. It is the global `off|simulate|live` execution switch the Imperial path already
   depends on. See "hedgeMode" below.

## ⚠️ Out of scope — DO NOT touch
- **`keeper/src/swap.js`** — that's the Jupiter **Swap** API (SOL→USDC), a *different* product from
  Jupiter **Perps**. The Imperial deposit depends on it. Leave it completely alone.
- **`PERP_HEDGE_MODE` / `config.hedgeMode`** — not Jupiter-specific anymore; leave untouched (below).

## Inventory — everything Jupiter-Perps (file:line)

### The module
- **`keeper/src/jupiterPerps.js`** — delete the whole file. Exports:
  - perp ops: `openPosition` (602), `topUpCollateral` (611), `increasePosition` (621),
    `withdrawCollateral` (631), `partialClose` (640), `closePerp` (654)
  - reads: `readPerpPosition` (333), `getFreeCollateralUsd` (319), `getJupPerps` (293),
    `marketIndexFor` (310)
  - misc: `unwrapWsol` (669), internal `buildAndExecute`, `ensureUsdc`
  - constants: `JUPITER_SUPPORTED_SYMBOLS` (55), **`SUPPORTED_SYMBOLS` (62)** —
    ⚠️ `SUPPORTED_SYMBOLS` is imported by `imperialPerps.js:63`, so it must be **moved** to a neutral
    module (e.g. `constants.js` or `imperial-markets`), not deleted.

### Dependency + build
- `keeper/package.json` — dep `"jup-perps-client": "^1.2.0"` (17) + `postinstall` patch (7).
- `keeper/scripts/patch-jup-perps-client.mjs` — delete.

### Importers / call sites to replace
| File | What it pulls from jupiterPerps | Action |
|---|---|---|
| `loop.js` (22-32) | getJupPerps, getFreeCollateralUsd, openPosition, increasePosition, topUpCollateral, withdrawCollateral, partialClose, unwrapWsol, readPerpPosition, closePerp | replace each call w/ the venue adapter (Imperial impl); delete the Jupiter `else` branches |
| `externalRouters.js` (30-31 → 244,251) | openPosition, increasePosition | migrate the perp leg to Imperial (`legImperialDeposit` already exists at 284) |
| `stateReconcile.js` (22) | readPerpPosition | replace w/ `imperialReadPosition`/`readVerifiedImperialPosition` |
| `index.js` (4) | getJupPerps, getFreeCollateralUsd | startup health/log — drop or replace |
| `imperialPerps.js` (63) | `SUPPORTED_SYMBOLS` (constant only) | repoint to the moved constant |

### loop.js call sites (specifics)
- Open: Jupiter `else` branch at **1815** (Imperial branch is **1645**) → delete the else.
- Topup/increase: **2336-2337** (`topUpCollateral`/`increasePosition`).
- Partial close / TP: **2490** (`partialClose`).
- Position reads: **1237**, **2398** (`readPerpPosition`).
- Free collateral: **1775**, **2296** (`getFreeCollateralUsd`).
- wSOL unwrap: **1107** (`unwrapWsol`) — Imperial is USDC-collateralized, likely droppable — **verify**.
- Standalone open at **2922** (`openPosition`) — identify the flow (reconcile re-open?) before replacing.

### hedgeMode — leave it alone (the one care item)
`config.hedgeMode` (`PERP_HEDGE_MODE`) is the global `off|simulate|live` execution switch, read across
~14 Imperial branches in loop.js (1681, 1683, 1705, 1721, 1823, 2125, 2127, 2149, 2171, 2224, 2346,
2492, 2538, 2598) to decide simulate-vs-live and optimistic-vs-verified handling. It is **not** being
deleted, renamed, or changed.
- The only requirement: when restructuring the open/topup/TP/close branches into the venue adapter,
  the adapter stays a **thin** wrapper (just the venue call) and **every `hedgeMode` guard stays in the
  loop, unchanged and in place.** A dropped/misplaced guard fails *silently* (real-money), so re-diff
  all 14 checks after Phase 2 and verify in `simulate` before `live`.

## Jupiter → Imperial mapping
| Jupiter (`jupiterPerps.js`) | Imperial replacement (`imperialPerps.js`) |
|---|---|
| `openPosition` | `imperialOpenPosition` |
| `increasePosition` | `imperialIncreasePosition` |
| `topUpCollateral` | `imperialTopUpMargin` / `imperialAddCollateralToPosition` |
| `partialClose` | `imperialPartialClose` |
| `closePerp` | `imperialClosePosition` |
| `withdrawCollateral` | `imperialWithdrawCollateral` |
| `readPerpPosition` | `imperialReadPosition` / `readVerifiedImperialPosition` |
| `getFreeCollateralUsd` | `readImperialProfileUsdcUi` (or drop; Imperial uses `availableUsd()`) |
| `unwrapWsol`, `getJupPerps`, `marketIndexFor` | drop |

## Multi-venue design (what to KEEP — the user's requirement)
Don't hardcode Imperial; keep the seams so a future venue plugs in without editing the loop.
- **Keep** the `router` column (token → venue family) and the venue resolution (`venue: 'phoenix'`).
- **Introduce a thin venue-adapter interface** so the loop is venue-agnostic, in a **top-level module**
  `keeper/src/venue.js` (no `venues/` subfolder):
  ```js
  // keeper/src/venue.js  (top-level) — wraps existing imperialPerps fns + resolver
  const imperialAdapter = {
    open, increase, topUp, partialClose, close,
    readPosition, freeCollateralUsd, isSupported(symbol),
  };
  export function resolveVenue(token) { /* token.router -> adapter */ }
  ```
  The loop calls `resolveVenue(token).open(...)` — replacing the
  `if (imperialTradeEnabled) {imperial} else {jupiter}` branch with the adapter call. Adding a venue
  later = another adapter in `venue.js` (or a sibling top-level file) + a `resolveVenue` case, **zero
  loop edits**. The `hedgeMode` guards stay in the loop around the adapter call (the adapter does not
  absorb them).

## DB / schema impact — NONE
Keeper-code + `package.json` only. All position/state columns (`position_size_usd`,
`position_collateral_usd`, `opened_collateral_usd`, `pnl_high_water_usd`, `pending_drift_sig`, …) are
venue-agnostic and already written by the Imperial path. No Supabase migration, no add/drop/rename
column, no backfill, no env-var changes (`PERP_HEDGE_MODE` stays). The `router` column stays.

## Phased steps
- **Phase 0 — prep (no behavior change):** move `SUPPORTED_SYMBOLS` to a neutral module. (No hedgeMode work.)
- **Phase 1 — venue adapter:** add a **top-level** `keeper/src/venue.js` (thin wrappers over
  `imperialPerps.js`) + a `resolveVenue(token)` that picks the adapter from `token.router`. No
  `venues/` subfolder.
- **Phase 2 — loop.js:** replace every Jupiter call with `adapter.*`; delete the Jupiter `else` branches
  (open/topup/TP/close). Keep all `hedgeMode` guards in place; re-diff them afterward.
- **Phase 3 — other importers:** migrate `externalRouters.js` perp leg to Imperial; repoint
  `stateReconcile.js` + `index.js` reads.
- **Phase 4 — delete:** `jupiterPerps.js`, the `jup-perps-client` dep, the `postinstall` line, and
  `scripts/patch-jup-perps-client.mjs`.
- **Phase 5 — verify:** `cd keeper && npm i` clean (no patch), keeper boots, the live TEST token opens
  via Imperial, topup/TP/close still work, and `grep -rn "jup-perps-client\|jupiterPerps" keeper/src` = 0.

## Open item to confirm during implementation
- **loop.js:2922 standalone open** — confirm the flow (reconcile re-open?) before replacing. Code-reading
  only; not a product decision.

## Risk notes
- **The only delicate part is preserving the `hedgeMode` guards** while moving the venue call into the
  adapter — they're interleaved with the exact branches being restructured and fail silently if dropped.
  Adapter stays thin; guards stay in the loop; re-diff after Phase 2; test in `simulate` first.
- Keep `swap.js` untouched (Jupiter Swap ≠ Jupiter Perps).
- Do Phase 5 verification on a live token before declaring done — same hybrid test as
  [LIVE_TESTING_LAUNCHES.md](LIVE_TESTING_LAUNCHES.md).
