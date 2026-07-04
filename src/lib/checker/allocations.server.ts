// SERVER-ONLY. Do NOT import this from any client component / route component.
// It pulls in the full 380-wallet allocation table (allocations.json), which must
// never ship in the client bundle. Import it exclusively from the /api/checker
// server route handler. The API returns only a SINGLE looked-up address, never
// the whole map.
//
// Regenerate allocations.json with: bun run scripts/build-checker-allocations.ts <csv>
import allocations from "./allocations.json";

export interface Allocation {
  /** Exact integer base units (6 decimals) of the total airdrop (base + bonus). */
  amountBaseUnits: string;
  /** UI decimal total airdrop (== base + daysBonus). NOT a 1:1 of held balance. */
  amountUi: number;
  perpadBalance: number;
  holdDays: number;
  /** Balance-weighted slice of the 65M base pool. */
  base: number;
  /** Days-weighted slice of the 5M loyalty pool (620.7864 tokens/day). */
  daysBonus: number;
}

const TABLE = allocations as Record<string, Allocation>;

/**
 * Look up one owner's allocation. `owner` is a case-sensitive base58 Solana
 * address and is used verbatim (no normalization). Returns null if not eligible.
 */
export function getAllocation(owner: string): Allocation | null {
  if (!owner) return null;
  return Object.prototype.hasOwnProperty.call(TABLE, owner) ? TABLE[owner] : null;
}

/** Total number of eligible former holders (safe to expose; not the list). */
export function eligibleCount(): number {
  return Object.keys(TABLE).length;
}
