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
