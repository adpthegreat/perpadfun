// Pure-logic coverage for the quest funnel. The Telegram membership decision
// (isJoinedStatus) is what getChannelMembership delegates to, so proving it here proves the
// server-side TG check's correctness without a live bot. Relative imports: vitest has no @/ alias.
import { describe, it, expect } from "vitest";
import {
  isJoinedStatus,
  stepsOf,
  genReferralCode,
  isWellFormedReferralCode,
  isLikelySolAddress,
} from "../../src/lib/quest/shared";

describe("isJoinedStatus (Telegram getChatMember → joined)", () => {
  it("counts active membership statuses as joined", () => {
    expect(isJoinedStatus("creator")).toBe(true);
    expect(isJoinedStatus("administrator")).toBe(true);
    expect(isJoinedStatus("member")).toBe(true);
  });

  it("counts restricted as joined ONLY when is_member is explicitly true", () => {
    expect(isJoinedStatus("restricted", true)).toBe(true);
    expect(isJoinedStatus("restricted", false)).toBe(false);
    expect(isJoinedStatus("restricted")).toBe(false); // is_member undefined
  });

  it("does not count left / kicked / banned as joined", () => {
    expect(isJoinedStatus("left")).toBe(false);
    expect(isJoinedStatus("kicked")).toBe(false);
    expect(isJoinedStatus("banned")).toBe(false);
  });

  it("treats missing status as not joined", () => {
    expect(isJoinedStatus(undefined)).toBe(false);
    expect(isJoinedStatus(null)).toBe(false);
    expect(isJoinedStatus("")).toBe(false);
  });
});

describe("stepsOf", () => {
  it("projects a row onto the public step state", () => {
    expect(stepsOf({ x_followed: true, x_retweeted: false, tg_joined: true })).toEqual({
      x_follow: true,
      x_retweet: false,
      tg_joined: true,
    });
  });
});

describe("referral codes", () => {
  it("generates codes of the requested length from the unambiguous alphabet", () => {
    const code = genReferralCode(new Uint8Array(8).fill(0));
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[2-9A-HJ-NP-Za-km-z]+$/);
  });

  it("round-trips: a generated code passes the well-formed check", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = new Uint8Array(8);
      for (let j = 0; j < bytes.length; j++) bytes[j] = (i * 7 + j * 13) % 256;
      expect(isWellFormedReferralCode(genReferralCode(bytes))).toBe(true);
    }
  });

  it("rejects malformed referral codes", () => {
    expect(isWellFormedReferralCode("")).toBe(false);
    expect(isWellFormedReferralCode("abc")).toBe(false); // too short
    expect(isWellFormedReferralCode("0OIl1")).toBe(false); // ambiguous chars excluded
    expect(isWellFormedReferralCode("has space")).toBe(false);
    expect(isWellFormedReferralCode("waytoolongreferralcode123")).toBe(false);
  });
});

describe("isLikelySolAddress (shape pre-check)", () => {
  it("accepts well-formed base58 Solana addresses", () => {
    expect(isLikelySolAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isLikelySolAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(true);
  });

  it("rejects the wrong shape (too short/long, bad chars, spaces)", () => {
    expect(isLikelySolAddress("")).toBe(false);
    expect(isLikelySolAddress("abc")).toBe(false);
    expect(isLikelySolAddress("0x1234567890abcdef")).toBe(false); // EVM-style
    expect(isLikelySolAddress("has space in it aaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isLikelySolAddress("0OIl" + "1".repeat(40))).toBe(false); // ambiguous chars
  });
});
