// Pure-JS port of the Kamino Merkle Distributor tree, matching the on-chain
// program BYTE-FOR-BYTE. Ported from github.com/Kamino-Finance/distributor
// (master):
//   - merkle-tree/src/tree_node.rs  TreeNode::hash
//   - merkle-tree/src/merkle_tree.rs  LEAF/INTERMEDIATE prefixes, hash_leaf!,
//     hash_intermediate!, sorted-pair + odd-node duplication, find_path/get_proof
//   - merkle-tree/src/airdrop_merkle_tree.rs  MerkleTree::new(hashed, true) +
//     IndexMap dedupe-sum (preserve insertion order)
//   - programs/.../verify  proof fold with `computed <= element` sort convention
//
// Hashing uses @noble/hashes/sha256 (zero-dep, browser- AND Cloudflare-Worker
// safe — NOT node:crypto, which does not run on Workers). Amounts are carried
// as bigint end-to-end so the 8-byte little-endian leaf encoding is exact and
// never round-trips through a JS number.
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";

/** LEAF_PREFIX = &[0] in merkle_tree.rs */
export const LEAF_PREFIX = 0x00;
/** INTERMEDIATE_PREFIX = &[1] in merkle_tree.rs */
export const INTERMEDIATE_PREFIX = 0x01;
/** PerpsPad airdrop token: legacy SPL Token, 6 decimals. */
export const TOKEN_DECIMALS = 6;

export interface AirdropEntry {
  /** base58 wallet */
  pubkey: string;
  /** claim amount in u64 BASE UNITS (floor(uiAmount * 10^decimals)) */
  amountBaseUnits: bigint;
}

export interface TreeNode {
  pubkey: string;
  /** u64 base units as a decimal string (exact) */
  amount: string;
  /** ordered sibling hashes, leaf -> root, 32 bytes each */
  proof: number[][];
}

export interface BuildTreeResult {
  root: Uint8Array;
  nodes: TreeNode[];
  /** sum of all (deduped) amounts, u64 base units */
  maxTotalClaim: bigint;
  /** count of unique claimants */
  maxNumNodes: number;
}

/** Encode a non-negative bigint as 8-byte little-endian (u64). */
export function u64ToLeBytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${value.toString()}`);
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Byte-lexicographic compare of two equal-or-unequal length buffers. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * TreeNode::hash — the raw leaf node (BEFORE the leaf prefix is applied):
 *   sha256( claimant[32] ++ amount.to_le_bytes()[8] ++ 0u64.to_le_bytes()[8] )
 * The third field is a LITERAL 0u64 in the Rust source (amount_locked is always
 * 0 for a plain airdrop, so it coincides; we encode a constant 0).
 */
export function hashLeafNode(pubkey: string, amountBaseUnits: bigint): Uint8Array {
  const claimant = new PublicKey(pubkey).toBytes(); // 32 bytes
  const buf = new Uint8Array(48);
  buf.set(claimant, 0);
  buf.set(u64ToLeBytes(amountBaseUnits), 32);
  // bytes 40..48 stay zero (the literal 0u64)
  return sha256(buf);
}

/** hash_leaf! — bottom tree level: sha256( 0x00 ++ node ). */
export function hashLeaf(node: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + node.length);
  buf[0] = LEAF_PREFIX;
  buf.set(node, 1);
  return sha256(buf);
}

/**
 * hash_intermediate! with sorted_hashes=true:
 *   sha256( 0x01 ++ min(l,r) ++ max(l,r) )   (byte-lexicographic min/max)
 */
export function hashIntermediate(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [l, r] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(1 + l.length + r.length);
  buf[0] = INTERMEDIATE_PREFIX;
  buf.set(l, 1);
  buf.set(r, 1 + l.length);
  return sha256(buf);
}

/**
 * Dedupe-sum entries by claimant, preserving FIRST-SEEN order to mirror the
 * Rust IndexMap. base58 keys are non-numeric, so JS Map iteration order ==
 * insertion order is stable.
 */
export function dedupeEntries(entries: AirdropEntry[]): AirdropEntry[] {
  const map = new Map<string, bigint>();
  for (const e of entries) {
    map.set(e.pubkey, (map.get(e.pubkey) ?? 0n) + e.amountBaseUnits);
  }
  return [...map.entries()].map(([pubkey, amountBaseUnits]) => ({
    pubkey,
    amountBaseUnits,
  }));
}

/**
 * Build the full set of tree levels bottom-up from the hashed leaves.
 * Odd-length levels duplicate the last node (paired with itself), matching
 * MerkleTree::new. levels[0] = leaves, levels[last] = [root].
 */
function buildLevels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error("cannot build a tree with 0 leaves");
  const levels: Uint8Array[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i];
      const r = i + 1 < cur.length ? cur[i + 1] : cur[i]; // odd -> pair with self
      next.push(hashIntermediate(l, r));
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

/**
 * Proof for a leaf index — port of MerkleTree::find_path / utils::get_proof.
 * At each level the sibling is the other element of the pair; for an even index
 * that is the last node of an odd level, the sibling is the node ITSELF. No
 * left/right flags are emitted because the on-chain verifier re-sorts each step.
 */
function proofForIndex(levels: Uint8Array[][], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRight = idx % 2 === 1;
    let siblingIdx: number;
    if (isRight) {
      siblingIdx = idx - 1;
    } else {
      siblingIdx = idx + 1 < nodes.length ? idx + 1 : idx; // odd tail -> self
    }
    proof.push(nodes[siblingIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a proof the SAME way the on-chain program does: fold the leaf up to the
 * root, re-sorting at each step (`computed <= element ? (computed,element) :
 * (element,computed)`), prefix byte 0x01. Used by build-tree.ts to self-check
 * every leaf, and exported for tests.
 */
export function verifyProof(
  proof: number[][],
  root: Uint8Array,
  hashedLeaf: Uint8Array,
): boolean {
  let computed = hashedLeaf;
  for (const p of proof) {
    const element = Uint8Array.from(p);
    computed = hashIntermediate(computed, element); // hashIntermediate sorts
  }
  return compareBytes(computed, root) === 0;
}

/**
 * Build the Merkle tree for a set of airdrop entries.
 * Returns the root, plus per-claimant amount + proof, in deduped insertion
 * order. Entries are dedupe-summed first.
 */
export function buildTree(entries: AirdropEntry[]): BuildTreeResult {
  const deduped = dedupeEntries(entries);
  const leaves = deduped.map((e) => hashLeaf(hashLeafNode(e.pubkey, e.amountBaseUnits)));
  const levels = buildLevels(leaves);
  const root = levels[levels.length - 1][0];

  const nodes: TreeNode[] = deduped.map((e, i) => ({
    pubkey: e.pubkey,
    amount: e.amountBaseUnits.toString(),
    proof: proofForIndex(levels, i).map((h) => Array.from(h)),
  }));

  const maxTotalClaim = deduped.reduce((acc, e) => acc + e.amountBaseUnits, 0n);

  return { root, nodes, maxTotalClaim, maxNumNodes: deduped.length };
}

/**
 * Convert a UI decimal amount (string) to u64 base units by integer string
 * math — NOT float*1e6 — so a clean decimal never rounds off-by-one. Truncates
 * any fractional digits beyond `decimals` (floor), matching the Rust
 * ui_amount_to_token_amount floor.
 */
export function uiAmountToBaseUnits(ui: string, decimals = TOKEN_DECIMALS): bigint {
  const s = ui.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid UI amount: "${ui}"`);
  }
  const [intPart, fracRaw = ""] = s.split(".");
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0"); // floor + pad
  const combined = `${intPart}${frac}`.replace(/^0+(?=\d)/, "");
  return BigInt(combined.length === 0 ? "0" : combined);
}

/** Hex-encode a hash for human-readable JSON / debugging. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
