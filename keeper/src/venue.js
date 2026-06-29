// Top-level venue-adapter layer.
//
// The keeper loop trades through a *venue* via this uniform interface; the actual
// implementation lives in the existing imperial*.js files. `resolveVenue(token)`
// picks the adapter from the token's `router` column. Imperial (→ Phoenix) is the
// only venue today; adding another = a second adapter object here (or a sibling
// top-level file) + a `VENUES` entry — zero loop changes.
//
// IMPORTANT — adapters are THIN. They only forward to the imperial*.js fns (same
// arg field names, so wiring the loop in Phase 2 is a direct call-site swap). They
// do NOT contain execution-mode (`config.hedgeMode`) logic — every simulate/live/
// verify guard stays in the loop around the adapter call.
//
// See plan/REMOVE_JUPITER_PERPS.md (Phase 1).
import {
  imperialOpenPosition,
  imperialIncreasePosition,
  imperialTopUpMargin,
  imperialAddCollateralToPosition,
  imperialPartialClose,
  imperialClosePosition,
  imperialWithdrawCollateral,
  imperialReadPosition,
  readImperialProfileUsdcUi,
  isUnderlyingSupportedForToken,
} from './imperialPerps.js';

// Imperial → Phoenix. Each method forwards its args object straight to the
// imperial implementation (identical field names).
export const imperialVenue = {
  id: 'imperial',
  open: (args) => imperialOpenPosition(args),
  increase: (args) => imperialIncreasePosition(args),
  topUpMargin: (args) => imperialTopUpMargin(args),
  addCollateral: (args) => imperialAddCollateralToPosition(args),
  partialClose: (args) => imperialPartialClose(args),
  close: (args) => imperialClosePosition(args),
  withdraw: (args) => imperialWithdrawCollateral(args),
  readPosition: (args) => imperialReadPosition(args),
  freeCollateralUsd: (args) => readImperialProfileUsdcUi(args),
  isSupported: (token, underlying) => isUnderlyingSupportedForToken(token, underlying),
};

// Registry of venue adapters, keyed by the `router` id.
const VENUES = {
  imperial: imperialVenue,
};

// Resolve the venue adapter for a token from its `router` column. The column
// defaults to 'imperial' in the DB; null/unknown/legacy values (e.g. 'jupiter')
// also resolve to Imperial — the sole venue post-removal.
export function resolveVenue(token) {
  const routerId = String(token?.router ?? 'imperial').toLowerCase();
  return VENUES[routerId] ?? imperialVenue;
}
