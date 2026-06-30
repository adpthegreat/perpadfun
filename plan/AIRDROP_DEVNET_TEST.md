# Devnet test — why a redeploy doesn't work, and what does

The Kamino merkle distributor is **mainnet-only** — `KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat`
returns `value:null` from `getAccountInfo` on **devnet and testnet** (only `executable:true` on
mainnet-beta).

We tried the obvious thing — dump the mainnet program and redeploy a copy to devnet under a new
program id. **It does not work:** the copy deploys fine, but every instruction reverts with Anchor
**`DeclaredProgramIdMismatch` (error 4100 / 0x1004)**. The program's bytecode embeds
`declare_id!(Kdisq…)`, and Anchor's runtime guard rejects execution whenever the deployed address ≠
the declared id. So a dumped-binary redeploy can never run; the program would have to be **rebuilt
from source** with `declare_id!(<new devnet id>)` (`cargo build-sbf` on
`github.com/Kamino-Finance/distributor`) and redeployed — and the client would also need the program
id threaded through every SDK call (the SDK's `Distributor` helper hardcodes the mainnet id and takes
no `programId` argument).

## The validated approach: localnet clone (what we used)
```
solana-test-validator --clone-upgradeable-program KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat \
  --url mainnet-beta
```
This clones the program **at its real address**, so `declare_id` matches and the **exact mainnet
bytecode** runs locally. `scratch-localnet/integration-test.ts` drives the full
create → handover → gate → open → claim → replay flow against it and asserts **19/19** (gated claim
reverts `ClaimingIsNotStarted` 0x1782 with no `ClaimStatus` lockout; `set_enable_slot` opens it;
claim succeeds 0 → 2,090,000; replay reverts). This validates the real program + our code with **no
rebuild** — it is the recommended way to test a mainnet-only program.

## The real-cluster check that matters
A single **mainnet test-claim (one wallet)** at deploy time — already in
`plan/AIRDROP_CLAIM_DEPLOY.md §0a` and the audit runbook. That exercises the genuine program +
genuine $PERPAD on the real cluster, cheaply, right before opening the gate.

## If a clickable devnet instance is still wanted
Rebuild the program from source with a devnet `declare_id`, deploy it, then thread that program id
through the SDK calls (`newDistributor(..., programId)`, and replace the `Distributor` helper in the
claim path with the manual `newClaim(..., programId)` path). Non-trivial, and it adds no correctness
coverage over the localnet clone — so it is not on the critical path to launch.
