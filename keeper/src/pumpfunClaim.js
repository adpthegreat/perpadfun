// pump.fun creator-fee claim via `DistributeCreatorFeesV2`.
//
// This is the instruction Phantom invokes when you click "Claim" on a
// pump.fun coin where the creator has opted into fee-sharing. The signer
// does NOT need to be the original creator: any wallet listed in the
// sharing config (or just any wallet, since `payer` only pays rent) can
// trigger distribution. SOL + WSOL proceeds are then routed by the
// pump.fun program to the configured recipients (one of which is our
// sub-wallet, e.g. FvSz5kqX74DF73zRJqpvN8sM1e26Z13BCdnem6d4tx1p).
//
// Program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
// Ix:      DistributeCreatorFeesV2
// Disc:    [255, 203, 19, 79, 244, 68, 8, 159]
// Args:    initialize_ata: u8 (1 = create payer's WSOL ATA if missing)
//
// Account order (matches Phantom screenshot + on-chain decode):
//   0. payer                (signer, writable)   — sub-wallet
//   1. mint                 (readonly)
//   2. bonding_curve        (readonly)  PDA(["bonding-curve", mint])
//   3. sharing_config       (readonly)  = bonding_curve.creator field
//   4. creator_vault        (writable)  PDA(["creator-vault", sharing_config])
//   5. system_program       11111111111111111111111111111111
//   6. event_authority      PDA(["__event_authority"], program)
//   7. program              (readonly)  pump.fun program id (self)
//   8. creator_vault_quote  (writable)  ATA(creator_vault, WSOL)
//   9. quote_mint           So111…11112
//  10. token_program        Tokenkeg…
//  11. associated_token_program  ATokenGPv…
//  12. payer                (signer, writable, duplicated as "creator" arg)

import {
  PublicKey,
  TransactionInstruction,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  Connection,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import { config } from './config.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
// pump.fun "creator fee sharing" program. When a coin opts into fee sharing,
// bonding_curve.creator points at a config account OWNED by this program whose
// body lists the recipient wallets (one of which is our sub-wallet). See
// isPumpfunFeeRecipient below.
export const PUMP_FEE_SHARE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const DISTRIBUTE_CREATOR_FEES_V2_DISC = Buffer.from([255, 203, 19, 79, 244, 68, 8, 159]);
const COLLECT_COIN_CREATOR_FEE_DISC = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);
const TRANSFER_CREATOR_FEES_TO_PUMP_V2_DISC = Buffer.from([1, 33, 78, 185, 33, 67, 44, 92]);

const PRIORITY_MICRO_LAMPORTS = Number(process.env.PUMPFUN_CLAIM_PRIORITY_MICRO ?? 100_000);
const COMPUTE_UNIT_LIMIT = Number(process.env.PUMPFUN_CLAIM_CU_LIMIT ?? 400_000);
// Skip claim until the creator_vault holds at least this much USD (SOL+WSOL
// combined, priced at the caller-supplied solUsd). Override with
// PUMPFUN_MIN_VAULT_USD. Default $100 keeps tx-fee overhead negligible
// relative to the claim size.
const MIN_VAULT_USD = Number(process.env.PUMPFUN_MIN_VAULT_USD ?? 100);
// Throttle: only attempt a claim per mint every N seconds. Default 10s so
// hot attention launches (FARTCOIN/TREMP-style $1k+ vault accrual in a few
// minutes) can claim on the dedicated sweep cadence instead of leaving fees
// pending while the main position loop is busy.
const CLAIM_INTERVAL_SEC = Number(process.env.PUMPFUN_CLAIM_INTERVAL_SEC ?? 10);
const PROBE_INTERVAL_SEC = Number(process.env.PUMPFUN_PROBE_INTERVAL_SEC ?? 60);

// mint(base58) -> last attempt epoch ms
const _lastAttempt = new Map();
const _lastProbe = new Map();

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

let _eventAuthority = null;
function eventAuthority() {
  if (_eventAuthority) return _eventAuthority;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_PROGRAM_ID,
  );
  _eventAuthority = pda;
  return pda;
}

function deriveBondingCurve(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

function deriveCreatorVault(creatorOrShareCfg) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creatorOrShareCfg.toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

// Read the `creator` field from a bonding-curve account.
// Layout (anchor): 8 disc + 8*5 numbers + 1 complete + 32 creator → offset 49.
async function fetchBondingCurveCreator(c, bondingCurvePk) {
  const acct = await c.getAccountInfo(bondingCurvePk, 'confirmed');
  if (!acct || acct.data.length < 49 + 32) {
    throw new Error('bonding_curve account missing or too small');
  }
  return new PublicKey(acct.data.slice(49, 49 + 32));
}

// Read the coin's on-chain creator-fee recipient (bonding_curve.creator) for
// `mint`. NOTE: this is NOT necessarily a wallet — when the coin opts into
// pump.fun's creator-fee sharing (the common case for our routers), it is the
// address of a fee-share CONFIG account owned by PUMP_FEE_SHARE_PROGRAM_ID whose
// body lists the actual recipient wallets. Use isPumpfunFeeRecipient() to decide
// ownership; this raw read is kept for diagnostics. Returns base58 or null.
export async function readPumpfunCreator(mint) {
  try {
    const bondingCurve = deriveBondingCurve(new PublicKey(mint));
    const creator = await fetchBondingCurveCreator(conn(), bondingCurve);
    return creator.toBase58();
  } catch {
    return null;
  }
}

// Unspoofable ownership proof for an external fee router: is `subWallet` the
// designated pump.fun creator-fee recipient for `mint`?
//
// pump.fun stores this one of two ways, and we accept BOTH:
//   1. Direct creator — bonding_curve.creator == subWallet (coin was launched
//      with the sub-wallet as the creator/fee wallet).
//   2. Fee sharing (the common case) — bonding_curve.creator points at a config
//      account owned by PUMP_FEE_SHARE_PROGRAM_ID, and the sub-wallet is listed
//      as a recipient inside it. Only the coin's true creator can add a recipient
//      to that config, so the sub-wallet's presence proves the owner routed fees
//      to us — unlike a SOL/vault balance, which anyone can inflate by sending.
//
// The old check compared bonding_curve.creator directly against the sub-wallet,
// which is the CONFIG address (not a recipient) in the sharing case, so it never
// matched and routed tokens stayed hidden. See plan/FEE_ROUTING_AND_MINT_INDEX.md §6.
//
// The bonding-curve account persists after graduation (marked complete), so this
// covers post-grad coins too. Returns true/false, or null when the chain can't be
// read (network error / not a pump.fun coin) so callers can distinguish "no" from
// "couldn't check".
export async function isPumpfunFeeRecipient(mint, subWallet) {
  const subB58 = typeof subWallet === 'string' ? subWallet : subWallet?.toBase58?.();
  if (!subB58) return null;
  let configPk;
  try {
    const bondingCurve = deriveBondingCurve(new PublicKey(mint));
    configPk = await fetchBondingCurveCreator(conn(), bondingCurve);
  } catch {
    return null;
  }
  // Case 1: direct creator wallet.
  if (configPk.toBase58() === subB58) return true;
  // Case 2: fee-share config account — the sub-wallet must be a recipient inside.
  let cfg;
  try {
    cfg = await conn().getAccountInfo(configPk, 'confirmed');
  } catch {
    return null;
  }
  if (!cfg) return false;
  // Only trust the sharing program's own accounts. A coincidental match inside an
  // arbitrary account we don't recognise must not grant a lock.
  if (!cfg.owner.equals(PUMP_FEE_SHARE_PROGRAM_ID)) return false;
  // Scan for the sub-wallet's 32 raw bytes among the recipient list. Byte match
  // (not offset-aligned) is safe: a 32-byte pubkey collision is astronomically
  // unlikely, and the sub-wallet can only be in here if the creator put it here.
  const target = new PublicKey(subB58).toBuffer();
  const data = cfg.data;
  for (let i = 0; i + 32 <= data.length; i++) {
    if (data.subarray(i, i + 32).equals(target)) return true;
  }
  return false;
}

function buildDistributeIx({
  payer,
  mint,
  bondingCurve,
  sharingConfig,
  creatorVault,
  creatorVaultQuote,
  initializeAta = true,
}) {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: false },
    { pubkey: sharingConfig, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority(), isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: creatorVaultQuote, isSigner: false, isWritable: true },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
  ];
  const data = Buffer.concat([DISTRIBUTE_CREATOR_FEES_V2_DISC, Buffer.from([initializeAta ? 1 : 0])]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

function buildTransferCreatorFeesToPumpV2Ix({
  payer,
  coinCreator,
  coinCreatorVaultAuthority,
  coinCreatorVaultAta,
  pumpCreatorVault,
  pumpCreatorVaultAta,
}) {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: coinCreator, isSigner: false, isWritable: false },
    { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: true },
    { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: pumpCreatorVault, isSigner: false, isWritable: true },
    { pubkey: pumpCreatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: ammEventAuthority(), isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys,
    data: TRANSFER_CREATOR_FEES_TO_PUMP_V2_DISC,
  });
}

/**
 * Trigger pump.fun fee distribution for a single coin.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Keypair} args.kp  payer / signer (sub-wallet)
 * @param {string} args.mint  pump.fun mint address (base58)
 * @param {string} [args.label]
 * @returns {Promise<{ signature: string, solClaimed: number } | null>}
 */
export async function claimPumpFunCreatorFees({ kp, mint, label = '', solUsd = 0, routeWalletSol = 0 }) {
  if (!kp) throw new Error('claimPumpFunCreatorFees: kp required');
  if (!mint) throw new Error('claimPumpFunCreatorFees: mint required');

  // Per-mint throttles. Real tx attempts keep the short retry window, while
  // read-only vault probes get a longer cooldown so idle/pending coins do not
  // hammer the RPC every external sweep tick.
  const now = Date.now();
  const last = _lastAttempt.get(mint) ?? 0;
  if (now - last < CLAIM_INTERVAL_SEC * 1000) {
    const remainSec = Math.ceil((CLAIM_INTERVAL_SEC * 1000 - (now - last)) / 1000);
    console.log(`[pumpfun] ${label} throttled: last attempt ${Math.round((now - last) / 1000)}s ago, next in ${remainSec}s`);
    return null;
  }
  const lastProbe = _lastProbe.get(mint) ?? 0;
  if (now - lastProbe < PROBE_INTERVAL_SEC * 1000) return null;
  _lastProbe.set(mint, now);

  const c = conn();
  const payer = kp.publicKey;
  const mintPk = new PublicKey(mint);

  const bondingCurve = deriveBondingCurve(mintPk);
  let sharingConfig;
  try {
    sharingConfig = await fetchBondingCurveCreator(c, bondingCurve);
  } catch (e) {
    console.warn(`[pumpfun] ${label} cannot read bonding_curve: ${e.message}`);
    return null;
  }
  const creatorVault = deriveCreatorVault(sharingConfig);
  const creatorVaultQuote = getAssociatedTokenAddressSync(WSOL_MINT, creatorVault, true);
  const sharingAmmVaultAuthority = deriveAmmCoinCreatorVaultAuthority(sharingConfig);
  const sharingAmmVaultAta = getAssociatedTokenAddressSync(WSOL_MINT, sharingAmmVaultAuthority, true);

  // Probe vault: SOL balance + WSOL ATA balance + graduated pump-amm WSOL
  // for the sharing config. Graduated sharing-config fees sit in the AMM
  // vault first, then must be transferred into the pump creator vault before
  // distribute_creator_fees_v2 can split them to the sub-wallet shareholder.
  let vaultSol = 0;
  let ammVaultSol = 0;
  let creatorVaultQuoteExists = false;
  try {
    const [solLamports, ataInfo, ammAtaInfo] = await Promise.all([
      c.getBalance(creatorVault, 'confirmed'),
      c.getAccountInfo(creatorVaultQuote, 'confirmed'),
      c.getAccountInfo(sharingAmmVaultAta, 'confirmed'),
    ]);
    vaultSol += solLamports / LAMPORTS_PER_SOL;
    creatorVaultQuoteExists = !!ataInfo;
    if (ataInfo && ataInfo.data && ataInfo.data.length >= 72) {
      const wsolLamports = Number(ataInfo.data.readBigUInt64LE(64));
      vaultSol += wsolLamports / LAMPORTS_PER_SOL;
    }
    if (ammAtaInfo && ammAtaInfo.data && ammAtaInfo.data.length >= 72) {
      const wsolLamports = Number(ammAtaInfo.data.readBigUInt64LE(64));
      ammVaultSol = wsolLamports / LAMPORTS_PER_SOL;
    }
  } catch (e) {
    console.warn(`[pumpfun] ${label} vault probe failed: ${e.message}`);
    return null;
  }

  const totalVaultSol = vaultSol + ammVaultSol;
  // Combine unclaimed vault + already-routed sub-wallet SOL so we don't get
  // stuck in a double-gate: vault < $100 AND route < $100 individually, even
  // when their sum crosses the threshold.
  const combinedSol = totalVaultSol + routeWalletSol;
  const vaultUsd = solUsd > 0 ? totalVaultSol * solUsd : 0;
  const combinedUsd = solUsd > 0 ? combinedSol * solUsd : 0;
  if (!(solUsd > 0)) {
    console.warn(`[pumpfun] ${label} skip: solUsd unavailable, cannot evaluate $${MIN_VAULT_USD} gate`);
    return null;
  }
  if (combinedUsd < MIN_VAULT_USD) {
    if (totalVaultSol > 0) {
      console.log(`[pumpfun] ${label} skip: vault=${totalVaultSol.toFixed(6)} SOL pump=${vaultSol.toFixed(6)} amm=${ammVaultSol.toFixed(6)} ($${vaultUsd.toFixed(2)}) + route=${routeWalletSol.toFixed(6)} SOL ($${(combinedUsd - vaultUsd).toFixed(2)}) = $${combinedUsd.toFixed(2)} < min $${MIN_VAULT_USD}`);
    }
    // Below the claim gate, but report the observed vault balance so the external
    // sweep can mark the token fee-routed (visible on the site) before the $100
    // claim fires. solClaimed:0 keeps `claim.solClaimed > 0` callers unaffected.
    // See plan/EXTERNAL_ROUTER_VISIBILITY.md.
    return { signature: null, solClaimed: 0, skipped: true, vaultSol: totalVaultSol, vaultUsd, routeWalletSol };
  }
  // Nothing in the vault to actually claim, but combined ≥ threshold means
  // the sweep leg below will fire on the already-routed SOL alone.
  if (totalVaultSol <= 0) return null;

  const beforePayer = await c.getBalance(payer, 'confirmed');

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  );
  if (ammVaultSol > 0) {
    tx.add(buildTransferCreatorFeesToPumpV2Ix({
      payer,
      coinCreator: sharingConfig,
      coinCreatorVaultAuthority: sharingAmmVaultAuthority,
      coinCreatorVaultAta: sharingAmmVaultAta,
      pumpCreatorVault: creatorVault,
      pumpCreatorVaultAta: creatorVaultQuote,
    }));
  }
  tx.add(buildDistributeIx({
    payer,
    mint: mintPk,
    bondingCurve,
    sharingConfig,
    creatorVault,
    creatorVaultQuote,
    initializeAta: !creatorVaultQuoteExists && ammVaultSol <= 0,
  }));

  let sig;
  try {
    _lastAttempt.set(mint, Date.now());
    sig = await sendAndConfirmTransaction(c, tx, [kp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
  } catch (e) {
    console.warn(`[pumpfun] ${label} distribute_creator_fees_v2 failed: ${e.message}`);
    return null;
  }

  const afterPayer = await c.getBalance(payer, 'confirmed');
  // Add back the ~tx fee so we don't undercount the SOL leg arriving at payer.
  const deltaLamports = Math.max(0, afterPayer - beforePayer + 10_000);
  const solClaimed = deltaLamports / LAMPORTS_PER_SOL;
  console.log(`[pumpfun] ${label} distributed (vault was ${totalVaultSol.toFixed(6)} SOL pump=${vaultSol.toFixed(6)} amm=${ammVaultSol.toFixed(6)}, payer Δ=${solClaimed.toFixed(6)}) sig=${sig.slice(0, 16)}…`);
  return { signature: sig, solClaimed };
}

// ────────────────────────────────────────────────────────────────────────────
// pump-amm `collect_coin_creator_fee`
//
// After a pump.fun coin graduates to the pump-swap AMM, creator fees no
// longer accrue in the bonding-curve creator_vault. They land in a separate
// WSOL ATA owned by a PDA on the AMM program:
//
//   coin_creator_vault_authority = PDA(["creator_vault", coin_creator], pump_amm)
//   coin_creator_vault_ata       = ATA(authority, WSOL, TOKEN_PROGRAM)
//
// The `coin_creator` (our sub-wallet) signs the claim. The instruction
// moves the WSOL from the vault ATA into a destination WSOL ATA owned by
// coin_creator. We then close that ATA to unwrap WSOL into native SOL on
// the sub-wallet, so the existing 50/25/25 split picks it up like any
// other claim.
//
// Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// Ix:      collect_coin_creator_fee
// Disc:    [160, 57, 89, 42, 181, 139, 43, 66]
// Args:    none

const AMM_CLAIM_MIN_VAULT_USD = Number(process.env.PUMPAMM_MIN_VAULT_USD ?? 1);
const _ammLastAttempt = new Map(); // creator(b58) -> ms
const _ammLastProbe = new Map(); // creator(b58) -> ms

function deriveAmmCoinCreatorVaultAuthority(creatorPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator_vault'), creatorPk.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
  return pda;
}

let _ammEventAuthority = null;
function ammEventAuthority() {
  if (_ammEventAuthority) return _ammEventAuthority;
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_AMM_PROGRAM_ID,
  );
  _ammEventAuthority = pda;
  return pda;
}

function buildCollectCoinCreatorFeeIx({
  coinCreator,
  coinCreatorVaultAuthority,
  coinCreatorVaultAta,
  coinCreatorTokenAccount,
}) {
  const keys = [
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },                        // quote_mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                  // quote_token_program
    { pubkey: coinCreator, isSigner: true, isWritable: true },                         // coin_creator (signer)
    { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: false },         // coin_creator_vault_authority (PDA)
    { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },                // coin_creator_vault_ata (source)
    { pubkey: coinCreatorTokenAccount, isSigner: false, isWritable: true },            // coin_creator_token_account (dest)
    { pubkey: ammEventAuthority(), isSigner: false, isWritable: false },               // event_authority
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },               // program
  ];
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys,
    data: COLLECT_COIN_CREATOR_FEE_DISC,
  });
}

/**
 * Claim accrued pump-amm coin-creator fees for a graduated pump.fun coin.
 * The sub-wallet `kp` IS the coin_creator. Returns null if nothing to claim.
 */
export async function claimPumpAmmCoinCreatorFees({ kp, label = '', solUsd = 0, routeWalletSol = 0 }) {
  if (!kp) throw new Error('claimPumpAmmCoinCreatorFees: kp required');

  const creator = kp.publicKey;
  const creatorB58 = creator.toBase58();

  // Per-creator throttles. Keep real tx retry quick, but do not re-probe empty
  // AMM vaults every sweep tick.
  const now = Date.now();
  const last = _ammLastAttempt.get(creatorB58) ?? 0;
  if (now - last < CLAIM_INTERVAL_SEC * 1000) {
    const remainSec = Math.ceil((CLAIM_INTERVAL_SEC * 1000 - (now - last)) / 1000);
    console.log(`[pumpamm] ${label} throttled: last attempt ${Math.round((now - last) / 1000)}s ago, next in ${remainSec}s`);
    return null;
  }
  const lastProbe = _ammLastProbe.get(creatorB58) ?? 0;
  if (now - lastProbe < PROBE_INTERVAL_SEC * 1000) return null;
  _ammLastProbe.set(creatorB58, now);

  const c = conn();
  const vaultAuthority = deriveAmmCoinCreatorVaultAuthority(creator);
  const vaultAta = getAssociatedTokenAddressSync(WSOL_MINT, vaultAuthority, true);
  const destAta = getAssociatedTokenAddressSync(WSOL_MINT, creator, false);

  // Probe vault ATA WSOL balance. If the ATA doesn't exist yet, nothing
  // has accrued — skip silently.
  let vaultSol = 0;
  try {
    const ataInfo = await c.getAccountInfo(vaultAta, 'confirmed');
    if (!ataInfo) return null;
    if (ataInfo.data && ataInfo.data.length >= 72) {
      const wsolLamports = Number(ataInfo.data.readBigUInt64LE(64));
      vaultSol = wsolLamports / LAMPORTS_PER_SOL;
    }
  } catch (e) {
    console.warn(`[pumpamm] ${label} vault probe failed: ${e.message}`);
    return null;
  }

  if (vaultSol <= 0) return null;
  if (!(solUsd > 0)) {
    console.warn(`[pumpamm] ${label} skip: solUsd unavailable, vault=${vaultSol.toFixed(6)} SOL`);
    return null;
  }
  const vaultUsd = vaultSol * solUsd;
  const combinedUsd = (vaultSol + routeWalletSol) * solUsd;
  if (combinedUsd < AMM_CLAIM_MIN_VAULT_USD) {
    console.log(`[pumpamm] ${label} skip: vault=${vaultSol.toFixed(6)} SOL ($${vaultUsd.toFixed(2)}) + route ($${(combinedUsd - vaultUsd).toFixed(2)}) = $${combinedUsd.toFixed(2)} < min $${AMM_CLAIM_MIN_VAULT_USD}`);
    // Below the claim gate, but report the observed vault balance so the token
    // can be marked fee-routed (visible) before the claim fires. See
    // plan/EXTERNAL_ROUTER_VISIBILITY.md.
    return { signature: null, solClaimed: 0, skipped: true, vaultSol, vaultUsd, routeWalletSol };
  }

  console.log(`[pumpamm] ${label} claiming creator-vault=${vaultSol.toFixed(6)} SOL ($${vaultUsd.toFixed(2)}) creator=${creatorB58.slice(0,6)}…`);

  const beforePayer = await c.getBalance(creator, 'confirmed');

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    // Ensure the destination WSOL ATA exists (no-op if already there).
    createAssociatedTokenAccountIdempotentInstruction(
      creator,       // payer
      destAta,       // ata
      creator,       // owner
      WSOL_MINT,     // mint
    ),
    buildCollectCoinCreatorFeeIx({
      coinCreator: creator,
      coinCreatorVaultAuthority: vaultAuthority,
      coinCreatorVaultAta: vaultAta,
      coinCreatorTokenAccount: destAta,
    }),
    // Unwrap WSOL -> SOL so the existing sweep/split sees native SOL.
    createCloseAccountInstruction(destAta, creator, creator),
  );

  let sig;
  try {
    _ammLastAttempt.set(creatorB58, Date.now());
    sig = await sendAndConfirmTransaction(c, tx, [kp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
  } catch (e) {
    console.warn(`[pumpamm] ${label} collect_coin_creator_fee failed: ${e.message}`);
    return null;
  }

  const afterPayer = await c.getBalance(creator, 'confirmed');
  // Add back ~tx fee so the SOL delta reflects the claimed amount, not net of fees.
  const deltaLamports = Math.max(0, afterPayer - beforePayer + 10_000);
  const solClaimed = deltaLamports / LAMPORTS_PER_SOL;
  console.log(`[pumpamm] ${label} collected (vault was ${vaultSol.toFixed(6)} SOL, payer Δ=${solClaimed.toFixed(6)}) sig=${sig.slice(0, 16)}…`);
  return { signature: sig, solClaimed };
}
