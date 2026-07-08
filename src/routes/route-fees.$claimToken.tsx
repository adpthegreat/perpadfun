import { createFileRoute, Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
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
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Flame, LineChart, Link2, RefreshCw, Wallet, X } from "lucide-react";

export const Route = createFileRoute("/route-fees/$claimToken")({
  component: RouterDashboard,
  validateSearch: (raw: Record<string, unknown>) => ({
    // `?linked=1` is set by the route-fees start page after a successful link
    // to render a persistent success banner that survives longer than the
    // sonner toast (which dies on the client-side navigation).
    linked: raw.linked === 1 || raw.linked === "1" || raw.linked === true ? true : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Router dashboard. perpspad" },
      { name: "robots", content: "noindex,nofollow" },
      {
        name: "description",
        content: "Live status for your perpspad fee router: balance, sweeps, perp PnL, and burns.",
      },
    ],
  }),
});

function RouterDashboard() {
  const { claimToken } = useParams({ from: "/route-fees/$claimToken" });
  const search = useSearch({ from: "/route-fees/$claimToken" });
  const navigate = useNavigate();
  const fetchFn = useServerFn(getRouterDashboard);
  const q = useQuery({
    queryKey: ["router-dashboard", claimToken],
    queryFn: () => fetchFn({ data: { claimToken } }),
    refetchInterval: 15_000,
  });

  // Reflects whether we just arrived here via a successful link. Persistent
  // until the user dismisses it or clicks the "Got it" button.
  const [linkedDismissed, setLinkedDismissed] = useState(false);
  const showLinkedBanner = search.linked === true && !linkedDismissed;
  function dismissLinked() {
    setLinkedDismissed(true);
    // Also strip the query param so a refresh doesn't re-open the banner.
    navigate({
      to: "/route-fees/$claimToken",
      params: { claimToken },
      search: {},
      replace: true,
    });
  }

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
          <Dashboard
            data={q.data}
            onRefresh={() => q.refetch()}
            refreshing={q.isFetching}
            copy={copy}
            claimToken={claimToken}
            showLinkedBanner={showLinkedBanner}
            onDismissLinked={dismissLinked}
          />
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
  showLinkedBanner,
  onDismissLinked,
}: {
  data: Extract<Awaited<ReturnType<typeof getRouterDashboard>>, { ok: true }>;
  onRefresh: () => void;
  refreshing: boolean;
  copy: (t: string, l: string) => void;
  claimToken: string;
  showLinkedBanner: boolean;
  onDismissLinked: () => void;
}) {
  const { router, balance, totals, events } = data;
  // "Awaiting first sweep" until first_fee_routed_at is populated by the keeper.
  // Until then the token is filtered out of the market feed (tokens.functions.ts
  // partial-visibility query), so we explain that here rather than let the user
  // think the link is broken.
  const awaitingFirstSweep = !router.mintPending && !router.firstFeeRoutedAt;
  const isLive = !!router.firstFeeRoutedAt;

  return (
    <div className="space-y-6">
      {showLinkedBanner ? (
        <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <div className="flex-1">
              <div className="text-base font-semibold text-emerald-300">
                Router linked. Your token is set up.
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Fees will auto-route to the sub-wallet below the moment pump.fun forwards them.
                Bookmark this page — it's your live status.
              </p>
            </div>
            <button
              onClick={onDismissLinked}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Dismiss"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Concrete artifacts — the user's real question is "where is my token?" */}
          <div className="mt-4 space-y-2 rounded-xl border border-emerald-500/20 bg-background/40 p-3">
            {router.externalMint ? (
              <ReceiptRow
                label="Your token mint"
                value={router.externalMint}
                onCopy={() => copy(router.externalMint as string, "Mint")}
                openHref={`https://solscan.io/token/${router.externalMint}`}
              />
            ) : null}
            <ReceiptRow
              label="Public token page"
              value={`${typeof window !== "undefined" ? window.location.origin : ""}/token/${router.id}`}
              onCopy={() =>
                copy(
                  `${typeof window !== "undefined" ? window.location.origin : ""}/token/${router.id}`,
                  "URL",
                )
              }
              openTo={{ to: "/token/$id", params: { id: router.id } }}
            />
          </div>

          {awaitingFirstSweep ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Note: your token appears on the market feed after the first fee is routed. See the
              amber card below for the current status.
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <Link to="/token/$id" params={{ id: router.id }}>
                Open token page
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button size="sm" variant="outline" onClick={onDismissLinked}>
              Got it
            </Button>
          </div>
        </div>
      ) : null}

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

      {awaitingFirstSweep ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <RefreshCw className="h-4 w-4" />
            Awaiting first sweep
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Your token will appear on the perpspad market feed after the first fee is routed. The
            keeper checks this sub-wallet every few seconds and sweeps once it holds at least
            0.01 SOL — enough to cover the buyback + burn tx fees.
          </p>
          <div className="mt-3 text-xs text-muted-foreground">
            Current balance:{" "}
            <span className="font-mono text-foreground">{balance.sol.toFixed(4)} SOL</span> · Last
            checked {refreshing ? "just now" : "recently"} (auto-refreshes every 15s)
          </div>
        </div>
      ) : isLive ? (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <div className="flex-1 text-emerald-200">
            Fee routing verified — first sweep landed{" "}
            <span className="font-mono text-muted-foreground">
              {new Date(router.firstFeeRoutedAt as string).toLocaleString()}
            </span>
            . Your token is on the market feed.
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/token/$id" params={{ id: router.id }}>
              View public page
              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      ) : null}

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

// Compact address/URL row used inside the success banner. Same shape as `Row`
// but denser and with an optional in-app "open" affordance so the user can
// tap through to the token page without hunting for a button.
function ReceiptRow({
  label,
  value,
  onCopy,
  openHref,
  openTo,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  openHref?: string;
  openTo?: { to: string; params: Record<string, string> };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-[11px] font-mono">
        {value}
      </code>
      <Button size="sm" variant="outline" onClick={onCopy}>
        <Copy className="h-3 w-3" />
      </Button>
      {openHref ? (
        <Button size="sm" variant="outline" asChild>
          <a href={openHref} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      ) : null}
      {openTo ? (
        <Button size="sm" variant="outline" asChild>
          {/* @ts-expect-error — dynamic route param type is fine at runtime */}
          <Link to={openTo.to} params={openTo.params}>
            <ExternalLink className="h-3 w-3" />
          </Link>
        </Button>
      ) : null}
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

