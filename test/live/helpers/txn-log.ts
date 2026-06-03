// Append a successful Imperial transaction to test/live/txns.txt, organised
// by venue and action. Lets the operator inspect every on-chain side-effect
// the live suite produced without scraping vitest output.
//
// File format: simple line-oriented log, easy to grep. One line per tx.
//   <iso-timestamp> | venue=<v> | action=<a> | symbol=<s> | wallet=<w> | profile=<p> | profilePda=<pda> | sig=<sig> | <extra>
//
// Example:
//   2026-06-01T12:34:56.789Z | venue=gmtrade | action=open | symbol=SOL | wallet=278zRg... | profile=0 | profilePda=DmCWVt... | sig=5Jf8nC2... | coll=$10 lev=2x
//
// Skipped entirely if `signature` is falsy (we only log REAL successful txs).
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOG_PATH = resolve(process.cwd(), "test/live/txns.txt");
const HEADER =
  "# Imperial live-suite transaction log.\n" +
  "# One line per successful on-chain side-effect from test/live/. Grep by\n" +
  "# venue / action / symbol / wallet / profile / profilePda / sig.\n" +
  "#\n" +
  "# Format: <iso-timestamp> | venue=<v> | action=<a> | symbol=<s> | wallet=<w> | profile=<p> | profilePda=<pda> | sig=<sig> | <extra>\n" +
  "#\n";

export type LoggedAction =
  | "open"
  | "close_full"
  | "close_partial"
  | "increase"
  | "topup_margin"
  | "withdraw_collateral"
  | "deposit_profile";

export interface TxnLogEntry {
  venue: "gmtrade" | "jupiter" | "phoenix" | "flash_trade";
  action: LoggedAction;
  symbol: string;
  // Owner wallet base58 pubkey — the signer of the tx.
  wallet: string;
  profileIndex: number;
  // Base58 Imperial profile PDA — derived from (wallet, profileIndex). Optional
  // because some callers may not have fetched it yet; if absent we record "?".
  profilePda?: string | null;
  signature: string | null | undefined;
  // Free-form trailing info (e.g. "coll=$10 lev=2x", "sizeUsd=$20"). Single
  // line — no embedded newlines.
  extra?: string;
}

let _initialised = false;

function ensureHeader(): void {
  if (_initialised) return;
  if (!existsSync(LOG_PATH)) {
    writeFileSync(LOG_PATH, HEADER, { encoding: "utf8" });
  }
  _initialised = true;
}

export function logTxn(entry: TxnLogEntry): void {
  if (!entry.signature) return; // never log empty sigs
  ensureHeader();
  const ts = new Date().toISOString();
  const extra = entry.extra ? entry.extra.replace(/[\r\n]+/g, " ").trim() : "";
  const line =
    `${ts} | venue=${entry.venue} | action=${entry.action} | ` +
    `symbol=${entry.symbol.toUpperCase()} | wallet=${entry.wallet} | ` +
    `profile=${entry.profileIndex} | profilePda=${entry.profilePda ?? "?"} | ` +
    `sig=${entry.signature}` +
    (extra ? ` | ${extra}` : "") +
    "\n";
  appendFileSync(LOG_PATH, line, { encoding: "utf8" });
}
