// Kamino Merkle Distributor PDA derivation. The program is deployed by Kamino on
// MAINNET ONLY (program id below) — it is NOT on devnet/testnet (verified via
// getAccountInfo: value:null on both). We never deploy it. To test against it,
// clone the mainnet program into a local validator:
//   solana-test-validator --clone-upgradeable-program <id> --url mainnet-beta
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { u64ToLeBytes } from "./merkle";

/** Mainnet-beta Kamino distributor — the default (the program is absent on devnet/testnet). */
const MAINNET_DISTRIBUTOR_PROGRAM_ID = "KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat";

/**
 * Resolve the distributor program id. Defaults to mainnet; overridable for
 * devnet/test deploys (where a COPY of the program is deployed under a new id —
 * see plan/AIRDROP_DEVNET_TEST.md):
 *   - ops scripts (node/bun):  DISTRIBUTOR_PROGRAM_ID env
 *   - client/Worker build:     VITE_DISTRIBUTOR_PROGRAM_ID (baked at build time)
 */
function resolveDistributorProgramId(): string {
  if (typeof process !== "undefined" && process.env?.DISTRIBUTOR_PROGRAM_ID) {
    return process.env.DISTRIBUTOR_PROGRAM_ID;
  }
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.VITE_DISTRIBUTOR_PROGRAM_ID) return env.VITE_DISTRIBUTOR_PROGRAM_ID;
  } catch {
    /* import.meta.env unavailable (non-Vite runtime) */
  }
  return MAINNET_DISTRIBUTOR_PROGRAM_ID;
}

/** Kamino Merkle Distributor program id (mainnet default; env-overridable for devnet). */
export const DISTRIBUTOR_PROGRAM_ID = new PublicKey(resolveDistributorProgramId());

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
