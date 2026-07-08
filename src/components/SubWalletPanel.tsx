import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useWallet as useSolanaAdapterWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import {
  getSubWalletInfo,
  revealSubWalletKey,
  sweepSubWallet,
  topUpSubWallet,
} from "@/lib/sub-wallet.functions";
import { isAdminWallet } from "@/lib/admin";
import { toast } from "sonner";

function shortAddr(a: string, n = 6) {
  if (!a) return "";
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function SubWalletPanel({ tokenId }: { tokenId: string }) {
  const fnInfo = useServerFn(getSubWalletInfo);
  const fnReveal = useServerFn(revealSubWalletKey);
  const fnSweep = useServerFn(sweepSubWallet);
  const fnTopUp = useServerFn(topUpSubWallet);

  const { publicKey, signMessage } = useSolanaAdapterWallet();
  const isAdmin = isAdminWallet(publicKey?.toBase58());

  const q = useQuery({
    queryKey: ["sub-wallet", tokenId],
    queryFn: () => fnInfo({ data: { tokenId } }),
    refetchInterval: 15000,
  });

  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const address = q.data?.address ?? null;
  const solBalance = q.data?.solBalance ?? 0;

  async function signAdminMessage(action: string): Promise<{ message: string; signature: string } | null> {
    if (!signMessage) {
      toast.error("Wallet does not support signMessage");
      return null;
    }
    const message = `perpspad-admin:${action}:${tokenId}:ts:${Date.now()}`;
    const sigBytes = await signMessage(new TextEncoder().encode(message));
    return { message, signature: bs58.encode(sigBytes) };
  }

  async function handleReveal() {
    if (!isAdmin) return;
    setBusy("reveal");
    try {
      const signed = await signAdminMessage("reveal");
      if (!signed) return;
      const res = await fnReveal({ data: { tokenId, ...signed } });
      if (!res.ok) {
        toast.error(res.error ?? "Reveal failed");
        return;
      }
      setPrivateKey(res.privateKey);
      toast.success("Wallet secret revealed. Do not share.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reveal failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleSweep() {
    if (!isAdmin) return;
    if (!confirm("Sweep all SOL from sub-wallet back to master treasury?")) return;
    setBusy("sweep");
    try {
      const signed = await signAdminMessage("sweep");
      if (!signed) return;
      const res = await fnSweep({ data: { tokenId, ...signed } });
      if (!res.ok) {
        toast.error(res.error ?? "Sweep failed");
        return;
      }
      toast.success(`Swept. Tx: ${res.signature?.slice(0, 8)}…`);
      q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sweep failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleTopUp() {
    if (!isAdmin) return;
    setBusy("topup");
    try {
      const signed = await signAdminMessage("topup");
      if (!signed) return;
      const res = await fnTopUp({ data: { tokenId, ...signed } });
      if (!res.ok) {
        toast.error(res.error ?? "Top-up failed");
        return;
      }
      toast.success(res.signature ? `Topped up. Tx: ${res.signature.slice(0, 8)}…` : "Already funded");
      q.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Top-up failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Token sub-wallet
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {solBalance.toFixed(4)} SOL
        </span>
      </div>
      <div className="mt-3 break-all font-mono text-xs">
        {address ? (
          <a
            href={`https://solscan.io/account/${address}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {address}
          </a>
        ) : (
          <span className="text-muted-foreground">deriving…</span>
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Dedicated wallet for this token. Receives fees and holds the perp position.
        Derived deterministically on the server. No wallet credentials are stored client-side.
      </p>

      {isAdmin && (
        <div className="mt-4 border border-primary/40 bg-primary/5 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
            Admin controls
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={handleReveal}
              disabled={busy !== null}
              className="border border-foreground px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-foreground hover:text-background disabled:opacity-50"
            >
              {busy === "reveal" ? "…" : "Reveal key"}
            </button>
            <button
              onClick={handleTopUp}
              disabled={busy !== null}
              className="border border-foreground px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-foreground hover:text-background disabled:opacity-50"
            >
              {busy === "topup" ? "…" : "Top up gas"}
            </button>
            <button
              onClick={handleSweep}
              disabled={busy !== null}
              className="border border-destructive px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
            >
              {busy === "sweep" ? "…" : "Sweep to master"}
            </button>
          </div>
          {privateKey && (
            <div className="mt-3 border border-destructive bg-destructive/10 p-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
                Wallet secret (base58). Import into Phantom. Do not share.
              </div>
              <textarea
                readOnly
                value={privateKey}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-2 h-20 w-full resize-none bg-background p-2 font-mono text-[11px]"
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(privateKey);
                  toast.success("Copied");
                }}
                className="mt-2 border border-foreground px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-foreground hover:text-background"
              >
                Copy
              </button>
              <button
                onClick={() => setPrivateKey(null)}
                className="ml-2 border border-foreground px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] hover:bg-foreground hover:text-background"
              >
                Hide
              </button>
            </div>
          )}
        </div>
      )}

      {/* {!isAdmin && publicKey && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Connect an authorized admin wallet to manage.
        </p>
      )} */}
    </div>
  );
}
