// Pure tests for the launch supply math (no network/Supabase). Builds a real
// Meteora curve config and asserts the split invariants. See plan/PERPSPAD_LAUNCH.md §6.1.
import { describe, it, expect } from "vitest";
import {
  buildCurveWithMarketCap,
  TokenType,
  TokenDecimal,
  TokenUpdateAuthorityOption,
  MigrationOption,
  MigrationFeeOption,
  ActivationType,
  CollectFeeMode,
  BaseFeeMode,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { computeSupplyBreakdown, validateLeftover, MAX_LEFTOVER_PCT } from "../../src/lib/launch/supplyBreakdown";

const TOTAL = 1_000_000_000;

function buildConfig(leftover: number) {
  return buildCurveWithMarketCap({
    initialMarketCap: 34,
    migrationMarketCap: 400,
    activationType: ActivationType.Slot,
    token: {
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenUpdateAuthority: TokenUpdateAuthorityOption.CreatorUpdateAuthority,
      totalTokenSupply: TOTAL,
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 250, endingFeeBps: 100, numberOfPeriod: 24, totalDuration: 216_000 },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  });
}

describe("validateLeftover", () => {
  it("accepts 0 and the 10% reserve", () => {
    expect(validateLeftover(0, TOTAL)).toBeNull();
    expect(validateLeftover(100_000_000, TOTAL)).toBeNull();
  });
  it("rejects negative, >= total, and over the cap", () => {
    expect(validateLeftover(-1, TOTAL)).toBeTruthy();
    expect(validateLeftover(TOTAL, TOTAL)).toBeTruthy();
    expect(validateLeftover((TOTAL * MAX_LEFTOVER_PCT) / 100 + 1, TOTAL)).toBeTruthy();
  });
});

describe("computeSupplyBreakdown", () => {
  it("splits into curve+LP and sums to total when leftover=0", () => {
    const b = computeSupplyBreakdown(buildConfig(0), TOTAL, 0, 6);
    expect(b.leftover).toBe(0);
    expect(b.curveSold).toBeGreaterThan(0);
    expect(b.lp).toBeGreaterThan(0);
    expect(b.curveSold + b.lp + b.leftover).toBeCloseTo(TOTAL, 0);
  });
  it("reserves the leftover and still sums to total", () => {
    const reserve = 100_000_000;
    const b = computeSupplyBreakdown(buildConfig(reserve), TOTAL, reserve, 6);
    expect(b.leftover).toBe(reserve);
    expect(b.curveSold + b.lp + b.leftover).toBeCloseTo(TOTAL, 0);
  });
});
