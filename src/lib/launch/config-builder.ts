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
// Preset quick-picks, plus "CUSTOM" for an arbitrary verified SPL mint whose
// mint + decimals are supplied at launch (from verifyQuoteToken).
export type Quote = "SOL" | "USDC" | "ANSEM" | "UWU" | "CUSTOM";
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

// Market-cap presets are denominated in the QUOTE token's whole units. SOL/USDC
// use fixed numbers; arbitrary SPL quotes (memecoins like $ANSEM) can't — a fixed
// token amount would swing wildly in USD — so they derive from the USDC USD
// targets ÷ the quote's live price at launch (Option B). USDC ≈ $1, so the USDC
// presets double as the canonical USD targets.
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

// USD market-cap targets used for priced (arbitrary-SPL) quotes — same as the
// USDC presets ($1 ≈ 1 USDC).
const USD_TARGETS = PRESETS.USDC;

type QuoteToken = {
  label: string;
  mint: string;
  quoteDecimal: 6 | 9;
  // Fixed presets in quote units (native/stable quotes), or null → derive per
  // launch from USD_TARGETS ÷ live price.
  presets: Record<CurvePreset, { initialMarketCap: number; migrationMarketCap: number }> | null;
};

// Quote-token registry. Add a new SPL quote by dropping in one entry
// (mint + decimals, presets: null to price it live).
export const QUOTE_TOKENS: Record<Exclude<Quote, "CUSTOM">, QuoteToken> = {
  SOL: { label: "SOL", mint: NATIVE_SOL_MINT_STR, quoteDecimal: 9, presets: PRESETS.SOL },
  USDC: { label: "USDC", mint: USDC_MINT_STR, quoteDecimal: 6, presets: PRESETS.USDC },
  ANSEM: {
    label: "ANSEM",
    mint: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump",
    quoteDecimal: 6,
    presets: null,
  },
  UWU: {
    label: "UWU",
    mint: "UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump",
    quoteDecimal: 6,
    presets: null,
  },
};

export function presetForLeverage(leverage: number): CurvePreset {
  return leverage === 2 ? "gentle" : leverage >= 5 ? "parabolic" : "standard";
}

// Resolve a quote to { mint, decimals, presets }. Preset quotes come from the
// registry; CUSTOM uses the mint + decimals passed in (from verifyQuoteToken)
// and is always live-priced (presets: null).
export function resolveQuote(
  quote: Quote,
  customMint?: string,
  customDecimals?: number,
): { mint: string; decimals: number; presets: QuoteToken["presets"] } {
  if (quote === "CUSTOM") {
    if (!customMint || customDecimals == null) {
      throw new Error("Custom quote requires a verified mint + decimals.");
    }
    return { mint: customMint, decimals: customDecimals, presets: null };
  }
  const qt = QUOTE_TOKENS[quote];
  return { mint: qt.mint, decimals: qt.quoteDecimal, presets: qt.presets };
}

export function quoteMintFor(quote: Quote, customMint?: string): PublicKey {
  return new PublicKey(resolveQuote(quote, customMint, 0).mint);
}

export function quoteDecimalsFor(quote: Quote, customDecimals?: number): number {
  return resolveQuote(quote, "x", customDecimals).decimals;
}

// Live USD price for an arbitrary quote mint (Jupiter price v3 — accepts any
// mint). Returns 0 on failure so callers can decide to block the launch.
export async function fetchQuoteUsdPrice(mint: string): Promise<number> {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return 0;
    const j = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = j[mint]?.usdPrice;
    return typeof p === "number" && p > 0 ? p : 0;
  } catch {
    return 0;
  }
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
    // Optional override for the quote's live USD price (priced quotes only);
    // when omitted, buildConfigParams fetches it.
    quoteUsdPrice?: number;
    // For quote === "CUSTOM": the verified mint + decimals to pair against.
    customMint?: string;
    customDecimals?: number;
  },
) {
  const qt = resolveQuote(cfg.quote, cfg.customMint, cfg.customDecimals);
  // Market caps in quote-token units: fixed for SOL/USDC, else derived from the
  // USD targets ÷ the quote's live price (Option B).
  let initialMarketCap: number;
  let migrationMarketCap: number;
  if (qt.presets) {
    ({ initialMarketCap, migrationMarketCap } = qt.presets[cfg.curvePreset]);
  } else {
    const usd = USD_TARGETS[cfg.curvePreset];
    const price = cfg.quoteUsdPrice ?? (await fetchQuoteUsdPrice(qt.mint));
    if (!price || price <= 0) {
      throw new Error(`No live ${cfg.quote} price available — can't set market-cap targets.`);
    }
    initialMarketCap = usd.initialMarketCap / price;
    migrationMarketCap = usd.migrationMarketCap / price;
  }
  const fee = cfg.feeSchedule ?? STANDARD_FEE_SCHEDULE;
  const leftover = cfg.leftoverTokens ?? 0;
  const lvErr = validateLeftover(leftover, TOTAL_SUPPLY);
  if (lvErr) throw new Error(lvErr);
  return sdk.buildCurveWithMarketCap({
    initialMarketCap,
    migrationMarketCap,
    activationType: sdk.ActivationType.Slot,
    token: {
      tokenType: sdk.TokenType.SPL,
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: qt.decimals === 6 ? sdk.TokenDecimal.SIX : sdk.TokenDecimal.NINE,
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
    "https://perpspad.fun"
  ).replace(/\/$/, "");
}
