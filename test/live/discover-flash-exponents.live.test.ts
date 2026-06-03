// Hits Imperial's /flash/markets endpoint (authenticated) to discover the
// per-asset priceExponent values. Output is logged so the operator can paste
// the resulting FLASH_PRICE_EXPONENTS env value into their .env.
//
// $0 cost — read-only.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import { authenticate } from "../../keeper/src/imperial.js";
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

liveSuite("Discover flash_trade priceExponent per market", () => {
  it("fetches /flash/markets and prints exponent table", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const base = process.env.IMPERIAL_BASE_URL || "https://api.imperial.space/api/v1";
    const r = await fetch(`${base}/flash/markets`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const txt = await r.text();
    let res;
    try {
      res = JSON.parse(txt);
    } catch (e) {
      console.log("[flash:markets] raw response (not JSON):");
      console.log(txt.slice(0, 3000));
      throw e;
    }
    const rows = Array.isArray(res) ? res : (res?.rows || res?.data || Object.values(res ?? {}));
    console.log(`\n[flash:markets] ${rows.length} markets:\n`);
    const exponents: Record<string, number> = {};
    for (const m of rows) {
      const sym = (m.symbol || m.asset || m.name || m.poolName || "").toUpperCase();
      const exp = m.priceExponent;
      console.log(
        `  ${sym.padEnd(12)} priceExp=${String(exp).padStart(4)} ` +
        `sizeExp=${m.sizeExponent ?? "-"} maxLev=${m.maxLeverage ?? "-"}`,
      );
      if (sym && exp !== undefined && exp !== null) exponents[sym] = exp;
    }
    const envValue = Object.entries(exponents).map(([k, v]) => `${k}=${v}`).join(",");
    console.log(`\n[flash:markets] FLASH_PRICE_EXPONENTS=${envValue}\n`);
    console.log("Paste the above into test/live/.env or your keeper env.");
  }, 60_000);
});
