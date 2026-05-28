// Imperial profile auto-roll.
//
// Imperial sub-accounts ("profiles") are just indices 0,1,2,... under the
// single treasury wallet. They are NOT separate Solana keypairs — same
// signer for all of them. Rolling between them is pure bookkeeping: pick
// the lowest-index profile that still has headroom, deposit into a fresh
// index when none do.
//
// Sub-wallets (per-token fee collectors) are entirely separate and never
// touch this layer.

export const DEFAULT_USDC_CAP = 100;      // roll when used >= $100 in a profile
export const DEFAULT_POSITION_CAP = 5;    // roll when open positions >= 5
export const DEFAULT_MIN_USDC = 11;       // need >= $11 free to open (Imperial floor is $10)
export const DEFAULT_DEPOSIT_TARGET = 15; // top a fresh profile up to $15

const USDC_DECIMALS = 6;
const toUi = (base) => Number(base ?? 0) / 10 ** USDC_DECIMALS;

/**
 * Decide which Imperial profile to use for the next position.
 *
 * @param {object} args
 * @param {Array<{ profileIndex:number, usdc:number|string }>} args.profiles  /mobile/balances .profiles
 * @param {Array<{ profileIndex?:number, status?:string }>} [args.positions]  /positions .dataList (open only)
 * @param {object} [args.caps]
 * @param {number} [args.caps.usdcCap]        max UI USD a profile may hold before we roll off it
 * @param {number} [args.caps.positionCap]    max open positions per profile
 * @param {number} [args.caps.minUsdc]        min free USDC to consider a profile "fundable"
 * @param {number} [args.caps.depositTarget]  UI USD to deposit when funding a fresh profile
 * @returns {{
 *   profileIndex: number,
 *   needsDeposit: boolean,
 *   depositAmountUi: number,
 *   reason: string,
 * }}
 */
export function pickProfile({ profiles = [], positions = [], caps = {} } = {}) {
  const usdcCap       = caps.usdcCap       ?? DEFAULT_USDC_CAP;
  const positionCap   = caps.positionCap   ?? DEFAULT_POSITION_CAP;
  const minUsdc       = caps.minUsdc       ?? DEFAULT_MIN_USDC;
  const depositTarget = caps.depositTarget ?? DEFAULT_DEPOSIT_TARGET;

  const open = positions.filter((p) => (p?.status ?? 'open') === 'open');
  const positionsByProfile = new Map();
  for (const p of open) {
    const idx = typeof p.profileIndex === 'number' ? p.profileIndex : null;
    if (idx === null) continue;
    positionsByProfile.set(idx, (positionsByProfile.get(idx) ?? 0) + 1);
  }

  const sorted = [...profiles].sort((a, b) => a.profileIndex - b.profileIndex);

  // 1) lowest-index profile with headroom on BOTH usdc and position count.
  for (const p of sorted) {
    const ui = toUi(p.usdc);
    const posCount = positionsByProfile.get(p.profileIndex) ?? 0;
    if (ui >= minUsdc && ui < usdcCap && posCount < positionCap) {
      return {
        profileIndex: p.profileIndex,
        needsDeposit: false,
        depositAmountUi: 0,
        reason: `profile ${p.profileIndex} has $${ui.toFixed(2)} / ${posCount} open positions`,
      };
    }
  }

  // 2) lowest-index profile that's under cap on positions but underfunded:
  //    top it up.
  for (const p of sorted) {
    const ui = toUi(p.usdc);
    const posCount = positionsByProfile.get(p.profileIndex) ?? 0;
    if (ui < minUsdc && posCount < positionCap) {
      return {
        profileIndex: p.profileIndex,
        needsDeposit: true,
        depositAmountUi: depositTarget,
        reason: `profile ${p.profileIndex} underfunded ($${ui.toFixed(2)} < $${minUsdc}), depositing $${depositTarget}`,
      };
    }
  }

  // 3) every existing profile is full. Open a fresh index at maxIndex+1.
  const maxIndex = sorted.length ? sorted[sorted.length - 1].profileIndex : -1;
  const nextIndex = maxIndex + 1;
  return {
    profileIndex: nextIndex,
    needsDeposit: true,
    depositAmountUi: depositTarget,
    reason: `all ${sorted.length} profiles at cap, rolling to fresh profile ${nextIndex}`,
  };
}
