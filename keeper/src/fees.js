// Real on-chain fee claims.
//
// Pre-graduation (DBC pool, quote = SOL):
//   DynamicBondingCurveClient.partner.claimPartnerTradingFee({...}) first,
//   then creator.claimCreatorTradingFee({...}) if creator fees exist.
//   The treasury is both the fee claimer and receiver. With the current SDK,
//   do NOT pass/sign an ephemeral tempWSol keypair when receiver === claimer:
//   the SDK ignores it, and signing it causes `unknown signer`. Let the SDK
//   use and close the treasury wSOL ATA back into native SOL.
//
// Post-graduation (DAMM v2 pool, token/SOL):
//   CpAmm.claimPositionFee({...}) on the treasury-owned LP position.
//   Same measurement trick: SOL balance delta = quote fee, token balance
//   delta (which we immediately burn separately) = base fee.
//
// Both paths:
//   - Skip silently if the pool/position is missing or already claimed (0 fees).
//   - Return { signature, solClaimed, tokensClaimed, kind } so the caller
//     can log a tx_log row and feed the SOL into the buyback reserve.
//   - Idempotency: caller derives intent_hash before submit. If we crash
//     between send and confirm, the next tick re-derives the same intent
//     and finds the tx_log row already pending; the server upsert merges.

import { ComputeBudgetProgram, Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { DynamicBondingCurveClient, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { config } from './config.js';
import { loadKeypair } from './wallet.js';
import { WSOL_MINT as SOL_MINT, TOKEN_PROGRAM } from './constants.js';
import { withRetry } from './rateLimiter.js';
import { swapUsdcToSol } from './swap.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const U64_MAX = new BN('18446744073709551615');
const MIN_CLAIM_USD = Number(process.env.MIN_CLAIM_USD ?? '0.02');
const MIN_CLAIM_SOL = Number(process.env.MIN_CLAIM_SOL ?? '0.0001');
const ENABLE_AMM_FEE_CLAIMS = String(process.env.ENABLE_AMM_FEE_CLAIMS ?? 'true').toLowerCase() === 'true';
const SEND_MAX_ATTEMPTS = Number(process.env.CLAIM_SEND_MAX_ATTEMPTS ?? '4');
const CONFIRM_TIMEOUT_MS = Number(process.env.CLAIM_CONFIRM_TIMEOUT_MS ?? '45000');
const PRIORITY_MICRO_LAMPORTS = Number(process.env.CLAIM_PRIORITY_MICRO_LAMPORTS ?? '250000');
const COMPUTE_UNIT_LIMIT = Number(process.env.CLAIM_COMPUTE_UNIT_LIMIT ?? '600000');
const POOL_COOLDOWN_MS = Number(process.env.CLAIM_POOL_COOLDOWN_MS ?? '300000'); // 5 min after a failed send

// in-memory cooldown map: poolAddress -> epoch ms until which we skip claims
const _poolCooldownUntil = new Map();
// DBC pools whose one-off migration fee we've already tried to sweep this process.
const _migrationFeeSwept = new Set();
function poolOnCooldown(addr) {
  const until = _poolCooldownUntil.get(addr);
  if (!until) return false;
  if (Date.now() >= until) { _poolCooldownUntil.delete(addr); return false; }
  return true;
}
function setPoolCooldown(addr, ms = POOL_COOLDOWN_MS) {
  _poolCooldownUntil.set(addr, Date.now() + ms);
}

console.log(`[fees] loaded dbc-amm-claim-v7-reliable enableAmm=${ENABLE_AMM_FEE_CLAIMS} minClaimUsd=${MIN_CLAIM_USD} minClaimSol=${MIN_CLAIM_SOL} attempts=${SEND_MAX_ATTEMPTS}`);

function bnNumber(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value.toString());
}

function rawTokenToUi(raw, decimals) {
  return bnNumber(raw) / 10 ** decimals;
}

function claimGate(pendingSol, solUsd) {
  const pendingUsd = solUsd > 0 ? pendingSol * solUsd : 0;
  const passSol = MIN_CLAIM_SOL <= 0 || pendingSol >= MIN_CLAIM_SOL;
  const passUsd = MIN_CLAIM_USD <= 0 || pendingUsd >= MIN_CLAIM_USD;
  return { pendingUsd, pass: passSol && passUsd };
}

let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

let _treasury = null;
function treasury() {
  if (!_treasury) _treasury = loadKeypair(config.treasuryKey);
  return _treasury;
}
function pickSigner(kp) {
  return kp ?? treasury();
}


let _dbc = null;
function dbc() {
  if (!_dbc) _dbc = new DynamicBondingCurveClient(conn(), 'confirmed');
  return _dbc;
}

let _amm = null;
function amm() {
  if (!_amm) _amm = new CpAmm(conn());
  return _amm;
}

function isComputeBudgetIx(ix) {
  return ix?.programId?.equals?.(ComputeBudgetProgram.programId);
}

function addPriorityInstructions(tx) {
  if (!Array.isArray(tx?.instructions)) return tx;
  if (tx.instructions.some(isComputeBudgetIx)) return tx;
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  );
  return tx;
}

async function materializeTransaction(txOrBuilder) {
  const built = typeof txOrBuilder === 'function' ? await txOrBuilder() : txOrBuilder;
  const tx = typeof built?.build === 'function'
    ? await built.build()
    : await built?.transaction?.() ?? built;
  if (!tx || (tx.instructions && tx.instructions.length === 0)) return null;
  return addPriorityInstructions(tx);
}

async function confirmWithTimeout(c, strategy) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`confirmation timeout after ${CONFIRM_TIMEOUT_MS}ms`)), CONFIRM_TIMEOUT_MS);
  });
  return Promise.race([
    c.confirmTransaction(strategy, 'confirmed'),
    timeout,
  ]);
}

async function signatureStatus(sig) {
  try {
    const status = await conn().getSignatureStatus(sig, { searchTransactionHistory: true });
    const value = status?.value;
    if (!value) return null;
    if (value.err) throw new Error(`tx failed: ${JSON.stringify(value.err)}`);
    if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return 'confirmed';
    return 'pending';
  } catch (e) {
    if (/tx failed:/i.test(e?.message ?? '')) throw e;
    return null;
  }
}

async function withTimeout(label, promise, ms = CONFIRM_TIMEOUT_MS) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]);
}

async function sendAndConfirm(txOrBuilder, label = 'tx', signer = null) {
  const c = conn();
  const kp = signer ?? treasury();
  let lastErr = null;
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
    const tx = await materializeTransaction(txOrBuilder);
    if (!tx) return null;
    if (!Array.isArray(tx.instructions)) {
      throw new Error(`${label}: unsupported transaction type for fee claim retry`);
    }
    const { blockhash, lastValidBlockHeight } = await withTimeout(`${label} blockhash`, c.getLatestBlockhash('confirmed'), 15000);
    // reset signatures so we can re-sign with a fresh blockhash
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    tx.signatures = [];
    tx.sign(kp);
    let sig = null;
    try {
      sig = await withTimeout(`${label} send`, c.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 10,
      }), 20000);
      const r = await confirmWithTimeout(c, { signature: sig, blockhash, lastValidBlockHeight });
      if (r.value.err) throw new Error(`tx failed: ${JSON.stringify(r.value.err)}`);
      console.log(`[fees] ${label} confirmed attempt=${attempt} sig=${sig}`);
      return sig;
    } catch (e) {
      if (sig) {
        const status = await signatureStatus(sig);
        if (status === 'confirmed') {
          console.log(`[fees] ${label} confirmed by status fallback attempt=${attempt} sig=${sig}`);
          return sig;
        }
      }
      lastErr = e;
      const msg = e?.message ?? String(e);
      const retriable = /block height exceeded|blockhash not found|expired|confirmation timeout|TransactionExpiredBlockheightExceededError/i.test(msg);
      if (!retriable || attempt === SEND_MAX_ATTEMPTS) throw e;
      console.warn(`[fees] send attempt ${attempt} failed (${msg.slice(0,120)}), retrying with fresh blockhash`);
    }
  }
  throw lastErr;
}


async function solBalance(pubkey) {
  const lamports = await withRetry(() => conn().getBalance(pubkey, 'confirmed'));
  return lamports / 1e9;
}

// Raw USDC ATA balance (6dp base units) for a wallet, or 0 if the ATA is absent.
async function readUsdcRaw(owner) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner);
    const bal = await withRetry(() => conn().getTokenAccountBalance(ata, 'confirmed'));
    return Number(bal?.value?.amount ?? 0);
  } catch {
    return 0;
  }
}

// USDC-quoted pools accrue fees in USDC, not SOL. After claiming, the USDC lands
// in the signer's USDC ATA. We swap it to SOL so the rest of the keeper's
// SOL-denominated economics (split/skim/perp-margin/buyback) run unchanged.
// Returns SOL received, or 0 if nothing was claimed/converted (USDC then stays
// in the wallet and is picked up by the buyback USDC-probe path on a later tick).
async function convertClaimedUsdcToSol({ kp, beforeUsdcRaw, expectedUsdcUi, label }) {
  const afterUsdcRaw = await readUsdcRaw(kp.publicKey);
  const measuredUi = Math.max(0, (afterUsdcRaw - beforeUsdcRaw) / 1e6);
  const usdcClaimed = Math.max(measuredUi, expectedUsdcUi);
  if (!(usdcClaimed > 0)) return 0;
  let sw = null;
  try {
    sw = await swapUsdcToSol({ wantUsd: usdcClaimed, kp });
  } catch (e) {
    console.error(`[${label}] USDC->SOL convert failed: ${e?.message ?? e}`);
  }
  const solClaimed = sw?.solReceived ?? 0;
  if (!(solClaimed > 0)) {
    console.warn(
      `[${label}] claimed ~$${usdcClaimed.toFixed(4)} USDC but USDC->SOL yielded 0; USDC stays in wallet for the buyback path`,
    );
    return 0;
  }
  console.log(`[${label}] converted ${usdcClaimed.toFixed(6)} USDC -> ${solClaimed.toFixed(9)} SOL sig=${sw.swapSig}`);
  return solClaimed;
}

// ---- DBC: claim trading fees on a virtual pool ----
// Most configs route 100% of trading fees to the PARTNER side (feeClaimer),
// not the creator side. We attempt both: partner first, then creator. If the
// treasury isn't the partner/creator for a side, the SDK throws and we skip it.
// Returns { signature, solClaimed } combined across both sides, or null.
export async function claimDbcFees({ dbcPoolAddress, solUsd = 0, kp: kpArg = null, quoteMint = SOL_MINT }) {
  const kp = pickSigner(kpArg);
  // USDC-quoted pools accrue fees in USDC (6dp); SOL pools in lamports (9dp).
  const isUsdc = quoteMint === USDC_MINT;
  const quoteDecimals = isUsdc ? 6 : 9;
  const quoteDivisor = 10 ** quoteDecimals;

  const pool = new PublicKey(dbcPoolAddress);
  const poolStateBefore = await dbc().state.getPool(pool);
  const partnerQuoteFeeRaw = bnNumber(poolStateBefore?.partnerQuoteFee);
  const creatorQuoteFeeRaw = bnNumber(poolStateBefore?.creatorQuoteFee);
  const partnerBaseFeeRaw = bnNumber(poolStateBefore?.partnerBaseFee);
  const creatorBaseFeeRaw = bnNumber(poolStateBefore?.creatorBaseFee);
  // UI units of the QUOTE token (SOL or USDC).
  const partnerQuoteUi = partnerQuoteFeeRaw / quoteDivisor;
  const creatorQuoteUi = creatorQuoteFeeRaw / quoteDivisor;

  console.log(
    `[claimDbcFees] pool=${pool.toBase58()} quote=${isUsdc ? 'USDC' : 'SOL'} partnerQuote=${partnerQuoteUi} creatorQuote=${creatorQuoteUi}`,
  );

  // Gate by USD threshold so we don't waste tx fees on dust claims. For USDC,
  // the quote UI amount IS the USD amount; convert to a SOL-equivalent so the
  // shared SOL+USD floors in claimGate apply identically.
  const pendingQuoteUi = partnerQuoteUi + creatorQuoteUi;
  const pendingSol = isUsdc ? (solUsd > 0 ? pendingQuoteUi / solUsd : 0) : pendingQuoteUi;
  const gate = claimGate(pendingSol, solUsd);
  if (!gate.pass) {
    console.log(`[claimDbcFees] skip: pendingSol=${pendingSol.toFixed(9)} pendingUsd=${gate.pendingUsd.toFixed(4)} < minSol=${MIN_CLAIM_SOL} or minUsd=${MIN_CLAIM_USD}`);
    return null;
  }


  const before = await solBalance(kp.publicKey);
  const beforeUsdcRaw = isUsdc ? await readUsdcRaw(kp.publicKey) : 0;
  const sigs = [];
  let claimedSide = null;
  let expectedQuoteUi = 0;

  // 1) PARTNER side (where fees actually live when creatorTradingFeePercentage = 0)
  if (partnerQuoteFeeRaw > 0 || partnerBaseFeeRaw > 0) {
    // Diagnostic: dump on-chain config.feeClaimer vs the signer we're about
    // to submit. If these differ we know the master key / sub-wallet
    // derivation drifted from what was burned in at launch.
    try {
      const cfgState = await dbc().state.getPoolConfig(poolStateBefore.config);
      const onChainFeeClaimer = cfgState?.feeClaimer?.toBase58?.() ?? String(cfgState?.feeClaimer);
      const onChainPoolCreator = poolStateBefore?.creator?.toBase58?.() ?? String(poolStateBefore?.creator);
      console.log(
        `[claimDbcFees] auth-check signer=${kp.publicKey.toBase58()} configFeeClaimer=${onChainFeeClaimer} poolCreator=${onChainPoolCreator} match=${onChainFeeClaimer === kp.publicKey.toBase58()}`,
      );
    } catch (e) {
      console.warn('[claimDbcFees] auth-check dump failed:', e?.message ?? e);
    }

    let tx;
    try {
      tx = await dbc().partner.claimPartnerTradingFee2({
        feeClaimer: kp.publicKey,
        payer: kp.publicKey,
        pool,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
        receiver: kp.publicKey,
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.warn("[fees] partner claim build skipped:", msg);
    }
    if (tx && (!tx.instructions || tx.instructions.length > 0)) {
      // Diagnostic: dump the actual fee_claimer account pubkey baked into
      // the built tx, so we can see if Anchor/SDK swapped in a different
      // pubkey than what we passed.
      try {
        const accs = tx.instructions?.map((ix, i) => ({
          i,
          prog: ix.programId.toBase58(),
          keys: ix.keys.map((k) => ({ pk: k.pubkey.toBase58(), s: k.isSigner, w: k.isWritable })),
        })) ?? [];
        const claimIx = accs.find((ix) => ix.prog === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
        if (claimIx) {
          console.log(`[claimDbcFees] claim ix accounts:`, JSON.stringify(claimIx.keys));
        }
      } catch (e) {
        console.warn('[claimDbcFees] ix dump failed:', e?.message ?? e);
      }
      try {
        sigs.push(await sendAndConfirm(tx, 'dbc-partner-claim', kp));
        claimedSide = 'partner';
        expectedQuoteUi += partnerQuoteUi;
        console.log(`[claimDbcFees] partner claimed expectedQuote=${partnerQuoteUi}`);
      } catch (e) {
        console.error("[fees] partner claim SEND failed:", e?.message ?? e);
      }
    }
  }

  // 2) CREATOR side (in case the config splits fees and creator share > 0)
  if (creatorQuoteFeeRaw > 0 || creatorBaseFeeRaw > 0) {
    let tx;
    try {
      tx = await dbc().creator.claimCreatorTradingFee2({
        creator: kp.publicKey,
        payer: kp.publicKey,
        pool,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
        receiver: kp.publicKey,
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.warn("[fees] creator claim build skipped:", msg);
    }
    if (tx && (!tx.instructions || tx.instructions.length > 0)) {
      try {
        sigs.push(await sendAndConfirm(tx, 'dbc-creator-claim', kp));
        claimedSide = claimedSide ? `${claimedSide}+creator` : 'creator';
        expectedQuoteUi += creatorQuoteUi;
        console.log(`[claimDbcFees] creator claimed expectedQuote=${creatorQuoteUi}`);
      } catch (e) {
        console.error("[fees] creator claim SEND failed:", e?.message ?? e);
      }
    }
  }

  // ---- one-off DBC fees folded in: pool-creation ("launch") + migration ----
  // Both land in the sub-wallet (kp), alongside the trading fees above, and run
  // regardless of whether trading fees were claimed (before the early return).
  // Launch fee is idempotent via the on-chain poolCreationFeeHasBeenClaimed flag;
  // the migration fee is one-off and guarded by _migrationFeeSwept for this process.
  if (poolStateBefore && poolStateBefore.poolCreationFeeHasBeenClaimed === false) {
    try {
      const tx = await dbc().partner.claimPartnerPoolCreationFee({ virtualPool: pool, feeReceiver: kp.publicKey });
      if (tx && (!tx.instructions || tx.instructions.length > 0)) {
        const sig = await sendAndConfirm(tx, 'dbc-launch-fee', kp);
        if (sig) console.log(`[claimDbcFees] launch fee -> sub-wallet pool=${dbcPoolAddress.slice(0, 8)}… sig=${String(sig).slice(0, 16)}…`);
      }
    } catch (e) {
      console.warn(`[claimDbcFees] launch-fee skip: ${e?.message ?? e}`);
    }
  }
  if (poolStateBefore?.isMigrated && !_migrationFeeSwept.has(dbcPoolAddress)) {
    _migrationFeeSwept.add(dbcPoolAddress);
    for (const side of ['partner', 'creator']) {
      try {
        const tx = side === 'partner'
          ? await dbc().partner.partnerWithdrawMigrationFee({ virtualPool: pool, sender: kp.publicKey })
          : await dbc().creator.creatorWithdrawMigrationFee({ virtualPool: pool, sender: kp.publicKey });
        if (tx && (!tx.instructions || tx.instructions.length > 0)) {
          const sig = await sendAndConfirm(tx, `dbc-migration-fee-${side}`, kp);
          if (sig) console.log(`[claimDbcFees] migration fee (${side}) -> sub-wallet pool=${dbcPoolAddress.slice(0, 8)}… sig=${String(sig).slice(0, 16)}…`);
        }
      } catch (e) {
        console.warn(`[claimDbcFees] migration-fee ${side} skip: ${e?.message ?? e}`);
      }
    }
  }

  if (sigs.length === 0) return null;

  // USDC pools: the claimed fee landed as USDC. Convert to SOL so callers get
  // the same SOL-denominated solClaimed they expect for SOL pools.
  if (isUsdc) {
    const solClaimed = await convertClaimedUsdcToSol({
      kp,
      beforeUsdcRaw,
      expectedUsdcUi: expectedQuoteUi,
      label: 'claimDbcFees',
    });
    if (!(solClaimed > 0)) return null;
    return { signature: sigs[sigs.length - 1], solClaimed, claimedSide };
  }

  const after = await solBalance(kp.publicKey);
  // Add back ~5000 lamports per signature for tx fees so claimed amount isn't undercounted
  const balanceDeltaSol = Math.max(0, after - before + 0.000005 * sigs.length);
  const solClaimed = Math.max(balanceDeltaSol, expectedQuoteUi);
  return { signature: sigs[sigs.length - 1], solClaimed, claimedSide };
}


// ---- DAMM v2: claim fees on the treasury's LP position ----
// If lpPositionAddress is unknown, we discover it via getUserPositionByPool.
// Returns { signature, solClaimed, tokensClaimed, lpPositionAddress } or null.
export async function claimAmmFees({ graduatedPoolAddress, mintAddress, lpPositionAddress, solUsd = 0, kp: kpArg = null, quoteMint = SOL_MINT }) {
  if (!ENABLE_AMM_FEE_CLAIMS) {
    console.log('[claimAmmFees] skip: AMM fee claims disabled (ENABLE_AMM_FEE_CLAIMS=false)');
    return null;
  }
  if (poolOnCooldown(graduatedPoolAddress)) {
    console.log(`[claimAmmFees] skip: pool ${graduatedPoolAddress} on cooldown`);
    return null;
  }

  try {
    return await _claimAmmFeesInner({ graduatedPoolAddress, mintAddress, lpPositionAddress, solUsd, kp: kpArg, quoteMint });
  } catch (e) {
    setPoolCooldown(graduatedPoolAddress);
    console.error(`[fees] claimAmmFees failed (non-fatal, cooldown ${POOL_COOLDOWN_MS}ms):`, e?.message ?? e);
    return null;
  }
}


async function resolveTokenProgram(mintPk) {
  const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM);
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  try {
    const info = await withRetry(() => conn().getAccountInfo(mintPk, 'confirmed'));
    if (info?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

async function mintDecimals(mintPk) {
  const supply = await conn().getTokenSupply(mintPk, 'confirmed');
  return supply?.value?.decimals ?? 0;
}

async function _claimAmmFeesInner({ graduatedPoolAddress, mintAddress, lpPositionAddress, solUsd = 0, kp: kpArg = null, quoteMint = SOL_MINT }) {
  const kp = pickSigner(kpArg);
  const isUsdc = quoteMint === USDC_MINT;

  const pool = new PublicKey(graduatedPoolAddress);

  const positions = await amm().getUserPositionByPool(pool, kp.publicKey);
  if (!positions || positions.length === 0) return null;

  // Fetch pool state for vault/mint addresses
  const poolState = await amm().fetchPoolState(pool);

  const tokenAMint = poolState.tokenAMint;
  const tokenBMint = poolState.tokenBMint;
  const tokenAVault = poolState.tokenAVault;
  const tokenBVault = poolState.tokenBVault;
  if (!tokenAMint || !tokenBMint || !tokenAVault || !tokenBVault) {
    console.error('[fees] poolState missing mint/vault fields, skipping AMM claim');
    return null;
  }

  // Derive token programs from the mint account owners (poolState fields are unreliable)
  const tokenAProgram = await resolveTokenProgram(tokenAMint);
  const tokenBProgram = await resolveTokenProgram(tokenBMint);

  // Gate AMM claims from account state before constructing/submitting anything.
  // Pick the treasury LP position with the largest unclaimed QUOTE side. The
  // quote side is SOL for SOL pools, USDC for USDC pools. The saved
  // lp_position_address can point at an empty position, causing 0-fee tx dust.
  const quoteMintPk = new PublicKey(quoteMint);
  const quoteSide = tokenAMint.equals(quoteMintPk) ? 'A' : tokenBMint.equals(quoteMintPk) ? 'B' : null;
  if (!quoteSide) {
    console.log(`[claimAmmFees] skip: pool has no ${isUsdc ? 'USDC' : 'SOL'} side for USD gate`);
    return null;
  }

  const [tokenADecimals, tokenBDecimals] = await Promise.all([
    mintDecimals(tokenAMint),
    mintDecimals(tokenBMint),
  ]);
  const quoteDecimals = quoteSide === 'A' ? tokenADecimals : tokenBDecimals;
  // pendingSol is a SOL-equivalent used only for the shared claimGate/log. For
  // USDC pools, the on-chain pending is USDC; convert via solUsd. pendingQuote
  // is the actual quote-token amount we'll claim and (for USDC) convert.
  const scoredPositions = positions
    .map((p) => {
      const fees = getUnClaimLpFee(poolState, p.positionState);
      const quoteRaw = quoteSide === 'A' ? fees.feeTokenA : fees.feeTokenB;
      const pendingQuote = rawTokenToUi(quoteRaw, quoteDecimals);
      const pendingSol = isUsdc ? (solUsd > 0 ? pendingQuote / solUsd : 0) : pendingQuote;
      return {
        position: p.position,
        positionNftAccount: p.positionNftAccount,
        pendingQuote,
        pendingSol,
        pendingUsd: pendingSol * solUsd,
      };
    })
    .sort((a, b) => b.pendingSol - a.pendingSol);
  let match = scoredPositions[0] ?? null;

  const bestGate = match ? claimGate(match.pendingSol, solUsd) : { pendingUsd: 0, pass: false };
  if (!bestGate.pass) {
    const bestSol = match?.pendingSol ?? 0;
    console.log(`[claimAmmFees] skip: bestUnclaimedSol=${bestSol.toFixed(9)} pendingUsd=${bestGate.pendingUsd.toFixed(4)} < minSol=${MIN_CLAIM_SOL} or minUsd=${MIN_CLAIM_USD}`);
    return null;
  }
  if (solUsd > 0) {
    if (lpPositionAddress && match.position.toBase58() !== lpPositionAddress) {
      console.log(`[claimAmmFees] using fee-bearing LP position ${match.position.toBase58()} instead of saved ${lpPositionAddress}`);
    }
    console.log(`[claimAmmFees] proceeding: unclaimedSol=${match.pendingSol.toFixed(9)} pendingUsd=${bestGate.pendingUsd.toFixed(4)} >= minSol=${MIN_CLAIM_SOL} minUsd=${MIN_CLAIM_USD}`);
  } else if (lpPositionAddress) {
    match = scoredPositions.find((p) => p.position.toBase58() === lpPositionAddress) ?? match;
  }

  if (!match) return null;
  const positionPk = match.position;
  const positionNftAccount = match.positionNftAccount;

  async function buildClaimTx() {
    const txBuilder = await amm().claimPositionFee2({
      owner: kp.publicKey,
      position: positionPk,
      pool,
      positionNftAccount,
      tokenAMint,
      tokenBMint,
      tokenAVault,
      tokenBVault,
      tokenAProgram,
      tokenBProgram,
      receiver: kp.publicKey,
      feePayer: kp.publicKey,
    });
    return materializeTransaction(txBuilder);
  }

  let tx;
  try {
    tx = await buildClaimTx();
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/not found|no.*position|invalid/i.test(msg)) return null;
    throw e;
  }
  if (!tx || (tx.instructions && tx.instructions.length === 0)) return null;

  const before = await solBalance(kp.publicKey);
  const beforeUsdcRaw = isUsdc ? await readUsdcRaw(kp.publicKey) : 0;
  const sig = await sendAndConfirm(buildClaimTx, 'amm-position-fee-claim', kp);

  // USDC pools: claimed quote fee landed as USDC -> convert to SOL so callers
  // get a SOL-denominated solClaimed exactly like SOL pools.
  let solClaimed;
  if (isUsdc) {
    solClaimed = await convertClaimedUsdcToSol({
      kp,
      beforeUsdcRaw,
      expectedUsdcUi: match.pendingQuote,
      label: 'claimAmmFees',
    });
    if (!(solClaimed > 0)) return null;
  } else {
    const after = await solBalance(kp.publicKey);
    solClaimed = Math.max(0, after - before, match.pendingSol);
  }

  // Token-side fees land in treasury ATA; loop.js will sweep them into a
  // burn on the same tick. We don't try to measure exactly here — the
  // buyback path uses Jupiter to size the next burn from the SOL side.
  return {
    signature: sig,
    solClaimed,
    tokensClaimed: 0, // surfaced via ATA delta in a future pass if needed
    lpPositionAddress: positionPk.toBase58(),
  };
}

// ---- Graduation detector ----
// Reads the DBC virtual pool state and reports whether the bonding curve has
// migrated to a DAMM v2 pool. When it has, derives the new pool address so
// the keeper can persist it and switch fee claims over to claimAmmFees.
//
// MigrationProgress (u8) on Meteora's VirtualPool account:
//   0 = PreBondingCurve     (still trading on the curve)
//   1 = PostBondingCurve    (curve filled, DAMM pool not yet created)
//   2 = CreatedPool         (DAMM v2 pool exists, LP minted to treasury)
//   3 = LockedVesting       (LP locked / vesting started)
// We treat anything >= 2 as "graduated".
//
// Returns:
//   { graduated: false }                                       not yet
//   { graduated: true, graduatedPoolAddress: string }          ready to switch
//   null                                                       pool not found / error
export async function detectGraduation({ dbcPoolAddress, dbcConfigAddress, baseMintAddress, quoteMintAddress }) {
  if (!dbcPoolAddress || !dbcConfigAddress || !baseMintAddress) return null;
  try {
    const poolState = await dbc().state.getPool(new PublicKey(dbcPoolAddress));
    if (!poolState) return null;
    const progress = Number(poolState.migrationProgress ?? 0);
    if (progress < 2) return { graduated: false, progress };
    const quoteMint = new PublicKey(quoteMintAddress ?? SOL_MINT);
    const dammPool = deriveDammV2PoolAddress(
      new PublicKey(dbcConfigAddress),
      new PublicKey(baseMintAddress),
      quoteMint,
    );
    return {
      graduated: true,
      progress,
      graduatedPoolAddress: dammPool.toBase58(),
    };
  } catch (e) {
    console.warn(`[graduation] detect failed pool=${dbcPoolAddress}: ${e?.message ?? e}`);
    return null;
  }
}
