// Authenticate against Imperial mainnet using a DEDICATED test wallet.
//
// Hard rule: this MUST NOT fall through to the production keeper treasury
// (`config.treasuryKey`). The live tests open and close real positions on
// the wallet they authenticate with; if they ran against the prod treasury
// they'd interleave with the keeper loop's own activity and produce ghost
// positions / failed reconciles. Use a dedicated test wallet, configured
// in test/live/.env (copy from .env.example).
import { authenticate } from "../../../keeper/src/imperial.js";
import { loadKeypair } from "../../../keeper/src/wallet.js";

export interface LiveAuth {
  kp: ReturnType<typeof loadKeypair>;
  wallet: string;
  token: string;
}

let _cached: LiveAuth | null = null;

function readLiveKey(): string {
  const raw = process.env.LIVE_TEST_PRIVATE_KEY;
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "LIVE_TEST_PRIVATE_KEY is not set.\n" +
        "  1. Copy test/live/.env.example -> test/live/.env\n" +
        "  2. Generate a dedicated wallet: solana-keygen new -o test-wallet.json\n" +
        "  3. Paste the JSON byte array (or base58) into LIVE_TEST_PRIVATE_KEY\n" +
        "  4. Fund the wallet with ~$50 USDC + 0.05 SOL on mainnet\n" +
        "  5. Sign into Imperial once via the frontend so the wallet is registered\n" +
        "\n" +
        "DO NOT use the production keeper treasury key (TREASURY_SOLANA_PRIVATE_KEY).",
    );
  }
  // Guard: refuse to run if LIVE_TEST_PRIVATE_KEY happens to match
  // TREASURY_SOLANA_PRIVATE_KEY. The live tests will open and close positions
  // on this wallet — they MUST be isolated from production.
  const treasury = process.env.TREASURY_SOLANA_PRIVATE_KEY;
  if (treasury && raw.trim() === treasury.trim()) {
    throw new Error(
      "LIVE_TEST_PRIVATE_KEY matches TREASURY_SOLANA_PRIVATE_KEY.\n" +
        "These tests open + close positions on the authenticated wallet and would\n" +
        "interleave with the production keeper loop. Use a SEPARATE wallet.",
    );
  }
  return raw;
}

// Authenticate once per process. The token is good for the lifetime of a test
// run; if a test runs multi-hour we'd refresh, but the suite caps at <5min.
export async function liveAuth(): Promise<LiveAuth> {
  if (_cached) return _cached;
  const kp = loadKeypair(readLiveKey());
  const wallet = kp.publicKey.toBase58();
  const auth = await authenticate(kp);
  if (!auth?.token) throw new Error("liveAuth: authenticate() returned no token");
  _cached = { kp, wallet, token: auth.token };
  return _cached;
}
