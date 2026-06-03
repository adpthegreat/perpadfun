// Fetch the max leverage Imperial allows for (symbol, venue) by hitting
// /route with all other venues excluded and reading `maxLeverage` from the
// response. Works for every venue uniformly (no per-venue catalog parsing).
//
// `desiredLeverage=200` forces /route to clamp to whatever the venue caps at,
// so the returned value IS the actual venue ceiling for this symbol at the
// probed notional. The OpenAPI describes `maxLeverage` as the venue cap for
// the smallest position tier — that's what we want for $10 collateral.
//
// Throws if Imperial returns 404 (venue doesn't support the asset) — e.g.
// jupiter doesn't list HYPE.
import { getRouteWithExclusions, type VenueStr } from "./imperial-order-protocol.js";

const IMPERIAL_BASE_URL =
  process.env.IMPERIAL_BASE_URL?.trim() || "https://api.imperial.space/api/v1";

const ALL_VENUES: VenueStr[] = ["jupiter", "flash_trade", "phoenix", "gmtrade"];

export async function getVenueMaxLeverage(
  venue: VenueStr,
  symbol: string,
  probeNotionalUsd = 20,
): Promise<number> {
  const excluded = ALL_VENUES.filter((v) => v !== venue);
  let route;
  try {
    route = await getRouteWithExclusions({
      baseUrl: IMPERIAL_BASE_URL,
      params: {
        asset: symbol.toUpperCase(),
        side: "long",
        notional: probeNotionalUsd,
        desiredLeverage: 200, // force clamping to venue cap
        slippageBps: 100,
        excludedVenues: excluded,
      },
    });
  } catch (e) {
    throw new Error(
      `getVenueMaxLeverage(${venue}, ${symbol}): /route failed — likely venue ` +
        `doesn't list ${symbol} (404). raw: ${(e as Error).message}`,
    );
  }

  // With all other venues excluded, top-level venue MUST be our target.
  if (route.venue === venue) {
    return route.maxLeverage;
  }
  // Fallback: look in candidates[] (shouldn't happen with exclusions, but
  // covers the case where Imperial returns a different shape).
  const cand = route.candidates?.find((c) => c.venue === venue);
  if (!cand) {
    throw new Error(
      `getVenueMaxLeverage(${venue}, ${symbol}): /route returned venue=${route.venue} ` +
        `with no ${venue} candidate. candidates=${JSON.stringify(route.candidates)}`,
    );
  }
  return cand.maxLeverage;
}

// Same as above but rounded down to the nearest 0.01 (Imperial sometimes
// returns floats like 9.96 or 14.92, which when passed as `desiredLeverage`
// at order time can over-shoot by floating-point noise). Truncating to 2dp
// avoids "leverage exceeds cap by 0.0001" rejections.
export async function getVenueMaxLeverageTruncated(
  venue: VenueStr,
  symbol: string,
  probeNotionalUsd = 20,
): Promise<number> {
  const raw = await getVenueMaxLeverage(venue, symbol, probeNotionalUsd);
  return Math.floor(raw * 100) / 100;
}
