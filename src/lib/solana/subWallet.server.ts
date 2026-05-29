import { Keypair } from "@solana/web3.js";
import { createHmac, randomUUID } from "crypto";
import bs58 from "bs58";
import { getTreasuryKeypair } from "./treasury.server";

// Every perpad token uses Imperial profile slot 1 under its OWN sub-wallet.
// Isolation comes from the per-token sub-wallet (the signer), not the index —
// so the index is a constant. Single source of truth for both the native and
// external creation paths.
export const TOKEN_IMPERIAL_PROFILE_INDEX = 1;

/**
 * Derive a deterministic per-token sub-wallet from the master treasury secret.
 *
 * seed = HMAC_SHA256(masterSecretKey, "perpad-subwallet-v1:" + tokenId)
 *
 * The seed is 32 bytes, exactly what Keypair.fromSeed expects. Same tokenId
 * always returns the same keypair. No private keys ever hit the database.
 *
 * Rotating TREASURY_SECRET_KEY would orphan every existing sub-wallet, so
 * sweep funds back to master before any rotation.
 */
export function deriveSubWalletKeypair(tokenId: string): Keypair {
  const master = getTreasuryKeypair();
  const seed = createHmac("sha256", Buffer.from(master.secretKey))
    .update(`perpad-subwallet-v1:${tokenId}`)
    .digest();
  return Keypair.fromSeed(new Uint8Array(seed));
}

export function deriveSubWalletAddress(tokenId: string): string {
  return deriveSubWalletKeypair(tokenId).publicKey.toBase58();
}

export function exportSubWalletPrivateKeyBase58(tokenId: string): string {
  const kp = deriveSubWalletKeypair(tokenId);
  return bs58.encode(kp.secretKey);
}

// The invariants every token row must carry from the instant it is created.
// Computed from the (deterministic) token id, so they can be written in the
// SAME insert — never a fallible post-insert step.
export function tokenInvariantsFor(tokenId: string): {
  treasury_wallet_address: string;
  imperial_profile_index: number;
} {
  return {
    treasury_wallet_address: deriveSubWalletAddress(tokenId),
    imperial_profile_index: TOKEN_IMPERIAL_PROFILE_INDEX,
  };
}

// Fresh identity for a brand-new token: a pre-generated id plus its invariants,
// so the whole row can be inserted atomically.
export function newTokenIdentity(): { id: string } & ReturnType<typeof tokenInvariantsFor> {
  const id = randomUUID();
  return { id, ...tokenInvariantsFor(id) };
}
