// Kamino Merkle Distributor PDA derivation. The program is deployed by Kamino
// at the same address on ALL clusters; we never deploy it.
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { u64ToLeBytes } from "./merkle";

/** Kamino Merkle Distributor program id (same on every cluster). */
export const DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  "KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat",
);

/**
 * Distributor PDA seeds: ["MerkleDistributor", base[32], mint[32], version u64-LE].
 * version == shard index; a single shard (<=12000 wallets) uses version 0.
 */
export function deriveDistributorPda(
  base: PublicKey,
  mint: PublicKey,
  version: number | bigint = 0,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("MerkleDistributor"),
      base.toBuffer(),
      mint.toBuffer(),
      Buffer.from(u64ToLeBytes(BigInt(version))),
    ],
    DISTRIBUTOR_PROGRAM_ID,
  );
  return pda;
}

/** ClaimStatus PDA seeds: ["ClaimStatus", claimant[32], distributor[32]]. */
export function deriveClaimStatusPda(
  claimant: PublicKey,
  distributor: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), claimant.toBuffer(), distributor.toBuffer()],
    DISTRIBUTOR_PROGRAM_ID,
  );
  return pda;
}

// Re-export BN so script callers share the exact instance the SDK uses.
export { BN };
