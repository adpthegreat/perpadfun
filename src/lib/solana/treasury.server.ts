import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";

let cached: Keypair | null = null;

export function getTreasuryKeypair(): Keypair {
  if (cached) return cached;
  const secret = process.env.TREASURY_SECRET_KEY;
  if (!secret) throw new Error("TREASURY_SECRET_KEY is not configured");
  // Accept either base58 (88 chars) or comma/JSON array of 64 numbers.
  let bytes: Uint8Array;
  if (secret.trim().startsWith("[")) {
    bytes = new Uint8Array(JSON.parse(secret));
  } else {
    bytes = bs58.decode(secret.trim());
  }
  if (bytes.length !== 64) throw new Error(`TREASURY_SECRET_KEY length ${bytes.length} (expected 64)`);
  cached = Keypair.fromSecretKey(bytes);
  return cached;
}

export function getServerConnection(): Connection {
  return new Connection(getServerSolanaRpcUrl(), "confirmed");
}
