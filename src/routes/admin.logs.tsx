import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { getWalletBalances } from "@/lib/wallet-balances.functions";
import {
  renderCell,
  RowDetail,
  StatusBadge,
  Stat,
  short,
  formatNum,
  relativeTime,
  classifyKeeperIssue,
  keeperIssueFromEvent,
  keeperIssueFromPendingTx,
  KeeperIssueGuide,
} from "@/components/admin-logs/cells";

export const Route = createFileRoute("/admin/logs")({
  component: AdminLogsPage,
  head: () => ({
    meta: [
      { title: "Debug logs · perpspad" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

type Tab = "keeper_issues" | "tx_log" | "treasury_events" | "tokens" | "summary";

function AdminLogsPage() {
  const [tab, setTab] = useState<Tab>("keeper_issues");
  const [tokenFilter, setTokenFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Token lookup map (ticker by id) shared across tabs
  const tokensIndex = useQuery({
    queryKey: ["admin-tokens-index"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tokens")
        .select(
          "id,ticker,name,router,status,migration_status,direction,leverage,underlying,treasury_sol,fees_accrued_usd,position_size_usd,position_collateral_usd,treasury_pnl_usd,buyback_reserve_usd,last_tick_at,last_fee_claim_at,treasury_wallet_address,imperial_profile_pda,mint_address,external_mint,dbc_pool_address",
        )
        .limit(1000);
      if (error) throw error;
      const map = new Map<string, any>();
      for (const t of data ?? []) map.set(t.id as string, t);
      return map;
    },
    staleTime: 30_000,
  });

  const query = useQuery({
    queryKey: ["admin-logs", tab, tokenFilter],
    queryFn: async () => {
      if (tab === "summary") return [];
      if (tab === "tokens") {
        const { data, error } = await supabase
          .from("tokens")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(500);
        if (error) throw error;
        return data ?? [];
      }
      if (tab === "keeper_issues") {
        const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const [eventsRes, pendingRes] = await Promise.all([
          supabase
            .from("treasury_events")
            .select("*")
            .gte("created_at", since)
            .or(
              "note.ilike.%backoff%,note.ilike.%parked%,note.ilike.%buyback drain err%,note.ilike.%imperial deposit err%,note.ilike.%top-up err%,note.ilike.%wallet capacity%,note.ilike.%below floor%,note.ilike.%fee claim error%,note.ilike.%insufficient lamports%",
            )
            .order("created_at", { ascending: false })
            .limit(300),
          supabase
            .from("tx_log")
            .select("*")
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(300),
        ]);
        if (eventsRes.error) throw eventsRes.error;
        if (pendingRes.error) throw pendingRes.error;
        const eventRows = (eventsRes.data ?? []).map((r: any) => keeperIssueFromEvent(r));
        const pendingRows = (pendingRes.data ?? []).map((r: any) => keeperIssueFromPendingTx(r));
        return [...eventRows, ...pendingRows].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
      }
      let q = supabase.from(tab).select("*").order("created_at", { ascending: false }).limit(1000);
      if (tokenFilter) q = q.eq("token_id", tokenFilter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 10000,
  });

  const rawRows = (query.data ?? []) as any[];
  const rows = useMemo(() => {
    if (!search) return rawRows;
    const s = search.toLowerCase();
    return rawRows.filter((r) =>
      Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(s)),
    );
  }, [rawRows, search]);

  const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];

  // Build summary rows from tokens index
  const summaryRows = useMemo(() => {
    if (tab !== "summary" || !tokensIndex.data) return [];
    return Array.from(tokensIndex.data.values());
  }, [tab, tokensIndex.data]);

  function downloadCsv() {
    const data = tab === "summary" ? summaryRows : rows;
    if (data.length === 0) return;
    const cols = Object.keys(data[0]);
    const csv = [
      cols.join(","),
      ...data.map((r: any) =>
        cols
          .map((c) => {
            const v = r[c];
            if (v == null) return "";
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return `"${s.replace(/"/g, '""')}"`;
          })
          .join(","),
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tab}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="w-full px-4 py-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h1 className="text-xl font-semibold mr-2">Debug (read-only)</h1>
          {(["keeper_issues", "tx_log", "treasury_events", "tokens", "summary"] as Tab[]).map((t) => (
            <Button
              key={t}
              size="sm"
              variant={tab === t ? "default" : "outline"}
              onClick={() => {
                setTab(t);
                setExpanded(null);
              }}
            >
              {t}
            </Button>
          ))}
          <input
            className="text-xs px-2 py-1 rounded border border-border bg-background w-[260px]"
            placeholder="filter by token_id (uuid)"
            value={tokenFilter}
            onChange={(e) => setTokenFilter(e.target.value.trim())}
          />
          {tokenFilter.length === 36 && (
            <Link
              to="/admin/logs/$tokenId"
              params={{ tokenId: tokenFilter }}
            >
              <Button size="sm" variant="outline">
                open
              </Button>
            </Link>
          )}
          <input
            className="text-xs px-2 py-1 rounded border border-border bg-background w-[220px]"
            placeholder="search any field..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            refresh
          </Button>
          <Button size="sm" variant="outline" onClick={downloadCsv}>
            export CSV
          </Button>
        </div>

        <div className="text-xs text-muted-foreground mb-2 flex flex-wrap gap-4">
          <span>
            {query.isLoading
              ? "loading..."
              : `${rows.length}${rawRows.length !== rows.length ? `/${rawRows.length}` : ""} rows`}
          </span>
          <span>auto-refresh 10s</span>
          <span>click row to expand. signatures and addresses link to Solscan.</span>
        </div>

        {tab === "keeper_issues" && <KeeperIssueGuide />}

        {tab === "summary" ? (
          <SummaryView rows={summaryRows} />
        ) : (
          <div className="overflow-auto border border-border rounded max-h-[calc(100vh-220px)]">
            <table className="text-xs w-max min-w-full">
              <thead className="bg-muted/60 sticky top-0 z-10">
                <tr>
                  <th className="w-6"></th>
                  {tab !== "tokens" && (
                    <th className="text-left px-2 py-1.5 font-mono">ticker</th>
                  )}
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="text-left px-2 py-1.5 font-mono whitespace-nowrap border-l border-border/40"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any, i) => {
                  const rowKey = row.id ?? `${i}`;
                  const isOpen = expanded === rowKey;
                  const tokenInfo =
                    tab !== "tokens" && row.token_id ? tokensIndex.data?.get(row.token_id) : null;
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className="border-t border-border hover:bg-muted/20 cursor-pointer"
                        onClick={() => setExpanded(isOpen ? null : rowKey)}
                      >
                        <td className="px-1 text-muted-foreground">{isOpen ? "▾" : "▸"}</td>
                        {tab !== "tokens" && (
                          <td className="px-2 py-1 font-mono text-primary whitespace-nowrap">
                            {row.token_id ? (
                              <Link
                                to="/admin/logs/$tokenId"
                                params={{ tokenId: String(row.token_id) }}
                                className="hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {tokenInfo?.ticker ?? "?"}
                              </Link>
                            ) : (
                              (tokenInfo?.ticker ?? "?")
                            )}
                          </td>
                        )}
                        {columns.map((c) => (
                          <td
                            key={c}
                            className="px-2 py-1 font-mono whitespace-nowrap border-l border-border/30"
                          >
                            {renderCell(c, row[c])}
                          </td>
                        ))}
                      </tr>
                      {isOpen && (
                        <tr className="bg-muted/10">
                          <td colSpan={columns.length + (tab !== "tokens" ? 2 : 1)} className="p-3">
                            <RowDetail row={row} tokenInfo={tokenInfo} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && !query.isLoading && (
                  <tr>
                    <td className="px-2 py-6 text-center text-muted-foreground" colSpan={columns.length + 2}>
                      no rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <DevNotes />
      </main>
    </div>
  );
}

function SummaryView({ rows }: { rows: any[] }) {
  const [showClosed, setShowClosed] = useState(false);

  // Live on-chain SOL + USDC for every sub-wallet (parked funds, gas runway).
  const addresses = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .map((r) => r.treasury_wallet_address)
            .filter((a): a is string => typeof a === "string" && a.length > 20),
        ),
      ),
    [rows],
  );
  const balances = useQuery({
    queryKey: ["admin-wallet-balances", addresses.join(",")],
    queryFn: () => getWalletBalances({ data: { addresses } }),
    enabled: addresses.length > 0,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const enriched = useMemo(() => {
    const bmap = balances.data?.balances ?? {};
    return rows.map((r) => {
      const size = Number(r.position_size_usd ?? 0);
      const coll = Number(r.position_collateral_usd ?? 0);
      const effLev = coll > 0 ? size / coll : 0;
      const selLev = Number(r.leverage ?? 0);
      const levDrift = selLev > 0 ? effLev / selLev : 0;
      const bal = (r.treasury_wallet_address && bmap[r.treasury_wallet_address]) || null;
      const isOpen = size > 0;
      const isClosed =
        ["graduated", "closed", "migrated", "complete"].includes(String(r.status ?? "")) ||
        ["graduated", "complete"].includes(String(r.migration_status ?? ""));
      return { ...r, _size: size, _coll: coll, _effLev: effLev, _levDrift: levDrift, _bal: bal, _isOpen: isOpen, _isClosed: isClosed };
    });
  }, [rows, balances.data]);

  const groups = useMemo(() => {
    const open = enriched.filter((r) => r._isOpen).sort((a, b) => b._size - a._size);
    const idle = enriched.filter((r) => !r._isOpen && !r._isClosed).sort(
      (a, b) => Number(b.fees_accrued_usd ?? 0) - Number(a.fees_accrued_usd ?? 0),
    );
    const closed = enriched.filter((r) => !r._isOpen && r._isClosed);
    return { open, idle, closed };
  }, [enriched]);

  const totals = useMemo(() => {
    const t = {
      open: groups.open.length,
      idle: groups.idle.length,
      closed: groups.closed.length,
      notional: 0,
      collateral: 0,
      pnl: 0,
      fees: 0,
      reserve: 0,
      treasurySol: 0,
      walletSol: 0,
      walletUsdc: 0,
    };
    for (const r of enriched) {
      t.notional += r._size;
      t.collateral += r._coll;
      t.pnl += Number(r.treasury_pnl_usd ?? 0);
      t.fees += Number(r.fees_accrued_usd ?? 0);
      t.reserve += Number(r.buyback_reserve_usd ?? 0);
      t.treasurySol += Number(r.treasury_sol ?? 0);
      t.walletSol += Number(r._bal?.sol ?? 0);
      t.walletUsdc += Number(r._bal?.usdc ?? 0);
    }
    return t;
  }, [enriched, groups]);

  return (
    <div className="space-y-4">
      {/* Totals strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        <Stat label="open / idle / closed" value={`${totals.open} / ${totals.idle} / ${totals.closed}`} />
        <Stat label="total notional" value={"$" + formatNum(totals.notional)} />
        <Stat label="total collateral" value={"$" + formatNum(totals.collateral)} />
        <Stat label="aggregate PnL" value={"$" + formatNum(totals.pnl)} tone={totals.pnl > 0 ? "good" : totals.pnl < 0 ? "bad" : undefined} />
        <Stat label="fees accrued" value={"$" + formatNum(totals.fees)} />
        <Stat label="buyback reserve" value={"$" + formatNum(totals.reserve)} />
        <Stat label="treasury SOL (db)" value={formatNum(totals.treasurySol)} />
        <Stat label="sub-wallets SOL (live)" value={formatNum(totals.walletSol)} tone={balances.isLoading ? "loading" : undefined} />
        <Stat label="sub-wallets USDC (live)" value={"$" + formatNum(totals.walletUsdc)} tone={balances.isLoading ? "loading" : undefined} />
      </div>

      {balances.error && (
        <div className="text-xs text-destructive">wallet balance fetch failed: {String(balances.error)}</div>
      )}

      <PositionGroup
        title="Open positions"
        subtitle="size &gt; 0, sorted by notional"
        rows={groups.open}
        emptyText="no open positions"
        accent="primary"
      />

      <PositionGroup
        title="Idle (no position, has activity)"
        subtitle="size = 0 but fees accrued or reserve held"
        rows={groups.idle}
        emptyText="no idle tokens"
        accent="muted"
      />

      <div className="border border-border rounded">
        <button
          type="button"
          onClick={() => setShowClosed((v) => !v)}
          className="w-full text-left px-3 py-2 text-xs font-semibold hover:bg-muted/30 flex items-center justify-between"
        >
          <span>
            Closed / migrated <span className="text-muted-foreground font-normal">({groups.closed.length})</span>
          </span>
          <span className="text-muted-foreground">{showClosed ? "▾" : "▸"}</span>
        </button>
        {showClosed && (
          <PositionGroup
            title=""
            subtitle=""
            rows={groups.closed}
            emptyText="no closed tokens"
            accent="muted"
            embedded
          />
        )}
      </div>
    </div>
  );
}

function PositionGroup({
  title,
  subtitle,
  rows,
  emptyText,
  accent,
  embedded,
}: {
  title: string;
  subtitle: string;
  rows: any[];
  emptyText: string;
  accent: "primary" | "muted";
  embedded?: boolean;
}) {
  return (
    <div className={embedded ? "" : "space-y-2"}>
      {!embedded && (
        <div className="flex items-baseline gap-2">
          <h2 className={`text-sm font-semibold ${accent === "primary" ? "text-foreground" : "text-muted-foreground"}`}>
            {title}
          </h2>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {rows.length} · {subtitle}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground px-3 py-4 border border-dashed border-border rounded">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-auto border border-border rounded">
          <table className="text-xs w-max min-w-full font-mono">
            <thead className="bg-muted/60 sticky top-0">
              <tr className="text-left">
                {[
                  "ticker",
                  "side",
                  "underlying",
                  "router",
                  "notional",
                  "coll",
                  "eff lev",
                  "PnL",
                  "fees",
                  "buyback rsv",
                  "sub SOL",
                  "sub USDC",
                  "last tick",
                  "status",
                ].map((c) => (
                  <th
                    key={c}
                    className="px-2 py-1.5 whitespace-nowrap border-l border-border/40 font-normal text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PositionRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PositionRow({ r }: { r: any }) {
  const pnl = Number(r.treasury_pnl_usd ?? 0);
  const pnlClass =
    pnl > 0.01 ? "text-emerald-500" : pnl < -0.01 ? "text-red-500" : "text-muted-foreground";
  const dirClass =
    r.direction === "long"
      ? "text-emerald-500"
      : r.direction === "short"
      ? "text-red-500"
      : "text-muted-foreground";
  const levDriftFlag = r._levDrift > 1.25 || (r._effLev > 0 && r._levDrift > 0 && r._levDrift < 0.75);
  const subSol = Number(r._bal?.sol ?? 0);
  const subUsdc = Number(r._bal?.usdc ?? 0);
  const lowGas = subSol < 0.005 && r._isOpen;
  const parkedFlag = subUsdc > 10; // > $10 USDC sitting in sub-wallet = likely parked

  return (
    <tr className="border-t border-border hover:bg-muted/20">
      <td className="px-2 py-1 text-primary whitespace-nowrap font-semibold">
        {r.ticker}
        <div className="text-[10px] text-muted-foreground font-normal truncate max-w-[140px]">{r.name}</div>
      </td>
      <td className={`px-2 py-1 whitespace-nowrap ${dirClass}`}>
        {r.direction ?? "·"} {r.leverage ? `${r.leverage}x` : ""}
      </td>
      <td className="px-2 py-1 whitespace-nowrap">{r.underlying ?? "·"}</td>
      <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{r.router}</td>
      <td className="px-2 py-1 whitespace-nowrap">${formatNum(r._size)}</td>
      <td className="px-2 py-1 whitespace-nowrap">${formatNum(r._coll)}</td>
      <td className={`px-2 py-1 whitespace-nowrap ${levDriftFlag ? "text-amber-500" : ""}`}>
        {r._effLev > 0 ? `${r._effLev.toFixed(2)}x` : "·"}
      </td>
      <td className={`px-2 py-1 whitespace-nowrap ${pnlClass}`}>
        {pnl === 0 ? "·" : `${pnl > 0 ? "+" : ""}$${formatNum(pnl)}`}
      </td>
      <td className="px-2 py-1 whitespace-nowrap">${formatNum(Number(r.fees_accrued_usd ?? 0))}</td>
      <td className="px-2 py-1 whitespace-nowrap">${formatNum(Number(r.buyback_reserve_usd ?? 0))}</td>
      <td className={`px-2 py-1 whitespace-nowrap ${lowGas ? "text-amber-500" : ""}`}>
        {r._bal ? subSol.toFixed(4) : "·"}
      </td>
      <td className={`px-2 py-1 whitespace-nowrap ${parkedFlag ? "text-amber-500" : ""}`}>
        {r._bal ? "$" + formatNum(subUsdc) : "·"}
      </td>
      <td className="px-2 py-1 whitespace-nowrap text-muted-foreground" title={r.last_tick_at ?? ""}>
        {relativeTime(r.last_tick_at)}
      </td>
      <td className="px-2 py-1 whitespace-nowrap">
        <StatusBadge status={r.status} migration={r.migration_status} />
        {r.treasury_wallet_address && (
          <a
            href={`https://solscan.io/account/${r.treasury_wallet_address}`}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-[10px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            wallet
          </a>
        )}
        {r.imperial_profile_pda && (
          <a
            href={`https://solscan.io/account/${r.imperial_profile_pda}`}
            target="_blank"
            rel="noreferrer"
            className="ml-2 text-[10px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            imperial
          </a>
        )}
      </td>
    </tr>
  );
}

function DevNotes() {
  return (
    <details className="mt-4 text-xs text-muted-foreground border border-border/60 rounded p-3">
      <summary className="cursor-pointer font-semibold text-foreground">
        Dev notes & schema reference
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed">
        <div>
          <div className="font-semibold text-foreground">tx_log</div>
          Every keeper-submitted Solana tx. Columns: id, token_id, kind, status (pending|confirmed|failed),
          signature, intent_hash, amount_usd / amount_sol / amount_tokens, error, created_at, confirmed_at.
        </div>
        <div>
          <div className="font-semibold text-foreground">treasury_events</div>
          Economic events. kind one of: tick, deposit, withdraw, fee_claim, buyback, burn, pnl_realized, etc.
          Fields: tx_sig, mid (mark price), pnl_delta_usd, sol_amount, tokens_amount (base units, /1e6 for UI),
          note (free-form, often has coll=$X / size=$Y for ticks).
        </div>
        <div>
          <div className="font-semibold text-foreground">tokens</div>
          Current state snapshot per token. Key fields: router (imperial|drift|...), status, migration_status,
          treasury_sol, fees_accrued_usd, position_size_usd, position_collateral_usd, treasury_pnl_usd,
          buyback_reserve_usd, launch_mid, last_tick_at, last_tick_mid, last_fee_claim_at,
          last_fee_claim_signature, dbc_pool_address, graduated_pool_address, lp_position_address,
          imperial_profile_pda, mint_address, external_mint, creator_address.
        </div>
        <div>
          <div className="font-semibold text-foreground">Imperial PnL gotcha</div>
          Imperial tokens have no launch_mid on open and the keeper writes pnl=$0 on every tick. Live PnL must
          be computed from tick history (weighted-avg entry by walking treasury_events ticks since
          position_opened_at, parsing coll=$X from note, treating coll increases as adds at that tick's mid).
        </div>
        <div>
          <div className="font-semibold text-foreground">External tokens</div>
          source='external' (e.g. pump.fun) requires external_mint set, mint_pending=false, and
          first_fee_routed_at NOT null to be visible in the public market. Don't drop the fee-routed gate.
        </div>
        <div>
          <div className="font-semibold text-foreground">Keeper / runtime</div>
          The keeper runs on Fly.io (separate from this web app). Logs: <code>fly logs -a &lt;app&gt;</code>.
          Private keys (TREASURY_SECRET_KEY, TREASURY_SOLANA_PRIVATE_KEY) live only as Fly secrets and Supabase
          secrets, never in the DB. RPC: SOLANA_RPC_URL.
        </div>
      </div>
    </details>
  );
}