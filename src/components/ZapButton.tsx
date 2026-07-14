// Nav widget for the PERPSPAD/WSOL DAMM v2 pool. It does three things:
//   - Zap in: one atomic tx that wraps SOL, swaps + splits it, and deposits both
//     sides as LP (a new position NFT). The user signs once and the whole thing
//     lands or nothing does (no stranded WSOL, no orphan position).
//   - Show current LP: the user's removable positions in the pool with the
//     PERPSPAD + SOL each would return on withdrawal.
//   - Unzap: remove all liquidity from a position, claim fees, close it, and
//     unwrap the WSOL back to native SOL — one tx per position.
//
// Zapping "more" simply creates another position (Meteora's zap always mints a
// fresh position NFT); the dialog aggregates value across every position.
// No server secrets involved — the browser wallet signs everything.
import { useState } from "react";
import { Zap as ZapIcon, ZapOff as ZapOffIcon, Loader2, ExternalLink, Coins } from "lucide-react";
import BN from "bn.js";
import { useConnection, useWallet as useAdapterWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import {
  buildPerpspadZap,
  buildUnzapTx,
  buildClaimFeesTx,
  fetchPerpspadPositions,
  type PerpspadPosition,
  PERPSPAD_MINT,
  PERPSPAD_WSOL_POOL,
} from "@/lib/meteora/zap";

const fmt = (n: number, max = 6) => n.toLocaleString(undefined, { maximumFractionDigits: max });
const fmtPerpspad = (bn: BN) => fmt(Number(bn.toString()) / 1e6, 2);
const fmtSol = (bn: BN) => fmt(Number(bn.toString()) / 1e9, 6);

// Verified floor: zap-sdk builds OK for any SOL ≥ 0.005 against the live pool,
// but the create-position tx + zap bundle cost ~0.01-0.05 SOL in rent + fees,
// so a smaller input barely adds liquidity and is dominated by overhead. 0.01
// SOL keeps the input meaningful while staying well above the SDK's price-impact
// rounding (which fires below one whole input token — see zap.ts UNIT_SOL).
const MIN_ZAP_SOL = 0.01;

type Phase = "idle" | "building" | "zapping" | "done";

export function ZapButton() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useAdapterWallet();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("0.1");
  const sol = parseFloat(amount) || 0;
  const belowFloor = !!publicKey && sol > 0 && sol < MIN_ZAP_SOL;
  const [slippageBps, setSlippageBps] = useState(300);
  const [phase, setPhase] = useState<Phase>("idle");
  const [zapSig, setZapSig] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // position pubkey (base58) currently being unzapped / claimed, if any
  const [unzapping, setUnzapping] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);

  const busy = phase === "building" || phase === "zapping";

  const positionsQuery = useQuery({
    queryKey: ["perpspad-positions", publicKey?.toBase58() ?? null],
    enabled: open && !!publicKey,
    queryFn: () => fetchPerpspadPositions({ connection, user: publicKey! }),
    staleTime: 15_000,
  });
  const positions = positionsQuery.data;
  const hasPositions = !!positions && positions.positions.length > 0;

  async function handleZap() {
    setErr(null);
    setZapSig(null);
    if (!publicKey || !signTransaction) {
      setErr("Connect a Solana wallet first.");
      return;
    }
    const sol = parseFloat(amount);
    if (!sol || sol <= 0) {
      setErr("Enter a SOL amount to zap.");
      return;
    }
    if (sol < MIN_ZAP_SOL) {
      setErr(
        `Minimum is ${MIN_ZAP_SOL} SOL. Smaller amounts are dominated by tx + rent overhead and wouldn't add meaningful liquidity.`,
      );
      return;
    }
    const amountLamports = new BN(Math.floor(sol * 1_000_000_000));
    setPhase("building");

    try {
      const built = await buildPerpspadZap({
        connection,
        user: publicKey,
        amountLamports,
        slippageBps,
      });

      // One atomic transaction with two signers. Phantom's Lighthouse flags
      // multi-signer txs unless the WALLET signs first and additional keypairs
      // partial-sign after — so: stamp blockhash/feePayer, wallet-sign, THEN the
      // position-NFT keypair partial-signs, then send + confirm.
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = built.transaction;
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      setPhase("zapping");
      const signed = await signTransaction(tx);
      signed.partialSign(built.positionNftKeypair);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      setZapSig(txid);
      await connection.confirmTransaction(
        { signature: txid, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      setPhase("done");
      toast.success(`Zapped ${fmt(sol)} SOL into PERPSPAD/WSOL LP.`);
      void positionsQuery.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Zap failed";
      setErr(msg);
      toast.error(msg);
      setPhase("idle");
    }
  }

  async function handleUnzap(pos: PerpspadPosition) {
    setErr(null);
    if (!publicKey || !signTransaction) {
      setErr("Connect a Solana wallet first.");
      return;
    }
    setUnzapping(pos.position.toBase58());
    try {
      const tx = await buildUnzapTx({
        connection,
        user: publicKey,
        position: pos.position,
        positionNftAccount: pos.positionNftAccount,
        positionState: pos.positionState,
        slippageBps,
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(
        { signature: txid, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      toast.success("Unzapped — liquidity withdrawn to your wallet as SOL + PERPSPAD.");
      void positionsQuery.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unzap failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setUnzapping(null);
    }
  }

  async function handleClaim(pos: PerpspadPosition) {
    setErr(null);
    if (!publicKey || !signTransaction) {
      setErr("Connect a Solana wallet first.");
      return;
    }
    setClaiming(pos.position.toBase58());
    try {
      const tx = await buildClaimFeesTx({
        connection,
        user: publicKey,
        position: pos.position,
        positionNftAccount: pos.positionNftAccount,
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const txid = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(
        { signature: txid, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      toast.success("Fees claimed to your wallet — your position stays open.");
      void positionsQuery.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Claim failed";
      setErr(msg);
      toast.error(msg);
    } finally {
      setClaiming(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPhase("idle");
          setErr(null);
          setZapSig(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          className="zap-shimmer flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-primary transition-colors hover:bg-primary/20"
          title="Zap SOL into the PERPSPAD/WSOL liquidity pool"
        >
          <ZapIcon className="h-3.5 w-3.5" />
          Zap LP
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ZapIcon className="h-4 w-4 text-primary" />
            PERPSPAD / SOL liquidity
          </DialogTitle>
          <DialogDescription>
            Put in SOL and it's added to the PERPSPAD/SOL pool for you — no need to balance the two
            tokens yourself. You earn a share of the pool's trading fees, and you can pull your
            money back out (as SOL + PERPSPAD) whenever you want.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Current position(s) */}
          {publicKey && positionsQuery.isLoading && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 p-3 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your position…
            </div>
          )}

          {hasPositions && (
            <div className="space-y-2 rounded-md border border-primary/30 bg-primary/[0.06] p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                  Your LP position
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {positions!.positions.length} position
                  {positions!.positions.length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[13px] tabular-nums">
                <div>
                  <div className="text-lg font-semibold">
                    {fmtPerpspad(positions!.totalPerpspad)}
                  </div>
                  <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    PERPSPAD
                  </div>
                </div>
                <div>
                  <div className="text-lg font-semibold">{fmtSol(positions!.totalSol)}</div>
                  <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    SOL
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-primary/15 pt-2 text-[11px]">
                <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Fees earned
                </span>
                <span className="font-mono tabular-nums text-primary">
                  {fmtPerpspad(positions!.totalFeePerpspad)} PERPSPAD +{" "}
                  {fmtSol(positions!.totalFeeSol)} SOL
                </span>
              </div>
              <p className="text-[9px] leading-tight text-muted-foreground">
                Claim your fees any time (position stays open), or unzap to withdraw everything —
                fees included.
              </p>

              <div className="space-y-1.5 pt-1">
                {positions!.positions.map((pos) => {
                  const key = pos.position.toBase58();
                  const isUnzapping = unzapping === key;
                  const isClaiming = claiming === key;
                  const rowBusy = !!unzapping || !!claiming;
                  const hasFees = pos.feePerpspad.gtn(0) || pos.feeSol.gtn(0);
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2 rounded border border-border/70 bg-background/40 px-2 py-1.5"
                    >
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {fmtPerpspad(pos.amountPerpspad)} PERPSPAD + {fmtSol(pos.amountSol)} SOL
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2 text-[10px]"
                          disabled={rowBusy || !hasFees}
                          title={hasFees ? "Claim fees, keep position" : "No fees to claim yet"}
                          onClick={() => handleClaim(pos)}
                        >
                          {isClaiming ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Coins className="h-3 w-3" />
                          )}
                          {isClaiming ? "Claiming…" : "Claim"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 px-2 text-[10px]"
                          disabled={rowBusy}
                          onClick={() => handleUnzap(pos)}
                        >
                          {isUnzapping ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ZapOffIcon className="h-3 w-3" />
                          )}
                          {isUnzapping ? "Unzapping…" : "Unzap"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Zap-in form */}
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {hasPositions ? "Zap in more SOL" : "SOL to zap"}
            </label>
            <input
              type="number"
              min={MIN_ZAP_SOL}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              className="w-full rounded-md border border-border bg-secondary/40 px-3 py-2 text-base tabular-nums outline-none focus:border-primary"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Slippage
            </label>
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={slippageBps / 100}
              onChange={(e) =>
                setSlippageBps(Math.max(10, Math.round((Number(e.target.value) || 3) * 100)))
              }
              disabled={busy}
              className="w-20 rounded-md border border-border bg-secondary/40 px-2 py-1 text-xs tabular-nums outline-none"
            />
            <span className="font-mono text-[10px] text-muted-foreground">%</span>
          </div>

          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {err}
            </div>
          )}

          {zapSig && (
            <div className="rounded-md border border-border bg-secondary/40 p-2 text-[11px]">
              <span className="font-mono uppercase tracking-wider text-muted-foreground">
                Zap tx:{" "}
              </span>
              <a
                href={`https://solscan.io/tx/${zapSig}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {zapSig.slice(0, 10)}… <ExternalLink className="inline h-3 w-3" />
              </a>
            </div>
          )}

          <div className="text-[10px] text-muted-foreground">
            Pool <code className="font-mono">{PERPSPAD_WSOL_POOL.slice(0, 8)}…</code> · Mint{" "}
            <code className="font-mono">{PERPSPAD_MINT.slice(0, 8)}…</code>
          </div>

          {phase === "done" ? (
            <Button className="w-full" variant="outline" onClick={() => setPhase("idle")}>
              Zap again
            </Button>
          ) : !publicKey ? (
            <div className="flex justify-center pt-1">
              <ConnectWalletButton />
            </div>
          ) : (
            <Button
              className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={busy || belowFloor || !!unzapping || !!claiming}
              onClick={handleZap}
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {phase === "building" ? "Building…" : "Zapping…"}
                </>
              ) : belowFloor ? (
                `Min ${MIN_ZAP_SOL} SOL`
              ) : (
                <>
                  <ZapIcon className="h-4 w-4" />
                  {hasPositions ? "Zap in more" : `Zap ${amount || "0"} SOL`}
                </>
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
