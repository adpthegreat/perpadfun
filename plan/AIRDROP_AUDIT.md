# PERPAD Airdrop — Pre-Launch Security Audit (Kamino Merkle Distributor)

**Date:** 2026-06-30 · **Method:** multi-agent adversarial audit (workflow `wf_77c3c1cb-c5e`, 37 agents, 6 dimensions, 3-lens verification)
**Decision: GO-WITH-FIXES**

**Verification tally:** 14 findings confirmed, 1 refuted (of 22 raw). Note: 4 verifier sub-agents hit the structured-output retry cap and dropped out; each affected finding still had >=1 other confirming lens, so no finding lost its verification.

---

## ADP #1 — Can anyone claim before launch time T?

YES — at the current commit (a540f1c) ANYONE eligible can claim before launch time T. There is ZERO time protection.

WHY (file:line + program citation):
- `scripts/airdrop/create-distributor.ts:97` sets `enableSlot: new BN(0)`.
- The deployed Kamino program (KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat, source @ commit aecda23a7363f448fae37543ab5a9f4662e50e50) gates `new_claim` with exactly ONE positive time check: `programs/merkle-distributor/src/instructions/new_claim.rs:96-99` -> `require!(distributor.enable_slot <= curr_slot, ErrorCode::ClaimingIsNotStarted)`, where `curr_slot = Clock::get()?.slot` (new_claim.rs:93). With `enable_slot = 0`, `0 <= curr_slot` is ALWAYS true, so the gate is permanently open.
- `start_vesting_ts`/`end_vesting_ts` do NOT gate `new_claim` (no `require!` references them in any claim handler; they only feed the locked-vesting math in the separate `claim_locked` ix, and `amount_locked = 0` here (merkle.ts:76, claim.ts passes BN(0)) makes that a no-op).
- create-distributor.ts funds the vault in the SAME run (lines 156-171), so claims succeed the instant the funding tx confirms.
- The frontend "NOT YET LIVE" gate is cosmetic: `src/lib/airdrop/proofMap.ts:71-76` `isFinalized()` only checks that proof-map.json's distributor/mint are non-placeholder; the file is a static Vite import (proofMap.ts:10) inlined verbatim into the public Cloudflare bundle, so any reader can reconstruct amount+proof and submit `newClaim` directly via RPC, bypassing the UI entirely.

EXACT change to enforce a hard T (primary — Strategy A, verified feasible):
1. In create-distributor.ts, before building `args`, add `const currentSlot = await connection.getSlot();` and replace line 97 with `enableSlot: new BN(currentSlot + 1_000_000_000)` (a far-future SENTINEL slot the chain cannot reach for years). Add a read-back assert near line 153: `if (!state.enableSlot.eq(args.enableSlot)) throw new Error("enableSlot MISMATCH")`.
2. Hand admin to the M-of-N multisig BEFORE funding (set_clawback_receiver -> multisig ATA, then set_admin -> multisig).
3. AT exactly T, the multisig calls `set_enable_slot(currentSlot_now)`. I verified `handle_set_enable_slot` (set_enable_slot.rs) is an unconditional admin field write — `distributor.enable_slot = enable_slot;`, only `has_one = admin`, NO must-increase/future constraint — so it can LOWER the sentinel to open. "Not before T" is then guaranteed by a deliberate multisig action, immune to slot-prediction error.

Autonomous fallback (no admin tx at T): set `enableSlot = new BN(currentSlot + Math.ceil((LAUNCH_TS - now) * 1000 / 400))` using the 400 ms/slot FLOOR (max plausible slot rate -> highest slot count -> opens AT-OR-AFTER T, never before). Do NOT use Kamino CLI's average-slot-time formula (process_set_enable_slot_by_time.rs:31-35) — average can open EARLY.

---

## Blockers (must fix before launch)

### 1. [CRITICAL] No hard launch-time gate: enableSlot=0 disables the only on-chain claim gate, and the script has no concept of T (timing derived from Date.now(), create+fund go live in one run). ADP#1 violated.
**Fix:** create-distributor.ts:86-99. Introduce a required LAUNCH_TS (or use sentinel+admin-flip). PRIMARY: set enableSlot = (await connection.getSlot()) + 1_000_000_000 (far-future sentinel); hand admin to multisig; at T the multisig calls set_enable_slot(currentSlot) to open (set_enable_slot.rs is an unconditional admin field write, can lower). FALLBACK (autonomous): enableSlot = currentSlot + ceil((LAUNCH_TS-now)*1000/400) via the 400ms FLOOR. Anchor clawbackStartTs to LAUNCH_TS+365d (or create+365d+gap), not Date.now()+365d. Add a read-back assert for enableSlot at ~line 153.

### 2. [HIGH] Committed distributor-input.json / proof-map.json are the 3-wallet SAMPLE (maxTotalClaim=21340000, maxNumNodes=3); build-tree.ts defaults to the sample CSV; create-distributor has no expected-value guard. A naive run funds 21.34 tokens for 3 test wallets and ships a 3-claim app — the 380 real recipients get nothing.
**Fix:** build-tree.ts:69 — remove the allocation.csv default; require an explicit CSV arg. Regenerate from the REAL ~/Downloads/PERPAD_AIRDROP_ALLOCATION.csv as the LAST step before create. Add a guard in create-distributor.ts that aborts unless input.maxNumNodes === 380 and input.maxTotalClaim === '775960887398266' (EXPECT_NODES/EXPECT_TOTAL env). Do not commit sample-derived artifacts to the launch branch.

### 3. [HIGH] Deployer is a single point of total failure during create->fund->handover: the full vault is funded under the sole deployer key, and the multisig handover is a manual post-funding checklist step. clawback is permissionless (clawback.rs:32-33) and clawback_start_ts is shortenable to ~end_ts+1day via set_clawback_start_ts, so the 365-day deadline is cosmetic, not trustless.
**Fix:** Reorder and bake into the script: create -> read-back assert -> HANDOVER (set_clawback_receiver -> multisig ATA, then set_admin -> multisig, asserting both on-chain) -> THEN fund. Funding is a plain SPL transfer from the deployer ATA and needs no admin rights, so it works after handover. This reduces the SPOF to M-of-N (does not remove the inherent Kamino clawback-after-deadline power — disclose that).

### 4. [MEDIUM] On-chain mint is never validated before creating the distributor. The only decimals check (create-distributor.ts:72) compares input.decimals to the constant — a tautology. A Token-2022 mint or wrong-decimals mint is caught only LATE (ATA-create or transferChecked revert) after newDistributor already created an orphan PDA.
**Fix:** At the top of main(): fetch the mint; assert getAccountInfo(MINT).owner.equals(TOKEN_PROGRAM_ID) (reject Token-2022) and getMint(MINT).decimals === 6, before deriving any ATA or sending newDistributor. Fail closed with an explicit message.

### 5. [MEDIUM] create-distributor.ts is non-idempotent: base = Keypair.generate() (line 78) is ephemeral and never persisted, with no existing-distributor or admin-balance pre-check. A second funded run mints a NEW distributor with a fresh, empty ClaimStatus namespace — the same public proofs claim against BOTH, double-spending ~776M tokens; a partial re-run orphans a fully-funded distributor recoverable only via clawback after 365 days.
**Fix:** Pre-flight: assert admin ATA balance >= BigInt(input.maxTotalClaim) before createTx. Persist base.secretKey to a gitignored file immediately after generation so a failed-fund run re-funds the SAME distributor. Before creating, query the chain for an existing distributor for this (mint, root) and ABORT if one is funded. Add a lockfile keyed on the distributor-input.json hash; require --force to re-run after success.

### 6. [MEDIUM] Low-SOL warning (0.003 SOL) is below the real first-time-claim cost (~0.00366 SOL: ClaimStatus rent 1,566,000 + ATA rent 2,039,280 + base 5,000 + priority 50,000) AND is advisory-only (does not disable the button). Since PERPAD does not exist until launch, nearly every claimer is first-time; a wallet in the 0.003-0.0037 SOL band sees a green button and the claim reverts on-chain.
**Fix:** src/routes/claim.tsx:43 — raise MIN_SOL_LAMPORTS to ~4_200_000 (0.0042 SOL) with margin; make the message specific ('You need ~0.0042 SOL for account rent + fees'); consider gating the button (or a confirm) on it rather than a passive amber hint. UX hardening, not a security gate.

---

# PERPAD Airdrop — Final GO/NO-GO Launch Audit (Kamino Merkle Distributor)

**Decision: GO-WITH-FIXES.** Not launchable at commit `a540f1c` as-is. The Kamino primitive is sound and the happy-path + double-claim already passed localnet E2E, so this is a configuration/ops problem, not a wrong-approach problem. Launch is approved ONLY after the blockers below land and are re-verified.

**Program reference:** `github.com/Kamino-Finance/distributor` @ `aecda23a7363f448fae37543ab5a9f4662e50e50`; deployed program `KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat`. SDK `@kamino-finance/distributor-sdk` v0.4.0 IDL matches the source on the load-bearing surface (newDistributor/newClaim arg order, error codes). Residual: if the program is upgradeable, deployed bytecode could diverge — diff the on-chain IDL at deploy time.

---

## ADP #1 — Can anyone claim before T today? YES.
`create-distributor.ts:97` `enableSlot: new BN(0)` disables the ONLY positive on-chain claim gate: `new_claim.rs:96-99` `require!(distributor.enable_slot <= curr_slot, ClaimingIsNotStarted)` (curr_slot = `Clock::get()?.slot`). `0 <= curr_slot` is always true. `start_vesting_ts`/`end_vesting_ts` never gate `new_claim` (amount_locked=0 makes the vesting path inert). The script funds in the same run (156-171), and the frontend "NOT YET LIVE" gate is cosmetic (proofMap.ts:71-76 checks placeholders; proof-map.json ships in the public bundle, so direct-RPC `newClaim` bypasses the UI). Fix = enforce the gate on-chain: far-future sentinel enable_slot + multisig `set_enable_slot(current_slot)` at T (verified: `handle_set_enable_slot` is an unconditional admin field write, so it can lower the sentinel), or the 400ms-floor formula from a required LAUNCH_TS.

---

## CRITICAL

### 1. No hard launch-time gate (enableSlot=0 + no T concept + create&fund-live-in-one-run)
- **Where:** `scripts/airdrop/create-distributor.ts:86-99, 156-171` vs `new_claim.rs:96-99`.
- **Scenario:** Ops runs the script on day X-2 to "pre-stage"; it creates with enable_slot=0 and funds in the same run. The instant funding confirms, every leaf is claimable. Anyone watching the funded vault on-chain (or reading the public proof-map) drains their allocation days before the announced T. `now = Date.now()/1000` (line 86) is script-run time, not a launch parameter — there is no T anywhere in the pipeline.
- **Fix:** See ADP answer. Introduce LAUNCH_TS; sentinel enable_slot + admin-flip at T (primary) or 400ms-floor (autonomous); read-back assert enableSlot; anchor clawbackStartTs to the launch, not Date.now().

---

## HIGH

### 2. Committed artifacts are the 3-wallet SAMPLE; build-tree defaults to the sample CSV; no expected-value guard
- **Where:** `scripts/airdrop/distributor-input.json` (maxTotalClaim=21340000, maxNumNodes=3, root 904c369d…), `proof-map.json` (3 placeholder claims); `build-tree.ts:69` (defaults to `allocation.csv`); `create-distributor.ts:90-91,164` read input verbatim.
- **Scenario:** Operator forgets the CSV arg or runs create against the committed sample → funds 21.34 tokens for 3 test wallets (AJBEz…, 6gEkt…, EEig…), ships a 3-claim app; the 380 real recipients get nothing and a distributor PDA + on-chain funds are burned.
- **Fix:** Remove the build-tree default; require explicit CSV. Regenerate from the real 380-wallet CSV as the last pre-create step. Add `EXPECT_NODES=380` / `EXPECT_TOTAL=775960887398266` guards in create-distributor; abort on mismatch. Don't commit sample artifacts to the launch branch.

### 3. Deployer SPOF during create→fund→handover; clawback permissionless and shortenable
- **Where:** `create-distributor.ts:78-99,140-171` (admin=deployer, funds, stops); handover only in `plan/AIRDROP_CLAIM_DEPLOY.md:93-118` (manual, post-funding). `clawback.rs:32-33` "Anyone can claw back", pays preset `clawback_receiver` (deployer ATA); `set_clawback_start_ts.rs` lets admin shorten to ~end_ts+1day.
- **Scenario:** Between funding and the manual handover, the full vault (775,960,887,398,266 base units) sits under the sole deployer key with all admin powers. If that key is compromised/malicious, attacker calls set_clawback_start_ts(end_ts+1day) then (anyone) the permissionless clawback ~24h later → entire vault to the deployer ATA, and clawed_back=true bricks all future claims (ClaimExpired/6013). The 365-day "deadline" is cosmetic.
- **Fix:** Reorder, baked into the script: create → assert → HANDOVER (set_clawback_receiver → multisig ATA, then set_admin → multisig, assert both) → THEN fund (funding needs no admin rights). Reduces SPOF to M-of-N; disclose the residual clawback-after-deadline power as inherent Kamino admin-trust.

### Supporting (HIGH, not a separate fix): frontend gate is cosmetic
`proofMap.ts:10,71-76` isFinalized() is a placeholder string check; proof-map.json is a static import inlined into the public Cloudflare bundle. Net client-side launch protection = ZERO. This is WHY blocker #1 must be solved on-chain. No code fix beyond #1 required; optionally add a UX-only Distributor.isClaimable() check (document as UX, not security).

---

## MEDIUM

### 4. On-chain mint never validated (decimals==6 AND legacy SPL, not Token-2022)
- **Where:** `create-distributor.ts:72` (tautological check vs the constant), 82/119/126/137/157/167 hardcode legacy TOKEN_PROGRAM_ID.
- **Scenario:** PERPAD minted as Token-2022 (common default) or with 9 decimals → ATA-create or transferChecked reverts LATE, after newDistributor already created an orphan frontrunnable PDA, with a cryptic error; a silently-accepted wrong-decimals mint would mis-scale the whole airdrop.
- **Fix:** Pre-flight getMint(MINT).decimals===6 and owner.equals(TOKEN_PROGRAM_ID) at the top of main(); fail closed.

### 5. Non-idempotent create (ephemeral base) → double-spend / orphaned funded distributor
- **Where:** `create-distributor.ts:78-79` (base=Keypair.generate(), never persisted), 140 (create), 156-171 (fund), no existence/balance pre-check. ClaimStatus is per-distributor (seeds ["ClaimStatus", claimant, distributor], plain `init`).
- **Scenario:** A second funded run mints a fresh distributor PDA with an empty ClaimStatus namespace; the same public proofs claim against BOTH → 2× payout (~1.55B tokens). A partial re-run (fund failed, or process died after funding) orphans a fully-funded distributor recoverable only via clawback after 365 days. proof-map.json is overwritten to whichever funded last.
- **Fix:** Pre-flight admin ATA balance >= maxTotalClaim; persist base to a gitignored file (re-fund the same D1 on retry); abort if a funded distributor for (mint, root) exists; lockfile + --force to re-run after success.

### 6. Low-SOL warning underestimates first-time-claim cost and is advisory-only
- **Where:** `claim.tsx:43` (MIN_SOL_LAMPORTS=3_000_000), :283 (button disabled only on inFlight/!finalized — lowSol absent).
- **Scenario:** Real first-time cost ≈ 3,660,280 lamports (ClaimStatus rent 1,566,000 + ATA rent 2,039,280 + base 5,000 + priority 50,000). Since PERPAD doesn't exist until launch, nearly every claimer is first-time. A wallet with ~0.0033 SOL sees no warning, clicks CLAIM, and it reverts on-chain with a generic toast.
- **Fix:** Raise MIN_SOL_LAMPORTS to ~4_200_000; specific message; consider gating the button. UX, not security.

---

## LOW (recommended, not launch-blocking)
- **Read-back asserts omit enableSlot/maxTotalClaim/version** (`create-distributor.ts:144-154`). Add them — cheap, and turns the launch gate (#1) and total (#2) into verified invariants. Fold into the #1/#2 fixes.
- **Non-idempotent ATA create on the live SDK path** (`claim.ts:54-57` → SDK utils.ts:56-61 non-idempotent createAssociatedTokenAccountInstruction). If the ATA appears between build and landing, the tx reverts with AccountAlreadyInUse; self-heals on retry. Swap to the idempotent variant.

---

## REFUTED (do not re-raise)
- **"Operational-only gating via 'fund at T' is fragile":** Refuted as a standalone blocker. An unfunded/under-funded vault genuinely makes `new_claim` revert at the token transfer (new_claim.rs:146), so "fund at/after T" is valid defense-in-depth — it is simply not the PRIMARY gate (enable_slot is). Folded into the runbook as belt-and-suspenders, not flagged as a vulnerability.
- **"Vesting window short-changes early claimers":** Refuted earlier — amount_locked=0 (merkle.ts:76), full value in amount_unlocked; start/end_vesting_ts are inert for this airdrop.

---

## LAUNCH RUNBOOK (real control surface — frontend gate is cosmetic)
1. (BEFORE T) Mint PERPAD: legacy SPL, EXACTLY 6 decimals. Verify with `spl-token display`.
2. (BEFORE T) Create M-of-N multisig + its $PERPAD ATA.
3. (BEFORE T) Regenerate tree from the REAL CSV; verify maxNumNodes=380, maxTotalClaim=775,960,887,398,266, self-verify passed.
4. (BEFORE T) Pre-flight: mint decimals/owner; admin ATA balance >= maxTotalClaim; EXPECT_NODES/EXPECT_TOTAL.
5. (BEFORE T) create-distributor with enableSlot = currentSlot + 1e9 (sentinel), closable=false; persist base; read-back assert incl. enableSlot. Claims now impossible even once funded.
6. (BEFORE T) HANDOVER: set_clawback_receiver → multisig ATA, then set_admin → multisig; assert both.
7. (BEFORE T) FUND exactly maxTotalClaim (plain transfer, works post-handover). Vault full, gate shut.
8. (BEFORE T) Inject distributor+mint into proof-map.json; build + test; deploy. Banner is cosmetic.
9. (AT T) Multisig calls set_enable_slot(current_slot) — the single switch that opens claims (verified lowerable). Probe one claim. [Autonomous fallback: instead set enableSlot via the 400ms floor at step 5 and skip this.]
10. (AFTER T) Monitor; advise ~0.0042 SOL; do NOT re-run create-distributor. Window = T → clawback_start_ts (~create+365d); thereafter only the multisig sweeps via clawback — disclose this residual.

---

## EMPIRICAL TEST (the one to run)
Re-bootstrap localnet cloning Kdisq… from mainnet; create with enableSlot = currentSlot + 1e9 (else identical, funded); run claim-driver claim1 (claimant1 AdMb9…, 2.09 → 2,090,000). PASS = revert with `custom program error: 0x1782` / `ClaimingIsNotStarted` / `6018`, balance stays 0, AND ClaimStatus PDA getAccountInfo == null (no state, no lockout). Control = the already-passed open-case E2E (same proof, enableSlot=0 → success 0→2,090,000). Same proof, only enableSlot changed → revert vs success isolates enable_slot as the sole gate.

---

## Launch Runbook (detailed — the real control surface)

1. (BEFORE T) Mint PERPAD as a LEGACY SPL Token (owner = Tokenkeg..., NOT Token-2022) with EXACTLY 6 decimals. Verify: `spl-token display <MINT>` shows the legacy program owner and Decimals: 6. This is an unguarded precondition the whole pipeline assumes.
2. (BEFORE T) Create the M-of-N multisig (e.g. Squads) and its $PERPAD ATA. Custody target must exist before handover.
3. (BEFORE T) Regenerate the tree from the REAL CSV: `bun run scripts/airdrop/build-tree.ts ~/Downloads/PERPAD_AIRDROP_ALLOCATION.csv`. Verify distributor-input.json: maxNumNodes == 380, maxTotalClaim == 775960887398266, decimals == 6, and the build's per-proof self-verify passed. Do NOT use the committed 3-wallet sample.
4. (BEFORE T) Add/run pre-flight asserts in create-distributor.ts: getMint(MINT).decimals == 6 and owner == TOKEN_PROGRAM_ID; admin ATA balance >= maxTotalClaim; EXPECT_NODES=380 / EXPECT_TOTAL=775960887398266. Abort on any mismatch.
5. (BEFORE T) Run create-distributor.ts with enableSlot = (await connection.getSlot()) + 1_000_000_000 (far-future SENTINEL) and closable = false. Persist the ephemeral `base` keypair to a gitignored file. Read-back assert: root, admin, clawbackReceiver, closable == false, tokenVault, enableSlot == sentinel, maxTotalClaim, maxNumNodes. Claims are now IMPOSSIBLE (enable_slot unreachable) even once funded.
6. (BEFORE T) HANDOVER, before funding: set_clawback_receiver -> multisig $PERPAD ATA, then set_admin -> multisig (order matters — once admin is the multisig you cannot single-key sign). Assert both on-chain. The full vault is now never under a sole deployer key.
7. (BEFORE T) FUND the vault with exactly maxTotalClaim (plain SPL transferChecked from the deployer ATA — needs no admin rights, works post-handover). Vault is full but claims remain shut by the sentinel enable_slot.
8. (BEFORE T) Inject distributor + mint into proof-map.json; `npm run build` && `npm run test`; deploy to Cloudflare. The site shows real data; the 'NOT YET LIVE' banner is cosmetic only — the real gate is on-chain. Do not rely on the frontend for security.
9. (AT T) Multisig executes set_enable_slot(current_slot). This is the SINGLE switch that opens claims; nothing before this multisig tx can claim. Confirm the tx, then run one probe claim to verify success. (Autonomous fallback: skip this step if at create you set enableSlot = currentSlot + ceil((T-now)*1000/400) via the 400ms floor — claims auto-open at-or-after T.)
10. (AFTER T) Monitor vault drawdown and claim success rate; advise users to hold ~0.0042 SOL for rent+fees. Do NOT re-run create-distributor.ts (non-idempotent — would mint a second funded distributor). The real claim window is T -> clawback_start_ts (~create+365d); after it, only the multisig can sweep unclaimed funds via permissionless clawback to the preset receiver — disclose this residual admin-trust.

---

## Empirical Test To Run (confirms the time-gate finding)

ONE test — the future-gate revert (isolates enable_slot as the sole claim gate). The finding is a deterministic code fact (enableSlot: new BN(0) literal vs the single require! at new_claim.rs:96-99), so this test confirms behavior; do not re-run the happy path — cite the already-passed E2E as the open-case control.

SETUP (reuse scratch-localnet/): bootstrap a localnet validator with scratch-localnet/solana-release/bin/solana-test-validator, cloning the deployed Kamino program from mainnet: `--clone KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat --clone <its program-data account> --url <mainnet RPC>` (the source clone is gone and ledger/ is stale, so re-bootstrap fresh). Use keys/admin.json (airdrop SOL; mint >= 5.59 PERPAD to its ATA), keys/mint.json as a legacy SPL mint with 6 decimals. Build the tree on scratch-localnet/alloc.csv (claimant1 AdMb9pQQjNse54aWEEdurA6Coz48ZANsKtjXX51iSRHg = 2.09 -> 2,090,000 base units; claimant2 E4egPSbqkBzKWiXntFAYCGandkEMdWXKoDxNq3NEtDTA = 3.5 -> 3,500,000).

ACTION: run create-distributor.ts with ONE edit — add `const currentSlot = await connection.getSlot();` and set `enableSlot: new BN(currentSlot + 1_000_000_000)` (a slot the localnet cannot reach); keep everything else identical (closable=false, read-back asserts, fund the vault with maxTotalClaim). Then run `bun run scratch-localnet/claim-driver.ts claim1` as claimant1 (drives the REAL src/lib/airdrop/claim.ts path).

EXPECTED (revert — three discriminating conditions, all required to pass): (1) claim-driver prints RESULT CLAIM_FAILED and PROGRAM_LOGS contain `Error Code: ClaimingIsNotStarted` / `Error Number: 6018` / `custom program error: 0x1782`; (2) claimant1 ATA balance stays 0 (no 2,090,000 delta); (3) the ClaimStatus PDA (seeds ["ClaimStatus", claimant1, distributor]) getAccountInfo == null — proving the gated attempt created NO state, so there is no lockout. A generic 'tx failed' is NOT a pass — it must be 0x1782 with no ClaimStatus PDA, else it could be a SOL/ATA/proof failure.

CONTROL (do not re-run — cite the settled E2E): with enableSlot=0/current slot the IDENTICAL proof already succeeded, moving 0 -> 2,090,000, and a double-claim was rejected by the ClaimStatus guard. Same proof, only enableSlot changed: revert (0x1782) vs success. PASS = the gated attempt reverts with 0x1782 and leaves no ClaimStatus PDA.
