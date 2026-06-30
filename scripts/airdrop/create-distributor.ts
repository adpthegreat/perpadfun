// OPS SCRIPT — create + fund the Kamino Merkle Distributor for the airdrop.
//
// Run AFTER build-tree.ts. Uses distributor-sdk 0.4.0's newDistributor builder.
// Creates the distributor with closable=FALSE (so the ClaimStatus init guard is
// a real double-claim guard — do NOT copy Kamino's deploy_distributor.sh which
// wrongly passes --closable=true), legacy SPL Token, decimals 6, the tree root
// from distributor-input.json, vesting open immediately, and clawback_start_ts
// FAR in the future (the de-facto claim deadline). Then funds the vault with
// exactly maxTotalClaim and injects the distributor PDA + mint into
// src/lib/airdrop/proof-map.json.
//
// SECURITY: newDistributor is frontrunnable. After it lands we read the account
// back and ASSERT root, admin, closable, AND clawback_receiver == admin ATA
// (the SDK docstring names clawback_receiver + admin as the primary theft
// vectors) BEFORE funding.
//
// RUN:
//   MINT=<base58 mint> \
//   ADMIN_KEYPAIR=~/.config/solana/id.json \
//   RPC_URL=http://127.0.0.1:8899 \
//   bun run scripts/airdrop/create-distributor.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { newDistributor, MerkleDistributor } from "@kamino-finance/distributor-sdk";
import { deriveDistributorPda, DISTRIBUTOR_PROGRAM_ID, BN } from "../../src/lib/airdrop/pda";
import { TOKEN_DECIMALS } from "../../src/lib/airdrop/merkle";

const SECONDS_PER_DAY = 86_400;

function loadKeypair(file: string): Keypair {
  const resolved = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  const secret = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json");
  const mint = new PublicKey(req("MINT"));

  const inputPath = path.resolve(__dirname, "distributor-input.json");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8")) as {
    root: number[];
    maxTotalClaim: string;
    maxNumNodes: number;
    version: number;
    decimals: number;
  };
  if (input.decimals !== TOKEN_DECIMALS) {
    throw new Error(`distributor-input decimals ${input.decimals} != ${TOKEN_DECIMALS}`);
  }
  if (input.root.length !== 32) throw new Error("root must be 32 bytes");

  const version = input.version;
  const base = Keypair.generate(); // ephemeral, must sign newDistributor
  const distributor = deriveDistributorPda(base.publicKey, mint, version);

  // token_vault = ATA(mint, owner=distributor PDA). allowOwnerOffCurve=true.
  const tokenVault = getAssociatedTokenAddressSync(mint, distributor, true, TOKEN_PROGRAM_ID);
  // clawback_receiver = admin's ATA for the mint.
  const clawbackReceiver = getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_PROGRAM_ID);

  const now = Math.floor(Date.now() / 1000);
  const args = {
    version: new BN(version),
    root: input.root,
    maxTotalClaim: new BN(input.maxTotalClaim),
    maxNumNodes: new BN(input.maxNumNodes),
    startVestingTs: new BN(now + 60),
    endVestingTs: new BN(now + 120),
    // FAR future: clawback_start_ts is the de-facto claim deadline (new_claim has
    // no end-time gate, only enable_slot + clawed_back). 365 days out.
    clawbackStartTs: new BN(now + 365 * SECONDS_PER_DAY),
    enableSlot: new BN(0), // claims open immediately
    closable: false, // CRITICAL: keeps the ClaimStatus double-claim guard real
  };

  console.log("Creating distributor:");
  console.log("  programId:", DISTRIBUTOR_PROGRAM_ID.toBase58());
  console.log("  distributor PDA:", distributor.toBase58());
  console.log("  base:", base.publicKey.toBase58());
  console.log("  mint:", mint.toBase58());
  console.log("  admin:", admin.publicKey.toBase58());
  console.log("  tokenVault (ATA of PDA):", tokenVault.toBase58());
  console.log("  clawbackReceiver (admin ATA):", clawbackReceiver.toBase58());

  // 1. Create the distributor. Vault + clawbackReceiver ATAs must exist first
  //    (the instruction has an associated_token::authority=distributor
  //    constraint on the vault), so create them idempotently in the same tx.
  const createTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      tokenVault,
      distributor,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      admin.publicKey,
      clawbackReceiver,
      admin.publicKey,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    newDistributor(args, {
      distributor,
      base: base.publicKey,
      clawbackReceiver,
      mint,
      tokenVault,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  );
  const createSig = await sendAndConfirmTransaction(connection, createTx, [admin, base]);
  console.log("  newDistributor tx:", createSig);

  // 2. Read back + assert (frontrun guard).
  const state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
  if (!state) throw new Error("distributor not found after create");
  const rootMatches = JSON.stringify(state.root) === JSON.stringify(input.root);
  if (!rootMatches) throw new Error("ROOT MISMATCH — aborting before funding");
  if (!state.admin.equals(admin.publicKey)) throw new Error("ADMIN MISMATCH — aborting");
  if (!state.clawbackReceiver.equals(clawbackReceiver)) {
    throw new Error("CLAWBACK_RECEIVER MISMATCH — possible frontrun, aborting before funding");
  }
  if (state.closable !== false) throw new Error("closable != false — double-claim guard broken, aborting");
  if (!state.tokenVault.equals(tokenVault)) throw new Error("TOKEN_VAULT MISMATCH — aborting");
  console.log("  read-back asserts OK (root, admin, clawbackReceiver, closable=false, tokenVault)");

  // 3. Fund the vault with exactly maxTotalClaim from the admin's ATA.
  const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const fundTx = new Transaction().add(
    createTransferCheckedInstruction(
      adminAta,
      mint,
      tokenVault,
      admin.publicKey,
      BigInt(input.maxTotalClaim),
      input.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  const fundSig = await sendAndConfirmTransaction(connection, fundTx, [admin]);
  console.log(`  funded vault with ${input.maxTotalClaim} base units, tx: ${fundSig}`);

  // 4. Inject distributor PDA + mint into proof-map.json.
  const proofMapPath = path.resolve(__dirname, "../../src/lib/airdrop/proof-map.json");
  const proofMap = JSON.parse(fs.readFileSync(proofMapPath, "utf8")) as {
    distributor: string;
    mint: string;
    version: number;
    root: string;
    claims: Record<string, { amount: string; proof: number[][]; distributor: string }>;
  };
  proofMap.distributor = distributor.toBase58();
  proofMap.mint = mint.toBase58();
  proofMap.version = version;
  for (const wallet of Object.keys(proofMap.claims)) {
    proofMap.claims[wallet].distributor = distributor.toBase58();
  }
  fs.writeFileSync(proofMapPath, JSON.stringify(proofMap, null, 2) + "\n");
  console.log(`  injected distributor + mint into ${proofMapPath}`);
  console.log("\nDONE. Distributor live and funded. The app can now serve /claim.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
