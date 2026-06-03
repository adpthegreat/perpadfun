// Diagnostic: read the open Flash position and dump every field name so we
// can spot which ID/PDA the close might need.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import { authenticate, getPositions } from "../../keeper/src/imperial.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function loadKp(): Keypair {
  const raw = process.env.LIVE_TEST_PRIVATE_KEY;
  if (!raw) throw new Error("Missing LIVE_TEST_PRIVATE_KEY");
  try {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}

liveSuite("Diagnostic: dump open Flash HYPE position fields", () => {
  it("prints the whole record", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const wallet = auth.pubkey ?? kp.publicKey.toBase58();
    const posRes = await getPositions(wallet, { token: auth.token });
    const positions = ((posRes as Record<string, unknown>)?.dataList ??
      (posRes as Record<string, unknown>)?.positions ??
      (Array.isArray(posRes) ? posRes : [])) as Array<Record<string, unknown>>;
    console.log(`\n${positions.length} position(s)\n`);
    for (const p of positions) {
      console.log("─".repeat(70));
      console.log(JSON.stringify(p, null, 2));
    }
  }, 60_000);
});
