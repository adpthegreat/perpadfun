# test/live/ — Imperial live order round-trip suite

> End-to-end tests for the `imperialPerps.js` helpers (`imperialOpenPosition`,
> `imperialIncreasePosition`, `imperialPartialClose`, `imperialClosePosition`,
> `imperialTopUpMargin`, `imperialWithdrawCollateral`) against the **real Imperial
> mainnet API**. Per-venue (phoenix primary, gmtrade/jupiter legacy, flash_trade deferred).
>
> **These tests spend real money. No mocks, no dummy assertions.** Every test
> places at least one on-chain transaction. The suite is SKIPPED by default;
> opt in only after configuring `test/live/.env` with a **dedicated** test
> wallet (never the production keeper treasury).
>
> ## Gates (per `helpers/live.ts`)
>
> | Env | Enables | Use case |
> |---|---|---|
> | `IMPERIAL_LIVE_TESTS=1` | The whole live suite (Phoenix primary) | Daily Phoenix verification |
> | `LEGACY_VENUE_TESTS=1` | `gmtrade-*.live.test.ts`, `jupiter-roundtrip.live.test.ts` | Emergency only — venues are deprecated per [`KEEPER_PHOENIX_LOCK.md`](../../plan/KEEPER_PHOENIX_LOCK.md) |
> | `FLASH_TESTS=1` | `flash_trade-*.live.test.ts` | Debugging the partial-close polling issue (tracked separately) |
>
> All three gates are AND-ed with `IMPERIAL_LIVE_TESTS=1`. The Phoenix tests
> need only `IMPERIAL_LIVE_TESTS=1`; they're the canonical path.

---

## Why this exists

Two things a unit-test suite can't catch:

1. **Imperial `/mobile/orders` is unreliable.** It often returns
   `{ success:false, error:"Failed to place order" }` *even when the order actually
   fills on-chain.* The production keeper compensates by polling `/positions`
   for a fresh open. This suite asserts the recovery path works end-to-end.

2. **Phoenix and flash_trade silently no-op.** The same `/mobile/orders` call
   returns 200-OK but the on-chain tx never lands, because Imperial needs
   venue-specific account fields we haven't plumbed yet (see
   [plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md](../../plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md)).
   These tests are the **Phase C verification gate** for that work.

---

## Setup (mandatory before any live test runs)

### 1. Generate a dedicated test wallet

**Do NOT use the production keeper treasury.** The tests open and close real
positions on whichever wallet authenticates; running them against prod would
interleave with the keeper loop and corrupt your reconciliation state.

```bash
solana-keygen new -o test-wallet.json --no-bip39-passphrase
solana-keygen pubkey test-wallet.json
# Note the pubkey — that's where you send the test funds
```

(The repo `.gitignore` excludes `test-wallet.json`.)

### 2. Fund the wallet on mainnet

You need:
- **~$50 USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) — covers full-suite
  cost (~$2 in fills + headroom for collateral that gets locked between tests)
- **~0.05 SOL** — gas for deposit / order / close txs

Send from any hot wallet to the pubkey from step 1.

### 3. Register on Imperial

Visit the Imperial frontend, sign in with the new wallet's pubkey once.
This creates the profile Imperial maps the wallet to. Without this step
`/mobile/balances` returns an empty profiles list.

### 4. Copy `.env.example` to `.env`

```bash
cp test/live/.env.example test/live/.env
```

Edit `test/live/.env` and fill in:
- `LIVE_TEST_PRIVATE_KEY` — paste the JSON byte array from `test-wallet.json`
- `LIVE_TEST_RPC_URL` — a mainnet RPC you control (public endpoint is rate-limited)

The `.env` file is already gitignored. Confirm with `git status` before
committing anything in this directory.

### 5. Run the suite

```bash
# Full suite
IMPERIAL_LIVE_TESTS=1 bunx vitest run test/live/

# Read-only first (free; pre-flight check)
IMPERIAL_LIVE_TESTS=1 bunx vitest run test/live/auth-and-route.live.test.ts \
                                       test/live/read-position.live.test.ts

# One venue at a time
IMPERIAL_LIVE_TESTS=1 bunx vitest run test/live/phoenix-roundtrip.live.test.ts
```

If `IMPERIAL_LIVE_TESTS` is not set to `1`, every file in this directory skips
cleanly with a "set IMPERIAL_LIVE_TESTS=1 to enable" marker.

---

## What's in the suite

Every file is a real test — none of them pass without hitting Imperial.

| File | Action sequence | Cost | Phase C role |
|---|---|---|---|
| [auth-and-route.live.test.ts](./auth-and-route.live.test.ts) | `authenticate()` + 4× `/route` + read `candidates[]` + check `marketsVersion` | $0 (read-only) | Pre-flight |
| [read-position.live.test.ts](./read-position.live.test.ts) | `imperialReadPosition` against known-open positions on the test wallet | $0 (read-only) | Pre-flight |
| [gmtrade-roundtrip.live.test.ts](./gmtrade-roundtrip.live.test.ts) | Open SOL → verify on-chain fill via USDC drain → close → verify gone | ~$0.20 | Control venue |
| [jupiter-roundtrip.live.test.ts](./jupiter-roundtrip.live.test.ts) | Same on BTC via jupiter | ~$0.20 | Post-gmtrade fallback control |
| [phoenix-roundtrip.live.test.ts](./phoenix-roundtrip.live.test.ts) | Same on SOL via phoenix | ~$0.20 once it works; $0 pre-Phase-B (silent no-op) | **THE PHASE B GATE** |
| [flash_trade-roundtrip.live.test.ts](./flash_trade-roundtrip.live.test.ts) | Same on PYTH via flash_trade | ~$0.20 once it works; $0 pre-Phase-B | **THE PHASE B GATE** |
| [increase-position.live.test.ts](./increase-position.live.test.ts) | Open → `imperialIncreasePosition` (+coll +size) → assert both deltas → close. Venue via `FORCE_VENUE` | ~$0.40 | Run per-venue once round-trips pass |
| [topup-margin.live.test.ts](./topup-margin.live.test.ts) | Open → `imperialTopUpMargin` (pure deposit) → assert profile USDC grew + position size unchanged → close | ~$0.30 | Run per-venue once round-trips pass |
| [partial-close.live.test.ts](./partial-close.live.test.ts) | Open → partial close ~50% → assert size shrunk + position still open → close remainder. Validates the `_TODO_VERIFY_` partial-close body shape in [imperialPerps.js:426](../../keeper/src/imperialPerps.js#L426) | ~$0.40 | Run per-venue once round-trips pass |
| [withdraw-collateral.live.test.ts](./withdraw-collateral.live.test.ts) | Open → `imperialWithdrawCollateral` → assert sub-wallet USDC grew + profile USDC shrunk → close. **Best-effort** — validates the `_TODO_VERIFY_` `WITHDRAW_PATH`/`WITHDRAW_MODE` in [imperialPerps.js:63-64](../../keeper/src/imperialPerps.js#L63) | ~$0.30 | Best-effort; not blocking |

**Full suite cost: ~$2** in Imperial fills + slippage. Slightly more if a test
fails its close step and you have to manually clean up.

---

## Env vars

All loaded from `test/live/.env` via the setup file in
[test/helpers/setup-env.ts](../helpers/setup-env.ts) when
`IMPERIAL_LIVE_TESTS=1`.

| Var | Required | Default | Notes |
|---|---|---|---|
| `IMPERIAL_LIVE_TESTS` | Yes | unset (skip) | Set to `1` to opt in. |
| `LIVE_TEST_PRIVATE_KEY` | Yes | — | DEDICATED test wallet (JSON byte array or base58). MUST NOT match `TREASURY_SOLANA_PRIVATE_KEY` — the auth helper throws if they match. |
| `LIVE_TEST_RPC_URL` | Recommended | `api.mainnet-beta.solana.com` (rate-limited) | Use your own Helius / QuickNode endpoint to avoid flaky tests. |
| `IMPERIAL_BASE_URL` | No | `https://api.imperial.space/api/v1` | Override only for Imperial staging. |
| `IMPERIAL_API_KEY` | No | — | Some Imperial profiles need this; most don't. Try blank first. |
| `LIVE_TEST_COLLATERAL_USD` | No | `10` | Min is `MIN_COLLATERAL_USD=10`; don't go lower. |
| `LIVE_TEST_LEVERAGE` | No | `2` | Higher = smaller fill, less slippage. |
| `LIVE_TEST_PROFILE_INDEX` | No | auto-pick via `pickProfile` | Pin a specific profile if your wallet has more than one. |
| `FORCE_VENUE` | No (advanced tests) | `gmtrade` for `increase-position`/`topup-margin`/`partial-close`/`withdraw-collateral`; pinned in round-trip files | Override to retarget the advanced flows at phoenix or flash_trade. |
| `FORCE_SYMBOL` | No (advanced tests) | `SOL` | Override to test another symbol. |

---

## Safety guarantees the suite enforces

- **No fall-through to production treasury.** The auth helper at
  [helpers/auth.ts:18](./helpers/auth.ts#L18) throws if `LIVE_TEST_PRIVATE_KEY`
  is missing OR matches `TREASURY_SOLANA_PRIVATE_KEY`.
- **Every round-trip ends with a verified close.** If a close polls
  `pollForPositionGone` for 30s and the position is still open, the test
  fails with a clear "**MANUAL CLEANUP REQUIRED**" message identifying the
  symbol + profile to close via the Imperial frontend.
- **Tests run serially.** `fileParallelism: false` in the project
  [vitest.config.ts](../../vitest.config.ts) prevents two files from racing
  on the same profile.
- **120-second per-test timeout.** Set per `it()` to accommodate `/positions`
  polling (15 attempts × 2s).

---

## Layout

```
test/live/
  README.md                              ← this file
  .env.example                           ← copy to .env, fill in dedicated key
  helpers/
    live.ts                              ← liveSuite() gate, sizing knobs
    auth.ts                              ← liveAuth() — refuses prod treasury fall-through
    rpc.ts                               ← liveRpcUrl() — refuses prod keeper RPC
    profile.ts                           ← pickAndFundProfile() + USDC reads
    verify.ts                            ← pollForFreshPosition / pollForPositionGone / refund detection
    roundtrip.ts                         ← shared open-verify-close used by per-venue tests
  auth-and-route.live.test.ts            ← read-only live
  read-position.live.test.ts             ← read-only live
  gmtrade-roundtrip.live.test.ts         ← control (deprecated venue)
  jupiter-roundtrip.live.test.ts         ← control
  phoenix-roundtrip.live.test.ts         ← Phase B verification gate
  flash_trade-roundtrip.live.test.ts     ← Phase B verification gate
  increase-position.live.test.ts         ← +collateral + size flow
  topup-margin.live.test.ts              ← pure deposit (no size change)
  partial-close.live.test.ts             ← partial close validation
  withdraw-collateral.live.test.ts       ← best-effort (_TODO_VERIFY_)
```

---

## Troubleshooting

- **All tests show "skipped — set IMPERIAL_LIVE_TESTS=1 to enable"** —
  `IMPERIAL_LIVE_TESTS` env var is unset.
- **`LIVE_TEST_PRIVATE_KEY is not set`** — `test/live/.env` is missing or
  doesn't have the key. Copy `.env.example` and fill it in.
- **`LIVE_TEST_PRIVATE_KEY matches TREASURY_SOLANA_PRIVATE_KEY`** — you're
  trying to use the production wallet. Generate a separate key (step 1 above).
- **`venue ${v} not yet supported`** — the `SUPPORTED_OPEN_VENUES` gate at
  [imperialPerps.js:254](../../keeper/src/imperialPerps.js#L254) is blocking
  the venue. For phoenix/flash_trade today, this is expected — the test
  passes after Phase B unblocks the gate.
- **`silent no-op detected: USDC drain $0.00`** — Order signed but Imperial
  didn't fill. Pre-Phase-B failure mode for phoenix/flash_trade.
- **`MANUAL CLEANUP REQUIRED`** — a close failed mid-test. Open the Imperial
  frontend and close the symbol + profile named in the error.
- **`Imperial indexer didn't see deposit within 60s`** — your RPC is slow
  or the Imperial indexer is lagging. Re-run with a better
  `LIVE_TEST_RPC_URL`.

---

## Related

- [keeper/scripts/imperial-order-probe.mjs](../../keeper/scripts/imperial-order-probe.mjs)
  — the original one-shot script this suite generalizes.
- [plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md](../../plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md)
  — the plan this suite gates Phase C of.
