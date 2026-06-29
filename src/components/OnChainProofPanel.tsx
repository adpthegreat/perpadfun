import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTreasury } from "@/lib/treasury.functions";
import { useState } from "react";
import { Copy, Check } from "lucide-react";

function shorten(s: string, head = 6, tail = 6) {
  if (!s || s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function AddrRow({
  label,
  address,
  hint,
  // For the Imperial profile / position-owner row we link to the venue's live
  // position view (imperial.space for Imperial, jup.ag/portfolio for legacy
  // Jupiter) rather than solscan, since that shows collateral/size/PnL/mark.
  // `linkAddress` lets the link target differ from the displayed address —
  // Imperial profiles are keyed by the owner wallet, not the collateral PDA.
  linkVariant = "solscan",
  linkAddress,
}: {
  label: string;
  address: string | null | undefined;
  hint?: string;
  linkVariant?: "solscan" | "jup-portfolio" | "imperial";
  linkAddress?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!address) {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
          {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
        </div>
        <span className="font-mono text-[11px] text-muted-foreground/60">not yet assigned</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-foreground" title={address}>
          {shorten(address)}
        </span>
        <button
          type="button"
          aria-label={`copy ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="rounded border border-border/60 p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
        <a
          href={
            linkVariant === "imperial"
              ? `https://www.imperial.space/profile/${linkAddress ?? address}`
              : linkVariant === "jup-portfolio"
                ? `https://jup.ag/portfolio/${linkAddress ?? address}`
                : `https://solscan.io/account/${linkAddress ?? address}`
          }
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary underline underline-offset-2 hover:opacity-80"
        >
          {linkVariant === "imperial"
            ? "view position ↗"
            : linkVariant === "jup-portfolio"
              ? "jup.ag/portfolio ↗"
              : "solscan ↗"}
        </a>
      </div>
    </div>
  );
}

export function OnChainProofPanel({
  tokenId,
  ticker,
  mintAddress,
  subWallet,
}: {
  tokenId: string;
  ticker: string;
  mintAddress: string | null | undefined;
  subWallet: string | null | undefined;
}) {
  const fn = useServerFn(getTreasury);
  // Reuses the same queryKey as TreasuryPanel so the second fetch is deduped.
  const q = useQuery({
    queryKey: ["treasury", tokenId],
    queryFn: () => fn({ data: { tokenId } }),
    refetchInterval: 30000,
  });

  const state = q.data?.state;
  const events = q.data?.events ?? [];
  const treasuryPubkey = q.data?.treasuryPubkey ?? subWallet ?? null;
  const imperialPda = state?.imperialProfilePda ?? null;
  const router = state?.router ?? "jupiter";

  // Pull every event with a tx signature, most recent first, cap at 15.
  const verifiableTxs = events
    .filter((e) => !!e.txSig)
    .slice(0, 15);

  return (
    <div className="border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Verify on-chain</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Don&apos;t trust this dashboard. Every address and transaction below is on Solana. Copy any of them
            into solscan, Phantom, or your own RPC and confirm the numbers match.
          </div>
        </div>
      </div>

      <div className="mt-4 border border-border/60 bg-secondary/20">
        <AddrRow label={`$${ticker} mint`} address={mintAddress} hint="The SPL token contract." />
        <AddrRow
          label="Hedge sub-wallet"
          address={treasuryPubkey}
          hint="Receives all fees. Funds every deposit into the perp profile."
        />
        <AddrRow
          label={router === "imperial" ? "Imperial profile (collateral)" : "Position owner"}
          address={imperialPda}
          hint={
            router === "imperial"
              ? "PDA that holds the live perp collateral on Imperial."
              : "Wallet that owns the Jupiter perp position NFT."
          }
          linkVariant={router === "imperial" ? "imperial" : "jup-portfolio"}
          linkAddress={router === "imperial" ? treasuryPubkey : undefined}
        />
      </div>

    </div>
  );
}
