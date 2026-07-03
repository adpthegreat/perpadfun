// Build the SERVER-ONLY $PERPAD airdrop allocation dataset from the raw CSV.
//
// Reads PERPAD_AIRDROP_ALLOCATION.csv (owner,perpad_balance,hold_days,base_1to1,
// days_bonus,total_airdrop) and writes src/lib/checker/allocations.json — a map
// keyed by the exact (case-sensitive base58) owner address.
//
// RUN:
//   bun run scripts/build-checker-allocations.ts /absolute/path/to/PERPAD_AIRDROP_ALLOCATION.csv
//
// IMPORTANT CORRECTNESS NOTES:
//  - Solana addresses are case-sensitive base58. Keys are stored VERBATIM. Never
//    lowercase / trim / normalize them.
//  - amountBaseUnits ($PERPAD has 6 decimals) is computed with STRING digit-shift
//    math, NOT `Math.floor(Number(total_airdrop) * 1e6)`. Float rounding makes the
//    naive JS approach off-by-one-low on ~3 of the 380 rows. Keep the string math.
//
// The emitted JSON is imported ONLY by src/lib/checker/allocations.server.ts, which
// must NEVER be imported by client code (see that file's header).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PERPAD_DECIMALS = 6;

// Exact floor(uiDecimalString * 10^decimals) as an integer string. No floats.
function toBaseUnits(ui: string, decimals = PERPAD_DECIMALS): string {
  const neg = ui.startsWith("-");
  const s = neg ? ui.slice(1) : ui;
  const [wholeRaw, fracRaw = ""] = s.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals); // pad+truncate = floor
  const digits = (whole + frac).replace(/^0+(?=\d)/, "") || "0";
  return (neg ? "-" : "") + digits;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("usage: bun run scripts/build-checker-allocations.ts <alloc.csv>");
    process.exit(1);
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "../src/lib/checker/allocations.json");

  const text = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split(",");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column: ${name}`);
    return i;
  };
  const iOwner = col("owner");
  const iBal = col("perpad_balance");
  const iDays = col("hold_days");
  const iBase = col("base_1to1");
  const iBonus = col("days_bonus");
  const iTotal = col("total_airdrop");

  const out: Record<
    string,
    {
      amountBaseUnits: string;
      amountUi: number;
      perpadBalance: number;
      holdDays: number;
      base1to1: number;
      daysBonus: number;
    }
  > = {};

  for (let r = 1; r < lines.length; r++) {
    const c = lines[r].split(",");
    const owner = c[iOwner]; // VERBATIM — case-sensitive base58, do not normalize
    if (out[owner]) throw new Error(`duplicate owner in CSV: ${owner}`);
    out[owner] = {
      amountBaseUnits: toBaseUnits(c[iTotal]),
      amountUi: Number(c[iTotal]),
      perpadBalance: Number(c[iBal]),
      holdDays: Number(c[iDays]),
      base1to1: Number(c[iBase]),
      daysBonus: Number(c[iBonus]),
    };
  }

  mkdirSync(dirname(outPath), { recursive: true });
  // Sorted keys → stable, reviewable diffs across regenerations.
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  console.log(`wrote ${Object.keys(sorted).length} allocations -> ${outPath}`);
}

main();
