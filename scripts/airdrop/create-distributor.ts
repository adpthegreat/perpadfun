// OPS SCRIPT — create + hand over + fund the Kamino Merkle Distributor.
//
// Run AFTER build-tree.ts. Hardened per the pre-launch audit (PERPSPAD_AIRDROP_AUDIT.md):
//   #1 LAUNCH GATE: enable_slot is the ONLY on-chain claim-start gate
//      (new_claim.rs: require!(enable_slot <= curr_slot, ClaimingIsNotStarted)).
//      DEFAULT = a far-future SENTINEL slot so claims are IMPOSSIBLE until the admin
//      (multisig) flips it at T via open-claims.ts (strategy A). If LAUNCH_TS is set,
//      enable_slot is computed from it with a 400ms/slot FLOOR so claims auto-open
//      AT-OR-AFTER T, never before (strategy B).
//   #3 CUSTODY: clawback_receiver is the MULTISIG's ATA at creation, and admin is
//      handed to the MULTISIG (set_admin) BEFORE funding — the funded vault is never
//      under a sole deployer key. (SKIP_HANDOVER=1 keeps admin=deployer; LOCALNET ONLY.)
//   #4 MINT GUARD: the on-chain mint is asserted LEGACY SPL Token + 6 decimals before
//      anything is created (the old `input.decimals === 6` check was a tautology).
//   #5 IDEMPOTENCY: the ephemeral `base` keypair is PERSISTED (gitignored) and reused
//      on re-run; admin token balance is pre-checked; an already-created/already-funded
//      distributor short-circuits — so a second run can NEVER mint a 2nd funded
//      distributor (which would double-spend the airdrop via a fresh ClaimStatus namespace).
//   closable=FALSE (real double-claim guard) and read-back asserts are retained/expanded.
//
// RUN (real launch, strategy A — sentinel + multisig flip at T):
//   MINT=<base58 mint> MULTISIG=<base58 squads vault> \
//   EXPECT_NODES=380 EXPECT_TOTAL=775960887398266 \
//   ADMIN_KEYPAIR=~/.config/solana/id.json RPC_URL=https://api.mainnet-beta.solana.com \
//   bun run scripts/airdrop/create-distributor.ts
//   ...then AT launch T: bun run scripts/airdrop/open-claims.ts  (multisig flips enable_slot)
//
// RUN (strategy B — autonomous): also set LAUNCH_TS=<unix seconds>; claims auto-open at T.
// RUN (localnet test): add SKIP_HANDOVER=1 (admin stays deployer so the test can flip
//   enable_slot directly); MULTISIG not required.
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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { newDistributor, setAdmin, MerkleDistributor } from "@kamino-finance/distributor-sdk";
import { deriveDistributorPda, DISTRIBUTOR_PROGRAM_ID, BN } from "../../src/lib/airdrop/pda";
import { TOKEN_DECIMALS } from "../../src/lib/airdrop/merkle";

const SECONDS_PER_DAY = 86_400;
const MS_PER_SLOT_FLOOR = 400; // fastest plausible slot -> most slots -> opens AT/AFTER T, never before
const SENTINEL_SLOT_OFFSET = 1_000_000_000; // ~12+ years of slots: unreachable until admin lowers it
const BASE_FILE = path.resolve(__dirname, ".distributor-base.json"); // gitignored; persisted for idempotency

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

/** Load the persisted base keypair, or generate + persist one. Reused across re-runs
 *  so a failed/partial run re-targets the SAME distributor PDA instead of minting a
 *  fresh (double-spendable) one. */
function loadOrCreateBase(): Keypair {
  if (fs.existsSync(BASE_FILE)) {
    const kp = loadKeypair(BASE_FILE);
    console.log(`  reusing persisted base ${kp.publicKey.toBase58()} (${BASE_FILE})`);
    return kp;
  }
  const kp = Keypair.generate();
  fs.writeFileSync(BASE_FILE, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`  generated + persisted base ${kp.publicKey.toBase58()} (${BASE_FILE})`);
  return kp;
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");
  const admin = loadKeypair(process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json");
  const mint = new PublicKey(req("MINT"));

  const skipHandover = process.env.SKIP_HANDOVER === "1";
  const multisig = skipHandover ? null : new PublicKey(req("MULTISIG"));
  if (skipHandover) {
    console.warn("  WARNING: SKIP_HANDOVER=1 — admin stays the deployer key. LOCALNET TESTING ONLY.");
  }

  // --- input + expected-value guard (#2b: catches the 3-wallet sample) ---
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
  console.log(`  tree: ${input.maxNumNodes} wallets, ${input.maxTotalClaim} base units total`);
  if (process.env.EXPECT_NODES && Number(process.env.EXPECT_NODES) !== input.maxNumNodes) {
    throw new Error(
      `EXPECT_NODES=${process.env.EXPECT_NODES} != distributor-input maxNumNodes=${input.maxNumNodes}. ` +
        `Did you forget to rebuild the tree from the REAL CSV? (the 3-wallet sample has 3 nodes.)`,
    );
  }
  if (process.env.EXPECT_TOTAL && process.env.EXPECT_TOTAL !== input.maxTotalClaim) {
    throw new Error(
      `EXPECT_TOTAL=${process.env.EXPECT_TOTAL} != distributor-input maxTotalClaim=${input.maxTotalClaim}.`,
    );
  }
  if (!process.env.EXPECT_NODES || !process.env.EXPECT_TOTAL) {
    console.warn(
      "  WARNING: EXPECT_NODES / EXPECT_TOTAL not set — wrong-tree guard skipped. " +
        "Real launch: EXPECT_NODES=380 EXPECT_TOTAL=775960887398266.",
    );
  }

  // --- mint guard (#4): legacy SPL Token + exactly 6 decimals, BEFORE anything is created ---
  const mintAcct = await connection.getAccountInfo(mint);
  if (!mintAcct) throw new Error(`MINT ${mint.toBase58()} not found on chain`);
  if (mintAcct.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("MINT is a Token-2022 mint; this distributor + claim path are LEGACY SPL Token only.");
  }
  if (!mintAcct.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`MINT owner ${mintAcct.owner.toBase58()} is not the SPL Token program.`);
  }
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  if (mintInfo.decimals !== TOKEN_DECIMALS) {
    throw new Error(`MINT decimals ${mintInfo.decimals} != ${TOKEN_DECIMALS} — tree amounts would mis-scale.`);
  }
  console.log(`  mint OK: legacy SPL, ${mintInfo.decimals} decimals`);

  // --- admin token balance pre-check (#5): must cover the full airdrop before we create ---
  const adminAta = getAssociatedTokenAddressSync(mint, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const need = BigInt(input.maxTotalClaim);
  try {
    const acct = await getAccount(connection, adminAta, "confirmed", TOKEN_PROGRAM_ID);
    if (acct.amount < need) {
      throw new Error(
        `admin ATA holds ${acct.amount} but the airdrop needs ${need} base units. ` +
          `Acquire/mint $PERPAD to ${adminAta.toBase58()} first.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.name === "TokenAccountNotFoundError") {
      throw new Error(`admin ATA ${adminAta.toBase58()} does not exist / is unfunded; needs ${need} base units.`);
    }
    throw e;
  }
  console.log(`  admin balance OK (>= ${need})`);

  const version = input.version;
  const base = loadOrCreateBase();
  const distributor = deriveDistributorPda(base.publicKey, mint, version);
  const tokenVault = getAssociatedTokenAddressSync(mint, distributor, true, TOKEN_PROGRAM_ID);
  // clawback_receiver: the MULTISIG's ATA (clawback-after-deadline pays the multisig,
  // not a hot deployer key). For localnet test, the deployer's ATA.
  const clawbackOwner = multisig ?? admin.publicKey;
  const clawbackReceiver = getAssociatedTokenAddressSync(mint, clawbackOwner, false, TOKEN_PROGRAM_ID);

  // --- enable_slot launch gate (#1) ---
  const currentSlot = await connection.getSlot();
  const nowSec = Math.floor(Date.now() / 1000);
  const launchTs = process.env.LAUNCH_TS ? Number(process.env.LAUNCH_TS) : null;
  let enableSlotNum: number;
  if (launchTs !== null) {
    if (!Number.isFinite(launchTs) || launchTs <= nowSec) {
      throw new Error(`LAUNCH_TS must be a FUTURE unix-seconds value; got ${process.env.LAUNCH_TS} (now=${nowSec}).`);
    }
    enableSlotNum = currentSlot + Math.ceil(((launchTs - nowSec) * 1000) / MS_PER_SLOT_FLOOR);
    console.log(`  enable_slot strategy B (autonomous): slot ${enableSlotNum} ~ T=${launchTs} (now slot ${currentSlot})`);
  } else {
    enableSlotNum = currentSlot + SENTINEL_SLOT_OFFSET;
    console.log(`  enable_slot strategy A (sentinel): ${enableSlotNum} (now ${currentSlot}) — claims SHUT until open-claims.ts at T`);
  }
  const enableSlot = new BN(enableSlotNum);
  // clawback deadline anchored to the LAUNCH, not script-run time.
  const clawbackStartTs = (launchTs ?? nowSec) + 365 * SECONDS_PER_DAY;

  const args = {
    version: new BN(version),
    root: input.root,
    maxTotalClaim: new BN(input.maxTotalClaim),
    maxNumNodes: new BN(input.maxNumNodes),
    startVestingTs: new BN(nowSec + 60),
    endVestingTs: new BN(nowSec + 120),
    clawbackStartTs: new BN(clawbackStartTs),
    enableSlot,
    closable: false, // CRITICAL: keeps the ClaimStatus double-claim guard real
  };

  console.log("Distributor:");
  console.log("  programId:", DISTRIBUTOR_PROGRAM_ID.toBase58());
  console.log("  distributor PDA:", distributor.toBase58());
  console.log("  base:", base.publicKey.toBase58());
  console.log("  mint:", mint.toBase58());
  console.log("  admin (deployer):", admin.publicKey.toBase58());
  if (multisig) console.log("  multisig (final admin + clawback owner):", multisig.toBase58());
  console.log("  tokenVault:", tokenVault.toBase58());
  console.log("  clawbackReceiver:", clawbackReceiver.toBase58());

  // --- 1. create (idempotent: skip if the persisted distributor already exists) ---
  let state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
  let justCreated = false;
  if (state) {
    console.log("  distributor already exists (reusing persisted base) — skipping create");
    if (JSON.stringify(state.root) !== JSON.stringify(input.root)) {
      throw new Error("existing distributor root != current tree root — base/tree mismatch, aborting");
    }
  } else {
    const createTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, tokenVault, distributor, mint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, clawbackReceiver, clawbackOwner, mint, TOKEN_PROGRAM_ID),
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
    justCreated = true;
    state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
    if (!state) throw new Error("distributor not found after create");
  }

  // --- 2. read-back asserts (frontrun guard, expanded) ---
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`ASSERT FAILED: ${msg} — aborting before funding`);
  };
  assert(JSON.stringify(state.root) === JSON.stringify(input.root), "root");
  assert(state.closable === false, "closable must be false (double-claim guard)");
  assert(state.tokenVault.equals(tokenVault), "tokenVault");
  assert(state.maxTotalClaim.eq(args.maxTotalClaim), "maxTotalClaim");
  assert(state.maxNumNodes.eq(args.maxNumNodes), "maxNumNodes");
  assert(state.version.eq(args.version), "version");
  assert(state.clawbackReceiver.equals(clawbackReceiver), "clawbackReceiver");
  if (justCreated) {
    // enable_slot/clawbackStartTs are slot/time-derived; only meaningful for the run that set them.
    assert(state.enableSlot.eq(args.enableSlot), "enableSlot (the launch gate)");
    console.log("  read-back asserts OK (root, closable=false, tokenVault, maxTotalClaim, maxNumNodes, version, clawbackReceiver, enableSlot)");
  } else {
    console.log(`  read-back asserts OK (immutables); existing enableSlot=${state.enableSlot.toString()}`);
  }

  // --- 3. HANDOVER admin -> multisig BEFORE funding (#3) ---
  if (multisig) {
    if (state.admin.equals(multisig)) {
      console.log("  admin already = multisig (handover done) — skipping");
    } else {
      assert(state.admin.equals(admin.publicKey), "current admin must be the deployer to hand over");
      const handTx = new Transaction().add(
        setAdmin({ distributor, admin: admin.publicKey, newAdmin: multisig }, DISTRIBUTOR_PROGRAM_ID),
      );
      const handSig = await sendAndConfirmTransaction(connection, handTx, [admin]);
      console.log("  set_admin -> multisig tx:", handSig);
      state = await MerkleDistributor.fetch(connection, distributor, DISTRIBUTOR_PROGRAM_ID);
      if (!state) throw new Error("distributor vanished after handover");
      assert(state.admin.equals(multisig), "admin == multisig after handover");
    }
    console.log("  custody OK: admin + clawbackReceiver are the multisig; the deployer has no admin power.");
  }

  // --- 4. fund the vault (idempotent: skip if already funded; works post-handover, no admin rights needed) ---
  let vaultBal = 0n;
  try {
    vaultBal = (await getAccount(connection, tokenVault, "confirmed", TOKEN_PROGRAM_ID)).amount;
  } catch {
    /* vault ATA may be 0 / not yet an initialized token account */
  }
  if (vaultBal >= need) {
    console.log(`  vault already funded (${vaultBal} >= ${need}) — skipping fund`);
  } else {
    const fundTx = new Transaction().add(
      createTransferCheckedInstruction(adminAta, mint, tokenVault, admin.publicKey, need, input.decimals, [], TOKEN_PROGRAM_ID),
    );
    const fundSig = await sendAndConfirmTransaction(connection, fundTx, [admin]);
    console.log(`  funded vault with ${input.maxTotalClaim} base units, tx: ${fundSig}`);
  }

  // --- 5. inject distributor + mint into proof-map.json ---
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

  if (launchTs !== null) {
    console.log(`\nDONE. Vault funded; claims AUTO-OPEN at ~T (${launchTs}). No further on-chain action needed.`);
  } else if (multisig) {
    console.log("\nDONE. Vault funded; claims are SHUT (sentinel enable_slot).");
    console.log("AT LAUNCH T: the multisig must run open-claims.ts to set enable_slot = current slot.");
  } else {
    console.log("\nDONE (SKIP_HANDOVER). Localnet: flip enable_slot via open-claims.ts or the test driver.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
