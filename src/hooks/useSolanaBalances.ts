import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useWallet } from "@/lib/wallet/WalletContext";
import { USDC_MINT, USDC_DECIMALS } from "@/lib/wallet/solanaConfig";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export function useSolBalance() {
  const { connection } = useConnection();
  const { wallet } = useWallet();
  const [sol, setSol] = useState<number | null>(null);

  useEffect(() => {
    if (!wallet || wallet.chain !== "solana") {
      setSol(null);
      return;
    }
    let active = true;
    const pk = new PublicKey(wallet.address);
    const fetch = async () => {
      try {
        const lamports = await connection.getBalance(pk, "confirmed");
        if (active) setSol(lamports / LAMPORTS_PER_SOL);
      } catch {
        if (active) setSol(null);
      }
    };
    fetch();
    const sub = connection.onAccountChange(pk, (acc: { lamports: number }) => {
      if (active) setSol(acc.lamports / LAMPORTS_PER_SOL);
    });
    const iv = setInterval(fetch, 30_000);
    return () => {
      active = false;
      connection.removeAccountChangeListener(sub).catch(() => {});
      clearInterval(iv);
    };
  }, [connection, wallet]);

  return sol;
}

export function useUsdcBalance() {
  const { connection } = useConnection();
  const { wallet } = useWallet();
  const [usdc, setUsdc] = useState<number | null>(null);

  useEffect(() => {
    if (!wallet || wallet.chain !== "solana") {
      setUsdc(null);
      return;
    }
    let active = true;
    const owner = new PublicKey(wallet.address);
    const mint = new PublicKey(USDC_MINT);
    const fetch = async () => {
      try {
        const resp = await connection.getParsedTokenAccountsByOwner(owner, {
          mint,
          programId: TOKEN_PROGRAM_ID,
        });
        const total = resp.value.reduce((sum: number, acc: { account: { data: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }) => {
          const amt = acc.account.data.parsed?.info?.tokenAmount?.uiAmount;
          return sum + (typeof amt === "number" ? amt : 0);
        }, 0);
        if (active) setUsdc(total);
      } catch {
        if (active) setUsdc(null);
      }
    };
    fetch();
    const iv = setInterval(fetch, 30_000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [connection, wallet]);

  return usdc;
}

export function formatNum(n: number | null, max = 4) {
  if (n == null) return "…";
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}
