// OPS SCRIPT — build the airdrop merkle tree from an allocation CSV.
//
// Reads a CSV (PerpsPad allocation columns `owner,...,total_airdrop`, OR the
// simple `pubkey,amount` form), dedupe-SUMs duplicate owners, builds the Kamino
// merkle tree, SELF-VERIFIES every proof against the root, and writes:
//   1. distributor-input.json  — { root, maxTotalClaim, maxNumNodes, version,
//      decimals }  consumed by create-distributor.ts
//   2. proof-map.json          — the static proof map bundled into the app
//      (claims only; distributor + mint are PLACEHOLDERS until
//      create-distributor.ts injects the real values).
//
// RUN:  bun run scripts/airdrop/build-tree.ts <inputCsv> [outDir]
//   inputCsv is REQUIRED (no default) so the committed 3-wallet sample can never
//   ship by accident. For the real airdrop:
//     bun run scripts/airdrop/build-tree.ts ~/Downloads/PERPAD_AIRDROP_ALLOCATION.csv
//   outDir defaults to scripts/airdrop/; proof-map -> src/lib/airdrop/proof-map.json
import * as fs from "node:fs";
import * as path from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  buildTree,
  hashLeaf,
  hashLeafNode,
  uiAmountToBaseUnits,
  verifyProof,
  toHex,
  TOKEN_DECIMALS,
  type AirdropEntry,
} from "../../src/lib/airdrop/merkle";

const PLACEHOLDER = "11111111111111111111111111111111"; // system program / "unset"
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1

interface Row {
  pubkey: string;
  uiAmount: string;
}

/** Minimal CSV: splits on commas, trims, ignores blank lines + quotes. */
function parseCsv(raw: string): Row[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header + at least one row");

  const splitLine = (l: string) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = splitLine(lines[0]).map((h) => h.toLowerCase());

  const ownerIdx = header.indexOf("owner") !== -1 ? header.indexOf("owner") : header.indexOf("pubkey");
  const amountIdx =
    header.indexOf("total_airdrop") !== -1 ? header.indexOf("total_airdrop") : header.indexOf("amount");
  if (ownerIdx === -1 || amountIdx === -1) {
    throw new Error(
      `CSV header must have owner|pubkey and total_airdrop|amount. Got: ${header.join(",")}`,
    );
  }

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const pubkey = cols[ownerIdx];
    const uiAmount = cols[amountIdx];
    if (!pubkey || !uiAmount) throw new Error(`Row ${i + 1} missing owner/amount: ${lines[i]}`);
    rows.push({ pubkey, uiAmount });
  }
  return rows;
}

function main() {
  const inputCsv = process.argv[2];
  if (!inputCsv) {
    throw new Error(
      "build-tree.ts requires an explicit <inputCsv> path (no default — prevents " +
        "accidentally building the committed 3-wallet sample). Real airdrop:\n" +
        "  bun run scripts/airdrop/build-tree.ts ~/Downloads/PERPAD_AIRDROP_ALLOCATION.csv",
    );
  }
  const outDir = process.argv[3] ?? path.resolve(__dirname);
  const proofMapPath = path.resolve(__dirname, "../../src/lib/airdrop/proof-map.json");

  const raw = fs.readFileSync(inputCsv, "utf8");
  const rows = parseCsv(raw);

  // Map rows -> entries, validating pubkeys and asserting the < 2^53 bound that
  // makes Number(amount) lossless for getNewClaimIx (MUSTFIX: amounts >= 2^53
  // silently lose precision in the SDK's new BN(number) and would produce a
  // wrong leaf -> on-chain InvalidProof). We fail the BUILD, not a claim.
  const entries: AirdropEntry[] = rows.map((r) => {
    let pk: PublicKey;
    try {
      pk = new PublicKey(r.pubkey);
    } catch {
      throw new Error(`Invalid base58 pubkey: ${r.pubkey}`);
    }
    const amountBaseUnits = uiAmountToBaseUnits(r.uiAmount, TOKEN_DECIMALS);
    if (amountBaseUnits > MAX_SAFE) {
      throw new Error(
        `Allocation for ${r.pubkey} = ${amountBaseUnits} base units exceeds 2^53-1; ` +
          `getNewClaimIx(amount:number) would lose precision. Split the airdrop or ` +
          `use the manual newClaim(BN(string)) path in claim.ts.`,
      );
    }
    return { pubkey: pk.toBase58(), amountBaseUnits };
  });

  const { root, nodes, maxTotalClaim, maxNumNodes } = buildTree(entries);

  // SELF-VERIFY: assert every proof folds to the root (catches any odd-node /
  // sort / encoding bug at build time, not as a failed on-chain claim).
  for (const node of nodes) {
    const leaf = hashLeaf(hashLeafNode(node.pubkey, BigInt(node.amount)));
    if (!verifyProof(node.proof, root, leaf)) {
      throw new Error(`Self-verify FAILED for ${node.pubkey} — refusing to write.`);
    }
  }

  // 1. distributor-input.json (consumed by create-distributor.ts)
  const distributorInput = {
    root: Array.from(root),
    rootHex: toHex(root),
    maxTotalClaim: maxTotalClaim.toString(),
    maxNumNodes,
    version: 0,
    decimals: TOKEN_DECIMALS,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "distributor-input.json"),
    JSON.stringify(distributorInput, null, 2) + "\n",
  );

  // 2. proof-map.json (bundled into the app; distributor/mint are placeholders
  //    until create-distributor.ts injects the real on-chain values).
  const claims: Record<string, { amount: string; proof: number[][]; distributor: string }> = {};
  for (const node of nodes) {
    claims[node.pubkey] = {
      amount: node.amount,
      proof: node.proof,
      distributor: PLACEHOLDER,
    };
  }
  const proofMap = {
    distributor: PLACEHOLDER,
    mint: PLACEHOLDER,
    version: 0,
    root: toHex(root),
    claims,
  };
  fs.writeFileSync(proofMapPath, JSON.stringify(proofMap, null, 2) + "\n");

  // eslint-disable-next-line no-console
  console.log(
    `Built tree: ${maxNumNodes} unique wallets, ${maxTotalClaim} base units total.\n` +
      `  root: ${toHex(root)}\n` +
      `  -> ${path.join(outDir, "distributor-input.json")}\n` +
      `  -> ${proofMapPath} (distributor/mint PLACEHOLDER — run create-distributor.ts next)`,
  );
}

main();
