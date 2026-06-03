import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getServerConnection } from "@/lib/solana/treasury.server";

// Live on-chain SOL + USDC for a set of sub-wallet addresses, for the /admin/logs
// summary tab (parked funds + gas runway). Read-only, best-effort.

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MAX_ADDRESSES = 120;
const CONCURRENCY = 8;

export type WalletBalance = { sol: number; usdc: number };

function isValidPubkey(a: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export const getWalletBalances = createServerFn({ method: "GET" })
  .inputValidator((d: { addresses: string[] }) =>
    z.object({ addresses: z.array(z.string()).max(500).default([]) }).parse(d),
  )
  .handler(async ({ data }) => {
    const balances: Record<string, WalletBalance> = {};
    // Dedupe + drop anything that isn't a real pubkey (seeded test wallets aren't),
    // and cap the fan-out so an admin refresh can't hammer the RPC.
    const valid = [...new Set(data.addresses)].filter(isValidPubkey).slice(0, MAX_ADDRESSES);
    if (valid.length === 0) return { balances };

    const conn = getServerConnection();
    const pubkeys = valid.map((a) => new PublicKey(a));

    // SOL: batched getMultipleAccountsInfo (<= 100 per call).
    for (let i = 0; i < pubkeys.length; i += 100) {
      const chunk = pubkeys.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
      chunk.forEach((_pk, j) => {
        const addr = valid[i + j];
        balances[addr] = { sol: (infos[j]?.lamports ?? 0) / LAMPORTS_PER_SOL, usdc: 0 };
      });
    }

    // USDC: per-owner parsed token accounts filtered to the USDC mint (bounded concurrency).
    await mapLimit(valid, CONCURRENCY, async (addr) => {
      try {
        const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(addr), { mint: USDC_MINT });
        let usdc = 0;
        for (const { account } of res.value) {
          const ui = (account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } })
            ?.parsed?.info?.tokenAmount?.uiAmount;
          if (typeof ui === "number") usdc += ui;
        }
        if (balances[addr]) balances[addr].usdc = usdc;
      } catch {
        // best-effort: leave usdc at 0 on RPC error
      }
    });

    return { balances };
  });
