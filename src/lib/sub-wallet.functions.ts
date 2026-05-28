import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  deriveSubWalletAddress,
  deriveSubWalletKeypair,
  exportSubWalletPrivateKeyBase58,
} from "@/lib/solana/subWallet.server";
import {
  getServerConnection,
  getTreasuryKeypair,
} from "@/lib/solana/treasury.server";

import { ADMIN_WALLET_PUBKEYS } from "@/lib/admin";

// Min SOL the sub-wallet should keep for rent + tx fees.
const MIN_SUBWALLET_SOL = 0.01;

function verifyAdminSignature(message: string, signatureB58: string): boolean {
  try {
    const sigBytes = bs58.decode(signatureB58);
    const msgBytes = new TextEncoder().encode(message);
    for (const admin of ADMIN_WALLET_PUBKEYS) {
      const pubBytes = bs58.decode(admin);
      if (nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Reject signatures older than 5 minutes to prevent replay.
function isFreshMessage(message: string): boolean {
  const m = message.match(/ts:(\d+)/);
  if (!m) return false;
  const ts = Number(m[1]);
  return Date.now() - ts < 5 * 60 * 1000;
}

// ---------- Public: get sub-wallet address + live SOL balance ----------
export const getSubWalletInfo = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId: string }) =>
    z.object({ tokenId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("tokens")
      .select("id, treasury_wallet_address")
      .eq("id", data.tokenId)
      .maybeSingle();
    if (error || !row) return { address: null, solBalance: 0, error: "Token not found" };

    let address = row.treasury_wallet_address as string | null;
    if (!address) {
      // Backfill on-demand: derive and persist.
      address = deriveSubWalletAddress(data.tokenId);
      await supabaseAdmin
        .from("tokens")
        .update({ treasury_wallet_address: address })
        .eq("id", data.tokenId);
    }

    let solBalance = 0;
    try {
      const conn = getServerConnection();
      const lamports = await conn.getBalance(new PublicKey(address));
      solBalance = lamports / LAMPORTS_PER_SOL;
    } catch {
      // best-effort
    }
    return { address, solBalance, error: null as string | null };
  });

// ---------- Admin: reveal base58 private key for Phantom import ----------
export const revealSubWalletKey = createServerFn({ method: "POST" })
  .inputValidator((d: { tokenId: string; message: string; signature: string }) =>
    z.object({
      tokenId: z.string().uuid(),
      message: z.string().min(8).max(200),
      signature: z.string().min(40).max(200),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    if (!isFreshMessage(data.message)) {
      return { ok: false as const, error: "Stale signature, refresh and retry" };
    }
    if (!verifyAdminSignature(data.message, data.signature)) {
      return { ok: false as const, error: "Unauthorized" };
    }
    const address = deriveSubWalletAddress(data.tokenId);
    const privateKey = exportSubWalletPrivateKeyBase58(data.tokenId);
    return { ok: true as const, address, privateKey, error: null };
  });

// ---------- Admin: sweep all SOL from sub-wallet back to master ----------
export const sweepSubWallet = createServerFn({ method: "POST" })
  .inputValidator((d: { tokenId: string; message: string; signature: string }) =>
    z.object({
      tokenId: z.string().uuid(),
      message: z.string().min(8).max(200),
      signature: z.string().min(40).max(200),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    if (!isFreshMessage(data.message)) {
      return { ok: false as const, error: "Stale signature, refresh and retry", signature: null };
    }
    if (!verifyAdminSignature(data.message, data.signature)) {
      return { ok: false as const, error: "Unauthorized", signature: null };
    }
    const sub = deriveSubWalletKeypair(data.tokenId);
    const master = getTreasuryKeypair();
    const conn = getServerConnection();
    const lamports = await conn.getBalance(sub.publicKey);
    // Leave nothing, but reserve fee. Tx fee ~ 5000 lamports.
    const FEE_LAMPORTS = 5000;
    if (lamports <= FEE_LAMPORTS) {
      return { ok: false as const, error: "Nothing to sweep", signature: null };
    }
    const sweepAmount = lamports - FEE_LAMPORTS;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sub.publicKey,
        toPubkey: master.publicKey,
        lamports: sweepAmount,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [sub]);
    return { ok: true as const, signature: sig, error: null };
  });

// ---------- Admin: top up sub-wallet from master to MIN_SUBWALLET_SOL ----------
export const topUpSubWallet = createServerFn({ method: "POST" })
  .inputValidator((d: { tokenId: string; message: string; signature: string }) =>
    z.object({
      tokenId: z.string().uuid(),
      message: z.string().min(8).max(200),
      signature: z.string().min(40).max(200),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    if (!isFreshMessage(data.message)) {
      return { ok: false as const, error: "Stale signature", signature: null };
    }
    if (!verifyAdminSignature(data.message, data.signature)) {
      return { ok: false as const, error: "Unauthorized", signature: null };
    }
    const sub = deriveSubWalletKeypair(data.tokenId);
    const master = getTreasuryKeypair();
    const conn = getServerConnection();
    const current = await conn.getBalance(sub.publicKey);
    const target = Math.floor(MIN_SUBWALLET_SOL * LAMPORTS_PER_SOL);
    if (current >= target) {
      return { ok: true as const, signature: null, error: "Already funded" };
    }
    const needed = target - current;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: master.publicKey,
        toPubkey: sub.publicKey,
        lamports: needed,
      }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [master]);
    return { ok: true as const, signature: sig, error: null };
  });


