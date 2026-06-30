// OPS SCRIPT — open the airdrop AT launch time T by setting enable_slot = current slot.
//
// The Kamino program gates new_claim on `require!(enable_slot <= curr_slot, ClaimingIsNotStarted)`.
// create-distributor.ts (strategy A) sets a far-future SENTINEL enable_slot, so claims are
// IMPOSSIBLE until this runs. set_enable_slot is admin-only and can LOWER the value, so this is
// the single switch that opens claims. (Strategy B sets enable_slot from LAUNCH_TS at create time
// and needs no opener — claims auto-open.)
//
// If the admin is a plain keypair (localnet test, or a non-multisig deploy), this signs + sends.
// If the admin is a MULTISIG, it cannot be signed here — the script prints the set_enable_slot
// instruction for you to wrap in a Squads transaction.
//
// RUN (AT T):
//   MINT=<mint> ADMIN_KEYPAIR=~/.config/solana/id.json RPC_URL=<rpc> \
//   bun run scripts/airdrop/open-claims.ts
//   (DRY_RUN=1 prints only; FORCE=1 re-sets even if already open.)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { setEnableSlot, MerkleDistributor } from "@kamino-finance/distributor-sdk";
import { DISTRIBUTOR_PROGRAM_ID, BN } from "../../src/lib/airdrop/pda";

function loadKeypair(file: string): Keypair {
  const resolved = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : file;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf8"))));
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");
  const dryRun = process.env.DRY_RUN === "1";

  // distributor comes from the injected proof-map (single source of truth post-create).
  const proofMapPath = path.resolve(__dirname, "../../src/lib/airdrop/proof-map.json");
  const proofMap = JSON.parse(fs.readFileSync(proofMapPath, "utf8")) as { distributor: string; mint: string };
  const PLACEHOLDER = "11111111111111111111111111111111";
  if (proofMap.distributor === PLACEHOLDER) {
    throw new Error("proof-map distributor is still the placeholder — run create-distributor.ts first.");
  }
  const distributor = new PublicKey(proofMap.distributor);

  const state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
  if (!state) throw new Error(`distributor ${distributor.toBase58()} not found on chain`);

  const currentSlot = await connection.getSlot();
  const onchainEnable = state.enableSlot; // BN
  const alreadyOpen = onchainEnable.lten(currentSlot); // enable_slot <= curr_slot
  console.log(`distributor:            ${distributor.toBase58()}`);
  console.log(`admin (on-chain):       ${state.admin.toBase58()}`);
  console.log(`enable_slot (on-chain): ${onchainEnable.toString()}   current slot: ${currentSlot}`);
  console.log(alreadyOpen ? "  -> claims are ALREADY OPEN" : "  -> claims are SHUT");

  if (alreadyOpen && process.env.FORCE !== "1") {
    console.log("Nothing to do (already open). Set FORCE=1 to re-set anyway.");
    return;
  }

  const target = new BN(currentSlot);
  const ix = setEnableSlot({ enableSlot: target }, { distributor, admin: state.admin }, DISTRIBUTOR_PROGRAM_ID);
  console.log(`\nset_enable_slot -> ${target.toString()} (opens claims now)`);

  // Can we sign? Only if the provided admin keypair matches the on-chain admin.
  let adminKp: Keypair | null = null;
  if (process.env.ADMIN_KEYPAIR) {
    try {
      const kp = loadKeypair(process.env.ADMIN_KEYPAIR);
      if (kp.publicKey.equals(state.admin)) adminKp = kp;
    } catch {
      /* ignore — fall through to the multisig print path */
    }
  }

  if (!adminKp) {
    // Multisig (or non-matching key): print the instruction for Squads execution.
    console.log("\nAdmin is NOT a local keypair we can sign with (multisig custody).");
    console.log("Wrap THIS instruction in a Squads transaction (vault = the admin above):");
    console.log("  programId:", ix.programId.toBase58());
    console.log(
      "  accounts:",
      JSON.stringify(
        ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        null,
        2,
      ),
    );
    console.log("  data (base64):", Buffer.from(ix.data).toString("base64"));
    return;
  }

  if (dryRun) {
    console.log("\nDRY_RUN=1 — not sending. Admin keypair matches; remove DRY_RUN to open claims.");
    return;
  }

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [adminKp]);
  console.log("\nset_enable_slot tx:", sig);
  const after = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
  console.log("enable_slot now:", after?.enableSlot.toString(), "— CLAIMS OPEN.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
