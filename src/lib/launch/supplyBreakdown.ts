// Pure supply-split math for a launch: given the built curve config + total supply
// + leftover reserve, report how the 1B splits into {curveSold, lp, leftover}.
// Uses the SDK's getBaseTokenForSwap (validated against the live curve presets).
// See plan/PERPSPAD_LAUNCH.md §6.1.
import { getBaseTokenForSwap } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { ConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";

export type SupplyBreakdown = {
  curveSold: number; // UI tokens sold along the bonding curve
  lp: number; // UI tokens seeding the DAMM v2 LP at graduation
  leftover: number; // UI tokens held back (airdrop reserve)
  raw: { total: string; sold: string; lp: string; leftover: string };
};

export const MAX_LEFTOVER_PCT = 20; // admin leftover cap (plan §6)

// totalSupplyTokens / leftoverTokens are WHOLE tokens; decimals is the base decimals (6).
export function computeSupplyBreakdown(
  config: ConfigParameters,
  totalSupplyTokens: number,
  leftoverTokens: number,
  decimals: number,
): SupplyBreakdown {
  const scale = 10n ** BigInt(decimals);
  const total = BigInt(Math.round(totalSupplyTokens)) * scale;
  const leftover = BigInt(Math.round(leftoverTokens)) * scale;

  const curve = config.curve;
  const sqrtMigration = curve[curve.length - 1].sqrtPrice;
  const sold = BigInt(getBaseTokenForSwap(config.sqrtStartPrice, sqrtMigration, curve).toString());

  let lp = total - sold - leftover;
  if (lp < 0n) lp = 0n;

  const toUi = (x: bigint) => Number(x) / 10 ** decimals;
  return {
    curveSold: toUi(sold),
    lp: toUi(lp),
    leftover: toUi(leftover),
    raw: { total: total.toString(), sold: sold.toString(), lp: lp.toString(), leftover: leftover.toString() },
  };
}

// Validate an admin-requested leftover (whole tokens) against the supply + cap.
export function validateLeftover(leftoverTokens: number, totalSupplyTokens: number): string | null {
  if (!Number.isFinite(leftoverTokens) || leftoverTokens < 0) return "leftover must be >= 0";
  if (leftoverTokens >= totalSupplyTokens) return "leftover must be < total supply";
  if (leftoverTokens > (totalSupplyTokens * MAX_LEFTOVER_PCT) / 100)
    return `leftover exceeds the ${MAX_LEFTOVER_PCT}% cap`;
  return null;
}
