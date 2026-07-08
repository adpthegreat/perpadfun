// Solana mainnet config.
// RPC key is NEVER hardcoded/shipped to the browser. Resolution order:
//   1. VITE_SOLANA_RPC_URL (build-time env) if set,
//   2. on perpspad.xyz / preview hosts: the server RPC proxy
//      (/api/public/solana/rpc) so the real key stays server-side,
//   3. otherwise the public mainnet RPC (rate-limited, no key).
const PUBLIC_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const configuredRpcUrl = import.meta.env.VITE_SOLANA_RPC_URL;

const isProxiedHost =
  typeof window !== "undefined" &&
  (window.location.hostname.endsWith("lovableproject.com") ||
    window.location.hostname.endsWith("lovable.app") ||
    window.location.hostname === "perpspad.xyz" ||
    window.location.hostname === "www.perpspad.xyz" ||
    // Local dev: route through the same-origin proxy (the dev server handles
    // /api/public/solana/rpc → real SOLANA_RPC_URL) so localhost doesn't fall back
    // to the public RPC, which 403s browser dApp calls.
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1");

export const SOLANA_RPC_URL =
  configuredRpcUrl ||
  (isProxiedHost && typeof window !== "undefined"
    ? new URL("/api/public/solana/rpc", window.location.origin).toString()
    : PUBLIC_MAINNET_RPC_URL);

// Server-side RPC URL. Reads SOLANA_RPC_URL from env at call time (must be
// invoked inside a server handler — env injection happens per-request).
export function getServerSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || PUBLIC_MAINNET_RPC_URL;
}
// Deprecated alias; do not use in new code.
export const SERVER_SOLANA_RPC_URL = PUBLIC_MAINNET_RPC_URL;

// USDC mainnet mint
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
