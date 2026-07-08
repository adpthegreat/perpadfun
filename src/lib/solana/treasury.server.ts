import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";

let cached: Keypair | null = null;

// Shared decoder: accepts base58 (88 chars) OR JSON array of 64 ints — matches
// the treasury / vanity-mint / recovery-CLI formats so operators never have to
// remember which shape a given secret expects.
function decodeSecretKey(secret: string, envName: string): Keypair {
  const v = secret.trim();
  let bytes: Uint8Array;
  if (v.startsWith("[")) {
    bytes = new Uint8Array(JSON.parse(v));
  } else {
    bytes = bs58.decode(v);
  }
  if (bytes.length !== 64) throw new Error(`${envName} length ${bytes.length} (expected 64)`);
  return Keypair.fromSecretKey(bytes);
}

export function getTreasuryKeypair(): Keypair {
  if (cached) return cached;
  const secret = process.env.TREASURY_SECRET_KEY;
  if (!secret) throw new Error("TREASURY_SECRET_KEY is not configured");
  cached = decodeSecretKey(secret, "TREASURY_SECRET_KEY");
  return cached;
}


export function getServerConnection(): Connection {
  return new Connection(getServerSolanaRpcUrl(), "confirmed");
}
