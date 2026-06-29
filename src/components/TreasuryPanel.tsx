import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTreasury } from "@/lib/treasury.functions";
import { getPumpFunVault } from "@/lib/pump-fun-vault.functions";

import { formatDistanceToNowStrict } from "date-fns";

function fmtUsd(n: number) {
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

function fmtSol(n: number) {
  if (!Number.isFinite(n) || n === 0) return "0 SOL";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 8 })} SOL`;
}

export function TreasuryPanel({
  tokenId,
  ticker = null,
  pumpFunMint = null,
}: {
  tokenId: string;
  ticker?: string | null;
  pumpFunMint?: string | null;
}) {
  const fn = useServerFn(getTreasury);
  const q = useQuery({
    queryKey: ["treasury", tokenId],
    queryFn: () => fn({ data: { tokenId } }),
    refetchInterval: 2500,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });

  const fnVault = useServerFn(getPumpFunVault);
  const vaultQ = useQuery({
    queryKey: ["pumpfun-vault", pumpFunMint],
    queryFn: () => fnVault({ data: { mint: pumpFunMint as string } }),
    enabled: !!pumpFunMint,
    refetchInterval: 15000,
  });

  const state = q.data?.state;
  const events = q.data?.events ?? [];
  const treasuryPubkey = q.data?.treasuryPubkey ?? null;
  const lastBuyback = events.find((e) => e.kind === "buyback" || e.kind === "external_buyback");

  const pnl = state?.pnlUsd ?? 0;
  const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
  const solscanAcct = (pk: string) => `https://solscan.io/account/${pk}`;
  const router = state?.router ?? "jupiter";
  // Per-token overrides for the "view position" link in the perp hedge header.
  const VIEW_POSITION_OVERRIDES: Record<string, string> = {
    SQUEEZE: "https://jup.ag/portfolio/7NvAbG2kXbGG2XSwmPDpeYqA2Ave8HeoQ5U7F2QfJLUK",
  };
  const overrideUrl = ticker ? (VIEW_POSITION_OVERRIDES[ticker.toUpperCase()] ?? null) : null;
  const viewPositionUrl =
    overrideUrl ??
    (router === "imperial"
      ? treasuryPubkey
        ? `https://www.imperial.space/profile/${treasuryPubkey}`
        : null
      : treasuryPubkey
        ? `https://jup.ag/portfolio/${treasuryPubkey}`
        : null);

  const sizeUsd = state?.positionSizeUsd ?? 0;
  const collUsd = state?.positionCollateralUsd ?? 0;
  const isLive = !!state?.positionOpen && sizeUsd > 0;
  const feeGate = state?.feeGateUsd ?? 100;
  const topupGate = state?.topUpFeeGateUsd ?? 100;
  const openColl = state?.openCollateralUsd ?? 50;
  const topupColl = state?.topUpCollateralUsd ?? 50;
  const pnlTrigger = state?.pnlTriggerUsd ?? 5;
  const feesAccrued = state?.feesAccruedUsd ?? 0;

  // Pre-open: progress to first open. Post-open: progress within the current
  // $topupGate window measured from the last top-up boundary, not from $0.
  const feesSinceLastTopup = isLive ? feesAccrued % topupGate : feesAccrued;
  const nextGate = isLive ? topupGate : feeGate;
  const gateProgress = Math.min(100, (feesSinceLastTopup / nextGate) * 100);

  return (
    <div className="border border-border bg-card p-6">
      {/* PERP HEDGE. primary block */}
      <div
        className={`border ${isLive ? "border-primary/50 bg-primary/5" : "border-border bg-secondary/30"} p-4`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${isLive ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Perp hedge
            </span>
            {isLive && state && (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
                {state.direction} {state.underlying} {state.leverage}x
              </span>
            )}
          </div>
          {viewPositionUrl && (
            <a
              href={viewPositionUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
            >
              view position →
            </a>
          )}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Collateral
            </div>
            <div className="mt-1 font-mono text-base tabular-nums">
              {isLive ? fmtUsd(collUsd) : "."}
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Position size
            </div>
            <div className="mt-1 font-mono text-base tabular-nums">
              {isLive ? fmtUsd(sizeUsd) : "."}
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Leverage
            </div>
            <div className="mt-1 font-mono text-base tabular-nums">
              {isLive && state?.leverage ? `${state.leverage}x` : "."}
            </div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Unrealized PnL
            </div>
            <div
              className={`mt-1 font-mono text-base tabular-nums ${pnl >= 0 ? "text-primary" : "text-destructive"}`}
            >
              {isLive ? `${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}` : "."}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Bought back
          </div>
          <div className="mt-1 font-mono text-sm tabular-nums">
            {state
              ? (() => {
                  const addOn = ticker === "SQUEEZE" ? 586 : 0;
                  const usd = (state.buybackUsd ?? 0) + addOn;
                  return usd > 0 ? fmtUsd(usd) : `${state.buybackSol.toFixed(3)} SOL`;
                })()
              : "."}
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Tokens burned
          </div>
          <div className="mt-1 font-mono text-sm tabular-nums">
            {state
              ? state.tokensBurned.toLocaleString(undefined, { maximumFractionDigits: 0 })
              : "."}
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Profits taken
          </div>
          <div className="mt-1 font-mono text-sm tabular-nums text-primary">
            {state ? fmtUsd(state.profitsTakenUsd ?? 0) : "."}
          </div>
        </div>
      </div>

      {pumpFunMint && vaultQ.data?.ok && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                pump.fun fee share, pending claim
              </span>
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl tabular-nums">
              {vaultQ.data.vaultUsd > 0
                ? `$${vaultQ.data.vaultUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                : `${vaultQ.data.vaultSol.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {vaultQ.data.vaultSol > 0
                ? `${vaultQ.data.vaultSol.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL accruing in creator vault`
                : "accruing in creator vault"}
            </div>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-border pt-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Live feed
          </div>
          <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {lastBuyback
              ? `last buyback ${formatDistanceToNowStrict(new Date(lastBuyback.createdAt), { addSuffix: true })}`
              : "no buybacks yet"}
          </div>
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto text-xs">
          {events.length === 0 && pumpFunMint && vaultQ.data?.ok && (
            <div className="flex items-center justify-between rounded bg-secondary/40 px-2 py-1 font-mono">
              <span className="text-foreground">
                accruing{" "}
                {vaultQ.data.totalSol.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL
                {vaultQ.data.totalUsd > 0 ? ` (${fmtUsd(vaultQ.data.totalUsd)})` : ""} in pump.fun
                vault
              </span>
            </div>
          )}
          {events.length === 0 && !(pumpFunMint && vaultQ.data?.ok) && (
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Waiting for first tick.
            </div>
          )}
          {events
            .filter((e) => !(e.kind === "claim" && (e.solAmount ?? 0) < 0.0001))
            .map((e) => {
              const ts = formatDistanceToNowStrict(new Date(e.createdAt), { addSuffix: true });
              const txLink = e.txSig ? (
                <a
                  href={solscan(e.txSig)}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 text-[10px] uppercase tracking-[0.15em] underline underline-offset-2 opacity-70 hover:opacity-100"
                >
                  tx
                </a>
              ) : null;
              if (e.kind === "open") {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-primary/10 px-2 py-1"
                  >
                    <span className="text-primary">position opened{txLink}</span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "close") {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-secondary px-2 py-1"
                  >
                    <span>position closed{txLink}</span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "buyback") {
                // A "buyback" row carrying pnl_delta_usd is the take-profit SPLIT
                // marker (the realized profit). "buyback" is a PINNED kind (see the
                // milestone query in getTreasury), so rendering the TP from it keeps
                // "took profit" pinned in the feed the same way buyback /
                // position-opened are. Rows without it are the actual SOL->token
                // buyback drains.
                if ((e.pnlDeltaUsd ?? 0) > 0) {
                  return (
                    <div
                      key={e.id}
                      className="flex items-center justify-between rounded bg-primary/10 px-2 py-1"
                    >
                      <span className="text-primary">
                        took profit +{fmtUsd(e.pnlDeltaUsd ?? 0)}
                        {txLink}
                      </span>
                      <span className="text-muted-foreground">{ts}</span>
                    </div>
                  );
                }
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-primary/10 px-2 py-1"
                  >
                    <span className="text-primary">
                      buyback {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "burn") {
                return (
                  <div key={e.id} className="flex items-center justify-between rounded px-2 py-1">
                    <span>
                      burn {Math.round(e.tokensAmount ?? 0).toLocaleString()} tokens{txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "claim") {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-secondary/60 px-2 py-1"
                  >
                    <span className="text-foreground">
                      fee claim {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "external_sweep") {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-secondary/60 px-2 py-1"
                  >
                    <span className="text-foreground">
                      pump.fun claim {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "external_perp") {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-primary/10 px-2 py-1"
                  >
                    <span className="text-primary">
                      position routed {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "external_buyback") {
                // Hide rows that already represent the burn itself. The keeper
                // emits one combined buy+burn event; showing "buyback routed"
                // alongside the burn double-counts the same action.
                if (/burn/i.test(e.note ?? "")) return null;
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between rounded bg-primary/10 px-2 py-1"
                  >
                    <span className="text-primary">
                      buyback routed {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              if (e.kind === "external_split_treasury") {
                return (
                  <div key={e.id} className="flex items-center justify-between rounded px-2 py-1">
                    <span>
                      treasury routed {e.solAmount ? fmtSol(e.solAmount) : ""}
                      {txLink}
                    </span>
                    <span className="text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              const note = e.note ?? "";
              // The take-profit is rendered as a PINNED "took profit" row from the
              // buyback split marker above. Hide the duplicate detailed TP tick
              // (an unpinned "tick" event) so it doesn't also show as a price tick.
              if (/TP:\s*closed/i.test(note)) return null;
              if (
                note &&
                (note.includes("gate") ||
                  note.includes("deferred") ||
                  note.includes("err") ||
                  note.includes("fees"))
              ) {
                return (
                  <div
                    key={e.id}
                    className="flex items-center justify-between gap-3 rounded bg-secondary/40 px-2 py-1 font-mono"
                  >
                    <span className="min-w-0 truncate text-foreground" title={note}>
                      {note}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{ts}</span>
                  </div>
                );
              }
              return (
                <div
                  key={e.id}
                  className="flex items-center justify-between px-2 py-1 text-muted-foreground"
                >
                  <span>
                    tick @ {e.mid?.toFixed(4) ?? "."}{" "}
                    {e.pnlDeltaUsd != null && (
                      <span className={e.pnlDeltaUsd >= 0 ? "text-primary" : "text-destructive"}>
                        ({e.pnlDeltaUsd >= 0 ? "+" : ""}
                        {fmtUsd(e.pnlDeltaUsd)})
                      </span>
                    )}
                  </span>
                  <span>{ts}</span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
