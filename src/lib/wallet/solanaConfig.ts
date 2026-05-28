// Solana mainnet config
// Preview runs from lovableproject.com, which can be rejected by domain-locked RPC keys.
const HELIUS_RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=0a3a1262-c7bc-4a9a-a2f6-2527442840bc";
const PUBLIC_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
const configuredRpcUrl = import.meta.env.VITE_SOLANA_RPC_URL;

const isProxiedHost =
  typeof window !== "undefined" &&
  (window.location.hostname.endsWith("lovableproject.com") ||
    window.location.hostname.endsWith("lovable.app") ||
    window.location.hostname === "perpad.fun" ||
    window.location.hostname === "www.perpad.fun");

export const SOLANA_RPC_URL =
  configuredRpcUrl ||
  (isProxiedHost && typeof window !== "undefined"
    ? new URL("/api/public/solana/rpc", window.location.origin).toString()
    : HELIUS_RPC_URL);

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
