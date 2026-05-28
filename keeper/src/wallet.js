import { Keypair } from '@solana/web3.js';
import { createHmac } from 'node:crypto';
import bs58 from 'bs58';

export function loadKeypair(secret) {
  const trimmed = secret.trim();
  let bytes;
  if (trimmed.startsWith('[')) {
    bytes = new Uint8Array(JSON.parse(trimmed));
  } else {
    bytes = bs58.decode(trimmed);
  }
  if (bytes.length !== 64) {
    throw new Error(`Treasury key must be 64 bytes (got ${bytes.length})`);
  }
  return Keypair.fromSecretKey(bytes);
}

// MUST mirror src/lib/solana/subWallet.server.ts exactly:
//   seed = HMAC_SHA256(masterSecretKey, "perpad-subwallet-v1:" + tokenId)
//   kp   = Keypair.fromSeed(seed)
// Any drift in the prefix string or hashing scheme orphans every existing
// sub-wallet, so do NOT change the constant without coordinated rotation.
export function deriveSubKeypair(masterKp, tokenId) {
  if (!tokenId) throw new Error('deriveSubKeypair: tokenId required');
  const seed = createHmac('sha256', Buffer.from(masterKp.secretKey))
    .update(`perpad-subwallet-v1:${tokenId}`)
    .digest();
  return Keypair.fromSeed(new Uint8Array(seed));
}

// Resolver used across keeper modules. Returns the sub-wallet keypair when
// the row carries a matching `treasury_wallet_address` (new-launch path),
// otherwise falls back to the master keypair (legacy tokens whose on-chain
// DBC config still has master as feeClaimer).
export function walletForToken(masterKp, token) {
  const addr = token?.treasury_wallet_address;
  if (!addr || !token?.id) return masterKp;
  const masterAddr = masterKp.publicKey.toBase58();
  // Legacy tokens (pre-sub-wallet) store the master pubkey directly; their
  // on-chain feeClaimer is master, so sign with master.
  if (addr === masterAddr) return masterKp;
  const sub = deriveSubKeypair(masterKp, token.id);
  const subAddr = sub.publicKey.toBase58();
  if (subAddr === addr) return sub;

  // If the keeper is deployed with TREASURY_SOLANA_PRIVATE_KEY while the app
  // derived sub-wallets from TREASURY_SECRET_KEY, master may differ from the
  // row's legacy treasury address. Still allow the real PERPAD legacy row to
  // use its stored master treasury so a derived sub-wallet mismatch does not
  // block ticks, fee claims, or perps for the main token.
  const ticker = String(token?.ticker ?? '').toUpperCase();
  const isPerpadLegacyMaster = ticker === 'PERPAD'
    && addr === '9Kxfhk9JMckpzAmGm1hXFjdfdL4VjpHvBKu9p4kJWHB7';
  if (isPerpadLegacyMaster) return masterKp;

  if (subAddr !== addr) {
    // Mismatch means TREASURY_SECRET_KEY was rotated since the row was
    // created, or the row was hand-edited. Refuse to sign with the wrong
    // wallet; the loop will surface this in logs.
    throw new Error(
      `sub-wallet mismatch for token=${token.id}: master=${masterAddr} derived=${subAddr} stored=${addr}`,
    );
  }
}
