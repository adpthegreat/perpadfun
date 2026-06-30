// Builds the claim instruction list for a single wallet. The page wraps these
// in a Transaction, signs with the adapter, and sends/polls (see claim.tsx).
//
// Normal path uses the SDK's getNewClaimIx, which fetches the distributor, auto-
// prepends the claimant ATA-create ix if missing, and builds newClaim with the
// legacy token program. We PREPEND ComputeBudget ixs because proof verify + ATA
// create blow past the 200k default CU (forgetting this fails ONLY first-time-ATA
// wallets — easy to miss).
//
// getNewClaimIx takes amountLamports:number and does `new BN(number)` internally,
// so a base-unit value >= 2^53 would silently lose precision -> wrong leaf ->
// on-chain InvalidProof. build-tree.ts asserts every amount < 2^53, so the normal
// path is always safe; the manual branch below is a belt-and-suspenders fallback
// that hand-builds newClaim with BN(string) and is dead-by-construction given the
// build assert.
import "@/lib/buffer-polyfill";
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { Distributor, MerkleDistributor, newClaim } from "@kamino-finance/distributor-sdk";
import { deriveClaimStatusPda, DISTRIBUTOR_PROGRAM_ID } from "./pda";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
/** proof verify + ATA create exceed the 200k default. */
export const CLAIM_CU_LIMIT = 1_000_000;
/** small priority fee so the claim lands promptly. */
export const CLAIM_PRIORITY_MICROLAMPORTS = 50_000;

/**
 * Build the full ordered instruction list for a claim, including ComputeBudget.
 * @param amountStr u64 base units as a decimal string (exact).
 * @param proof number[][] sibling hashes, leaf->root.
 */
export async function buildClaimInstructions(
  connection: Connection,
  distributor: PublicKey,
  user: PublicKey,
  amountStr: string,
  proof: number[][],
): Promise<TransactionInstruction[]> {
  const amount = BigInt(amountStr);

  let claimIxs: TransactionInstruction[];
  if (amount <= MAX_SAFE) {
    // Normal path: SDK builds ATA-create (if needed) + newClaim.
    const dist = new Distributor(connection);
    claimIxs = await dist.getNewClaimIx(distributor, user, Number(amountStr), proof);
  } else {
    // Manual path (dead-by-construction): BN(string) keeps precision for amounts
    // >= 2^53. Replicate the SDK's accounts + an idempotent ATA-create.
    const state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
    if (!state) throw new Error("Distributor not found");
    const mint = state.mint;
    const tokenVault = state.tokenVault;
    const userAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID);
    const claimStatus = deriveClaimStatusPda(user, distributor);
    claimIxs = [
      createAssociatedTokenAccountIdempotentInstruction(user, userAta, user, mint, TOKEN_PROGRAM_ID),
      newClaim(
        { amountUnlocked: new BN(amountStr), amountLocked: new BN(0), proof },
        {
          distributor,
          claimStatus,
          from: tokenVault,
          to: userAta,
          claimant: user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
        DISTRIBUTOR_PROGRAM_ID,
      ),
    ];
  }

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CLAIM_PRIORITY_MICROLAMPORTS }),
    ...claimIxs,
  ];
}
