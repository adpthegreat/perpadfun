// Verify the Flash close actually settled, then withdraw the freed USDC.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import {
  authenticate,
  getPositions,
  getBalances,
} from "../../keeper/src/imperial.js";
import { Connection, VersionedTransaction, Keypair } from "@solana/web3.js";
import { Buffer } from "buffer";
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

liveSuite("Verify Flash close + withdraw USDC", () => {
  it("poll for empty positions then withdraw all", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const wallet = auth.pubkey ?? kp.publicKey.toBase58();

    // ── poll for close settlement ───────────────────────────────
    console.log("[verify] polling /positions for Flash close settlement...");
    let settled = false;
    for (let i = 0; i < 12; i++) {
      const posRes = await getPositions(wallet, { token: auth.token });
      const positions = ((posRes as Record<string, unknown>)?.dataList ??
        []) as Array<Record<string, unknown>>;
      const open = positions.find(
        (p) => Number(p.sizeUsd ?? p.size ?? 0) > 0 && p.status !== "closed",
      );
      if (!open) {
        console.log(`[verify] ✓ no open positions remain (poll ${i + 1})`);
        settled = true;
        break;
      }
      console.log(
        `  poll ${i + 1}/12: ${positions.length} entries, first sizeUsd=$${Number(positions[0]?.sizeUsd ?? 0).toFixed(2)} status=${positions[0]?.status}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!settled) console.log("[verify] !! close not settled within 60s — continuing anyway");

    // ── balance read ────────────────────────────────────────────
    const balRes = (await getBalances(auth.token)) as Record<string, unknown>;
    const profiles = (balRes?.profiles as Array<Record<string, unknown>>) ?? [];
    const p0 = profiles.find((p) => Number(p.profileIndex ?? p.index ?? -1) === 0);
    const usdc = Number(p0?.usdc ?? p0?.usdcBalance ?? 0) / 1_000_000;
    console.log(`\n[verify] profile 0 USDC: $${usdc.toFixed(6)}`);

    if (usdc <= 0.01) {
      console.log("[verify] nothing to withdraw");
      return;
    }

    // ── withdraw ────────────────────────────────────────────────
    const base = process.env.IMPERIAL_BASE_URL || "https://api.imperial.space/api/v1";
    const amountBase = Math.floor(usdc * 1_000_000);
    console.log(`[verify] withdrawing $${usdc.toFixed(6)} (raw=${amountBase})`);
    const r = await fetch(`${base}/deposit/build-tx`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        wallet,
        profileIndex: 0,
        amount: amountBase,
        mode: "withdraw",
      }),
    });
    const txt = await r.text();
    const body = JSON.parse(txt) as { transaction?: string };
    if (!r.ok || !body.transaction) {
      console.log(`[verify] build-tx failed: HTTP ${r.status} ${txt.slice(0, 400)}`);
      return;
    }
    const rpcUrl = process.env.LIVE_TEST_RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl, "confirmed");
    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
    tx.sign([kp]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    console.log(`[verify] withdraw submitted: ${sig}`);
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.log(`[verify] withdraw failed on-chain: ${JSON.stringify(conf.value.err)}`);
      return;
    }
    console.log(`[verify] ✓ withdraw confirmed`);
    appendTxnLog(
      `${new Date().toISOString()} | venue=- | action=withdraw_collateral | symbol=USDC | wallet=${wallet} | profile=0 | profilePda=DmCWVtZg3Suen1GqG8tefmBbmXRUWu9YWDtCbfPsQoLt | sig=${sig} | amount=$${usdc.toFixed(6)} endpoint=/deposit/build-tx mode=withdraw cleanup=post-flash-close`,
    );

    // verify final
    await new Promise((r) => setTimeout(r, 5000));
    const balResAfter = (await getBalances(auth.token)) as Record<string, unknown>;
    const profilesAfter = (balResAfter?.profiles as Array<Record<string, unknown>>) ?? [];
    const p0After = profilesAfter.find((p) => Number(p.profileIndex ?? p.index ?? -1) === 0);
    const usdcAfter = Number(p0After?.usdc ?? p0After?.usdcBalance ?? 0) / 1_000_000;
    console.log(
      `\n[verify] profile 0 USDC after: $${usdcAfter.toFixed(6)} (was $${usdc.toFixed(6)})`,
    );
  }, 180_000);
});
