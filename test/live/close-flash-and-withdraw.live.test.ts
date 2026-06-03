// Operator utility: aggressively try to close the stale Flash HYPE position
// on the test wallet, then withdraw all USDC from Imperial profile 0.
//
// Strategy for Flash close (known buggy server-side, see KEEPER_PHOENIX_LOCK.md §6c):
//   1. Try full close at 1000 bps slippage
//   2. If that fails, escalate to 2000 bps
//   3. If that fails, try a smaller partial close ($100, then $50)
//   4. If all close attempts fail, skip to the withdraw and log the open position
//
// Then unconditionally try to withdraw all USDC from profile 0 via
// /deposit/build-tx { mode: 'withdraw' }.
//
// Cost: up to $1-2 if multiple close attempts run, plus tx fees on the withdraw.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import {
  authenticate,
  getPositions,
  getBalances,
} from "../../keeper/src/imperial.js";
import { directClose, directMarkPrice } from "./helpers/direct-order.js";
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

type CloseAttempt = {
  sizeUsd: number;
  slippageBps: number;
  label: string;
};

const CLOSE_LADDER: CloseAttempt[] = [
  { sizeUsd: 722.7, slippageBps: 1000, label: "full @ 10%" },
  { sizeUsd: 722.7, slippageBps: 2000, label: "full @ 20%" },
  { sizeUsd: 100, slippageBps: 1000, label: "$100 partial @ 10%" },
  { sizeUsd: 50, slippageBps: 1000, label: "$50 partial @ 10%" },
  { sizeUsd: 25, slippageBps: 2000, label: "$25 partial @ 20%" },
];

function appendTxnLog(line: string) {
  const path = "test/live/txns.txt";
  if (fs.existsSync(path)) fs.appendFileSync(path, line + "\n");
}

liveSuite("Close stale Flash position + withdraw USDC", () => {
  it("inventory → close ladder → withdraw all USDC", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const wallet = auth.pubkey ?? kp.publicKey.toBase58();
    console.log(`\n[cleanup] wallet=${wallet}`);

    // ── STEP 1: inventory ────────────────────────────────────────────────
    const posRes = await getPositions(wallet, { token: auth.token });
    const positions = ((posRes as Record<string, unknown>)?.dataList ??
      (posRes as Record<string, unknown>)?.positions ??
      (Array.isArray(posRes) ? posRes : [])) as Array<Record<string, unknown>>;
    console.log(`\n[cleanup] /positions: ${positions.length} entries`);
    for (const p of positions) {
      const sym = String(p.marketSymbol || p.symbol || p.asset || "?");
      const sideStr = p.side === 0 || p.side === "long" ? "long" : "short";
      const size = Number(p.sizeUsd ?? p.size ?? 0);
      const coll = Number(p.collateralUsd ?? 0);
      const pnl = Number(p.pnlUsd ?? 0);
      const venue = String(p.venue ?? p.underwriter ?? "?");
      console.log(
        `  ${sym.padEnd(8)} ${sideStr} venue=${venue.padEnd(12)} size=$${size.toFixed(2).padStart(9)} coll=$${coll.toFixed(2)} pnl=$${pnl.toFixed(2)}`,
      );
    }

    const flashHype = positions.find((p) => {
      const venueStr = String(p.venue ?? p.underwriter ?? "").toLowerCase();
      const sym = String(p.marketSymbol || p.symbol || p.asset || "").toUpperCase();
      return sym === "HYPE" && (venueStr === "flash_trade" || venueStr === "flash");
    });

    // ── STEP 2: aggressive close ladder ─────────────────────────────────
    let closed = false;
    if (flashHype) {
      const side = flashHype.side === 0 || flashHype.side === "long" ? "long" : "short";
      const mark = await directMarkPrice("HYPE", "flash_trade");
      console.log(`\n[cleanup] flash HYPE position found — markPrice=${mark}`);
      if (!mark) {
        console.log("  [skip] no mark price; cannot construct close order");
      } else {
        for (const attempt of CLOSE_LADDER) {
          console.log(
            `\n[cleanup] try: ${attempt.label} (size=$${attempt.sizeUsd}, slip=${attempt.slippageBps}bps)`,
          );
          try {
            const res = await directClose({
              token: auth.token,
              venue: "flash_trade",
              wallet,
              symbol: "HYPE",
              side,
              closeSizeUsd: attempt.sizeUsd,
              slippageBps: attempt.slippageBps,
              profileIndex: 0,
              marketPrice: mark,
            });
            console.log(
              `  resp success=${res.success} sig=${res.signature?.slice(0, 16) ?? "(none)"}... err=${res.error ?? "none"}`,
            );
            if (res.success && res.signature) {
              const tag = attempt.sizeUsd >= 722 ? "close_full" : "close_partial";
              appendTxnLog(
                `${new Date().toISOString()} | venue=flash_trade | action=${tag} | symbol=HYPE | wallet=${wallet} | profile=0 | profilePda=DmCWVtZg3Suen1GqG8tefmBbmXRUWu9YWDtCbfPsQoLt | sig=${res.signature} | strategy="${attempt.label}" slippageBps=${attempt.slippageBps} resp.success=true`,
              );
              // Poll to confirm
              console.log("  waiting 8s for settle...");
              await new Promise((r) => setTimeout(r, 8000));
              const reread = await getPositions(wallet, { token: auth.token });
              const rerolls = ((reread as Record<string, unknown>)?.dataList ?? []) as Array<Record<string, unknown>>;
              const stillOpen = rerolls.find((p) => {
                const venueStr = String(p.venue ?? p.underwriter ?? "").toLowerCase();
                const sym = String(p.marketSymbol || p.symbol || p.asset || "").toUpperCase();
                return sym === "HYPE" && (venueStr === "flash_trade" || venueStr === "flash");
              });
              if (!stillOpen || Number(stillOpen.sizeUsd ?? stillOpen.size ?? 0) <= 0) {
                console.log("  ✓ position closed");
                closed = true;
                break;
              } else {
                console.log(
                  `  partial fill — remaining size=$${Number(stillOpen.sizeUsd ?? 0).toFixed(2)}`,
                );
                // Continue ladder if still open
              }
            }
          } catch (e) {
            console.log(`  threw: ${(e as Error).message.slice(0, 200)}`);
          }
          // brief pause between attempts
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } else {
      console.log("\n[cleanup] no flash HYPE position to close");
    }
    if (flashHype && !closed) {
      console.log("\n[cleanup] !! flash close did not fully succeed; position may still be open");
    }

    // ── STEP 3: read balance + withdraw all USDC from profile 0 ────────
    const balResBefore = (await getBalances(auth.token)) as Record<string, unknown>;
    const profilesBefore = (balResBefore?.profiles as Array<Record<string, unknown>>) ?? [];
    const p0Before = profilesBefore.find((p) => Number(p.profileIndex ?? p.index ?? -1) === 0);
    const usdcBefore = Number(p0Before?.usdc ?? p0Before?.usdcBalance ?? 0) / 1_000_000;
    console.log(`\n[cleanup] profile 0 USDC before withdraw: $${usdcBefore.toFixed(6)}`);

    if (usdcBefore <= 0.01) {
      console.log("[cleanup] nothing to withdraw");
      return;
    }

    // Withdraw via /deposit/build-tx { mode: 'withdraw' }. Empirically proven
    // to work (see txns.txt 2026-06-01T04:42:00.000Z sig=3g9tLekVQna79Qm5...).
    const base = process.env.IMPERIAL_BASE_URL || "https://api.imperial.space/api/v1";
    const amountBase = Math.floor(usdcBefore * 1_000_000); // 6-decimal native units
    console.log(`[cleanup] requesting withdraw of $${usdcBefore.toFixed(6)} (raw=${amountBase})`);

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
    let body: { transaction?: string } & Record<string, unknown> = {};
    try {
      body = JSON.parse(txt);
    } catch {
      body = { raw: txt };
    }
    if (!r.ok || !body.transaction) {
      console.log(`[cleanup] withdraw build failed: HTTP ${r.status} body=${txt.slice(0, 400)}`);
      return;
    }

    const rpcUrl = process.env.LIVE_TEST_RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl, "confirmed");
    const tx = VersionedTransaction.deserialize(
      Buffer.from(body.transaction as string, "base64"),
    );
    tx.sign([kp]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    console.log(`[cleanup] withdraw submitted: sig=${sig}`);
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) {
      console.log(`[cleanup] withdraw failed on-chain: ${JSON.stringify(conf.value.err)}`);
      return;
    }
    console.log(`[cleanup] ✓ withdraw confirmed`);
    appendTxnLog(
      `${new Date().toISOString()} | venue=- | action=withdraw_collateral | symbol=USDC | wallet=${wallet} | profile=0 | profilePda=DmCWVtZg3Suen1GqG8tefmBbmXRUWu9YWDtCbfPsQoLt | sig=${sig} | amount=$${usdcBefore.toFixed(6)} endpoint=/deposit/build-tx mode=withdraw cleanup=close-and-empty`,
    );

    // ── STEP 4: verify ──────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 5000));
    const balResAfter = (await getBalances(auth.token)) as Record<string, unknown>;
    const profilesAfter = (balResAfter?.profiles as Array<Record<string, unknown>>) ?? [];
    const p0After = profilesAfter.find((p) => Number(p.profileIndex ?? p.index ?? -1) === 0);
    const usdcAfter = Number(p0After?.usdc ?? p0After?.usdcBalance ?? 0) / 1_000_000;
    console.log(
      `\n[cleanup] profile 0 USDC after withdraw: $${usdcAfter.toFixed(6)} (was $${usdcBefore.toFixed(6)})`,
    );
  }, 900_000);
});
