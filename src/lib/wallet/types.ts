export type WalletChain = "evm" | "solana";

export type WalletConn = {
  chain: WalletChain;
  address: string;
  provider: "phantom" | "metamask" | "rabby" | "injected" | "walletconnect";
};

declare global {
  interface Window {
    ethereum?: any;
    solana?: any;
    phantom?: {
      ethereum?: any;
      solana?: any;
    };
  }
}
