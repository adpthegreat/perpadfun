// Read-only live test: imperialReadPosition + getPositions shape verification.
// Doesn't open or close anything. Verifies the defensive multi-key lookup in
// imperialReadPosition handles whatever Imperial's /positions currently
// returns.
import { it, expect, beforeAll } from "vitest";
import { imperialReadPosition } from "../../keeper/src/imperialPerps.js";
import { liveSuite, warnCostOnce } from "./helpers/live.js";
import { liveAuth } from "./helpers/auth.js";
import { fetchOpenPositions } from "./helpers/profile.js";

liveSuite("Imperial — imperialReadPosition (read-only)", () => {
  beforeAll(() => warnCostOnce());

  it("returns null for a profile with no open position on the queried symbol", async () => {
    const auth = await liveAuth();
    // Use a high profileIndex unlikely to have a position; if it does we'll
    // skip the negative assertion and just check the shape.
    const result = await imperialReadPosition({
      profileIndex: 99,
      symbol: "DOES_NOT_EXIST_ZZZZ",
      side: "long",
      token: auth.token,
      wallet: auth.wallet,
    });
    expect(result).toBeNull();
  }, 30_000);

  it("returns a shaped object when a real position exists (best-effort)", async () => {
    const auth = await liveAuth();
    const positions = await fetchOpenPositions(auth.token, auth.wallet);
    if (positions.length === 0) {
      // No open positions — can't test the positive case. Don't fail; live
      // state varies. Print a hint so the operator knows why.
      process.stderr.write(
        "[read-position] no open Imperial positions on this wallet — " +
          "positive-case assertion skipped\n",
      );
      return;
    }
    const sample = positions[0];
    const result = await imperialReadPosition({
      profileIndex: Number(sample.profileIndex ?? 0),
      // imperialReadPosition normalizes via defensive multi-key lookup; pass
      // whatever symbol the position row used.
      symbol: String(
        (sample as { symbol?: string; asset?: string; market?: string }).symbol ||
          (sample as { asset?: string }).asset ||
          (sample as { market?: string }).market ||
          "",
      ),
      side: String(
        (sample as { side?: string | number }).side ||
          (sample as { direction?: string | number }).direction ||
          "long",
      ),
      token: auth.token,
      wallet: auth.wallet,
    });
    expect(result).toBeTruthy();
    if (result) {
      expect(typeof result.sizeUsd).toBe("number");
      expect(result.sizeUsd).toBeGreaterThan(0);
      expect(typeof result.collateralUsd).toBe("number");
      expect(["long", "short"]).toContain(result.side);
    }
  }, 30_000);
});
