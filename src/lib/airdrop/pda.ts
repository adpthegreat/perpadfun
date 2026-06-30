// Kamino Merkle Distributor PDA derivation. The program is deployed by Kamino on
// MAINNET ONLY (program id below) — it is NOT on devnet/testnet (verified via
// getAccountInfo: value:null on both). We never deploy it. To test against it,
// clone the mainnet program into a local validator:
//   solana-test-validator --clone-upgradeable-program <id> --url mainnet-beta
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { u64ToLeBytes } from "./merkle";

/** Kamino Merkle Distributor program id (mainnet-beta; absent on devnet/testnet). */
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
