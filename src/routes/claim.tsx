// Airdrop claim page. Reachable in coming-soon mode via the coming-soon.ts edit.
// Buffer MUST be polyfilled before any @solana import — keep this first.
import "@/lib/buffer-polyfill";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Transaction } from "@solana/web3.js";
import {
  useWallet as useSolanaAdapterWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { Gift, Wallet, Loader2, CheckCircle2, XCircle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/lib/wallet/WalletContext";
import { Distributor } from "@kamino-finance/distributor-sdk";
import { getClaim, getStats, isFinalized, type Claim } from "@/lib/airdrop/proofMap";
import { buildClaimInstructions } from "@/lib/airdrop/claim";
import { TOKEN_DECIMALS } from "@/lib/airdrop/merkle";

export const Route = createFileRoute("/claim")({
  component: ClaimPage,
  head: () => ({
    meta: [
      { title: "Claim airdrop · perpspad" },
      { name: "description", content: "Claim your PERP airdrop allocation." },
    ],
  }),
});

type Status =
  | "idle"
  | "preparing"
  | "awaiting-signature"
  | "sending"
  | "confirming"
  | "done"
  | "error";

const SYMBOL = "PERP";
/** below this the wallet likely can't cover ClaimStatus rent + ATA + fee. */
const MIN_SOL_LAMPORTS = 3_000_000; // ~0.003 SOL

function formatAmount(baseUnits: string): string {
  const n = Number(baseUnits) / 10 ** TOKEN_DECIMALS;
  return n.toLocaleString(undefined, { maximumFractionDigits: TOKEN_DECIMALS });
}

function ClaimPage() {
  const { wallet } = useWallet(); // app-level: address string + gating only
  const { publicKey, signTransaction } = useSolanaAdapterWallet(); // raw adapter
  const { connection } = useConnection(); // routes through the RPC proxy on prod

  const [status, setStatus] = useState<Status>("idle");
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [lowSol, setLowSol] = useState(false);

  const claim = useMemo<Claim | null>(
    () => (publicKey ? getClaim(publicKey.toBase58()) : null),
    [publicKey],
  );
  const stats = useMemo(() => getStats(), []);
  const finalized = useMemo(() => isFinalized(), []);

  const inFlight =
    status === "preparing" ||
    status === "awaiting-signature" ||
    status === "sending" ||
    status === "confirming";

  // On connect: read on-chain claim status (drives the ALREADY CLAIMED state and
  // idempotency on retry) + a SOL balance hint.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!publicKey) {
        setAlreadyClaimed(false);
        setLowSol(false);
        return;
      }
      try {
        const bal = await connection.getBalance(publicKey);
        if (!cancelled) setLowSol(bal < MIN_SOL_LAMPORTS);
      } catch {
        /* ignore balance read errors */
      }
      if (!claim) {
        if (!cancelled) setAlreadyClaimed(false);
        return;
      }
      setChecking(true);
      try {
        const d = new Distributor(connection);
        const claimed = await d.userClaimed(claim.distributor, publicKey);
        if (!cancelled) setAlreadyClaimed(claimed);
      } catch {
        /* ignore — chain state is re-checked on claim */
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [publicKey, claim, connection]);

  async function onClaim() {
    if (!publicKey || !signTransaction || !claim) return;
    if (!finalized) {
      toast.message("The distributor is not live yet. Check back soon.");
      return;
    }
    try {
      setStatus("preparing");
      const ixs = await buildClaimInstructions(
        connection,
        claim.distributor,
        publicKey,
        claim.amountStr,
        claim.proof,
      );
      const bh = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        recentBlockhash: bh.blockhash,
        feePayer: publicKey,
      }).add(...ixs);

      setStatus("awaiting-signature");
      const signed = await signTransaction(tx);

      setStatus("sending");
      const raw = signed.serialize();
      const txSig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 5,
      });
      setSig(txSig);

      setStatus("confirming");
      // Re-broadcast every 2s until landed or the blockhash expires. Do NOT use
      // connection.confirmTransaction (it stalls on Cloudflare Workers).
      const deadline = Date.now() + 90_000;
      let landed = false;
      while (Date.now() < deadline) {
        const st = await connection.getSignatureStatus(txSig, {
          searchTransactionHistory: true,
        });
        const v = st.value;
        if (v?.err) throw new Error("Claim failed on-chain");
        if (
          v &&
          (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")
        ) {
          landed = true;
          break;
        }
        const h = await connection.getBlockHeight("confirmed").catch(() => 0);
        if (h > bh.lastValidBlockHeight) break;
        await connection
          .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!landed) throw new Error("Claim expired before landing. Try again.");

      setStatus("done");
      setAlreadyClaimed(true);
      toast.success(`Claimed ${formatAmount(claim.amountStr)} ${SYMBOL}`, {
        description: "View transaction on Solscan",
        action: {
          label: "Open",
          onClick: () => window.open(`https://solscan.io/tx/${txSig}`, "_blank"),
        },
      });
    } catch (e) {
      setStatus("error");
      const msg = e instanceof Error ? e.message : "Claim failed";
      // Idempotency: a second claim by the same wallet fails because the
      // ClaimStatus PDA is already initialized. Re-check on-chain and, if claimed,
      // flip to the ALREADY CLAIMED state instead of showing a hard error.
      try {
        const d = new Distributor(connection);
        const claimed = await d.userClaimed(claim.distributor, publicKey);
        if (claimed) {
          setAlreadyClaimed(true);
          toast.message("You have already claimed this allocation.");
          return;
        }
      } catch {
        /* ignore */
      }
      toast.error(msg);
    }
  }

  const buttonLabel = (() => {
    switch (status) {
      case "preparing":
        return "PREPARING";
      case "awaiting-signature":
        return "CONFIRM IN WALLET";
      case "sending":
        return "SENDING";
      case "confirming":
        return "CONFIRMING";
      case "done":
        return "CLAIMED";
      default:
        return claim ? `CLAIM ${formatAmount(claim.amountStr)} ${SYMBOL}` : "CLAIM";
    }
  })();

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="mx-auto max-w-xl px-6 py-16">
        <div className="mb-8 flex items-center gap-3">
          <Gift className="h-5 w-5 text-foreground" />
          <h1 className="font-mono text-sm uppercase tracking-[0.25em] text-foreground">
            {SYMBOL} Airdrop
          </h1>
        </div>

        {!finalized && (
          <div className="mb-6 border border-border bg-card px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Distributor not yet live. Check back soon.
          </div>
        )}

        <div className="border border-border bg-card p-6">
          {/* 1. disconnected */}
          {!wallet || !publicKey ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <Wallet className="h-8 w-8 text-muted-foreground" />
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Connect your wallet to check eligibility
              </p>
              <ConnectWalletButton />
            </div>
          ) : !claim ? (
            /* 2. connected, not eligible */
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <XCircle className="h-8 w-8 text-muted-foreground" />
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                This wallet is not eligible for the airdrop
              </p>
            </div>
          ) : (
            /* 3 + 4. eligible */
            <div className="flex flex-col gap-5">
              <div className="flex items-end justify-between border-b border-border pb-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Your allocation
                </span>
                <span className="font-mono text-2xl tabular-nums text-foreground">
                  {formatAmount(claim.amountStr)}
                  <span className="ml-1.5 text-xs text-muted-foreground">{SYMBOL}</span>
                </span>
              </div>

              {checking ? (
                <div className="flex items-center justify-center gap-2 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> checking status.
                </div>
              ) : alreadyClaimed ? (
                <div className="flex items-center justify-center gap-2 border border-emerald-500/40 bg-emerald-500/10 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> already claimed
                </div>
              ) : (
                <>
                  {lowSol && (
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-400">
                      Low SOL balance — you need a little SOL for rent + fees to claim.
                    </p>
                  )}
                  <Button
                    size="lg"
                    onClick={onClaim}
                    disabled={inFlight || !finalized}
                    className="w-full rounded-none font-mono text-[11px] uppercase tracking-[0.2em]"
                  >
                    {inFlight && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                    {finalized ? buttonLabel : "NOT YET LIVE"}
                  </Button>
                </>
              )}

              {sig && (
                <a
                  href={`https://solscan.io/tx/${sig}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
                >
                  view transaction <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {stats.totalWallets.toLocaleString()} wallets ·{" "}
          {formatAmount(stats.totalBaseUnits.toString())} {SYMBOL} total
        </p>
      </div>
    </div>
  );
}
