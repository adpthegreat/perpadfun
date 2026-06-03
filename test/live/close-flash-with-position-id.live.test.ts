// Try Flash close with positionId from /positions[*].positionPda — the
// missing field that may have been silently rejecting our action=1 orders.
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

liveSuite("Close stale Flash position with positionId", () => {
  it("read positionPda → close with positionId", async () => {
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
      console.log("[close] no flash HYPE position open");
      return;
    }
    const positionId = String(flashHype.positionPda || flashHype.positionId || "");
    const side = String(flashHype.side ?? "long").toLowerCase() === "short" ? "short" : "long";
    const sizeUsd = Number(flashHype.sizeUsd ?? 0);
    console.log(
      `[close] flash HYPE: positionPda=${positionId} side=${side} size=$${sizeUsd}`,
    );

    if (!positionId) {
      console.log("[close] no positionPda on record — cannot send positionId");
      return;
    }

    const mark = await directMarkPrice("HYPE", "flash_trade");
    console.log(`[close] markPrice=${mark}`);

    // Try full close first with positionId + healthy slippage
    console.log(`\n[close] try: full close with positionId + 1000bps`);
    const res = await directClose({
      token: auth.token,
      venue: "flash_trade",
      wallet,
      symbol: "HYPE",
      side,
      closeSizeUsd: sizeUsd,
      slippageBps: 1000,
      profileIndex: 0,
      marketPrice: mark!,
      positionId,
    });
    console.log(
      `  resp success=${res.success} sig=${res.signature?.slice(0, 16) ?? "(none)"}... err=${res.error ?? "none"}`,
    );
    if (res.success && res.signature) {
      appendTxnLog(
        `${new Date().toISOString()} | venue=flash_trade | action=close_full | symbol=HYPE | wallet=${wallet} | profile=0 | profilePda=DmCWVtZg3Suen1GqG8tefmBbmXRUWu9YWDtCbfPsQoLt | sig=${res.signature} | strategy="full+positionId" sizeUsd=$${sizeUsd} positionPda=${positionId} resp.success=true`,
      );

      // Wait + verify
      console.log(`\n[close] waiting 15s for settle...`);
      await new Promise((r) => setTimeout(r, 15000));
      const reread = await getPositions(wallet, { token: auth.token });
      const stillOpen = ((reread as Record<string, unknown>)?.dataList ?? []) as Array<
        Record<string, unknown>
      >;
      const remaining = stillOpen.find(
        (p) =>
          String(p.asset ?? "").toUpperCase() === "HYPE" &&
          String(p.underwriter ?? "").toLowerCase() === "flash_trade" &&
          Number(p.sizeUsd ?? 0) > 0,
      );
      if (!remaining) {
        console.log(`[close] ✓ position closed`);
      } else {
        console.log(
          `[close] partial — remaining size=$${Number(remaining.sizeUsd).toFixed(2)}`,
        );
      }
    }
  }, 120_000);
});
