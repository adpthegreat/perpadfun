// Shared on-chain program IDs, the wSOL mint, and Jupiter v6 endpoints.
// Single source of truth so buyback.js / fees.js / swap.js
// don't each redeclare them. (SOL_MINT in some files is the same value as
// WSOL_MINT — import it as `WSOL_MINT as SOL_MINT` there.)

export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
export const JUP_SWAP = 'https://lite-api.jup.ag/swap/v1/swap';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Quote-token registry (mirrors src/lib/launch/config-builder.ts). Maps the
// tokens.quote_token enum → its mint + decimals so the keeper can handle any
// quote generically: SOL is native, everything else is an SPL quote whose fees
// get swapped to SOL after claiming. Add a new quote by dropping in one entry.
export const QUOTE_TOKENS = {
  SOL: { mint: WSOL_MINT, decimals: 9 },
  USDC: { mint: USDC_MINT, decimals: 6 },
  ANSEM: { mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump', decimals: 6 },
  UWU: { mint: 'UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump', decimals: 6 },
};

// Resolve a quote_token string to { mint, decimals }, defaulting to SOL.
export function quoteTokenInfo(quoteToken) {
  return QUOTE_TOKENS[quoteToken] ?? QUOTE_TOKENS.SOL;
}
