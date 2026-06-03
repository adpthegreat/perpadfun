// Operator utility: read all open positions on the live test wallet, close
// any that exist, then report USDC balance on the Imperial profile.
//
// Cost: ~$0.10-$0.50 per open position to close, then $0 to read balance.
// Run when the test wallet needs cleanup between debug sessions.
import { it } from "vitest";
import { liveSuite } from "./helpers/live.js";
import { authenticate, getPositions, getBalances } from "../../keeper/src/imperial.js";
import { directClose, directMarkPrice } from "./helpers/direct-order.js";
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

type Position = {
  marketSymbol?: string;
  symbol?: string;
  asset?: string;
  side?: number | string;
  sizeUsd?: number | string;
  size?: number | string;
  collateralUsd?: number | string;
  pnlUsd?: number | string;
  underwriter?: number;
  venue?: string;
};

function venueFromUnderwriter(u: number | string | undefined): string {
  // /positions returns underwriter as either a number (0..3) or a string
  // ("flash_trade", "phoenix", etc.). Handle both.
  if (typeof u === "string") {
    const s = u.toLowerCase();
    if (s === "jupiter" || s === "flash_trade" || s === "phoenix" || s === "gmtrade") return s;
    if (s === "flash") return "flash_trade";
  }
  switch (u) {
    case 0: return "jupiter";
    case 1: return "flash_trade";
    case 2: return "phoenix";
    case 3: return "gmtrade";
    default: return `underwriter=${String(u)}`;
  }
}

liveSuite("Cleanup live test wallet — close all positions + report balance", () => {
  it("inventory → close → balance", async () => {
    const kp = loadKp();
    const auth = await authenticate(kp);
    const wallet = (auth.pubkey ?? kp.publicKey.toBase58());
    console.log(`\n[cleanup] wallet=${wallet}`);

    // STEP 1 — inventory open positions
    const posRes = await getPositions(wallet, { token: auth.token });
    const positions = ((posRes as Record<string, unknown>)?.dataList ??
      (posRes as Record<string, unknown>)?.positions ??
      (Array.isArray(posRes) ? posRes : [])) as Position[];
    console.log(`\n[cleanup] /positions returned ${positions.length} entries:\n`);
    for (const p of positions) {
      const sym = (p.marketSymbol || p.symbol || p.asset || "?").toString();
      const sideStr = p.side === 0 || p.side === "long" ? "long" : "short";
      const size = Number(p.sizeUsd ?? p.size ?? 0);
      const coll = Number(p.collateralUsd ?? 0);
      const pnl = Number(p.pnlUsd ?? 0);
      const venue = p.venue ?? venueFromUnderwriter(p.underwriter);
      console.log(
        `  ${sym.padEnd(10)} ${sideStr.padEnd(6)} venue=${venue.padEnd(12)} ` +
        `size=$${size.toFixed(2).padStart(10)} coll=$${coll.toFixed(2).padStart(8)} ` +
        `pnl=$${pnl.toFixed(2).padStart(8)}`,
      );
    }

    const openPositions = positions.filter(
      (p) => Number(p.sizeUsd ?? p.size ?? 0) > 0,
    );

    // STEP 2 — close each open position
    if (openPositions.length > 0) {
      console.log(`\n[cleanup] closing ${openPositions.length} open position(s)...\n`);
      for (const p of openPositions) {
        const sym = String(p.marketSymbol || p.symbol || p.asset || "");
        const side = p.side === 0 || p.side === "long" ? "long" : "short";
        const venueRaw = p.venue ?? venueFromUnderwriter(p.underwriter);
        const venue = (venueRaw === "gmtrade" || venueRaw === "jupiter" || venueRaw === "phoenix" || venueRaw === "flash_trade")
          ? venueRaw as "gmtrade" | "jupiter" | "phoenix" | "flash_trade"
          : "phoenix";
        const sizeUsd = Number(p.sizeUsd ?? p.size ?? 0);
        if (!sym || !sizeUsd) continue;

        try {
          const mark = await directMarkPrice(sym, venue);
          if (!mark) {
            console.log(`  [skip] ${sym} ${venue}: no mark price available`);
            continue;
          }
          const res = await directClose({
            token: auth.token,
            venue,
            wallet,
            symbol: sym,
            side,
            closeSizeUsd: sizeUsd,
            slippageBps: 500,
            profileIndex: 0,
            marketPrice: mark,
          });
          console.log(
            `  ${res.success ? "✓" : "✗"} ${sym.padEnd(8)} ${venue.padEnd(12)} size=$${sizeUsd.toFixed(2)} ` +
            `sig=${res.signature?.slice(0, 16) ?? "(none)"}... err=${res.error ?? "none"}`,
          );
        } catch (e) {
          console.log(`  ✗ ${sym} ${venue}: ${(e as Error).message}`);
        }
        // Pause between closes
        await new Promise((r) => setTimeout(r, 3000));
      }
    } else {
      console.log("\n[cleanup] no open positions to close.\n");
    }

    // STEP 3 — balance read
    const balRes = (await getBalances(auth.token)) as Record<string, unknown>;
    const profiles = (balRes?.profiles as Array<Record<string, unknown>>) ?? [];
    console.log(`\n[cleanup] /mobile/balances — ${profiles.length} profile(s):\n`);
    for (const prof of profiles) {
      const idx = Number(prof.profileIndex ?? prof.index ?? -1);
      // /mobile/balances returns USDC in native 6-decimal units; convert to UI dollars.
      const usdcUi = prof.usdcUi !== undefined ? Number(prof.usdcUi) : null;
      const usdcRaw = Number(prof.usdc ?? prof.usdcBalance ?? 0);
      const usdc = usdcUi ?? usdcRaw / 1_000_000;
      const sol = Number(prof.solUi ?? prof.sol ?? 0);
      const pda = String(prof.profilePda ?? prof.pda ?? "?");
      if (usdc > 0 || idx === 0) {
        console.log(
          `  profile=${idx} pda=${pda.slice(0, 12)}... usdc=$${usdc.toFixed(6)} sol=${sol.toFixed(6)}`,
        );
      }
    }
  }, 600_000);
});
