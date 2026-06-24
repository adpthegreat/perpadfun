import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider as SolanaWalletProvider, useWallet as useSolanaAdapterWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";
import type { WalletConn } from "./types";
import { SOLANA_RPC_URL } from "./solanaConfig";

export type SolanaWalletName = "Phantom" | "Solflare" | "Backpack";

type Ctx = {
  wallet: WalletConn | null;
  connecting: boolean;
  connectSolanaWith: (name: SolanaWalletName) => Promise<void>;
  /** @deprecated kept for backward compat – Perpspad is Solana-only now */
  connectSolana: () => Promise<void>;
  /** @deprecated kept for backward compat – Perpspad is Solana-only now */
  connectEvm: (provider?: string) => Promise<void>;
  /** @deprecated */
  switchToHyperEvm: () => Promise<void>;
  disconnect: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletBridge>{children}</WalletBridge>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

function WalletBridge({ children }: { children: ReactNode }) {
  const { publicKey, connected, connecting, wallet: adapterWallet, select, connect, disconnect: solDisconnect, wallets } = useSolanaAdapterWallet();
  const [pending, setPending] = useState(false);

  const wallet: WalletConn | null = useMemo(() => {
    if (!connected || !publicKey) return null;
    const name = adapterWallet?.adapter.name?.toLowerCase() ?? "phantom";
    const provider = (name === "solflare" ? "solflare" : name === "backpack" ? "backpack" : "phantom") as WalletConn["provider"];
    return { chain: "solana", address: publicKey.toBase58(), provider };
  }, [connected, publicKey, adapterWallet]);

  const connectSolanaWith = useCallback(
    async (name: SolanaWalletName) => {
      const adapter = wallets.find((w: { adapter: { name: string } }) => w.adapter.name === name);
      if (!adapter) {
        const urls: Record<SolanaWalletName, string> = {
          Phantom: "https://phantom.app/download",
          Solflare: "https://solflare.com/download",
          Backpack: "https://backpack.app/downloads",
        };
        window.open(urls[name], "_blank");
        throw new Error(`${name} not detected. Install it and refresh.`);
      }
      setPending(true);
      try {
        select(adapter.adapter.name);
        // give react a tick to apply the selected wallet
        await new Promise((r) => setTimeout(r, 0));
        await adapter.adapter.connect();
      } finally {
        setPending(false);
      }
    },
    [wallets, select],
  );

  const connectSolana = useCallback(() => connectSolanaWith("Phantom"), [connectSolanaWith]);
  const connectEvm = useCallback(async () => {
    throw new Error("Perpspad is Solana only.");
  }, []);
  const switchToHyperEvm = useCallback(async () => {}, []);

  const disconnect = useCallback(() => {
    solDisconnect().catch(() => {});
  }, [solDisconnect]);

  return (
    <WalletCtx.Provider
      value={{
        wallet,
        connecting: connecting || pending,
        connectSolanaWith,
        connectSolana,
        connectEvm,
        switchToHyperEvm,
        disconnect,
      }}
    >
      {children}
    </WalletCtx.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}

export function truncateAddress(a: string, n = 4) {
  if (!a) return "";
  if (a.length <= 2 * n + 3) return a;
  return `${a.slice(0, n + 2)}…${a.slice(-n)}`;
}
