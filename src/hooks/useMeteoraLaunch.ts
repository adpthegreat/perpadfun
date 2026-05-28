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
import {
  useWallet as useSolanaAdapterWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { useServerFn } from "@tanstack/react-start";
import {
  createDraftToken,
  deleteDraft,
  launchAsTreasury,
} from "@/lib/meteora/dbc.functions";
import { getLaunchFundingTarget } from "@/lib/treasury.functions";

export type LaunchStatus =
  | "idle"
  | "creating-draft"
  | "awaiting-signature"
  | "sending-prefund"
  | "confirming-prefund"
  | "launching"
  | "done"
  | "error";

type LaunchInput = {
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
  // Creator dev-buy in SOL. Min 0.1, max 5.
  initialBuySol: number;
};

const MIN_DEV_BUY_SOL = 0.1;
const MAX_DEV_BUY_SOL = 5;
const LAMPORTS_PER_SOL = 1_000_000_000;
// Extra SOL the user sends to treasury to cover rent + tx fees for the two
// transactions treasury signs (config init + pool+buy), plus a retry buffer
// so a partial failure (config landed, pool didn't) can be retried. Must
// match LAUNCH_RENT_AND_FEES_LAMPORTS + SUB_WALLET_OPS_SEED on the server.
const TX_SLACK_LAMPORTS = 110_000_000; // 0.11 SOL

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

      const buySol = input.initialBuySol;
      if (!Number.isFinite(buySol) || buySol < MIN_DEV_BUY_SOL || buySol > MAX_DEV_BUY_SOL) {
        throw new Error(`Initial buy must be between ${MIN_DEV_BUY_SOL} and ${MAX_DEV_BUY_SOL} SOL`);
      }
      const buyLamports = Math.floor(buySol * LAMPORTS_PER_SOL);
      const prefundLamports = buyLamports + TX_SLACK_LAMPORTS;

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

        const fundingTarget = await fundingTargetFn({
          data: { tokenId: draft.tokenId, requiredLamports: prefundLamports },
        });
        const subWalletPubkey = new PublicKey(fundingTarget.pubkey);
        const lamportsToFund = fundingTarget.lamportsNeeded;
        let prefundSig: string | null = null;

        if (lamportsToFund > 0) {
          // 1. Build + sign + send a simple SOL transfer directly to this
          // token's sub-wallet. If a previous attempt already funded it, this
          // is skipped so retrying cannot double-charge the user.
          const bh = await connection.getLatestBlockhash("confirmed");
          const transferTx = new Transaction({
            recentBlockhash: bh.blockhash,
            feePayer: publicKey,
          }).add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: subWalletPubkey,
              lamports: lamportsToFund,
            }),
          );

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
            if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
              landed = true;
              break;
            }
            const currentHeight = await connection.getBlockHeight("confirmed").catch(() => 0);
            if (currentHeight > bh.lastValidBlockHeight) break;
            await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (!landed) {
            throw new Error(
              "Your SOL transfer expired before landing on-chain. No funds were moved. Please try launching again.",
            );
          }
        }

        // Past this point the user's SOL is in the token sub-wallet. Don't wipe the draft
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
            buyLamports,
            prefundSignature: prefundSig,
            curvePreset: draft.curvePreset as "gentle" | "standard" | "parabolic",
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
