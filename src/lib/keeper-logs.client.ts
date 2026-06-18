// Browser-side keeper_logs reads for the /admin/keeper-logs pages.
//
// keeper_logs is non-public (no RLS read policy), so we cannot read it with the
// anon supabase client like /admin/logs does for treasury_events. Instead we hit
// the secret-gated GET /api/public/keeper/logs route (supabaseAdmin server-side)
// with the admin key in the x-keeper-secret header — the same secret the keeper
// and the other /api/admin operations use. The key lives in localStorage (see
// admin-key.ts) so the admin enters it once per browser.
//
// Signatures mirror the old server fns ({ data }) and return the same shapes so
// the page call sites are unchanged.
import { getAdminKey } from "@/lib/admin-key";
import type { KeeperLogRow, KeeperLogStats } from "@/lib/keeper-logs.functions";

export type { KeeperLogRow, KeeperLogStats } from "@/lib/keeper-logs.functions";

// Thrown when the admin key is missing or rejected — the pages catch this to
// show the "enter admin key" prompt rather than a generic failure.
export class AdminKeyError extends Error {}

const LOGS_ENDPOINT = "/api/public/keeper/logs";

async function getJson(params: Record<string, string | undefined>): Promise<any> {
  const key = getAdminKey();
  if (!key) throw new AdminKeyError("admin key required");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const res = await fetch(`${LOGS_ENDPOINT}?${qs.toString()}`, {
    headers: { "x-keeper-secret": key },
  });
  if (res.status === 401) throw new AdminKeyError("admin key rejected");
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `request failed (${res.status})`);
  }
  return body;
}

type ListInput = {
  tokenId?: string;
  level?: "info" | "warn" | "error";
  event?: string;
  before?: string;
  limit?: number;
};

export async function listKeeperLogs({
  data,
}: {
  data: ListInput;
}): Promise<{ logs: KeeperLogRow[]; nextBefore: string | null }> {
  const body = await getJson({
    token_id: data.tokenId,
    level: data.level,
    event: data.event,
    before: data.before,
    limit: data.limit != null ? String(data.limit) : undefined,
  });
  return {
    logs: (body.logs ?? []) as KeeperLogRow[],
    nextBefore: (body.next_before ?? null) as string | null,
  };
}

export async function getKeeperLogStats({
  data,
}: {
  data: { tokenId?: string };
}): Promise<KeeperLogStats> {
  const body = await getJson({ stats: "1", token_id: data.tokenId });
  return {
    total: body.total ?? 0,
    info: body.info ?? 0,
    warn: body.warn ?? 0,
    error: body.error ?? 0,
    globalNullCount: body.globalNullCount ?? 0,
    lastActivityAt: body.lastActivityAt ?? null,
    token: body.token ?? null,
    workflow: body.workflow ?? null,
  };
}
