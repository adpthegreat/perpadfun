// Parity guard: the client-side leverage mirror (src/lib/imperial-markets.ts
// IMPERIAL_MAX_LEVERAGE) MUST match the keeper's source of truth
// (keeper/src/imperial.js SUPPORTED_MARKETS). If they drift, the UI/server caps
// diverge from what the keeper will actually accept at open, which is exactly
// how an "unsupported leverage" can slip through.
//
// We parse the keeper file as text rather than importing it, because
// keeper/src/imperial.js imports ./config.js which throws at load when
// TREASURY_SOLANA_PRIVATE_KEY / KEEPER_SECRET are unset (as in CI).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IMPERIAL_MAX_LEVERAGE } from "../../src/lib/imperial-markets.ts";

function parseKeeperMarkets(): Record<string, number> {
  const path = fileURLToPath(new URL("../../keeper/src/imperial.js", import.meta.url));
  const src = readFileSync(path, "utf8");
  const start = src.indexOf("SUPPORTED_MARKETS = Object.freeze({");
  expect(start, "SUPPORTED_MARKETS block not found in keeper/src/imperial.js").toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("});", start));
  const out: Record<string, number> = {};
  // Match e.g.  BTC:  { venue: 'phoenix', maxLeverage: 20, alias: 'WTIOIL' },
  const rx = /^\s*([A-Z0-9]+):\s*\{[^}]*maxLeverage:\s*([0-9]+(?:\.[0-9]+)?)/gm;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block)) !== null) out[m[1]] = Number(m[2]);
  return out;
}

describe("leverage mirror parity (client ↔ keeper)", () => {
  const keeper = parseKeeperMarkets();

  it("parses a sane number of keeper markets", () => {
    expect(Object.keys(keeper).length).toBeGreaterThan(20);
    expect(keeper.BTC).toBe(20); // sanity anchor
  });

  it("client IMPERIAL_MAX_LEVERAGE has the exact same symbols as the keeper", () => {
    const clientKeys = new Set(Object.keys(IMPERIAL_MAX_LEVERAGE));
    const keeperKeys = new Set(Object.keys(keeper));
    const missingInClient = [...keeperKeys].filter((k) => !clientKeys.has(k));
    const extraInClient = [...clientKeys].filter((k) => !keeperKeys.has(k));
    expect(missingInClient, `symbols in keeper but missing from client mirror: ${missingInClient}`).toEqual([]);
    expect(extraInClient, `symbols in client mirror but not in keeper: ${extraInClient}`).toEqual([]);
  });

  it("every symbol's max leverage matches between client and keeper", () => {
    const mismatches: string[] = [];
    for (const [sym, lev] of Object.entries(keeper)) {
      if (IMPERIAL_MAX_LEVERAGE[sym] !== lev) {
        mismatches.push(`${sym}: client=${IMPERIAL_MAX_LEVERAGE[sym]} keeper=${lev}`);
      }
    }
    expect(mismatches, `max-leverage mismatches: ${mismatches.join(", ")}`).toEqual([]);
  });
});
