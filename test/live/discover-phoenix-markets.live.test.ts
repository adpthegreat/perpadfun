// Hits Imperial's /phoenix/markets endpoint (authenticated) to discover the
// supported assets, their max leverage, and any market metadata we need to
// pin into SUPPORTED_MARKETS in keeper/src/imperial.js.
//
// $0 cost — read-only. Run when refreshing the Phoenix support table.
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

liveSuite("Discover phoenix markets + max leverage", () => {
  it("fetches /phoenix/markets and prints a SUPPORTED_MARKETS-ready table", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const base = process.env.IMPERIAL_BASE_URL || "https://api.imperial.space/api/v1";
    const r = await fetch(`${base}/phoenix/markets`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const txt = await r.text();
    let res;
    try {
      res = JSON.parse(txt);
    } catch (e) {
      console.log("[phoenix:markets] raw response (not JSON):");
      console.log(txt.slice(0, 3000));
      throw e;
    }
    const rows = Array.isArray(res) ? res : (res?.rows || res?.data || Object.values(res ?? {}));
    console.log(`\n[phoenix:markets] ${rows.length} markets:\n`);

    type Row = { sym: string; maxLev?: number; marketMint?: string; raw: Record<string, unknown> };
    const distilled: Row[] = [];
    for (const m of rows as Array<Record<string, unknown>>) {
      const sym = String(
        (m.symbol as string) ||
          (m.asset as string) ||
          (m.name as string) ||
          (m.marketName as string) ||
          "",
      ).toUpperCase();
      const maxLev = (m.maxLeverage ?? m.max_leverage ?? m.leverage) as number | undefined;
      const marketMint = (m.marketMint ??
        m.baseMint ??
        m.market_mint ??
        m.mint) as string | undefined;
      console.log(
        `  ${sym.padEnd(14)} maxLev=${String(maxLev).padStart(5)} ` +
        `mint=${marketMint ?? "-"}`,
      );
      if (sym) distilled.push({ sym, maxLev, marketMint, raw: m });
    }

    // Print a SUPPORTED_MARKETS-ready snippet for direct paste into imperial.js
    console.log(`\n[phoenix:markets] SUPPORTED_MARKETS snippet for imperial.js:\n`);
    console.log("export const SUPPORTED_MARKETS = {");
    const seen = new Set<string>();
    for (const r of distilled) {
      if (seen.has(r.sym)) continue;
      seen.add(r.sym);
      const lev = r.maxLev ?? "null";
      const mint = r.marketMint ? `"${r.marketMint}"` : "null";
      console.log(
        `  ${r.sym}: { venue: "phoenix", maxLeverage: ${lev}, marketMint: ${mint} },`,
      );
    }
    console.log("};");
  }, 60_000);
});
