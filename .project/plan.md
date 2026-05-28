# Keeper Full Cleanup

Scope is the `keeper/` Fly service only. No frontend / DB-schema changes required for v1; one optional migration noted at the end.

## What's wrong today (from logs + code read)

1. **HYPU buyback not burnt** — `buyback.js::buybackAndBurn` runs swap → poll ATA → burn. If `swap` confirms but the ATA poll times out (6s) OR the burn tx fails, tokens sit stranded in the treasury ATA. There is no retry. `burnExistingTokenBalance` exists but nothing in the loop calls it on a schedule.
2. **Buybacks scattered** — at least three callers fire buybacks: `fees.js` (DBC fee → treasury buy), `loop.js` (tick PnL / treasury buyback), `pumpfunClaim.js` (external claim → buy). Each has its own gating, slippage, logging, error swallow. No single source of truth.
3. **Sub-$6 deposits silently fail** — `DUMPED`/`ELON`: `open partial: cap $50 → wallet capacity $5.62` then `post-swap USDC $0.00 below floor $2`. SOL→USDC swap is returning 0 USDC. Either (a) Jupiter rejected the tiny route silently, (b) the swap landed but USDC ATA read raced, or (c) the wallet had no SOL to swap from in the first place. Needs diagnostic logging + a floor check that skips earlier instead of attempting a doomed swap.
4. **Imperial optimistic writes drift** — DEGEN/WRLD opened on-chain (drain confirmed) but `/positions` didn't index in 13 polls, so we wrote the *requested* coll/size, never reconciled. If Imperial actually filled with different size/leverage, our DB lies forever.
5. **`loop.js` is 2024 lines** — perp tick, deposit logic, fee claim orchestration, buyback decisions, status writes, all in one file. Hard to test, hard to reason about.
6. **Noisy logs** — every per-wallet Imperial call logs the handshake fallback. Worth gating behind `LOG_VERBOSE=1`.

## Plan

### Phase 1 — New unified buyback queue (`buybackQueue.js`)

Single in-memory FIFO drained by a dedicated buyback tick (independent of the main perp loop).

- `enqueueBuyback({ tokenId, mintAddress, payMint, payAmountBaseUnits, kp, reason })` — push, dedupe by `(tokenId, reason, hash(payAmount))`.
- `buybackTick()` — pops up to N items per cycle, runs each through `buybackAndBurn`, persists outcome to `tx_log` (`kind='buyback'` + `kind='burn'`), updates `tokens.tokens_burned` + `tokens.buyback_reserve_usd`.
- **Burn-or-retry forever:** any item where swap confirmed but burn did not is re-enqueued as `kind='burn-only'` and drained by `burnExistingTokenBalance` until the ATA balance reads zero. Persisted in a new `keeper_pending_burns` in-memory map keyed by `(tokenId, mintAddress)` and rebuilt on startup by scanning treasury ATAs for nonzero balances of tokens we've ever bought.
- Interval: `BUYBACK_TICK_MS` (default 8000ms). Independent from perp tick.

All current call sites (`fees.js`, `loop.js`, `pumpfunClaim.js`) switch from direct `buybackAndBurn` calls to `enqueueBuyback`.

### Phase 2 — Position reconcile pass (`positionReconcile.js`)

Per perp tick, after the deposit/open phase:

- For each token with `position_opened_at > now() - 10 minutes` AND `status='live'`, re-query Imperial `/positions` for `(wallet, profile)`.
- If a real position is now indexed and differs from DB (`collateral_usd`, `size_usd`), update DB to the venue's truth and write a `treasury_events` row with `kind='reconcile'`.
- If 10 minutes pass with still no match AND drain was verified, leave the optimistic write but log `[reconcile] PERSISTENT_MISS` once so we can investigate.

### Phase 3 — Deposit swap fix (`imperialDeposit.js`)

- Before attempting SOL→USDC swap, log `wallet=X solBalance=Y lamports walletCapUsd=Z plannedSpend=W`.
- If `walletCapUsd < (floor + jupSlippageBuffer)`, skip with a single clear log line instead of running a swap that we already know will land $0.
- Catch Jupiter quote/swap responses with no `outAmount` and surface the route error (Jupiter often returns 200 with `{"error":"No routes found"}` for sub-$5 routes).

### Phase 4 — `loop.js` split

Carve out into focused modules (keeps `loop.js` as the orchestrator):

- `tickPerp.js`        — current perp tick body (read mids, compute coll/size, write ticks).
- `tickDeposit.js`     — wraps `imperialDeposit` per-token iteration.
- `tickFeeClaim.js`    — DBC/pumpfun claim loop (was inline in loop.js + fees.js + pumpfunClaim.js).
- `tickReconcile.js`   — Phase 2.
- `tickBuyback.js`     — drains buyback queue (Phase 1).

`loop.js` becomes the scheduler: each tick type has its own interval + in-flight guard (same pattern as the existing `safeTick`). `index.js` admin routes get a `/admin/buybackQueue` endpoint that returns the current queue + pending-burn list.

### Phase 5 — Log hygiene

- Gate `imperial:auth ... running handshake instead` behind `LOG_VERBOSE`.
- Add `[buyback]` / `[burn]` / `[reconcile]` prefixes consistently.
- `/health` and `/status` already expose `feeSplit`; add `buybackQueueDepth`, `pendingBurns`, `lastReconcileAt`.

### Migration (optional, recommended)

Add `treasury_events.kind='reconcile'` rows when DB is updated. No schema change required — `kind` is free text. **No new tables.**

## Out of scope for this PR

- Per-token PnL recomputation logic (already covered by mem://constraints/imperial-pnl).
- Migrating away from Imperial as the perp venue.
- UI changes.

## Risk

This touches every code path that moves money. Mitigation:

- Behind a `BUYBACK_QUEUE_ENABLED=true` flag (default off in first deploy). When off, callers fall back to the existing direct `buybackAndBurn` path.
- `RECONCILE_ENABLED=true` flag, default off first deploy.
- Loop.js split is mechanical — same code, different file. Can be reverted without state changes.

Expected delta: +~600 LOC new modules, -~400 LOC from `loop.js`, net ~200 lines, but much better isolated.

## Deliverable

Updated `keeper/src/*` ready for `fly deploy -a perpad-keeper`. Local `.env`/`config.js` gets three new flags with safe defaults. Same procedure as last time: pull, deploy, curl `/status` to verify the new fields.
