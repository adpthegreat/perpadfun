// Imperial routing adapter (Phase 1: shadow only).
//
// `quoteIfEnabled` is safe to call from anywhere in the hedge loop. It is a
// strict no-op unless ALL of these are true:
//   - config.imperial.enabled
//   - config.imperial.routingMode !== 'off'
//   - the symbol is in SUPPORTED_MARKETS
//
// Even when active, this function NEVER places an order and NEVER throws.
// On any error it logs and returns null so the caller can ignore it and
// continue with the existing hedge path unchanged.
//
// Output shape (when a quote is fetched):
//   {
//     symbol, side, collateralUsd, notionalUsd, leverage,
//     venue,                    // e.g. 'gmtrade' | 'phoenix' | 'flash_trade'
//     maxLeverage,              // venue's reported cap for this size
//     expectedCostUsd,          // round-trip cost from Imperial
//     reason,                   // Imperial's human-readable reason
//     raw,                      // full /route payload (for debugging)
//   }

import { config } from './config.js';
import { getRoute, isSupportedMarket, SUPPORTED_MARKETS, MIN_COLLATERAL_USD } from './imperial.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

function usdcUiToBaseUnits(usd) {
  return Math.max(0, Math.round(Number(usd) * 10 ** USDC_DECIMALS));
}

export function imperialRouterActive() {
  return Boolean(config.imperial.enabled && config.imperial.routingMode !== 'off');
}

/**
 * Fetch a quote from Imperial's /route endpoint. Shadow-safe: returns null
 * (and logs, never throws) if Imperial is disabled, the symbol isn't
 * supported, or the call fails.
 *
 * @param {object} args
 * @param {string} args.symbol         base symbol, e.g. 'SOL' (case-insensitive)
 * @param {'long'|'short'} args.side
 * @param {number} args.collateralUsd  collateral the keeper would post (UI USDC)
 * @param {number} args.leverage       desired leverage multiplier
 * @param {number} [args.slippageBps]  defaults to config.slippageBps
 * @param {string} [args.context]      free-form label for logs (e.g. 'open', 'topup')
 */
export async function quoteIfEnabled({
  symbol,
  side,
  collateralUsd,
  leverage,
  slippageBps,
  context = 'quote',
}) {
  if (!imperialRouterActive()) return null;
  const sym = String(symbol || '').toUpperCase();
  if (!isSupportedMarket(sym)) return null;
  if (!collateralUsd || !leverage) return null;
  if (Number(collateralUsd) < MIN_COLLATERAL_USD) {
    console.warn(
      `[imperial:${context}] ${sym} ${side} skipped: collateral $${collateralUsd} < min $${MIN_COLLATERAL_USD}`,
    );
    return null;
  }

  const notionalUsd = Number(collateralUsd) * Number(leverage);
  const params = {
    asset: sym,
    side: side === 'short' ? 'short' : 'long',
    amount: String(usdcUiToBaseUnits(collateralUsd)),
    collateralAsset: USDC_MINT,
    notional: notionalUsd.toFixed(6),
    desiredLeverage: String(leverage),
    slippageBps: String(slippageBps ?? config.slippageBps ?? 100),
  };

  try {
    const raw = await getRoute(params);
    const quote = {
      symbol: sym,
      side: params.side,
      collateralUsd: Number(collateralUsd),
      notionalUsd,
      leverage: Number(leverage),
      venue: raw?.venue ?? null,
      maxLeverage: raw?.maxLeverage ?? null,
      expectedCostUsd: raw?.expectedCostUsd ?? null,
      reason: raw?.reason ?? null,
      raw,
    };
    // Single structured log line per quote for easy grepping.
    console.log(
      `[imperial:${context}] ${sym} ${params.side} coll=$${collateralUsd} ` +
      `size=$${notionalUsd.toFixed(2)} lev=${leverage}x ` +
      `-> venue=${quote.venue} maxLev=${Number(quote.maxLeverage).toFixed(2)} ` +
      `cost=$${Number(quote.expectedCostUsd).toFixed(4)}`,
    );
    return quote;
  } catch (err) {
    console.warn(
      `[imperial:${context}] ${sym} ${params.side} quote failed: ${err?.message || err}`,
    );
    return null;
  }
}

export { SUPPORTED_MARKETS };
