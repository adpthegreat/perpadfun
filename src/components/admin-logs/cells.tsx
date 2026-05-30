// Shared cells / helpers used by /admin/logs and /admin/logs/$tokenId.
// Lifted from src/routes/admin.logs.tsx so both pages render identically.
import { Fragment, type ReactNode } from "react";

// ---------------- constants ----------------
export const TX_SIG_COLS = new Set([
  "tx_sig",
  "signature",
  "launch_signature",
  "last_fee_claim_signature",
  "pending_drift_sig",
]);

export const ADDR_COLS = new Set([
  "mint_address",
  "external_mint",
  "metadata_address",
  "dbc_pool_address",
  "dbc_config_address",
  "graduated_pool_address",
  "lp_position_address",
  "treasury_wallet_address",
  "imperial_profile_pda",
  "creator_address",
  "solana_address",
]);

// ---------------- pure helpers ----------------
export function short(s: string) {
  if (s.length <= 16) return s;
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}

export function formatNum(n: number) {
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return n.toString();
}

export function relativeTime(iso?: string | null) {
  if (!iso) return "·";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (!isFinite(ms) || ms < 0) return iso.slice(0, 19).replace("T", " ");
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export function renderCell(col: string, v: unknown): ReactNode {
  if (v === null || v === undefined || v === "")
    return <span className="text-muted-foreground">·</span>;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);

  if (TX_SIG_COLS.has(col) && typeof v === "string" && v.length > 20) {
    return (
      <a
        href={`https://solscan.io/tx/${v}`}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {short(s)}
      </a>
    );
  }
  if (ADDR_COLS.has(col) && typeof v === "string" && v.length > 20) {
    return (
      <a
        href={`https://solscan.io/account/${v}`}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {short(s)}
      </a>
    );
  }
  if (col.endsWith("_at") && typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) {
      return <span title={v}>{d.toISOString().replace("T", " ").slice(0, 19)}</span>;
    }
  }
  if (typeof v === "number") {
    return <span>{formatNum(v)}</span>;
  }
  return <span title={s}>{s.length > 60 ? s.slice(0, 60) + "…" : s}</span>;
}

// ---------------- components ----------------
export function StatusBadge({ status, migration }: { status?: string; migration?: string }) {
  const s = String(status ?? "");
  const m = String(migration ?? "");
  const tone =
    s === "launching"
      ? "bg-amber-500/15 text-amber-500"
      : s === "live" || s === "open"
        ? "bg-emerald-500/15 text-emerald-500"
        : s === "graduated" || m === "graduated"
          ? "bg-blue-500/15 text-blue-500"
          : "bg-muted text-muted-foreground";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] ${tone}`}>
      {s}
      {m && m !== "pending" && m !== s ? ` · ${m}` : ""}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "loading";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-500"
      : tone === "bad"
        ? "text-red-500"
        : tone === "loading"
          ? "text-muted-foreground animate-pulse"
          : "";
  return (
    <div className="border border-border rounded px-2 py-1.5 bg-muted/20">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-mono ${toneClass}`}>{value}</div>
    </div>
  );
}

export function RowDetail({
  row,
  tokenInfo,
}: {
  row: Record<string, unknown>;
  tokenInfo?: Record<string, unknown> | null;
}) {
  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
          Fields
        </div>
        <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
          {Object.entries(row).map(([k, v]) => (
            <Fragment key={k}>
              <div className="text-muted-foreground">{k}</div>
              <div className="break-all">
                {v == null || v === "" ? (
                  <span className="text-muted-foreground">·</span>
                ) : typeof v === "object" ? (
                  <pre className="whitespace-pre-wrap text-xs font-mono bg-muted/20 p-1.5 rounded">
                    {JSON.stringify(v, null, 2)}
                  </pre>
                ) : (
                  String(v)
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      <div>
        {tokenInfo && (
          <>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Token
            </div>
            <pre className="text-xs font-mono bg-muted/30 p-2 rounded overflow-auto">
              {JSON.stringify(tokenInfo, null, 2)}
            </pre>
          </>
        )}
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-3 mb-1">
          JSON
        </div>
        <pre className="text-xs font-mono bg-muted/30 p-2 rounded overflow-auto">
          {JSON.stringify(row, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// Level color tone for keeper_logs rows (info muted / warn amber / error red).
// Used by /admin/keeper-logs + /admin/keeper-logs/$tokenId.
export function levelTone(level: string): string {
  if (level === "error") return "bg-red-500/15 text-red-500";
  if (level === "warn") return "bg-amber-500/15 text-amber-500";
  return "bg-muted text-muted-foreground";
}

export function LevelBadge({ level }: { level: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase ${levelTone(level)}`}>
      {level}
    </span>
  );
}

export function KeeperIssueGuide() {
  return (
    <div className="mb-3 grid gap-2 md:grid-cols-3 text-xs">
      <div className="border border-border rounded bg-muted/20 p-3">
        <div className="font-semibold text-foreground">RPC 429 throttle</div>
        <div className="text-muted-foreground mt-1">
          Raw 429s are Fly logs only. This tab shows the downstream DB symptoms they cause.
        </div>
      </div>
      <div className="border border-border rounded bg-muted/20 p-3">
        <div className="font-semibold text-foreground">Parked collateral</div>
        <div className="text-muted-foreground mt-1">
          Profile USDC is visible, but Imperial is not accepting the top-up or open yet.
        </div>
      </div>
      <div className="border border-border rounded bg-muted/20 p-3">
        <div className="font-semibold text-foreground">Pending tx backlog</div>
        <div className="text-muted-foreground mt-1">
          Old pending rows can block idempotent retry lanes for claims, swaps, and buybacks.
        </div>
      </div>
    </div>
  );
}

// ---------------- issue-row normalizers (used by both /admin/logs and /admin/logs/$tokenId) ----------------
// The return shape is concrete (NOT `unknown`-propagating) so callers can sort by
// `created_at` and render fields without re-casting at every use site.
export type IssueRow = {
  id: string;
  source: "treasury_events" | "tx_log";
  issue: string;
  created_at: string;
  token_id: string | null;
  kind: string | null;
  status: string;
  amount_usd: number | null;
  tx_sig: string | null;
  note: string;
};

export function classifyKeeperIssue(note: string) {
  const s = note.toLowerCase();
  if (s.includes("backoff") || s.includes("parked")) return "imperial parked collateral";
  if (s.includes("buyback drain") || s.includes("insufficient lamports"))
    return "buyback blocked by wallet SOL";
  if (s.includes("below floor") || s.includes("wallet capacity"))
    return "deposit blocked by wallet capacity";
  if (s.includes("fee claim")) return "fee claim issue";
  if (s.includes("top-up")) return "top-up issue";
  return "keeper issue";
}

function asStr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function keeperIssueFromEvent(row: Record<string, unknown>): IssueRow {
  const note = String(row.note ?? "");
  return {
    id: `event-${String(row.id ?? "")}`,
    source: "treasury_events",
    issue: classifyKeeperIssue(note),
    created_at: String(row.created_at ?? ""),
    token_id: asStr(row.token_id),
    kind: asStr(row.kind),
    status: "observed",
    amount_usd: null,
    tx_sig: asStr(row.tx_sig),
    note,
  };
}

export function keeperIssueFromPendingTx(row: Record<string, unknown>): IssueRow {
  const createdAt = String(row.created_at ?? "");
  const kind = asStr(row.kind) ?? "?";
  return {
    id: `pending-${String(row.id ?? "")}`,
    source: "tx_log",
    issue: "stuck pending tx",
    created_at: createdAt,
    token_id: asStr(row.token_id),
    kind,
    status: asStr(row.status) ?? "pending",
    amount_usd: asNum(row.amount_usd),
    tx_sig: asStr(row.signature),
    note: asStr(row.error) ?? `pending ${kind} since ${createdAt}`,
  };
}
