// Browser-side reads for the /admin cockpit. Every keeper table read here is
// secret-gated (no public RLS), so we hit the /api/public/keeper/* routes with
// the admin key in the x-keeper-secret header — the same key the keeper-logs
// pages use (localStorage, see admin-key.ts). Enter it once per browser.
import { getAdminKey } from "@/lib/admin-key";
import { AdminKeyError } from "@/lib/keeper-logs.api";

export { AdminKeyError };

// A managed token row as returned by /api/public/keeper/tokens (the SELECT there
// plus the embedded workflow). Only the fields the cockpit reads are typed.
export type WorkflowRow = {
  state: string | null;
  blocked_reason: string | null;
  next_retry_at: string | null;
  updated_at: string | null;
};

export type KeeperToken = {
  id: string;
  ticker: string | null;
  underlying: string | null;
  leverage: number | null;
  direction: string | null;
  source: string | null;
  migration_status: string | null;
  router: string | null;
  position_size_usd: number | null;
  position_collateral_usd: number | null;
  opened_collateral_usd: number | null;
  treasury_pnl_usd: number | null;
  fees_accrued_usd: number | null;
  buyback_reserve_usd: number | null;
  sol_raised: number | null;
  last_tick_at: string | null;
  position_opened_at: string | null;
  token_workflows: WorkflowRow | WorkflowRow[] | null;
};

export type OverviewFunnel = {
  signups: number;
  walletVerified: number;
  xFollowed: number;
  tgJoined: number;
  claimed: number;
  waitlisted: number;
};

export type Overview = {
  funnel: OverviewFunnel;
  codes: { total: number; assigned: number; remaining: number };
  series: { day: string; count: number }[];
};

async function getJson(endpoint: string): Promise<any> {
  const key = getAdminKey();
  if (!key) throw new AdminKeyError("admin key required");
  const res = await fetch(endpoint, { headers: { "x-keeper-secret": key } });
  if (res.status === 401) throw new AdminKeyError("admin key rejected");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return body;
}

// token_workflows comes back as an object or a single-element array depending on
// the join; normalize to the first row (or null).
export function workflowOf(t: KeeperToken): WorkflowRow | null {
  const w = t.token_workflows;
  if (!w) return null;
  return Array.isArray(w) ? (w[0] ?? null) : w;
}

export async function listKeeperTokens(): Promise<KeeperToken[]> {
  const body = await getJson("/api/public/keeper/tokens");
  return (body.tokens ?? []) as KeeperToken[];
}

export async function listStuckTokens(): Promise<KeeperToken[]> {
  const body = await getJson("/api/public/keeper/stuck-tokens");
  return (body.tokens ?? []) as KeeperToken[];
}

export async function getOverview(): Promise<Overview> {
  const body = await getJson("/api/public/keeper/overview");
  return {
    funnel: body.funnel,
    codes: body.codes,
    series: body.series ?? [],
  };
}

// ── mint-status index (FEE_ROUTING_AND_MINT_INDEX.md §3) ──────────────────────
export type RouterStatus = {
  found: boolean;
  mint: string;
  matchedColumn?: "external_mint" | "mint_address";
  duplicate?: boolean;
  token?: {
    id: string;
    ticker: string | null;
    name: string | null;
    source: string;
    status: string | null;
    externalPlatform: string | null;
    externalMint: string | null;
    mintAddress: string | null;
    subWallet: string | null;
    mintPending: boolean;
    firstFeeRoutedAt: string | null;
    createdAt: string | null;
  };
  subWalletBalanceSol?: number | null;
  balanceError?: string | null;
  listedOnSite?: boolean;
  events?: { kind: string; solAmount: number; txSig: string | null; createdAt: string | null }[];
  verdict: string;
  detail: string;
  nextAction: string;
};

export async function getRouterStatus(mint: string): Promise<RouterStatus> {
  const body = await getJson(`/api/public/keeper/router-status?mint=${encodeURIComponent(mint)}`);
  return body as RouterStatus;
}
