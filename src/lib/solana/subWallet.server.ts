import { Keypair } from "@solana/web3.js";
import { createHmac } from "crypto";
import bs58 from "bs58";
import { getTreasuryKeypair } from "./treasury.server";

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
