// Router-agnostic gate used by loop.js / externalRouters.js / imperialPerps.js to
// decide whether a token's underlying is hedgeable on the currently-active venue.
// Built from Imperial's market catalog (imperial.js SUPPORTED_MARKETS) plus the
// SOL/ETH/BTC base set.
//
// Lives in its own neutral module (moved out of the legacy jupiterPerps.js) so it
// survives the Jupiter-perps removal. See plan/REMOVE_JUPITER_PERPS.md (Phase 0).
import { SUPPORTED_MARKETS as IMPERIAL_SUPPORTED_MARKETS } from './imperial.js';

export const SUPPORTED_SYMBOLS = new Set([
  ...Object.keys(IMPERIAL_SUPPORTED_MARKETS),
  'SOL', 'ETH', 'BTC',
]);
