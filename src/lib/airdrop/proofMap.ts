// Typed, Buffer-free accessor over the bundled static proof map. The page never
// builds the tree client-side — it just looks up a wallet's precomputed proof.
//
// proof-map.json is emitted by scripts/airdrop/build-tree.ts (claims + root) and
// finalized by scripts/airdrop/create-distributor.ts (which injects the
// distributor PDA + mint once the on-chain distributor exists). amounts stay as
// u64 base-unit STRINGS for exactness; build-tree asserts every amount < 2^53 so
// Number(amount) is lossless for getNewClaimIx (which takes a JS number).
import { PublicKey } from "@solana/web3.js";
import proofMapJson from "./proof-map.json";

export interface RawClaim {
  /** u64 base units as a decimal string */
  amount: string;
  /** ordered sibling hashes leaf->root, 32 bytes each */
  proof: number[][];
  /** base58 MerkleDistributor PDA (== top-level distributor for a single shard) */
  distributor: string;
}

export interface ProofMapFile {
  distributor: string;
  mint: string;
  version: number;
  /** base58 merkle root, for display/debug */
  root?: string;
  claims: Record<string, RawClaim>;
}

const data = proofMapJson as ProofMapFile;

export interface Claim {
  /** u64 base units, exact decimal string */
  amountStr: string;
  /** same value as a JS number (guaranteed < 2^53 by the build assert) */
  amountNumber: number;
  proof: number[][];
  distributor: PublicKey;
}

/** Look up a wallet's claim, or null if it is not in the airdrop. */
export function getClaim(wallet: string): Claim | null {
  const raw = data.claims[wallet];
  if (!raw) return null;
  return {
    amountStr: raw.amount,
    amountNumber: Number(raw.amount),
    proof: raw.proof,
    distributor: new PublicKey(raw.distributor),
  };
}

/** The airdrop token mint. */
export function getMint(): PublicKey {
  return new PublicKey(data.mint);
}

/** The (single-shard) distributor PDA. */
export function getDistributor(): PublicKey {
  return new PublicKey(data.distributor);
}

/** Aggregate stats for display. */
export function getStats(): { totalWallets: number; totalBaseUnits: bigint } {
  let total = 0n;
  for (const c of Object.values(data.claims)) total += BigInt(c.amount);
  return { totalWallets: Object.keys(data.claims).length, totalBaseUnits: total };
}

/** True once create-distributor.ts has injected a real distributor + mint. */
export function isFinalized(): boolean {
  return (
    data.distributor !== "11111111111111111111111111111111" &&
    data.mint !== "11111111111111111111111111111111"
  );
}
