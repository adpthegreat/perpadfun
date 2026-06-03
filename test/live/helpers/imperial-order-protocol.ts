// =============================================================================
// Imperial /mobile/orders protocol — findings + correct request builders.
//
// Source of truth: Imperial OpenAPI spec at
//   https://api.imperial.space/api/v1/openapi.json
// Fetched 2026-06-01. Confirmed by reading every relevant schema component.
//
// PURPOSE OF THIS FILE
//   The comment at keeper/src/imperialPerps.js:248-252 says:
//     "phoenix + flash_trade need extra body fields (oracle accounts, lookup
//      tables, etc) that the Imperial dev has not yet spec'd to us."
//   That comment is WRONG. The OpenAPI spec proves that /mobile/orders takes
//   the same body shape for every venue. Phoenix and flash_trade do not need
//   marketAddress / orderbook / perpAssetMap / poolAddress / custody accounts
//   in the order body. Those fields live in /phoenix/markets and /flash/markets
//   for READ purposes only; Imperial resolves them server-side from
//   (symbol, underwriter).
//
//   What was probably actually wrong is one of:
//     (a) Phoenix profile wasn't activated for the test wallet.
//     (b) The body had EXTRA fields Imperial silently rejected (the keeper's
//         buildOrderBody now strips these).
//     (c) marketPrice was missing — phoenix is a CLOB, no marketPrice can
//         mean no match.
//     (d) The wallet wasn't holding $10 USDC (Imperial's hard MIN_COLLATERAL).
//
// This file:
//   1. Documents every Imperial endpoint the keeper interacts with, with the
//      EXACT field list, types, and required/optional flags as of 2026-06-01.
//   2. Provides typed body builders that always produce a valid request.
//   3. Adds helpers Imperial gave us that the keeper doesn't use yet:
//        - /phoenix/register (one-time activation, optional; auto-activates on
//          first /mobile/orders call)
//        - /route?excludedVenues=gmtrade (the canonical way to filter venues —
//          this is what the Imperial dev meant by "filter the same way you
//          filtered out perp venues before")
//        - /mobile/orders/collateral (the RIGHT endpoint for topup-margin and
//          withdraw-collateral; the current keeper guesses /deposit/build-tx
//          { mode: 'withdraw' } which is wrong and marked _TODO_VERIFY_)
//
// This file is **observational** — it doesn't mutate keeper code or the
// production order path. Reach for it from live tests when constructing the
// raw fetch() body yourself, or read it as the canonical reference for what
// Imperial actually wants.
// =============================================================================

// -----------------------------------------------------------------------------
// VENUE ENUM
// -----------------------------------------------------------------------------
// Two parallel representations Imperial uses for the same thing:
//   - Wire format (integer): used in /mobile/orders `underwriter` field
//   - String format: used in /route, /orders, /mobile/balances filters
//
// Wire-format mapping mirrors `passthrough_client::Underwriter`:
//   0 = Jupiter
//   1 = Flash Trade
//   2 = Phoenix
//   3 = GMTrade
//   4 = (reserved for Pacifica — not yet active)
export const UNDERWRITER = Object.freeze({
  jupiter: 0,
  flash_trade: 1,
  phoenix: 2,
  gmtrade: 3,
} as const);

export type VenueStr = "jupiter" | "flash_trade" | "phoenix" | "gmtrade";
export type UnderwriterInt = 0 | 1 | 2 | 3;

export function underwriterFor(venue: VenueStr): UnderwriterInt {
  return UNDERWRITER[venue] as UnderwriterInt;
}

// -----------------------------------------------------------------------------
// SIDE / ORDER TYPE / ACTION / TRIGGER CONDITION enums
// -----------------------------------------------------------------------------
// From MobileCreateOrderRequest.properties.* descriptions.
export const SIDE = Object.freeze({ long: 0, short: 1 } as const);
export const ACTION = Object.freeze({ increase: 0, decrease: 1 } as const);
export const TRIGGER_CONDITION = Object.freeze({ above: 0, below: 1 } as const);

// Imperial's full orderType enum. Keeper today only uses Market (0).
// 0=Market, 1=Limit, 2=StopLimit, 3=LandMine, 4=Ratchet, 6=RatchetEntry,
// 9=DCA, 10=FibRatchet, 11=FibRatchetEntry, 12=DcaClose, 13=DcaTimeClose,
// 14=DcaRatchetClose, 15=DcaTime, 16=DcaRatchet.
export const ORDER_TYPE = Object.freeze({
  market: 0,
  limit: 1,
  stopLimit: 2,
  landMine: 3,
  ratchet: 4,
  ratchetEntry: 6,
  dca: 9,
  fibRatchet: 10,
  fibRatchetEntry: 11,
  dcaClose: 12,
  dcaTimeClose: 13,
  dcaRatchetClose: 14,
  dcaTime: 15,
  dcaRatchet: 16,
} as const);

// Funding mode — most integrators want 0.
// 0 = funded at creation: collateral debited from the profile immediately
// 1 = pending: order created without collateral, the order-bot funder tops it
//     up asynchronously. `priority` controls the funding-queue rank.
export const FUNDING_STATUS = Object.freeze({ funded: 0, pending: 1 } as const);

// -----------------------------------------------------------------------------
// /mobile/orders REQUEST BODY (POST)
// -----------------------------------------------------------------------------
// Source: MobileCreateOrderRequest schema, OpenAPI 2026-06-01.
//
// REQUIRED for every venue (no exceptions, no per-venue extras):
//   wallet, side, orderType, action, triggerCondition, sizeUsd,
//   collateralAmount, slippageBps, triggerPrice, profileIndex, priority,
//   fundingStatus, underwriter
//
// OPTIONAL:
//   symbol      — canonical symbol like "SOL", "XAU". Recommended over
//                 marketMint. Imperial resolves the per-venue marketMint
//                 server-side from (symbol, underwriter). Works for phoenix
//                 synthetics (XAU, SPY, EUR, GBP) that have no SPL mint.
//   marketMint  — base58 SPL mint, alternative to symbol. If both set,
//                 marketMint wins.
//   marketPrice — client-observed price in oracle scale (1e9), forwarded to
//                 the market-order instruction for slippage enforcement.
//                 Ignored for resting orders. Strongly recommend for market
//                 orders (skipping this is plausibly why phoenix had silent
//                 no-ops in our earlier probes).
//   extraData   — per-orderType params (ratchet, DCA configs)
//   parentOrderPda — TP/SL grouping under an unresolved limit; null for our
//                    market-order use case.
//   phoenixNative — bool, ONLY meaningful for (underwriter=phoenix AND
//                   orderType=Limit AND action=Increase) OR PrivateTpSl(5).
//                   Default false → API rewrites Phoenix Limit/PrivateTpSl
//                   to StopLimit so they route through the keeper path
//                   (avoids a class of orderbook-watcher bugs). For our
//                   Market orders this flag is ignored.
export interface MobileCreateOrderBody {
  wallet: string;
  side: 0 | 1;
  orderType: number;
  action: 0 | 1;
  triggerCondition: 0 | 1;
  sizeUsd: number; // u64, 6-decimal USD (1_000_000 = $1)
  collateralAmount: number; // u64, native units (USDC = 6 decimals)
  slippageBps: number;
  triggerPrice: number; // u64, 1e9 oracle scale
  profileIndex: number; // 0..5
  priority: number; // 0 = highest
  fundingStatus: 0 | 1;
  underwriter: UnderwriterInt;
  // optional
  symbol?: string;
  marketMint?: string;
  marketPrice?: number;
  extraData?: unknown;
  parentOrderPda?: string;
  phoenixNative?: boolean;
}

// Convenience: build a Market order body for any venue. Since the spec is
// identical across venues, this single builder works for all 4. The optional
// `phoenixNative` is only included for phoenix limits; for market orders we
// always omit it.
export function buildMarketOrderBody(opts: {
  venue: VenueStr;
  wallet: string;
  symbol: string;
  side: "long" | "short";
  // collateral in USD UI units (e.g. 10 = $10). Converted to native units (6 decimals).
  collateralUsd: number;
  // size in USD UI units (e.g. 20 = $20). Converted to 6-decimal fixed point.
  sizeUsd: number;
  slippageBps?: number;
  profileIndex: number;
  // Optional client-observed price (oracle scale 1e9). Strongly recommended
  // for Market orders, especially Phoenix where the absence may cause
  // silent no-ops (see file header point (c)).
  marketPrice?: number;
}): MobileCreateOrderBody {
  const USDC_DECIMALS = 6;
  // IMPORTANT: emit explicit `null` for every optional field even when unused.
  // The Scalar API reference demo includes `extraData`, `marketMint`,
  // `parentOrderPda`, and `phoenixNative` as `null` in the example body.
  // Imperial's server appears to use a strict Rust serde deserializer that
  // expects all fields present in the wire format — omitting them causes a
  // deserialization failure masked by their catch-all "Failed to place
  // order — please try again." response. Always include all 4.
  return {
    wallet: opts.wallet,
    symbol: opts.symbol.toUpperCase(),
    marketMint: null as unknown as string,
    side: SIDE[opts.side],
    orderType: ORDER_TYPE.market,
    action: ACTION.increase,
    triggerCondition: TRIGGER_CONDITION.above,
    triggerPrice: 0,
    sizeUsd: Math.round(opts.sizeUsd * 10 ** USDC_DECIMALS),
    collateralAmount: Math.round(opts.collateralUsd * 10 ** USDC_DECIMALS),
    slippageBps: opts.slippageBps ?? 100,
    profileIndex: opts.profileIndex,
    priority: 0,
    fundingStatus: FUNDING_STATUS.funded,
    underwriter: underwriterFor(opts.venue),
    marketPrice: opts.marketPrice ?? 0,
    extraData: null,
    parentOrderPda: null as unknown as string,
    phoenixNative: null as unknown as boolean,
  };
}

// Close order: same shape as open, with action=1 and collateralAmount=0.
// per imperialPerps.js:415-417: Imperial only has the open/close action verbs;
// "partial" is just a close with smaller sizeUsd. For a FULL close, set
// sizeUsd to the position's exact sizeUsd (avoid float drift).
export function buildCloseOrderBody(opts: {
  venue: VenueStr;
  wallet: string;
  symbol: string;
  side: "long" | "short";
  // sizeUsd to close — equals position.sizeUsd for full close, less for partial
  closeSizeUsd: number;
  slippageBps?: number;
  profileIndex: number;
  marketPrice?: number;
  // Position PDA from /positions[*].positionPda. REQUIRED for flash_trade
  // closes (silent reject otherwise). Optional for phoenix/gmtrade/jupiter
  // — the keeper resolves by symbol+side. Pass it when available.
  positionId?: string;
}): MobileCreateOrderBody & { positionId?: string } {
  const USDC_DECIMALS = 6;
  // Same explicit-null requirement as buildMarketOrderBody.
  const body: MobileCreateOrderBody & { positionId?: string } = {
    wallet: opts.wallet,
    symbol: opts.symbol.toUpperCase(),
    marketMint: null as unknown as string,
    side: SIDE[opts.side], // SAME side as the position
    orderType: ORDER_TYPE.market,
    action: ACTION.decrease, // 1 = close
    triggerCondition: TRIGGER_CONDITION.above,
    triggerPrice: 0,
    sizeUsd: Math.round(opts.closeSizeUsd * 10 ** USDC_DECIMALS),
    collateralAmount: 0, // MUST be 0 for close
    slippageBps: opts.slippageBps ?? 100,
    profileIndex: opts.profileIndex,
    priority: 0,
    fundingStatus: FUNDING_STATUS.funded,
    underwriter: underwriterFor(opts.venue),
    marketPrice: opts.marketPrice ?? 0,
    extraData: null,
    parentOrderPda: null as unknown as string,
    phoenixNative: null as unknown as boolean,
  };
  if (opts.positionId) body.positionId = opts.positionId;
  return body;
}

// -----------------------------------------------------------------------------
// /mobile/orders RESPONSE
// -----------------------------------------------------------------------------
// Source: MobileOrderResponse schema.
//   success    bool      true = order bot accepted; false = rejected
//   error      string?   humanized error message when success=false
//   signature  string?   Solana tx signature, if one was produced
//   orderPda   string?   base58 Order PDA — for RESTING orders only (limit,
//                        stop-limit, ratchet, DCA, Phoenix native). None for
//                        Market orders.
//
// IMPORTANT: per keeper/scripts/imperial-order-probe.mjs:188-192, Imperial's
// /mobile/orders sometimes returns {success:false, error:"Failed to place
// order"} EVEN WHEN THE ORDER ACTUALLY FILLED on-chain. The keeper compensates
// by polling /positions for a freshly-opened position. The same fallback is
// in test/live/helpers/verify.ts:pollForFreshPosition.
export interface MobileOrderResponse {
  success: boolean;
  error?: string | null;
  signature?: string | null;
  orderPda?: string | null;
}

// -----------------------------------------------------------------------------
// /mobile/orders/collateral — the CORRECT topup-margin and withdraw endpoint
// -----------------------------------------------------------------------------
// Source: MobileCollateralEditRequest + the OpenAPI endpoint definition.
//
// This is the endpoint the keeper SHOULD be using for:
//   - imperialTopUpMargin: action=0 (add collateral)
//   - imperialWithdrawCollateral: action=1 (remove collateral)
//
// Current keeper code (imperialPerps.js):
//   - imperialTopUpMargin calls depositToImperialProfile, which uses
//     /deposit/build-tx { mode: 'deposit' }. That deposits to the PROFILE
//     pool, not to the position's margin. Imperial's /mobile/orders/collateral
//     is the right call to actually attach more margin to a position.
//   - imperialWithdrawCollateral guesses /deposit/build-tx { mode: 'withdraw' }
//     (see comment at imperialPerps.js:31-34 marked _TODO_VERIFY_). The
//     correct endpoint is /mobile/orders/collateral with action=1.
//
// REQUIRED:
//   wallet, marketMint, side, action, collateralAmount, slippageBps,
//   profileIndex, underwriter, price
//
// Note: marketMint is REQUIRED here (vs optional for /mobile/orders). The
// `symbol` shortcut isn't available on this endpoint — you must look up the
// per-venue marketMint via resolveMarket() / /phoenix/markets / /flash/markets
// / /gmtrade/markets first.
export interface CollateralEditBody {
  wallet: string;
  marketMint: string;
  side: 0 | 1;
  action: 0 | 1; // 0 = add, 1 = remove
  collateralAmount: number; // u64, USDC native units (6 decimals)
  slippageBps: number;
  profileIndex: number;
  underwriter: UnderwriterInt;
  price: number; // u64, oracle scale (1e9)
}

export function buildCollateralEditBody(opts: {
  venue: VenueStr;
  wallet: string;
  marketMint: string;
  side: "long" | "short";
  // 'add' = top up; 'remove' = withdraw
  direction: "add" | "remove";
  collateralUsd: number;
  slippageBps?: number;
  profileIndex: number;
  // Required, in oracle scale (1e9). Fetch via getMarkPrice() in imperial.js.
  priceOracle1e9: number;
}): CollateralEditBody {
  const USDC_DECIMALS = 6;
  return {
    wallet: opts.wallet,
    marketMint: opts.marketMint,
    side: SIDE[opts.side],
    action: opts.direction === "add" ? 0 : 1,
    collateralAmount: Math.round(opts.collateralUsd * 10 ** USDC_DECIMALS),
    slippageBps: opts.slippageBps ?? 100,
    profileIndex: opts.profileIndex,
    underwriter: underwriterFor(opts.venue),
    price: opts.priceOracle1e9,
  };
}

// -----------------------------------------------------------------------------
// /mobile/orders/cancel
// -----------------------------------------------------------------------------
// Source: MobileCancelOrderRequest. For resting orders (limit/stop-limit/etc.).
// Not relevant for our Market-only flow, but documented for completeness.
//
// REQUIRED: wallet, orderPda, profileIndex
// The orderPda comes back in the MobileOrderResponse when the resting order
// was first placed.
export interface CancelOrderBody {
  wallet: string;
  orderPda: string;
  profileIndex: number;
}

// -----------------------------------------------------------------------------
// /mobile/orders/batch — open + close legs in one POST
// -----------------------------------------------------------------------------
// Source: MobileCreateOrderBatchRequest. Useful if we ever attach TP/SL at
// entry time. Entry submitted first; close legs submitted in order; if entry
// fails, no closes are submitted; if a close fails, the entry stays open
// (same partial-state semantics as the homepage flow).
//
// Out of scope for the current keeper's flow but documented for the design
// of the future percentage-TP work (KEEPER_PCT_TP_FLYWHEEL.md). Imperial
// claims close-target validation is implicit when entry+close ship together.

// -----------------------------------------------------------------------------
// /phoenix/register — pre-activate phoenix for a (wallet, profileIndex)
// -----------------------------------------------------------------------------
// Source: RegisterPhoenixRequest + RegisterPhoenixResponse.
//
// IMPORTANT NUANCE from the OpenAPI description:
//   "/mobile/orders already auto-activates Phoenix on first use and caches
//    the result. Use this endpoint only when you want to pre-activate from
//    a UI flow or warm the cache before sending a latency-sensitive first
//    Phoenix order. Idempotent."
//
// BUT also:
//   "Each profile activates independently — bots farming across multiple
//    subaccounts must register each one before placing Phoenix orders from
//    it."
//
// So the safe pattern for our test suite is:
//   1. Pre-register each profile we plan to use Phoenix from.
//   2. Then call /mobile/orders.
// This eliminates the "first-use latency hit + possible silent failure"
// failure mode as a hypothesis for the previously-observed Phoenix no-ops.
//
// REQUIRED: wallet
// OPTIONAL: profileIndex (defaults to 0 if omitted, per OpenAPI minimum=0)
//
// **Unauthenticated** — no JWT needed. Imperial's design choice; the activation
// is keyed on the profile PDA so a stranger can't hurt you by pre-activating
// you, and the worst case is they pre-register you under Imperial's referral
// which is "exactly what we want anyway."
export interface PhoenixRegisterBody {
  wallet: string;
  profileIndex?: number;
}

export interface PhoenixRegisterResponse {
  activated: boolean;
  profilePda: string;
  message: string;
}

export async function registerPhoenixProfile(opts: {
  baseUrl: string; // e.g. "https://api.imperial.space/api/v1"
  wallet: string;
  profileIndex?: number;
}): Promise<PhoenixRegisterResponse> {
  const url = `${opts.baseUrl}/phoenix/register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet: opts.wallet,
      ...(opts.profileIndex !== undefined ? { profileIndex: opts.profileIndex } : {}),
    } satisfies PhoenixRegisterBody),
  });
  if (!res.ok) {
    throw new Error(`/phoenix/register ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PhoenixRegisterResponse;
}

// -----------------------------------------------------------------------------
// /route — get the cheapest venue for a trade, with optional venue exclusions
// -----------------------------------------------------------------------------
// Source: RouteResult schema + /route query parameters.
//
// **This is the canonical answer to "how do we filter out gmtrade?"** The
// Imperial dev told us "filter the same way you filtered out perp venues
// before." That meant the `excludedVenues` query parameter:
//
//   GET /api/v1/route?asset=BTC&side=long&notional=20&desiredLeverage=2
//     &slippageBps=100&excludedVenues=gmtrade
//
// Returns: venue (string), maxLeverage, expectedCostUsd, costBreakdown,
//          candidates[], marketsVersion
//
// Excluding gmtrade entirely is one comma-separated value. The previously-
// pursued approach (re-running probe7 at $20 notional and filtering client-
// side) is wrong because /route's default pick is cost-optimal AT THAT SIZE
// — non-gmtrade venues route the SAME symbols at larger sizes. The catalog
// union (phoenix.symbols ∪ flash_trade.symbols ∪ jupiter.symbols) is the
// right scope for SUPPORTED_MARKETS; this query is the right tool for
// per-request venue selection.
//
// Other relevant params:
//   stickyVenue           — lock the venue (e.g. an open position must close
//                           on the same venue it opened on)
//   subaccountDefaultVenue— server-side per-subaccount default; nice-to-have
//   excludedVenues        — array, comma-separated in the URL
//   wallet + profileIndex — when present, sticky venue auto-resolves from the
//                           subaccount's open lifecycles
export interface RouteParams {
  asset: string;
  side: "long" | "short";
  notional: number;
  desiredLeverage: number;
  slippageBps?: number;
  // ARRAY in the type; comma-joined in the URL.
  excludedVenues?: VenueStr[];
  stickyVenue?: VenueStr;
  subaccountDefaultVenue?: VenueStr;
  wallet?: string;
  profileIndex?: number;
  holdHours?: number;
  dailyVol?: number;
}

export interface RouteCandidate {
  venue: VenueStr;
  expectedCostUsd: number;
  maxLeverage: number;
  costBreakdown?: Record<string, number>;
}

export interface RouteResult {
  venue: VenueStr;
  maxLeverage: number;
  expectedCostUsd: number;
  costBreakdown: Record<string, number>;
  clamped: boolean;
  clampedMaxLeverage?: number;
  candidates: RouteCandidate[];
  reason: string;
  marketsVersion: number;
}

export async function getRouteWithExclusions(opts: {
  baseUrl: string;
  params: RouteParams;
}): Promise<RouteResult> {
  const p = opts.params;
  const qs = new URLSearchParams({
    asset: p.asset.toUpperCase(),
    side: p.side,
    notional: String(p.notional),
    desiredLeverage: String(p.desiredLeverage),
    slippageBps: String(p.slippageBps ?? 100),
  });
  if (p.excludedVenues && p.excludedVenues.length > 0) {
    // Imperial expects comma-separated list per `excludedVenues=phoenix,gmtrade`.
    qs.set("excludedVenues", p.excludedVenues.join(","));
  }
  if (p.stickyVenue) qs.set("stickyVenue", p.stickyVenue);
  if (p.subaccountDefaultVenue) qs.set("subaccountDefaultVenue", p.subaccountDefaultVenue);
  if (p.wallet) qs.set("wallet", p.wallet);
  if (p.profileIndex !== undefined) qs.set("profileIndex", String(p.profileIndex));
  if (p.holdHours !== undefined) qs.set("holdHours", String(p.holdHours));
  if (p.dailyVol !== undefined) qs.set("dailyVol", String(p.dailyVol));
  const url = `${opts.baseUrl}/route?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/route ${res.status}: ${await res.text()}`);
  return (await res.json()) as RouteResult;
}

// -----------------------------------------------------------------------------
// Per-venue market catalogs (read-only; NOT order body inputs)
// -----------------------------------------------------------------------------
// /phoenix/markets, /flash/markets, /gmtrade/markets all return an array of
// per-market entries. Each entry has venue-specific fields (orderbook PDA for
// phoenix, marketAddress for flash_trade, market PDA for gmtrade, etc.).
//
// **These are reference data, not order body inputs.** Imperial resolves
// (symbol, underwriter) to the right marketMint server-side; we don't forward
// the venue-specific PDAs.
//
// The per-venue catalogs ARE useful for two things:
//   1. The full list of symbols each venue actually supports (the right source
//      for SUPPORTED_MARKETS — see plan/KEEPER_PHOENIX_FLASH_TRADE_OPENS.md §1
//      postscript).
//   2. The `marketMint` to pass to /mobile/orders/collateral (which DOES
//      require it). Resolution map:
//        gmtrade     → row.market
//        flash_trade → row.marketAddress
//        phoenix     → row.orderbook
//   This matches keeper/src/imperial.js:mintForVenueEntry().
export function marketMintForVenueRow(
  venue: VenueStr,
  row: Record<string, unknown>,
): string | null {
  switch (venue) {
    case "gmtrade":
      return (row.market as string) ?? null;
    case "flash_trade":
      return (row.marketAddress as string) ?? null;
    case "phoenix":
      return (row.orderbook as string) ?? null;
    case "jupiter":
      // Jupiter has no per-market catalog endpoint; their markets are derived
      // from token mints directly. Pass the SPL mint for the underlying.
      return null;
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// SUMMARY: why the previous "phoenix + flash_trade need extra body fields"
// belief was wrong, and what to do instead.
// -----------------------------------------------------------------------------
//
// THE BELIEF:
//   imperialPerps.js:248-252 claims phoenix and flash_trade orders need
//   "extra body fields (oracle accounts, lookup tables, etc) that the
//   Imperial dev has not yet spec'd to us." Based on this, the keeper has
//   SUPPORTED_OPEN_VENUES = {gmtrade, jupiter} and rejects all phoenix /
//   flash_trade routes client-side.
//
// THE EVIDENCE FROM OPENAPI 2026-06-01:
//   1. MobileCreateOrderRequest has 13 required fields. NONE are venue-
//      specific. The schema doesn't change based on `underwriter`.
//   2. The OpenAPI description for `symbol` says: "Resolved server-side to
//      the right `marketMint` for the requested `underwriter`." Imperial
//      handles per-venue resolution server-side.
//   3. The only venue-conditional body field is `phoenixNative`, and it's
//      ONLY for resting Phoenix limit orders (orderType=Limit), which we
//      don't use anyway.
//   4. `/phoenix/register` is OPTIONAL and idempotent; /mobile/orders auto-
//      activates phoenix on first use.
//   5. /route accepts `excludedVenues` to filter venues — exactly the
//      "filter the same way you filtered before" pattern the Imperial dev
//      pointed at.
//
// THE LIKELY ACTUAL CAUSE of the previous 200-OK silent no-ops:
//   (a) Test wallet wasn't phoenix-activated AND there was a one-shot
//       activation failure path that returned success=false. Pre-registering
//       via /phoenix/register sidesteps this.
//   (b) Body had EXTRA fields (notional / desiredLeverage / collateralAsset /
//       reduceOnly / marketMint) that Imperial silently ignored or rejected.
//       The keeper's current buildOrderBody (imperial.js:619-668) strips
//       these — but this fix landed AFTER the original phoenix/flash_trade
//       probes were run.
//   (c) marketPrice wasn't set. Phoenix orderbook needs a reference price
//       for the on-chain slippage check; without one the order can be
//       silently no-op'd. Always set marketPrice for market orders.
//   (d) Wallet didn't hold >= $10 USDC, Imperial's MIN_COLLATERAL hard floor.
//
// THE FIX (deferred — this file is observational only):
//   The keeper's buildOrderBody is already correct shape-wise. To unlock
//   phoenix and flash_trade opens, the right code change is:
//     1. imperialPerps.js:254 — drop the SUPPORTED_OPEN_VENUES gate (or
//        change the set to {phoenix, flash_trade, jupiter}).
//     2. Always set marketPrice in buildOrderBody (currently it's only set
//        when getMarkPrice returns a value; fail loudly if it doesn't).
//     3. Add a one-time /phoenix/register call to the keeper's profile
//        bootstrap (next to imperialDeposit setup).
//     4. Switch imperialTopUpMargin and imperialWithdrawCollateral to use
//        /mobile/orders/collateral (with marketMint resolution) instead of
//        /deposit/build-tx.
//   Each of these is testable against the live suite in this directory.
// -----------------------------------------------------------------------------
