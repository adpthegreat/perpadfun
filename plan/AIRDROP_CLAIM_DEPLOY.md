# PerpsPad $PERPAD Airdrop — Mainnet Deploy Handoff (for ADP)

Single-shard Kamino Merkle Distributor airdrop. The Kamino program
(`KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat`) is **already deployed on
mainnet-beta by Kamino — we do NOT deploy it.** We only (1) build the merkle
tree, (2) create + fund a distributor PDA, (3) hand custody to a multisig, and
(4) ship the finalized proof map in the app.

Branch: `feat/airdrop-claim`. All paths below are repo-relative.

---

## 0a. POST-AUDIT HARDENED FLOW (2026-06-30) — READ FIRST

A multi-agent security audit (**`plan/AIRDROP_AUDIT.md`**, decision **GO-WITH-FIXES**) found the scripts as-written had **NO launch-time gate** (anyone could claim the instant the vault was funded) plus several ops footguns. The scripts are now **hardened**, enforce the safe path automatically, and were verified end-to-end on localnet against the real Kamino program (gated claim reverts `ClaimingIsNotStarted` 0x1782, no ClaimStatus lockout; opens via `set_enable_slot`; claim succeeds; replay reverts — no double-spend).

**The only on-chain claim gate is `enable_slot`** — `new_claim` reverts `ClaimingIsNotStarted` (0x1782) unless `enable_slot <= current_slot`. `create-distributor.ts` now defaults to a far-future SENTINEL `enable_slot`, so **claims are IMPOSSIBLE until you deliberately open them at T**. The frontend "NOT YET LIVE" banner is cosmetic (the proof-map ships in the public JS bundle) — the gate MUST be on-chain.

Authoritative env-driven sequence:

```bash
# 1. BEFORE T — build the tree from the REAL CSV (explicit path now REQUIRED; no sample default)
bun run scripts/airdrop/build-tree.ts ~/Downloads/PERPAD_AIRDROP_ALLOCATION.csv
#    -> verify: 380 wallets, maxTotalClaim 775960887398266, root 37798572…53e7a69a

# 2. BEFORE T — create + hand over (admin->multisig) + fund. Claims stay SHUT (sentinel enable_slot).
MINT=<legacy-SPL 6dp mint> \
MULTISIG=<squads vault pubkey> \
EXPECT_NODES=380 EXPECT_TOTAL=775960887398266 \
ADMIN_KEYPAIR=~/.config/solana/id.json RPC_URL=https://api.mainnet-beta.solana.com \
bun run scripts/airdrop/create-distributor.ts
#    auto-enforces: mint is legacy-SPL + 6dp; tree == EXPECT_*; admin ATA >= maxTotalClaim;
#    base keypair persisted (idempotent, no double-spend); clawback_receiver = multisig ATA;
#    set_admin -> multisig BEFORE funding; read-back asserts incl. enableSlot.

# 3. step 2 injects distributor+mint into proof-map.json -> build + test + deploy the app
npm run build && npm run test && <deploy>   # banner shows NOT-YET-LIVE; the real gate is on-chain

# 4. AT T — the multisig opens claims (prints the set_enable_slot ix to wrap in Squads):
MINT=<mint> RPC_URL=<rpc> bun run scripts/airdrop/open-claims.ts
```

**Autonomous alternative (no multisig tx at T):** add `LAUNCH_TS=<unix seconds>` to step 2 — `enable_slot` is derived from T via the 400ms/slot floor so claims auto-open AT-OR-AFTER T (never before); skip step 4.

**Localnet testing:** add `SKIP_HANDOVER=1` to step 2 (admin stays the deployer so a test can flip `enable_slot` directly); `MULTISIG` not required.

The detailed steps in §0–§6 below remain the reference; the commands above are the authoritative sequence.

---

## 0. Preconditions — verify BEFORE running anything (a miss here loses funds)

1. **$PERPAD mint is the LEGACY SPL Token program** (`Tokenkeg…`), **NOT
   Token-2022.** The whole pipeline hardcodes `TOKEN_PROGRAM_ID` (legacy) for the
   vault ATA, the transfer, and the on-chain `new_claim`. A Token-2022 mint
   silently derives the wrong ATAs and cannot be used with Kamino as-is.
   Check: `spl-token display <MINT>` → "Program: …Tokenkeg…".
2. **$PERPAD decimals == 6.** Baked into `src/lib/airdrop/merkle.ts`
   (`TOKEN_DECIMALS = 6`) and asserted in `create-distributor.ts`. If decimals
   ≠ 6: allocation math is silently wrong at build time AND the fund
   `transferChecked` aborts. If real decimals ≠ 6, change `TOKEN_DECIMALS` and
   rebuild the tree. Check: `spl-token display <MINT>` → "Decimals: 6".
3. **Admin keypair's $PERPAD ATA holds ≥ `maxTotalClaim`** before running
   create-distributor. The script funds the vault in a SEPARATE tx after the
   create tx; if that transfer fails for lack of balance the distributor is left
   **created-but-unfunded**, and a naive re-run mints a NEW distributor on a
   fresh ephemeral `base` (orphaning the first). Fund the admin ATA first.
4. **Allocation CSV present.** The real file is `PERPAD_AIRDROP_ALLOCATION.csv`
   (NOT in repo as of this handoff — `scripts/airdrop/allocation.csv` is only a
   4-row sample). Expected columns: `owner,perpad_balance,hold_days,base_1to10,
   days_bonus,total_airdrop`. The builder maps `owner→pubkey` and
   `total_airdrop→amount` (uiAmount float). **No thousands-separator commas** in
   `total_airdrop` — the CSV parser splits naively on `,`. A non-numeric amount
   throws and FAILS THE BUILD (fail-closed, good), but an embedded comma would
   misalign columns. Sanitize first.
5. **Multisig ready** (Squads or equivalent) with its own $PERPAD **ATA created**
   — needed in step 3 for both `set_admin` and `set_clawback_receiver`.

---

## 1. Build the merkle tree

```bash
bun run scripts/airdrop/build-tree.ts PERPAD_AIRDROP_ALLOCATION.csv
```

Produces:
- `scripts/airdrop/distributor-input.json` — `{ root, maxTotalClaim, maxNumNodes,
  version:0, decimals:6 }`, consumed by create-distributor.
- `src/lib/airdrop/proof-map.json` — per-wallet `{ amount, proof }`; `distributor`
  + `mint` are PLACEHOLDER (`111…`) until step 2 injects them.

The script dedupe-SUMs duplicate `owner` rows, builds the Kamino tree, and
**self-verifies every proof folds to the root** before writing (aborts on any
mismatch). Record the printed `root` and `maxTotalClaim`. 380 wallets ≤ 12000 ⇒
a single shard, `version 0`.

---

## 2. Create + fund the distributor (mainnet)

```bash
MINT=<real $PERPAD mint base58> \
ADMIN_KEYPAIR=~/.config/solana/perpad-admin.json \
RPC_URL=https://api.mainnet-beta.solana.com \
bun run scripts/airdrop/create-distributor.ts
```

What it does, in order:
1. Idempotently creates the **vault ATA** (owner = distributor PDA) and the
   **clawback-receiver ATA** (owner = admin), then calls `newDistributor` with
   `closable=false`, `enableSlot=0` (claims open immediately on fund),
   `clawbackStartTs = now + 365d`, legacy token, decimals 6, the tree root.
2. **Reads the account back and asserts** root, admin, clawbackReceiver,
   `closable==false`, tokenVault — the frontrun guard the SDK docstring demands.
   Aborts before funding on any mismatch.
3. Funds the vault with **exactly `maxTotalClaim`** from the admin ATA.
4. Injects the real `distributor` PDA + `mint` into
   `src/lib/airdrop/proof-map.json`.

> **`enableSlot` / timestamps are HARDCODED** in `create-distributor.ts`
> (`startVestingTs`, `endVestingTs`, `clawbackStartTs`, `enableSlot`). With
> `amount_locked = 0` the vesting timestamps are inert (the unlocked amount is
> claimable immediately, confirmed on localnet — see §5). The only on-chain
> launch gate is `enableSlot`. **For a timed launch, edit the `enableSlot: new
> BN(0)` line to a future slot BEFORE running, or call `setEnableSlot` afterward
> (admin-only).** `clawbackStartTs` (now+365d) is the de-facto claim deadline.

---

## 3. Hand custody to the multisig — DO THIS IMMEDIATELY AFTER §2

The deployer keypair is currently a **single point of total failure**, for two
distinct reasons confirmed against the on-chain program source:

- **`admin`** can `set_admin`, `set_clawback_receiver`, `set_clawback_start_ts`,
  `set_enable_slot`.
- **`clawback_receiver`** is where ALL unclaimed funds go after the deadline —
  and clawback is **PERMISSIONLESS**: `programs/.../clawback.rs` says
  *"Anyone can claw back the funds"* (`claimant: Signer`, no admin constraint),
  with `to` pinned to `distributor.clawback_receiver`. So the **destination**,
  not the caller, is the control. create-distributor set it to the **deployer's
  ATA**. After 365 days, anyone can sweep the remainder to that ATA.

Therefore transfer BOTH:

```
setClawbackReceiver(distributor, admin=deployer, newClawbackReceiver = MULTISIG $PERPAD ATA)
setAdmin(distributor, admin=deployer, newAdmin = MULTISIG)
```

(Both instructions are exported by `@kamino-finance/distributor-sdk`; both
require the current `admin` to sign. Do `setClawbackReceiver` first, then
`setAdmin` — once admin is the multisig you can no longer sign single-key.)
Read the account back and assert `admin == multisig` and `clawbackReceiver ==
multisig ATA`.

---

## 4. Ship the finalized proof map in the app

`src/lib/airdrop/proof-map.json` is a **static `import` bundled by Vite** — the
live app does NOT pick up the create-distributor mutation until you rebuild and
redeploy. The on-chain distributor is claimable the instant it's funded
(`enableSlot=0`), independent of the frontend; the frontend just stops gating
once the map is finalized (`isFinalized()` checks `distributor`/`mint` ≠
placeholder).

```bash
# proof-map.json now has the real distributor + mint (injected in §2)
npm run build          # PASS — see §5
npm run test           # merkle KATs PASS — see §5
git add src/lib/airdrop/proof-map.json scripts/airdrop/distributor-input.json
git commit -m "feat(airdrop): finalize proof map with live $PERPAD distributor"
# deploy (Cloudflare) per the project's normal release flow
```

The `/claim` route is already wired to stay live in coming-soon mode
(`src/lib/coming-soon.ts` returns `true` for `/claim`). Claimant UX: the wallet
pays ClaimStatus rent (~0.0016 SOL) + ATA-create (if new) + tx fee; the page
warns on low SOL and shows "already claimed" via on-chain `userClaimed`.

---

## 5. Localnet evidence — the pipeline works against the REAL Kamino program

Full E2E ran the production claim builder (`src/lib/airdrop/claim.ts` →
`getNewClaimIx`) against the **actual mainnet program cloned into a local
validator** (`--clone-upgradeable-program`, agave v4.1.0). The on-chain verifier
accepted a real claim and rejected the double-claim — closing the only prior
residual (merkle correctness was confirmed by summarized Rust, now confirmed
byte-for-byte by the deployed program).

| Check | Result | Evidence |
|---|---|---|
| Program cloned, executable | PASS | `getAccountInfo(Kdisq…JyGat)` → `executable:true`, owner `BPFLoaderUpgradeab1e…` |
| Distributor created, root match, `closable=false` | PASS | PDA `C3oMNzAyN3dVxRLnNATDcm2dub3ZhcJ5zBE6KJ1MFCYH`; on-chain root `aa0800b9…426791` == tree root; `closable=false` asserted |
| Claim #1 correct balance | PASS | claimant1 ATA `0 → 2090000` (== 2.09 × 10⁶) |
| Double-claim rejected | PASS | 2nd `NewClaim` → ClaimStatus PDA `xALuU29J…` "already in use" → `custom program error: 0x0`; balance unchanged |
| `npm run build` | PASS | exit 0; `dist/client/assets/claim-*.js` emitted |
| `npx tsc --noEmit` | PASS | "No errors found" |

Throwaway-fixture tx sigs (localnet):
- newDistributor `2U8wQ7BepiroKyZGRB5UgpxV3QrsAyvEoxWgdDJrxTbW5wHccNzLRLWSKrkrVZR3Ve3Ny1xbtVQHgXDWL7LFwH3W`
- fund vault `3sH2kAKVNeoyPvWqAoPon89EFUgGaqtPqKAzfZVhLcDWX6X36qpFuYw2HTZd1e1TNFqXTnquTQQntC8PgnQUGL1m`
- claim #1 `5Xa3MtSQyXCUMPTLSxY1fBLXRw67mX5V6W9n9qt6CCeP1JnqMZ24df8ivcXgqytwDohkVGRdLRE7x6cWbCM3cdvd`

Fixture: throwaway mint `4566BbivvRqguW7jajDgiUDPQMjSjEwdkJGiGzpRb3CT` (legacy, 6dp),
2 claimants (2.09, 3.5), tree total 5,590,000 base units. (`scratch-localnet/` is
untracked/gitignored — keypairs + agave binaries. The 1.17.25 bundled
`solana-test-validator` cannot create a ledger on macOS 26/arm64, a RocksDB
incompat; agave v4.1.0 was used out-of-tree with no change to the installed
toolchain.)

Byte-exactness was additionally re-confirmed against the program source during
this review:
- leaf = `hashv(claimant[32], amount_unlocked_le[8], amount_locked_le[8])`, then
  `hashv([0x00], node)` (`programs/.../new_claim.rs`).
- verify folds with sorted pairs + prefix `0x01`:
  `if computed ≤ element { hashv([1], computed, element) } else { hashv([1],
  element, computed) }` (`verify/src/lib.rs`). The root is OUR input — the
  program never rebuilds the tree, only folds proof→root, which `verifyProof`
  mirrors. `src/lib/airdrop/merkle.ts` matches both exactly.

---

## 6. Adversarial review findings (this handoff)

No code bug requires a fix; `npx tsc --noEmit` and the merkle KATs pass. Findings:

- **HIGH (process, §3):** clawback is permissionless after the deadline and
  `clawback_receiver` is the deployer ATA. **Must** `setClawbackReceiver` →
  multisig ATA AND `setAdmin` → multisig before walking away.
- **MEDIUM (§0.1/0.2):** legacy-Token-only + decimals==6 are unguarded
  preconditions; a Token-2022 or non-6-dp mint breaks silently. Verify first.
- **MEDIUM (§0.3):** fund failure leaves a created-but-unfunded distributor;
  re-run orphans it on a fresh `base`. Fund admin ATA ≥ maxTotalClaim first.
- **MEDIUM (§2):** `enableSlot`/timestamps hardcoded; edit before run for a timed
  launch (or `setEnableSlot` after).
- **LOW:** CSV parser splits naively on `,` — sanitize thousands separators /
  quoted commas (else fail-closed at build).
- **LOW:** `getNewClaimIx` uses a NON-idempotent ATA-create (skipped only if the
  ATA already exists at build time); a griefer front-creating the claimant ATA
  between build and land would revert that one tx. Self-heals on retry (rebuild
  sees the ATA and skips). Not worth a fix.
- **INFO:** claim tx is a legacy `Transaction` (spec allowed legacy or v0) with
  ComputeBudget prepended (1M CU + 50k µLamports/CU ≈ 0.00005 SOL priority) —
  required because proof-verify + ATA-create exceed the 200k default.
- **INFO:** over-claim and non-whitelist claims are impossible — the leaf binds
  claimant+amount, a forged amount/wallet fails on-chain `verify`; double-claim
  is blocked by the `ClaimStatus` `init` with `closable=false` (E2E-confirmed).

---

## 7. Mainnet checklist

- [ ] §0 preconditions verified (legacy token, 6dp, admin ATA funded, CSV clean, multisig ATA exists)
- [ ] `build-tree.ts` run on real CSV; root + maxTotalClaim recorded
- [ ] `create-distributor.ts` run; read-back asserts passed; vault funded
- [ ] `setClawbackReceiver` → multisig ATA; `setAdmin` → multisig; both asserted on-chain
- [ ] proof-map.json finalized → rebuild → test → commit → deploy
- [ ] `/claim` live; test-claim one real eligible wallet end-to-end
