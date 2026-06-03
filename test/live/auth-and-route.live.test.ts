// Read-only live test: authenticate against Imperial mainnet, hit /route for
// one symbol per venue, assert `candidates[]` shape. No funds at risk.
//
// This is the cheapest live test and the first one to run when validating
// Imperial connectivity in a new environment.
import { it, expect, beforeAll } from "vitest";
import { getRoute } from "../../keeper/src/imperial.js";
import { liveSuite, warnCostOnce } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface RouteCandidate {
  venue: string;
  expectedCostUsd: number;
  maxLeverage: number;
  costBreakdown?: Record<string, number>;
}
interface RouteResponse {
  venue: string;
  maxLeverage: number;
  expectedCostUsd: number;
  candidates?: RouteCandidate[];
  marketsVersion?: number;
}

const ROUTE_PARAMS = (asset: string) => ({
  asset,
  side: "long",
  amount: "10000000",
  collateralAsset: USDC,
  notional: "20",
  desiredLeverage: "2",
  slippageBps: "100",
});

liveSuite("Imperial — auth + /route (read-only)", () => {
  beforeAll(() => warnCostOnce());

  it("authenticates the treasury wallet against Imperial", async () => {
    const auth = await liveAuth();
    expect(auth.token).toBeTypeOf("string");
    expect(auth.token.length).toBeGreaterThan(20);
    expect(auth.wallet).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }, 30_000);

  it("returns a candidates[] array for BTC including phoenix + flash_trade + jupiter", async () => {
    const route = (await getRoute(ROUTE_PARAMS("BTC"))) as RouteResponse;
    expect(route).toBeTruthy();
    expect(Array.isArray(route.candidates)).toBe(true);
    expect(route.candidates!.length).toBeGreaterThanOrEqual(2);
    const venues = new Set(route.candidates!.map((c) => c.venue));
    // BTC is multi-venue; if /route ever returns a single candidate we want
    // to know about it (catalog regression or auth issue).
    expect(venues.size).toBeGreaterThan(1);
  }, 30_000);

  it("returns a phoenix candidate for SOL (catalog presence check)", async () => {
    const route = (await getRoute(ROUTE_PARAMS("SOL"))) as RouteResponse;
    const phoenix = route.candidates?.find((c) => c.venue === "phoenix");
    expect(phoenix).toBeTruthy();
    expect(phoenix!.maxLeverage).toBeGreaterThan(0);
  }, 30_000);

  it("returns a flash_trade candidate for PYTH (catalog presence check)", async () => {
    const route = (await getRoute(ROUTE_PARAMS("PYTH"))) as RouteResponse;
    const flash = route.candidates?.find((c) => c.venue === "flash_trade");
    expect(flash).toBeTruthy();
    expect(flash!.maxLeverage).toBeGreaterThan(0);
  }, 30_000);

  it("includes `marketsVersion` in /route responses (Phase A open question)", async () => {
    // If Imperial drops marketsVersion, we want to know so plan §1 'What
    // /route exposes that we're not using' is updated.
    const route = (await getRoute(ROUTE_PARAMS("SOL"))) as RouteResponse;
    expect(route.marketsVersion).toBeDefined();
    expect(typeof route.marketsVersion).toBe("number");
  }, 30_000);
});
