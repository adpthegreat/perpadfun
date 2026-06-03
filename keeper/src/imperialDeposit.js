// Gated Imperial funding helpers.
//
// PURPOSE: Prevent the keeper from sending USDC out of a token's wallet
// (master treasury for legacy tokens, sub-wallet for new ones) into an
// Imperial profile unless the specific token has actually earned enough
// fees to pay for it.
//
// MIRRORS the existing Jupiter-perps gating in loop.js:
//   - OPEN  : token.fees_accrued_usd must be >= config.feeGateUsd
//             AND the deposit amount is capped at fees_accrued_usd
//   - TOPUP : token.fees_accrued_usd must be >= config.topUpFeeGateUsd
//             AND the deposit amount is capped at fees_accrued_usd
//
// This applies equally to:
//   - perpad-native tokens (fees claimed from DBC/DAMM v2 pools)
//   - external pump.fun-routed tokens (creator fees swept to sub-wallet)

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { config } from './config.js';
import { swapSolToUsdc, MIN_VIABLE_USDC } from './swap.js';
import { MIN_COLLATERAL_USD as IMPERIAL_MIN_COLLATERAL_USD } from './imperial.js';
import { withRetry } from './rateLimiter.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
function usdToBase(usd) { return Math.max(0, Math.round(Number(usd) * 10 ** USDC_DECIMALS)); }

/**
 * Decide whether the keeper is allowed to move USDC from the token's wallet
 * into an Imperial profile, and how much.
 */
export function gateImperialFunding({ token, kind, requestedUsd }) {
  if (!token) return { allow: false, reason: 'no token' };
  if (kind !== 'open' && kind !== 'topup') return { allow: false, reason: `bad kind=${kind}` };

  const fees = Math.max(0, Number(token.fees_accrued_usd ?? 0));
  const gate = kind === 'open' ? config.feeGateUsd : config.topUpFeeGateUsd;
  // Fix 1d: two floors, applied by kind.
  //  - viableFloor: don't swap+deposit below a size the SOL->USDC swap can fill.
  //    MIN_VIABLE_USDC is the single source of truth shared with keeper/src/swap.js.
  //  - OPEN additionally requires Imperial's minimum collateral: there is no
  //    point swapping+depositing until the reserve can actually OPEN a position.
  //    A TOPUP adds to an already-funded profile, so it only needs viableFloor.
  const viableFloor = Math.max(1, Number(config.minDepositUsd ?? 5), Number(MIN_VIABLE_USDC) || 0);
  const floor =
    kind === 'open'
      ? Math.max(viableFloor, Number(IMPERIAL_MIN_COLLATERAL_USD) || 0)
      : viableFloor;

  if (fees < gate) {
    return { allow: false, fees, gate, floor, reason: `accrued $${fees.toFixed(2)} < ${kind} gate $${gate}` };
  }

  // Hard cap: never deposit more than the token has actually earned in fees.
  // Master treasury principal MUST NOT subsidize the perp position.
  const cap = fees;
  const allowedUsd = Math.min(Math.max(0, Number(requestedUsd) || 0), cap);

  // Fix 1d: below the viable floor we DON'T attempt a doomed micro-swap. The
  // reserve keeps accumulating as SOL in the wallet until a single viable
  // swap+deposit is possible. Surfaced as `awaiting_swap_size` so the dashboard
  // shows "accumulating", not a hard error.
  if (allowedUsd < floor) {
    return {
      allow: false, fees, gate, floor,
      reason: `awaiting_swap_size: deposit cap $${cap.toFixed(2)} below viable floor $${floor}`,
    };
  }

  return { allow: true, allowedUsd, fees, gate, floor };
}

// Pure: deployable USD a wallet can route into a deposit = parked USDC + (SOL
// above the keep-alive reserve, USD-valued, minus a 3% swap-slippage haircut).
// When this is below the minimum-deposit floor we skip the swap entirely
// (the DUMPED/ELON "capacity-below-floor" case) instead of burning a Jupiter
// call on a route that lands $0.
export function walletCapacityUsd({ usdcUi = 0, solUi = 0, solUsd = 0, reserveSol = 0.01 } = {}) {
  const swappableSol = Math.max(0, Number(solUi) - Math.max(0, Number(reserveSol)));
  const fromSwap = swappableSol * (Number(solUsd) || 0) * 0.97;
  return Math.max(0, Number(usdcUi) || 0) + fromSwap;
}

/**
 * Read total deployable USD in a sub-wallet: USDC balance + (SOL above reserve) * solUsd,
 * with a small slippage cushion for the SOL leg. This is the most we can realistically
 * route into an Imperial profile this tick without raiding tx-fee reserves.
 */
export async function getWalletCapacityUsd({ kp, solUsd, rpcUrl }) {
  const conn = new Connection(rpcUrl || config.rpcUrl, 'confirmed');
  const reserveSol = Math.max(0, Number(config.walletSolReserve ?? 0.01));
  const SLIPPAGE = 0.99;

  let usdc = 0;
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, kp.publicKey);
    const bal = await withRetry(() => conn.getTokenAccountBalance(ata, 'confirmed'));
    usdc = Number(bal.value.uiAmount ?? 0);
  } catch { /* no ATA = 0 */ }

  let solUi = 0;
  try {
    const lamports = await withRetry(() => conn.getBalance(kp.publicKey, 'confirmed'));
    solUi = lamports / 1e9;
  } catch { /* ignore */ }

  const swappableSol = Math.max(0, solUi - reserveSol);
  const solValueUsd = swappableSol * Number(solUsd || 0) * SLIPPAGE;
  return Math.max(0, usdc + solValueUsd);
}

async function getUsdcUi(conn, owner) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const bal = await withRetry(() => conn.getTokenAccountBalance(ata, 'confirmed'));
    return Number(bal.value.uiAmount ?? 0);
  } catch { return 0; }
}

/**
 * Ensure `kp` has USDC available for deposit, swapping SOL->USDC via Jupiter
 * if needed. Tries to land at >= usdAmount but tolerates Jupiter slippage:
 * returns the ACTUAL USDC balance after the attempt (capped at usdAmount).
 *
 * Cushion is the larger of $0.75 or 3% of usdAmount, so small swaps have
 * enough headroom for Jupiter price impact + tx fees instead of landing
 * $1-2 short of target every tick.
 *
 * Never throws on shortfall - caller decides what to do with the partial
 * amount (the wallet keeps the USDC for the next tick either way).
 */
export async function ensureUsdcForDeposit({ kp, usdAmount, solUsd, rpcUrl }) {
  if (!(usdAmount > 0)) throw new Error('ensureUsdcForDeposit: usdAmount must be > 0');
  if (!(solUsd > 0)) throw new Error('ensureUsdcForDeposit: solUsd must be > 0');
  const conn = new Connection(rpcUrl || config.rpcUrl, 'confirmed');

  const usdcUiBefore = await getUsdcUi(conn, kp.publicKey);
  if (usdcUiBefore >= usdAmount) {
    return {
      swapped: false, usdcUiBefore, usdcUiAfter: usdcUiBefore,
      effectiveUsd: usdAmount, shortfall: false,
    };
  }

  // Pre-flight: compute the wallet's true SOL-side capacity and bail with a
  // clear log line if we can already see we can't reach the minimum deposit
  // floor. This prevents wasting a Jupiter call on routes that will land $0
  // (the silent failure the user hit on DUMPED/ELON: $5.62 capacity -> $0
  // USDC because Jupiter couldn't route the tiny swap).
  const wallet = kp.publicKey.toBase58();
  const reserveSol = Math.max(0, Number(config.walletSolReserve ?? 0.01));
  let solUi = 0;
  let lamports = 0;
  try {
    lamports = await withRetry(() => conn.getBalance(kp.publicKey, 'confirmed'));
    solUi = lamports / 1e9;
  } catch { /* ignore */ }
  const totalCapacityUsd = walletCapacityUsd({ usdcUi: usdcUiBefore, solUi, solUsd, reserveSol });
  const capacityFromSwap = totalCapacityUsd - usdcUiBefore;
  const floor = Math.max(1, Number(config.minDepositUsd ?? 2));

  if (totalCapacityUsd < floor) {
    console.log(
      `[imperial:ensureUsdc] skip wallet=${wallet.slice(0, 8)}… sol=${solUi.toFixed(6)} usdc=${usdcUiBefore.toFixed(2)} totalCap=$${totalCapacityUsd.toFixed(2)} < floor $${floor} (wanted $${usdAmount.toFixed(2)})`,
    );
    return {
      swapped: false, usdcUiBefore, usdcUiAfter: usdcUiBefore,
      effectiveUsd: usdcUiBefore, shortfall: true, skipReason: 'capacity-below-floor',
    };
  }

  // Cushion sized to actually beat Jupiter slippage on small swaps:
  // max($0.75, 3% of target).
  const cushion = Math.max(0.75, usdAmount * 0.03);
  const need = Math.min(usdAmount - usdcUiBefore + cushion, capacityFromSwap + cushion);
  let sw = null;
  let swapErr = null;
  try {
    sw = await swapSolToUsdc({ wantUsdc: need, solUsd, kp });
  } catch (e) {
    swapErr = e.message;
    console.warn(
      `[imperial:ensureUsdc] swap failed wallet=${wallet.slice(0, 8)}… sol=${solUi.toFixed(6)} (lamports=${lamports}) need=$${need.toFixed(2)} solUsd=$${solUsd.toFixed(2)}: ${e.message}`,
    );
  }
  // Brief re-poll: the swap can confirm at 'confirmed' a beat before the
  // USDC ATA reflects, especially when wrapAndUnwrapSol creates a fresh ATA.
  let usdcUiAfter = await getUsdcUi(conn, kp.publicKey);
  if (sw && usdcUiAfter < usdcUiBefore + 0.01) {
    for (let i = 0; i < 4 && usdcUiAfter < usdcUiBefore + 0.01; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      usdcUiAfter = await getUsdcUi(conn, kp.publicKey);
    }
  }
  const effectiveUsd = Math.min(usdAmount, usdcUiAfter);
  if (sw && usdcUiAfter < usdcUiBefore + 0.01) {
    console.warn(
      `[imperial:ensureUsdc] swap returned sig=${sw.swapSig?.slice(0, 16)}… but USDC ATA still ${usdcUiAfter.toFixed(4)} (was ${usdcUiBefore.toFixed(4)}). Possible silent route fail.`,
    );
  }
  return {
    swapped: !!sw,
    swapSig: sw?.swapSig,
    usdcReceived: sw?.usdcReceived,
    solSpent: sw?.solSpent,
    swapErr,
    usdcUiBefore,
    usdcUiAfter,
    effectiveUsd,
    shortfall: usdcUiAfter < usdAmount,
  };
}

/**
 * Sign + send Imperial's /deposit/build-tx. Auto-swaps SOL->USDC first if the
 * wallet doesn't have enough USDC. ONLY call this after gateImperialFunding()
 * returns { allow: true }.
 *
 * Partial-deposit fallback: if the SOL->USDC swap lands short of the
 * requested amount (Jupiter slippage), we deposit whatever USDC is actually
 * in the wallet (rounded down to 2dp) instead of throwing. This keeps the
 * profile filling up tick-by-tick. Only throws if post-swap balance is
 * below config.minDepositUsd (genuine "nothing to deposit").
 *
 * Returns { signature, depositedUsd, prep } on success.
 */
export async function depositToImperialProfile({
  authToken,
  kp,
  profileIndex,
  usdAmount,
  solUsd,
  baseUrl,
  rpcUrl,
  autoSwap = true,
}) {
  if (!authToken) throw new Error('depositToImperialProfile: authToken required');
  if (!kp) throw new Error('depositToImperialProfile: kp required');
  if (!(usdAmount > 0)) throw new Error('depositToImperialProfile: usdAmount must be > 0');
  if (profileIndex == null) throw new Error('depositToImperialProfile: profileIndex required');

  let prep = null;
  let depositUsd = Number(usdAmount);
  if (autoSwap) {
    if (!(solUsd > 0)) throw new Error('depositToImperialProfile: solUsd required when autoSwap=true');
    prep = await ensureUsdcForDeposit({ kp, usdAmount, solUsd, rpcUrl });
    if (prep.shortfall) {
      const floor = Math.max(1, Number(config.minDepositUsd ?? 5));
      if (prep.effectiveUsd < floor) {
        throw new Error(
          `depositToImperialProfile: post-swap USDC $${prep.usdcUiAfter.toFixed(2)} below floor $${floor} (wanted $${usdAmount.toFixed(2)})`,
        );
      }
      // Round DOWN to 2dp so we never ask Imperial for more than we hold.
      depositUsd = Math.floor(prep.effectiveUsd * 100) / 100;
      console.log(`[imperial:deposit] partial: requested $${usdAmount.toFixed(2)}, post-swap balance $${prep.usdcUiAfter.toFixed(2)}, depositing $${depositUsd.toFixed(2)}`);
    }
  }

  const base = baseUrl || config.imperial.baseUrl;
  const wallet = kp.publicKey.toBase58();
  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };
  if (config.imperial.apiKey) headers['x-api-key'] = config.imperial.apiKey;

  const res = await fetch(`${base}/deposit/build-tx`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      wallet,
      profileIndex,
      amount: usdToBase(depositUsd),
      mode: 'deposit',
    }),
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok || !body?.transaction) {
    throw new Error(`Imperial /deposit/build-tx ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  const conn = new Connection(rpcUrl || config.rpcUrl, 'confirmed');
  const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, 'base64'));
  tx.sign([kp]);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(signature, 'confirmed');
  if (conf.value.err) {
    throw new Error(`Imperial deposit tx on-chain err: ${JSON.stringify(conf.value.err)}`);
  }
  return { signature, depositedUsd: depositUsd, prep };
}
