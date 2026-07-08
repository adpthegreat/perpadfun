// Shared Meteora DBC config builder + constants used by both pipeline.ts (the
// real launch path) and simulate.functions.ts (the pre-launch sim). Kept in its
// own module so simulate.functions.ts can dynamic-import it without also
// dragging pipeline.ts (which references subWallet.server + Node crypto) into
// the client bundle.

import { PublicKey } from "@solana/web3.js";
import {
  computeSupplyBreakdown,
  validateLeftover,
  type SupplyBreakdown,
} from "@/lib/launch/supplyBreakdown";

export type CurvePreset = "gentle" | "standard" | "parabolic";
export type Quote = "SOL" | "USDC";
export type FeeSchedule = {
  startingFeeBps: number;
  endingFeeBps: number;
  numberOfPeriod: number;
  totalDuration: number;
};

export const STANDARD_FEE_SCHEDULE: FeeSchedule = {
  startingFeeBps: 400,
  endingFeeBps: 250,
  numberOfPeriod: 60,
  totalDuration: 9000,
};

export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;

export const LAUNCH_RENT_AND_FEES_LAMPORTS = 100_000_000;
export const SUB_WALLET_OPS_SEED_LAMPORTS = 10_000_000;

const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NATIVE_SOL_MINT_STR = "So11111111111111111111111111111111111111112";

const PRESETS = {
  SOL: {
    gentle: { initialMarketCap: 34, migrationMarketCap: 400 },
    standard: { initialMarketCap: 34, migrationMarketCap: 460 },
    parabolic: { initialMarketCap: 34, migrationMarketCap: 550 },
  },
  USDC: {
    gentle: { initialMarketCap: 3000, migrationMarketCap: 36000 },
    standard: { initialMarketCap: 3000, migrationMarketCap: 41000 },
    parabolic: { initialMarketCap: 3000, migrationMarketCap: 49000 },
  },
} as const;

export function presetForLeverage(leverage: number): CurvePreset {
  return leverage === 2 ? "gentle" : leverage >= 5 ? "parabolic" : "standard";
}

export function quoteMintFor(quote: Quote): PublicKey {
  return new PublicKey(quote === "USDC" ? USDC_MINT_STR : NATIVE_SOL_MINT_STR);
}

export async function loadSdk() {
  return (await import("@meteora-ag/dynamic-bonding-curve-sdk")) as any;
}

export async function loadBN() {
  return (await import("bn.js")).default as any;
}

export async function buildConfigParams(
  sdk: any,
  cfg: {
    quote: Quote;
    curvePreset: CurvePreset;
    leftoverTokens?: number;
    feeSchedule?: FeeSchedule;
  },
) {
  const preset = PRESETS[cfg.quote][cfg.curvePreset];
  const fee = cfg.feeSchedule ?? STANDARD_FEE_SCHEDULE;
  const leftover = cfg.leftoverTokens ?? 0;
  const lvErr = validateLeftover(leftover, TOTAL_SUPPLY);
  if (lvErr) throw new Error(lvErr);
  return sdk.buildCurveWithMarketCap({
    initialMarketCap: preset.initialMarketCap,
    migrationMarketCap: preset.migrationMarketCap,
    activationType: sdk.ActivationType.Slot,
    token: {
      tokenType: sdk.TokenType.SPL,
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: cfg.quote === "USDC" ? sdk.TokenDecimal.SIX : sdk.TokenDecimal.NINE,
      tokenUpdateAuthority: sdk.TokenUpdateAuthorityOption.CreatorUpdateAuthority,
      totalTokenSupply: TOTAL_SUPPLY,
      leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: sdk.BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: fee.startingFeeBps,
          endingFeeBps: fee.endingFeeBps,
          numberOfPeriod: fee.numberOfPeriod,
          totalDuration: fee.totalDuration,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: sdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: sdk.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: sdk.MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
  });
}

export function breakdownFor(configParams: any, leftoverTokens: number): SupplyBreakdown {
  return computeSupplyBreakdown(configParams, TOTAL_SUPPLY, leftoverTokens, TOKEN_DECIMALS);
}

export function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.PERPAD_BASE_URL ||
    "https://perpspad.xyz"
  ).replace(/\/$/, "");
}
