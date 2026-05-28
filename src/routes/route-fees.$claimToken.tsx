import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getRouterDashboard } from "@/lib/route-fees-dashboard.functions";
import { linkMintToRouter } from "@/lib/external-router.functions";
import { toast } from "sonner";
import { ArrowLeft, Copy, ExternalLink, Flame, LineChart, Link2, RefreshCw, Wallet } from "lucide-react";

export const Route = createFileRoute("/route-fees/$claimToken")({
  component: RouterDashboard,
  head: () => ({
    meta: [
      { title: "Router dashboard. perpad" },
      { name: "robots", content: "noindex,nofollow" },
      {
        name: "description",
        content: "Live status for your perpad fee router: balance, sweeps, perp PnL, and burns.",
      },
    ],
  }),
});

function RouterDashboard() {
  const { claimToken } = useParams({ from: "/route-fees/$claimToken" });
  const fetchFn = useServerFn(getRouterDashboard);
  const q = useQuery({
    queryKey: ["router-dashboard", claimToken],
    queryFn: () => fetchFn({ data: { claimToken } }),
    refetchInterval: 15_000,
  });

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="container mx-auto max-w-4xl px-4 py-10">
        <div className="mb-6">
          <Link to="/route-fees" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-3 w-3" /> Create another router
          </Link>
        </div>

        {q.isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Loading router.
          </div>
        ) : !q.data?.ok ? (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-6">
            <h1 className="text-lg font-semibold">Router not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {q.data?.error ?? "Double-check the claim token in your URL."}
            </p>
          </div>
        ) : (
          <Dashboard data={q.data} onRefresh={() => q.refetch()} refreshing={q.isFetching} copy={copy} claimToken={claimToken} />
        )}
      </main>
    </div>
  );
}

function Dashboard({
  data,
  onRefresh,
  refreshing,
  copy,
  claimToken,
}: {
  data: Extract<Awaited<ReturnType<typeof getRouterDashboard>>, { ok: true }>;
  onRefresh: () => void;
  refreshing: boolean;
  copy: (t: string, l: string) => void;
  claimToken: string;
}) {
  const { router, balance, totals, events } = data;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {router.externalPlatform ?? "external"} router
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{router.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Backing {router.direction?.toUpperCase()} {router.leverage}x {router.underlying} perp.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {!router.mintPending ? (
              <Button size="sm" asChild>
                <Link to="/token/$id" params={{ id: router.id }}>
                  Public page
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Row
            label="Token mint"
            value={router.externalMint ?? "— pending link —"}
            onCopy={() => router.externalMint && copy(router.externalMint, "Mint")}
          />
          <Row label="Sub-wallet" value={router.address ?? ""} onCopy={() => copy(router.address ?? "", "Address")}
            link={router.address ? `https://solscan.io/account/${router.address}` : undefined} />
        </div>
      </div>

      {router.mintPending ? <LinkMintCard claimToken={claimToken} onLinked={onRefresh} /> : null}


      <div className="grid gap-4 sm:grid-cols-4">
        <Stat icon={<Wallet className="h-4 w-4" />} label="Live balance" value={`${balance.sol.toFixed(4)} SOL`} hint={balance.error ?? "On-chain"} />
        <Stat icon={<LineChart className="h-4 w-4" />} label="Into perp" value={`${totals.perpSol.toFixed(4)} SOL`} hint="50% leg, cumulative" />
        <Stat icon={<Flame className="h-4 w-4" />} label="Buyback + burn" value={`${totals.buybackSol.toFixed(4)} SOL`} hint={`${totals.tokensBurned.toLocaleString()} tokens burned`} />
        <Stat icon={<Wallet className="h-4 w-4" />} label="To treasury" value={`${totals.treasurySol.toFixed(4)} SOL`} hint="25% leg, cumulative" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Recent activity</h2>
          <span className="text-xs text-muted-foreground">{events.length} event{events.length === 1 ? "" : "s"}</span>
        </div>
        {events.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No sweeps yet. The keeper picks up fees automatically once the sub-wallet holds 0.01 SOL or more.
          </p>
        ) : (
          <div className="mt-4 divide-y divide-border">
            {events.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <KindBadge kind={e.kind} />
                  <div>
                    <div className="font-mono text-xs">
                      {e.solAmount > 0 ? `${e.solAmount.toFixed(4)} SOL` : null}
                      {e.tokensAmount > 0 ? ` ${e.tokensAmount.toLocaleString()} tokens` : null}
                      {e.pnlDeltaUsd != null ? ` ${e.pnlDeltaUsd >= 0 ? "+" : ""}${e.pnlDeltaUsd.toFixed(2)} USD` : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</div>
                  </div>
                </div>
                {e.txSig ? (
                  <a
                    href={`https://solscan.io/tx/${e.txSig}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
                  >
                    tx <ExternalLink className="ml-1 h-3 w-3" />
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/5 p-5">
        <Label className="text-yellow-300">Your dashboard URL</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Bookmark this. Anyone with the URL can view (read-only) router activity.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-background px-3 py-2 text-xs font-mono">
            /route-fees/{claimToken}
          </code>
          <Button size="sm" variant="outline" onClick={() => copy(window.location.href, "URL")}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, onCopy, link }: { label: string; value: string; onCopy: () => void; link?: string }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-background px-3 py-2 text-xs font-mono">{value}</code>
        <Button size="sm" variant="outline" onClick={onCopy}>
          <Copy className="h-3 w-3" />
        </Button>
        {link ? (
          <Button size="sm" variant="outline" asChild>
            <a href={link} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" /></a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-2 font-mono text-lg tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    external_perp: { label: "PERP", cls: "border-blue-500/40 text-blue-300 bg-blue-500/5" },
    external_buyback: { label: "BURN", cls: "border-orange-500/40 text-orange-300 bg-orange-500/5" },
    external_split_treasury: { label: "TREASURY", cls: "border-emerald-500/40 text-emerald-300 bg-emerald-500/5" },
  };
  const m = map[kind] ?? { label: kind.toUpperCase(), cls: "border-border text-muted-foreground" };
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] font-mono tracking-wider ${m.cls}`}>{m.label}</span>;
}

function LinkMintCard({ claimToken, onLinked }: { claimToken: string; onLinked: () => void }) {
  const linkFn = useServerFn(linkMintToRouter);
  const [mint, setMint] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await linkFn({ data: { claimToken, externalMint: mint.trim() } });
      if (!r.ok) {
        toast.error(r.error ?? "Failed to link mint");
        return;
      }
      toast.success("Mint linked. Buyback + burn now active.");
      setMint("");
      onLinked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-primary/40 bg-primary/5 p-6 space-y-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <Link2 className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Link your pump.fun mint</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your sub-wallet is collecting SOL already. Paste the mint address pump.fun gave you at
            launch to switch on the buyback + burn leg.
          </p>
        </div>
      </div>
      <div>
        <Label htmlFor="link-mint">Token mint address</Label>
        <Input
          id="link-mint"
          required
          placeholder="e.g. 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          className="font-mono text-xs"
        />
      </div>
      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Linking…" : "Link mint"}
      </Button>
    </form>
  );
}

