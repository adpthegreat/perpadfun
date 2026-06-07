// Client-safe mirror of SUPPORTED_MARKETS in keeper/src/imperial.js.
//
// Used by /launch and /route-fees to hide leverage tiers the venue would
// reject at open. After the Phoenix venue lock (plan/KEEPER_PHOENIX_LOCK.md)
// every market routes to Phoenix; gmtrade/flash_trade/jupiter are legacy
// fallbacks only. Phoenix's max-leverage table caps everything below 25×.
//
// Source of truth for routing remains keeper/src/imperial.js. Re-sync this
// file whenever SUPPORTED_MARKETS changes there (test/live/discover-phoenix-markets.live.test.ts
// regenerates the snippet).
export const IMPERIAL_MAX_LEVERAGE: Record<string, number> = {
  // ─── Primary 8 (UI-prominent) ───
  BTC: 20,
  ETH: 20,
  SOL: 15,
  ZEC: 10,
  HYPE: 10,
  SILVER: 25,
  GOLD: 25,
  OIL: 20,     // Phoenix lists it as WTIOIL
  WTIOIL: 20,  // direct passthrough

  // ─── Other crypto majors ───
  XRP: 15,
  BNB: 10,
  DOGE: 10,
  ADA: 10,
  SUI: 10,
  TRX: 10,
  NEAR: 10,
  TON: 10,
  XLM: 5,
  XPL: 10,

  // ─── DeFi / Sol-eco ───
  AAVE: 10,
  JTO: 5,
  JUP: 10,
  ENA: 10,
  ONDO: 10,
  MORPHO: 5,
  LIT: 5,

  // ─── AI / data ───
  FET: 5,
  RENDER: 5,
  VIRTUAL: 5,
  TAO: 5,
  WLD: 10,

  // ─── Memes / misc ───
  FARTCOIN: 10,
  CHIP: 5,
  SKR: 3,
  MEGA: 5,
  MET: 5,
  VVV: 5,
  MON: 5,

  // ─── Commodities ───
  COPPER: 20,
};

// Phoenix's max across all listed markets is 25× (GOLD, SILVER). Drop the
// 50× / 100× tiers from the picker entirely — they would never show under
// any Phoenix-routed asset.
export const BASE_LEVERAGES = [2, 3, 5] as const;
export const DEGEN_LEVERAGES = [10, 20, 25] as const;

// Every discrete leverage tier the UI can show, ascending. Single source of
// truth shared by the picker and the server-side validators, so the two can
// never drift (the picker only hides bad options — it can be bypassed).
export const ALLOWED_LEVERAGES: readonly number[] = [...BASE_LEVERAGES, ...DEGEN_LEVERAGES];

export const MARKET_DISPLAY_NAMES: Record<string, string> = {
  SPY: "S&P 500",
  WTIOIL: "Oil",
  OIL: "Oil",
};

// Per KEEPER_PHOENIX_LOCK.md, every asset in IMPERIAL_MAX_LEVERAGE routes to
// Phoenix and is openable. The legacy "this market is on a venue the keeper
// can't open against" set is therefore empty. Keep the helper so callers
// don't need to change shape; expansion is reserved for markets we
// explicitly off-board (e.g. a venue de-listing).
export const IMPERIAL_UNAVAILABLE_MARKETS: ReadonlySet<string> = new Set<string>();

export function isMarketUnavailable(underlying: string | null | undefined): boolean {
  if (!underlying) return false;
  return IMPERIAL_UNAVAILABLE_MARKETS.has(underlying.toUpperCase());
}

export function maxLeverageFor(underlying: string | null | undefined): number {
  if (!underlying) return 0;
  return IMPERIAL_MAX_LEVERAGE[underlying.toUpperCase()] ?? 0;
}

// A leverage is valid for a market iff it is one of the allowed tiers AND at or
// below that market's venue cap. This is the gate the server MUST enforce; the
// picker hiding over-cap tiers is only a UX convenience.
export function isValidLeverageFor(
  underlying: string | null | undefined,
  leverage: number,
): boolean {
  if (!Number.isInteger(leverage) || !ALLOWED_LEVERAGES.includes(leverage)) return false;
  const cap = maxLeverageFor(underlying);
  return cap > 0 && leverage <= cap;
}

// A market the keeper's SUPPORTED_MARKETS knows about (case-insensitive).
export function isSupportedMarket(underlying: string | null | undefined): boolean {
  if (!underlying) return false;
  return underlying.toUpperCase() in IMPERIAL_MAX_LEVERAGE;
}

// Launchable = supported by the Phoenix routing whitelist AND not in the
// off-boarded set (currently empty). The keeper enforces the same gate so a
// token can never be born into the "claims fees forever but never opens"
// state (KEEPER_P1_FIXES.md cause F / Fix 2a).
export function isLaunchableMarket(underlying: string | null | undefined): boolean {
  return isSupportedMarket(underlying) && !isMarketUnavailable(underlying);
}
