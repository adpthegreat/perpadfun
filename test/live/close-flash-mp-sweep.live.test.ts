// Sweep marketPrice scaling for Flash close. positionId now present; what
// remains is figuring out which marketPrice value Flash close actually wants.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import { authenticate, getPositions } from "../../keeper/src/imperial.js";
import { directClose, directMarkPrice } from "./helpers/direct-order.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";

function loadKp(): Keypair {
  const raw = process.env.LIVE_TEST_PRIVATE_KEY;
  if (!raw) throw new Error("Missing LIVE_TEST_PRIVATE_KEY");
  try {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}

function appendTxnLog(line: string) {
  const path = "test/live/txns.txt";
  if (fs.existsSync(path)) fs.appendFileSync(path, line + "\n");
}

liveSuite("Flash close — marketPrice sweep", () => {
  it("try multiple marketPrice scalings", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const wallet = auth.pubkey ?? kp.publicKey.toBase58();

    const posRes = await getPositions(wallet, { token: auth.token });
    const positions = ((posRes as Record<string, unknown>)?.dataList ??
      []) as Array<Record<string, unknown>>;
    const flashHype = positions.find(
      (p) =>
        String(p.asset ?? p.symbol ?? "").toUpperCase() === "HYPE" &&
        String(p.underwriter ?? p.venue ?? "").toLowerCase() === "flash_trade",
    );
    if (!flashHype) {
      console.log("[close] no flash HYPE position");
      return;
    }
    const positionId = String(flashHype.positionPda || "");
    const side = String(flashHype.side ?? "long").toLowerCase() === "short" ? "short" : "long";
    const sizeUsd = Number(flashHype.sizeUsd ?? 0);
    const markRaw = await directMarkPrice("HYPE", "flash_trade");
    if (!markRaw) {
      console.log("[close] no mark");
      return;
    }
    console.log(
      `[close] position pda=${positionId} side=${side} size=$${sizeUsd} mark(raw1e9)=${markRaw}`,
    );

    // Build candidate marketPrice values
    const candidates: Array<{ label: string; mp: number }> = [
      { label: "raw 1e9 (control — known fail)", mp: markRaw },
      { label: "/10 (priceExp -8)", mp: Math.round(markRaw / 10) },
      { label: "/100", mp: Math.round(markRaw / 100) },
      { label: "/1000 (phoenix-style)", mp: Math.round(markRaw / 1000) },
      { label: "0 (let server resolve)", mp: 0 },
    ];

    for (const c of candidates) {
      console.log(`\n[close] try ${c.label}: marketPrice=${c.mp}`);
      try {
        const res = await directClose({
          token: auth.token,
          venue: "flash_trade",
          wallet,
          symbol: "HYPE",
          side,
          closeSizeUsd: sizeUsd,
          slippageBps: 1000,
          profileIndex: 0,
          marketPrice: c.mp,
          positionId,
        });
        console.log(
          `  resp success=${res.success} sig=${res.signature?.slice(0, 16) ?? "(none)"}... err=${res.error ?? "none"}`,
        );
        if (res.success && res.signature) {
          appendTxnLog(
            `${new Date().toISOString()} | venue=flash_trade | action=close_full | symbol=HYPE | wallet=${wallet} | profile=0 | profilePda=DmCWVtZg3Suen1GqG8tefmBbmXRUWu9YWDtCbfPsQoLt | sig=${res.signature} | strategy="${c.label}" mp=${c.mp} positionId=${positionId} resp.success=true`,
          );
          console.log("[close] ✓ POSITION CLOSED — winning scaling above.");
          return;
        }
      } catch (e) {
        console.log(`  threw: ${(e as Error).message.slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("\n[close] no marketPrice scaling worked — Flash server-side close path is broken");
  }, 180_000);
});
