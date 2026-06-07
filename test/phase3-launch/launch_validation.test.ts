// TEST_PLAN.md Phase 3 - Fix 2: launch validation / provisioning (causes F, G, H).
//
// Proves a token can't be born into an unlaunchable or half-provisioned state:
//   3.1 isLaunchableMarket rejects unsupported / venue-unavailable markets
//   3.3 refreshPoolState guards: sol_raised never zeroed, migration_status one-way
//   3.4 launch status transitions are enforced (canTransition)
//   3.2 (e2e) a created token always carries its signer + profile index (atomic)
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import {
  isLaunchableMarket,
  isSupportedMarket,
  isMarketUnavailable,
  isValidLeverageFor,
  maxLeverageFor,
  ALLOWED_LEVERAGES,
} from "../../src/lib/imperial-markets.ts";
import { nextSolRaised, nextMigrationStatus } from "../../src/lib/launch/poolState.ts";
import { canTransition } from "../../src/lib/launch/transitions.ts";
import { dbAvailable, ensureSchema, resetDb, seedToken, getToken, query, closeDb } from "../helpers/db.ts";

describe("Phase 3: launch validation (T1)", () => {
  it("3.1 isLaunchableMarket: supported -> yes (every Phoenix-routed market is launchable); unsupported -> no", () => {
    expect(isLaunchableMarket("SOL")).toBe(true);
    expect(isLaunchableMarket("BTC")).toBe(true);
    // After the Phoenix venue lock (plan/KEEPER_PHOENIX_LOCK.md) every market
    // in SUPPORTED_MARKETS routes to Phoenix and is launchable. The legacy
    // "venue-unavailable" set is reserved for future off-boarding and is
    // currently empty — BNB is supported AND available AND launchable.
    expect(isSupportedMarket("BNB")).toBe(true);
    expect(isMarketUnavailable("BNB")).toBe(false);
    expect(isLaunchableMarket("BNB")).toBe(true);
    // genuinely unsupported / missing
    expect(isLaunchableMarket("FOOBAR")).toBe(false);
    expect(isLaunchableMarket(null)).toBe(false);
    // case-insensitive
    expect(isLaunchableMarket("sol")).toBe(true);
  });

  it("3.5 isValidLeverageFor: enforces allowed tiers AND the per-market venue cap", () => {
    // Within cap, allowed tier -> ok.
    expect(isValidLeverageFor("BTC", 20)).toBe(true); // BTC cap 20
    expect(isValidLeverageFor("SOL", 10)).toBe(true); // SOL cap 15
    expect(isValidLeverageFor("GOLD", 25)).toBe(true); // GOLD cap 25
    expect(isValidLeverageFor("SKR", 3)).toBe(true); // SKR cap 3 -> base tier 3

    // Over the per-market cap -> rejected (this is what the picker hides; the
    // server must independently reject it).
    expect(isValidLeverageFor("SOL", 25)).toBe(false); // 25 > SOL cap 15
    expect(isValidLeverageFor("ZEC", 20)).toBe(false); // 20 > ZEC cap 10
    expect(isValidLeverageFor("SKR", 5)).toBe(false); // 5 > SKR cap 3

    // Off-tier values are rejected even if <= cap (e.g. 4, 7).
    expect(isValidLeverageFor("BTC", 4)).toBe(false);
    expect(isValidLeverageFor("BTC", 7)).toBe(false);
    expect(isValidLeverageFor("BTC", 0)).toBe(false);
    expect(isValidLeverageFor("BTC", -5)).toBe(false);
    expect(isValidLeverageFor("BTC", 2.5)).toBe(false);

    // The retired degen tiers (50x/100x) are no longer accepted for ANY market
    // — this is the regression that let 100x positions through (logdumps).
    for (const sym of Object.keys({ BTC: 1, ETH: 1, SOL: 1, GOLD: 1, SILVER: 1 })) {
      expect(isValidLeverageFor(sym, 50)).toBe(false);
      expect(isValidLeverageFor(sym, 100)).toBe(false);
    }

    // The newly-added 20x tier (commit 1b7e648) is a real allowed tier.
    expect(ALLOWED_LEVERAGES).toContain(20);
    expect(isValidLeverageFor("ETH", 20)).toBe(true); // ETH cap 20

    // Unknown markets have no cap -> nothing is valid.
    expect(isValidLeverageFor("FOOBAR", 2)).toBe(false);
    expect(isValidLeverageFor(null, 2)).toBe(false);

    // Every allowed tier is valid for at least one real market (no dead tiers).
    for (const lev of ALLOWED_LEVERAGES) {
      const someMarketAccepts = ["SOL", "BTC", "ETH", "GOLD", "SILVER"].some(
        (m) => lev <= maxLeverageFor(m),
      );
      expect(someMarketAccepts).toBe(true);
    }
  });

  it("3.3 sol_raised is preserved when the on-chain read exposes none (never zeroed)", () => {
    expect(nextSolRaised(80, 50)).toBe(80); // fresh read used
    expect(nextSolRaised(null, 50)).toBe(50); // no read -> keep last known
    expect(nextSolRaised(undefined, 50)).toBe(50);
    expect(nextSolRaised(0, 50)).toBe(0); // a real 0 read is honored
    expect(nextSolRaised(null, 0)).toBe(0);
  });

  it("3.3 migration_status is one-way (graduated never downgrades to curve)", () => {
    expect(nextMigrationStatus("graduated", false)).toBe("graduated"); // stays even if read flips
    expect(nextMigrationStatus("graduated", undefined)).toBe("graduated");
    expect(nextMigrationStatus("curve", true)).toBe("graduated"); // migrate forward
    expect(nextMigrationStatus("curve", false)).toBe("curve");
    expect(nextMigrationStatus("pending", false)).toBe("curve");
  });

  it("3.4 only legal launch transitions are accepted", () => {
    expect(canTransition("launching", "live")).toBe(true);
    expect(canTransition("launching", "failed")).toBe(true);
    expect(canTransition("failed", "live")).toBe(true); // a retry that finally lands recovers
    expect(canTransition("live", "deprecated")).toBe(true);
    expect(canTransition("live", "live")).toBe(true); // idempotent no-op
    // illegal
    expect(canTransition("live", "launching")).toBe(false); // no going backward
    expect(canTransition("deprecated", "live")).toBe(false); // terminal
    expect(canTransition("live", "failed")).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("Phase 3: atomic launch provisioning - e2e (3.2, DB reset per test)", () => {
  beforeAll(async () => {
    await ensureSchema();
  });
  afterEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("a created token always carries its signer (treasury_wallet_address) + imperial_profile_index", async () => {
    const id = await seedToken(); // models createDraftToken's atomic identity insert
    const t = await getToken(id);
    expect(t.treasury_wallet_address).toBeTruthy();
    expect(t.imperial_profile_index).not.toBeNull();
  });

  it("a signer-less / index-less half-create is impossible (DB enforces atomicity)", async () => {
    // omit treasury_wallet_address -> NOT NULL rejects (no draft without a signer)
    await expect(
      query("insert into public.tokens (ticker, name, underlying, leverage, direction) values ('T','N','SOL',5,'long')"),
    ).rejects.toThrow();
    // explicit-null imperial_profile_index -> NOT NULL rejects
    await expect(
      query(
        "insert into public.tokens (ticker, name, underlying, leverage, direction, treasury_wallet_address, imperial_profile_index) values ('T','N','SOL',5,'long','w', null)",
      ),
    ).rejects.toThrow();
  });
});
