// Client-safe mirror of keeper/src/imperial.js SUPPORTED_MARKETS.
// Used by /launch and /route-fees to hide leverage options the venue
// would reject. Keep in sync with the keeper file. Source of truth for
// routing decisions is still the keeper; this is a UX guard.
export const IMPERIAL_MAX_LEVERAGE: Record<string, number> = {
  BTC: 500, ETH: 294, SOL: 250, BNB: 9.96, XRP: 250, DOGE: 200, ADA: 100,
  AVAX: 250, TON: 9.96, NEAR: 100, SUI: 9.96, TRX: 250, LTC: 100, DOT: 100,
  BCH: 100, XLM: 100, HYPE: 100, LINK: 100, APE: 100, ZEC: 9.96,
  ARB: 100, UNI: 200, AAVE: 250, GMX: 100, JTO: 4.99, ENA: 9.96, JUP: 9.96,
  PYTH: 56.28, KMNO: 53.57,
  BONK: 100, PEPE: 100, SHIB: 200, BOME: 100, WIF: 100, FARTCOIN: 100,
  TRUMP: 100, MELANIA: 100, PUMP: 200, PENGU: 28.95,
  TAO: 4.99, WLD: 100,
  TSLA: 24.39, NVDA: 24.39, AAPL: 24.39, AMD: 24.39, AMZN: 24.39, SPY: 24.39,
  XAU: 200, XAG: 200, GOLD: 24.78, SILVER: 24.78, WTI: 100, CRUDEOIL: 6.92,
  NATGAS: 11.78, COPPER: 19.86,
  EUR: 500, GBP: 500, USDJPY: 500, USDCHF: 500, USDCAD: 500, AUD: 500, NZD: 500,
};

export const BASE_LEVERAGES = [2, 3, 5] as const;
export const DEGEN_LEVERAGES = [10, 25, 50, 100] as const;

export const MARKET_DISPLAY_NAMES: Record<string, string> = {
  SPY: "S&P 500",
};

// Markets that Imperial routes to phoenix or flash_trade. These venues need
// extra body fields (oracle accounts, lookup tables, etc) that Imperial has
// not yet spec'd, so the keeper skips opens for them. Surface as UNAVAILABLE
// in any UI that creates a token or routes fees so users don't pick a market
// that silently no-ops.
// Source of truth: keeper/src/imperial.js SUPPORTED_MARKETS venues.
export const IMPERIAL_UNAVAILABLE_MARKETS: ReadonlySet<string> = new Set([
  // phoenix
  "BNB", "TON", "SUI", "ZEC", "JTO", "ENA", "JUP", "TAO",
  "GOLD", "SILVER", "COPPER",
  // flash_trade
  "PYTH", "KMNO", "PENGU",
  "TSLA", "NVDA", "AAPL", "AMD", "AMZN", "SPY",
  "CRUDEOIL", "NATGAS",
]);

export function isMarketUnavailable(underlying: string | null | undefined): boolean {
  if (!underlying) return false;
  return IMPERIAL_UNAVAILABLE_MARKETS.has(underlying.toUpperCase());
}

export function maxLeverageFor(underlying: string | null | undefined): number {
  if (!underlying) return 0;
  return IMPERIAL_MAX_LEVERAGE[underlying.toUpperCase()] ?? 0;
}

// A market the keeper's SUPPORTED_MARKETS knows about (case-insensitive).
export function isSupportedMarket(underlying: string | null | undefined): boolean {
  if (!underlying) return false;
  return underlying.toUpperCase() in IMPERIAL_MAX_LEVERAGE;
}

// Launchable = supported by Imperial AND not in the venue-unavailable set
// (phoenix/flash_trade markets the keeper can't open yet). This is the gate a
// token must pass at creation so it can never be born into the "claims fees
// forever but never opens" state (KEEPER_P1_FIXES.md cause F / Fix 2a).
export function isLaunchableMarket(underlying: string | null | undefined): boolean {
  return isSupportedMarket(underlying) && !isMarketUnavailable(underlying);
}
