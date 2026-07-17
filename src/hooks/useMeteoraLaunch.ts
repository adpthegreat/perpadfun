// Client-side launch flow (treasury-signed pool variant).
//
// User signs ONE thing: a SOL transfer to the treasury covering the dev-buy
// plus a small slack for tx + rent. The treasury then creates the config +
// pool atomically with the dev-buy bundled, and is set as poolCreator +
// feeClaimer so the keeper can actually claim creator trading fees later.
// Tokens from the dev-buy still land in the user's wallet, so they show as
// the original "dev holder".
import { ensureBufferPolyfill } from "@/lib/buffer-polyfill";

import { useCallback, useState } from "react";
import { useWallet as useSolanaAdapterWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { useServerFn } from "@tanstack/react-start";
import { createDraftToken, deleteDraft, launchAsTreasury } from "@/lib/meteora/dbc.functions";
import { getLaunchFundingTarget } from "@/lib/treasury.functions";
import { QUOTE_TOKENS, fetchQuoteUsdPrice } from "@/lib/launch/config-builder";

export type LaunchStatus =
  | "idle"
  | "creating-draft"
  | "awaiting-signature"
  | "sending-prefund"
  | "confirming-prefund"
  | "launching"
  | "done"
  | "error";

export type LaunchInput = {
  ticker: string;
  name: string;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  underlying: string;
  leverage: number;
  direction: "long" | "short";
  creatorAddress?: string;
  // Admin-only knobs (exposed by /admin-launch; /launch omits them).
  leftoverTokens?: number; // held back from the bonding curve, 0..1B
  vanityMintPrivateKey?: string; // base58 or JSON array of 64 ints; server decodes
  adminSecret?: string; // required when either admin knob above is set
  // Quote token the bonding curve is denominated in (default SOL).
  quote?: "SOL" | "USDC" | "ANSEM" | "UWU" | "CUSTOM";
  // For quote === "CUSTOM": the verified mint + decimals (from verifyQuoteToken).
  quoteMint?: string;
  quoteDecimals?: number;
  // Creator dev-buy, in the QUOTE token's UI units. SOL: 0.1–5. USDC: 5–5000.
  initialBuy: number;
};

// Dev-buy bounds + base-unit scale per quote token (amounts in the quote's units).
const DEV_BUY_BOUNDS = {
  SOL: { min: 0.1, max: 5, decimals: 9 },
  USDC: { min: 5, max: 5000, decimals: 6 },
  ANSEM: { min: 10, max: 50000, decimals: 6 },
  UWU: { min: 50, max: 500000, decimals: 6 },
} as const;
const LAMPORTS_PER_SOL = 1_000_000_000;
// Extra SOL the user sends to treasury to cover rent + tx fees for the two
// transactions treasury signs (config init + pool+buy), plus a retry buffer
// so a partial failure (config landed, pool didn't) can be retried. Must
// match LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED on the server.
const TX_SLACK_LAMPORTS = 130_000_000; // 0.13 SOL

export function useMeteoraLaunch() {
  const { publicKey, signTransaction } = useSolanaAdapterWallet();
  const { connection } = useConnection();
  const draftFn = useServerFn(createDraftToken);
  const deleteFn = useServerFn(deleteDraft);
  const fundingTargetFn = useServerFn(getLaunchFundingTarget);
  const launchFn = useServerFn(launchAsTreasury);
  const [status, setStatus] = useState<LaunchStatus>("idle");

  const launch = useCallback(
    async (input: LaunchInput) => {
      if (!publicKey || !signTransaction) {
        throw new Error("Connect a Solana wallet");
      }

      const quote = input.quote ?? "SOL";
      // CUSTOM: mint + decimals come from the verified input; bounds are permissive
      // (verifyQuoteToken already vetted the token). Presets use the registry.
      let decimals: number;
      let bounds: { min: number; max: number };
      let quoteMintStr: string;
      if (quote === "CUSTOM") {
        decimals = input.quoteDecimals ?? 6;
        quoteMintStr = input.quoteMint!;
        // Cap the custom dev-buy at ~$5,000 worth (the same USD ceiling as the
        // USDC quote), derived from the live price — never leave it unbounded.
        // If the price is momentarily unavailable, fall back to a finite,
        // decimals-scaled cap (cheaper high-decimal coins allow a bigger count).
        const priceUsd = await fetchQuoteUsdPrice(quoteMintStr);
        const maxUnits =
          priceUsd > 0 ? Math.max(1, Math.floor(5000 / priceUsd)) : 10 ** decimals;
        bounds = { min: 0, max: maxUnits };
      } else {
        const b = DEV_BUY_BOUNDS[quote];
        decimals = b.decimals;
        bounds = { min: b.min, max: b.max };
        quoteMintStr = QUOTE_TOKENS[quote].mint;
      }
      const quoteMintPk = new PublicKey(quoteMintStr);
      const buy = input.initialBuy;
      if (!Number.isFinite(buy) || buy < bounds.min || buy > bounds.max) {
        throw new Error(`Initial buy must be between ${bounds.min} and ${bounds.max}`);
      }
      // Dev-buy in the quote token's base units.
      const buyAmount = Math.floor(buy * 10 ** decimals);

      setStatus("creating-draft");
      const draft = await draftFn({
        data: { ...input, creatorAddress: publicKey.toBase58() },
      });
      if (!draft.ok) {
        setStatus("error");
        throw new Error(draft.error ?? "Draft failed");
      }

      let cleanupOnFail = true;

      try {
        ensureBufferPolyfill();

        // Build the prefund instruction set. SOL pools: a single SOL transfer
        // covering dev-buy + rent/fees. USDC pools: SOL for rent/fees only, plus
        // a USDC transfer of the dev-buy into the sub-wallet's USDC ATA. Reading
        // current balances first makes a retry idempotent (never double-charges).
        const prefundIxs = [];

        // SOL leg: SOL pools fund buy + slack; USDC pools fund only rent/fees.
        const solRequiredLamports =
          quote !== "SOL" ? TX_SLACK_LAMPORTS : buyAmount + TX_SLACK_LAMPORTS;
        const fundingTarget = await fundingTargetFn({
          data: { tokenId: draft.tokenId, requiredLamports: solRequiredLamports },
        });
        const subWalletPubkey = new PublicKey(fundingTarget.pubkey);
        if (fundingTarget.lamportsNeeded > 0) {
          prefundIxs.push(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: subWalletPubkey,
              lamports: fundingTarget.lamportsNeeded,
            }),
          );
        }

        // USDC leg: create the sub-wallet's USDC ATA (user pays its rent) and
        // transfer the missing dev-buy amount into it.
        if (quote !== "SOL") {
          // The quote token may be classic SPL or Token-2022 (e.g. ANSEM). The
          // ATA address + transfer/create instructions must use the mint's own
          // program; the default (classic) would derive an unusable ATA and a
          // transfer that fails on-chain for a Token-2022 quote.
          const mintInfo = await connection.getAccountInfo(quoteMintPk, "confirmed");
          const quoteProgramId =
            mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
              ? TOKEN_2022_PROGRAM_ID
              : TOKEN_PROGRAM_ID;
          const subUsdcAta = getAssociatedTokenAddressSync(
            quoteMintPk,
            subWalletPubkey,
            true,
            quoteProgramId,
          );
          const userUsdcAta = getAssociatedTokenAddressSync(
            quoteMintPk,
            publicKey,
            false,
            quoteProgramId,
          );
          let subUsdcRaw = 0;
          try {
            const b = await connection.getTokenAccountBalance(subUsdcAta, "confirmed");
            subUsdcRaw = Number(b.value.amount ?? 0);
          } catch {
            subUsdcRaw = 0;
          }
          const usdcToSend = Math.max(0, buyAmount - subUsdcRaw);
          if (usdcToSend > 0) {
            let userUsdcRaw = 0;
            try {
              const b = await connection.getTokenAccountBalance(userUsdcAta, "confirmed");
              userUsdcRaw = Number(b.value.amount ?? 0);
            } catch {
              userUsdcRaw = 0;
            }
            if (userUsdcRaw < usdcToSend) {
              throw new Error(
                `Insufficient ${quote}: need ${(usdcToSend / 10 ** decimals).toFixed(2)}, wallet has ${(userUsdcRaw / 10 ** decimals).toFixed(2)}`,
              );
            }
            prefundIxs.push(
              createAssociatedTokenAccountIdempotentInstruction(
                publicKey,
                subUsdcAta,
                subWalletPubkey,
                quoteMintPk,
                quoteProgramId,
              ),
              createTransferCheckedInstruction(
                userUsdcAta,
                quoteMintPk,
                subUsdcAta,
                publicKey,
                usdcToSend,
                decimals,
                [],
                quoteProgramId,
              ),
            );
          }
        }

        let prefundSig: string | null = null;

        if (prefundIxs.length > 0) {
          // Build + sign + send the prefund. If a previous attempt already
          // funded the sub-wallet, prefundIxs is empty and this is skipped so
          // retrying cannot double-charge the user.
          const bh = await connection.getLatestBlockhash("confirmed");
          const transferTx = new Transaction({
            recentBlockhash: bh.blockhash,
            feePayer: publicKey,
          }).add(...prefundIxs);

          setStatus("awaiting-signature");
          const signed = await signTransaction(transferTx);

          setStatus("sending-prefund");
          const raw = signed.serialize();
          prefundSig = await connection.sendRawTransaction(raw, {
            skipPreflight: false,
            maxRetries: 5,
          });

          setStatus("confirming-prefund");
          // Re-broadcast every 2s until landed or the blockhash expires.
          const deadline = Date.now() + 90_000;
          let landed = false;
          while (Date.now() < deadline) {
            const st = await connection.getSignatureStatus(prefundSig, {
              searchTransactionHistory: true,
            });
            const v = st.value;
            if (v?.err) throw new Error("Prefund transfer failed on-chain");
            if (
              v &&
              (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")
            ) {
              landed = true;
              break;
            }
            const currentHeight = await connection.getBlockHeight("confirmed").catch(() => 0);
            if (currentHeight > bh.lastValidBlockHeight) break;
            await connection
              .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
              .catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (!landed) {
            throw new Error(
              "Your prefund transfer expired before landing on-chain. No funds were moved. Please try launching again.",
            );
          }
        }

        // Past this point the user's funds are in the token sub-wallet. Don't wipe the draft
        // even if launchAsTreasury fails — we want a recoverable row.
        cleanupOnFail = false;

        // 2. Hand off to the server: treasury signs and submits the launch.
        setStatus("launching");
        const rec = await launchFn({
          data: {
            tokenId: draft.tokenId,
            ticker: input.ticker,
            name: input.name,
            imageUrl: input.imageUrl,
            creatorAddress: publicKey.toBase58(),
            buyAmount,
            prefundSignature: prefundSig,
            curvePreset: draft.curvePreset as "gentle" | "standard" | "parabolic",
            // Admin extras. Undefined when called from /launch.
            leftoverTokens: input.leftoverTokens,
            vanityMintPrivateKey: input.vanityMintPrivateKey,
            adminSecret: input.adminSecret,
          },
        });
        if (!rec.ok) {
          setStatus("error");
          throw new Error(rec.error ?? "Treasury launch failed");
        }

        setStatus("done");
        return {
          tokenId: rec.tokenId,
          mint: rec.mint,
          poolAddress: rec.poolAddress,
          signature: rec.signature,
        };
      } catch (err) {
        if (cleanupOnFail) {
          await deleteFn({ data: { tokenId: draft.tokenId } }).catch(() => {});
        }
        setStatus("error");
        throw err;
      }
    },
    [publicKey, signTransaction, connection, draftFn, deleteFn, fundingTargetFn, launchFn],
  );

  return { launch, status };
}
