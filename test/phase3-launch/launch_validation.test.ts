// TEST_PLAN.md Phase 3 - Fix 2: launch validation / provisioning (causes F, G, H).
//
// Proves a token can't be born into an unlaunchable or half-provisioned state:
//   3.1 isLaunchableMarket rejects unsupported / venue-unavailable markets
//   3.3 refreshPoolState guards: sol_raised never zeroed, migration_status one-way
//   3.4 launch status transitions are enforced (canTransition)
//   3.2 (e2e) a created token always carries its signer + profile index (atomic)
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { isLaunchableMarket, isSupportedMarket, isMarketUnavailable } from "../../src/lib/imperial-markets.ts";
import { nextSolRaised, nextMigrationStatus } from "../../src/lib/launch/poolState.ts";
import { canTransition } from "../../src/lib/launch/transitions.ts";
import { dbAvailable, ensureSchema, resetDb, seedToken, getToken, query, closeDb } from "../helpers/db.ts";

describe("Phase 3: launch validation (T1)", () => {
  it("3.1 isLaunchableMarket: supported + available -> yes; venue-unavailable -> no; unsupported -> no", () => {
    expect(isLaunchableMarket("SOL")).toBe(true);
    expect(isLaunchableMarket("BTC")).toBe(true);
    // BNB IS supported (has a max-leverage entry) but routes to phoenix -> UNAVAILABLE -> not launchable
    expect(isSupportedMarket("BNB")).toBe(true);
    expect(isMarketUnavailable("BNB")).toBe(true);
    expect(isLaunchableMarket("BNB")).toBe(false);
    // genuinely unsupported / missing
    expect(isLaunchableMarket("FOOBAR")).toBe(false);
    expect(isLaunchableMarket(null)).toBe(false);
    // case-insensitive
    expect(isLaunchableMarket("sol")).toBe(true);
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
