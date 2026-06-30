// Known-answer tests for the Kamino merkle port. The gate is INDEPENDENT
// verification: the expected leaf/root bytes are recomputed here with Node's
// built-in `node:crypto` SHA-256 — a completely different code path from the
// `@noble/hashes` SHA-256 used by merkle.ts. A shared bug in noble-invocation or
// byte assembly would diverge between the two and fail these asserts (a pure
// round-trip self-check could not catch that). Round-trip verify is ALSO run as
// a second layer.
//
// Caveat: neither layer can catch a misreading of the Rust LAYOUT (both sides
// are written here from the same source reading) — only a real on-chain claim
// closes that gap. The byte assembly itself, however, is fully pinned.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, it, expect } from "vitest";
import {
  buildTree,
  hashLeafNode,
  hashLeaf,
  hashIntermediate,
  verifyProof,
  uiAmountToBaseUnits,
  type AirdropEntry,
} from "../../src/lib/airdrop/merkle";

// ---- Independent reference implementation (node:crypto) ----
function sha(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
function refLeafNode(pubkey: string, amount: bigint): Buffer {
  const claimant = Buffer.from(new PublicKey(pubkey).toBytes());
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(amount);
  const zero = Buffer.alloc(8); // literal 0u64
  return sha(claimant, amt, zero);
}
function refHashedLeaf(node: Buffer): Buffer {
  return sha(Buffer.from([0]), node);
}
function refIntermediate(a: Buffer, b: Buffer): Buffer {
  const [l, r] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha(Buffer.from([1]), l, r);
}
function refLeaf(pubkey: string, amount: bigint): Buffer {
  return refHashedLeaf(refLeafNode(pubkey, amount));
}

// Distinct, valid base58 pubkeys (system program + token program + the two
// Kamino fixture EDGARW... wallets are real keys; use a spread of known ones).
const PK = {
  a: "FLYqJsmJ5AGMxMxK3Qy1rSen4ES2dqqo6h51W3C1tYS", // Kamino fixture
  b: "EDGARWktv3nDxRYjufjdbZmryqGXceaFPoPpbUzdpqED", // Kamino fixture
  c: "EDGARWktv3nDxRYjufjdbZmryqGXceaFPoPpbUzdpqEH", // Kamino fixture
  d: "So11111111111111111111111111111111111111112",
};

describe("merkle primitives match node:crypto byte-for-byte", () => {
  it("leaf node hash (claimant ++ amount_le ++ 0u64)", () => {
    const amt = 123_456_789n;
    expect(Buffer.from(hashLeafNode(PK.a, amt))).toEqual(refLeafNode(PK.a, amt));
  });

  it("hashed leaf (0x00 ++ node)", () => {
    const node = hashLeafNode(PK.a, 100n);
    expect(Buffer.from(hashLeaf(node))).toEqual(refHashedLeaf(refLeafNode(PK.a, 100n)));
  });

  it("intermediate is sorted (0x01 ++ min ++ max), order-independent", () => {
    const x = refLeaf(PK.a, 1n);
    const y = refLeaf(PK.b, 2n);
    expect(Buffer.from(hashIntermediate(x, y))).toEqual(refIntermediate(x, y));
    // sorted => swapping inputs yields the same hash
    expect(Buffer.from(hashIntermediate(x, y))).toEqual(Buffer.from(hashIntermediate(y, x)));
  });
});

describe("tree root matches independent reference", () => {
  it("1-node tree: root == hashed leaf", () => {
    const entries: AirdropEntry[] = [{ pubkey: PK.a, amountBaseUnits: 1_000_000n }];
    const { root } = buildTree(entries);
    expect(Buffer.from(root)).toEqual(refLeaf(PK.a, 1_000_000n));
  });

  it("2-node tree: root == intermediate(l0,l1)", () => {
    const entries: AirdropEntry[] = [
      { pubkey: PK.a, amountBaseUnits: 10n },
      { pubkey: PK.b, amountBaseUnits: 20n },
    ];
    const { root } = buildTree(entries);
    const l0 = refLeaf(PK.a, 10n);
    const l1 = refLeaf(PK.b, 20n);
    expect(Buffer.from(root)).toEqual(refIntermediate(l0, l1));
  });

  it("3-node tree: odd tail duplicated (Kamino fixture wallets @ 100e9)", () => {
    const amt = 100_000_000_000n; // 100 USDC @ 9dp, the Rust fixture amount
    const entries: AirdropEntry[] = [
      { pubkey: PK.a, amountBaseUnits: amt },
      { pubkey: PK.b, amountBaseUnits: amt },
      { pubkey: PK.c, amountBaseUnits: amt },
    ];
    const { root, maxNumNodes, maxTotalClaim } = buildTree(entries);
    const l0 = refLeaf(PK.a, amt);
    const l1 = refLeaf(PK.b, amt);
    const l2 = refLeaf(PK.c, amt);
    const n0 = refIntermediate(l0, l1);
    const n1 = refIntermediate(l2, l2); // odd -> paired with self
    const expectedRoot = refIntermediate(n0, n1);
    expect(Buffer.from(root)).toEqual(expectedRoot);
    expect(maxNumNodes).toBe(3);
    expect(maxTotalClaim).toBe(amt * 3n);
  });
});

describe("every proof verifies against the root (round-trip)", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    it(`${n}-node tree: all proofs valid`, () => {
      const entries: AirdropEntry[] = Array.from({ length: n }, (_, i) => ({
        // derive distinct deterministic pubkeys
        pubkey: PublicKey.unique().toBase58(),
        amountBaseUnits: BigInt((i + 1) * 1_000_000),
      }));
      const { root, nodes } = buildTree(entries);
      for (const node of nodes) {
        const leaf = hashLeaf(hashLeafNode(node.pubkey, BigInt(node.amount)));
        expect(verifyProof(node.proof, root, leaf)).toBe(true);
        // tamper one byte -> must fail
        const bad = leaf.slice();
        bad[0] ^= 0xff;
        expect(verifyProof(node.proof, root, bad)).toBe(false);
      }
    });
  }
});

describe("dedupe-sum preserves first-seen order and sums amounts", () => {
  it("duplicate owner rows are summed into one node", () => {
    const entries: AirdropEntry[] = [
      { pubkey: PK.a, amountBaseUnits: 100n },
      { pubkey: PK.b, amountBaseUnits: 50n },
      { pubkey: PK.a, amountBaseUnits: 25n }, // duplicate of a
    ];
    const { nodes, maxNumNodes, maxTotalClaim } = buildTree(entries);
    expect(maxNumNodes).toBe(2);
    expect(maxTotalClaim).toBe(175n);
    expect(nodes.map((n) => n.pubkey)).toEqual([PK.a, PK.b]); // order preserved
    expect(nodes[0].amount).toBe("125"); // 100 + 25
    expect(nodes[1].amount).toBe("50");
  });
});

describe("uiAmountToBaseUnits — exact integer string math (no float)", () => {
  it("whole number", () => {
    expect(uiAmountToBaseUnits("100")).toBe(100_000_000n);
  });
  it("clean fractional (no off-by-one)", () => {
    expect(uiAmountToBaseUnits("1.234567")).toBe(1_234_567n);
  });
  it("pads short fraction", () => {
    expect(uiAmountToBaseUnits("0.5")).toBe(500_000n);
  });
  it("floors (truncates) extra fractional digits", () => {
    expect(uiAmountToBaseUnits("1.2345678")).toBe(1_234_567n);
  });
  it("a value that float*1e6 would round wrong stays exact", () => {
    // 2.09 * 1e6 in IEEE-754 = 2089999.9999... -> Math.floor gives 2089999.
    // Integer string math yields the intended 2_090_000.
    expect(uiAmountToBaseUnits("2.09")).toBe(2_090_000n);
    expect(Math.floor(2.09 * 1e6)).toBe(2_089_999); // documents the float bug we avoid
  });
  it("rejects junk", () => {
    expect(() => uiAmountToBaseUnits("abc")).toThrow();
    expect(() => uiAmountToBaseUnits("")).toThrow();
  });
});
