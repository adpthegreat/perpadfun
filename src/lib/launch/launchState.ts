// Launch lifecycle state machine (Phase 4 of LAUNCH_REFACTOR.md).
//
// `status` is the launch lifecycle. `migration_status` (curve -> graduated) is
// an orthogonal, keeper-managed bonding-curve concern and is intentionally NOT
// modeled here. This module is the single place that (a) defines the legal
// status transitions and (b) defines which statuses are hidden from the keeper
// and the public UI.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { canTransition, type LaunchStatus } from "./transitions";

// Re-export the pure transition rules so existing importers are unaffected.
export {
  type LaunchStatus,
  HIDDEN_LAUNCH_STATUSES,
  HIDDEN_STATUS_PG_LIST,
  ALLOWED,
  canTransition,
} from "./transitions";

// Guarded, idempotent status transition.
//  - reads the current status,
//  - no-ops (ok) if already in the target state (so retries are safe),
//  - rejects illegal moves,
//  - applies the change atomically with a compare-and-set on status.
export async function transitionLaunch(
  tokenId: string,
  to: LaunchStatus,
  patch: Record<string, unknown> = {},
): Promise<{ ok: boolean; error: string | null }> {
  const { data: row, error } = await supabaseAdmin
    .from("tokens")
    .select("status")
    .eq("id", tokenId)
    .single();
  if (error || !row) return { ok: false, error: error?.message ?? "token not found" };

  const from = row.status as LaunchStatus;
  if (from === to) return { ok: true, error: null };
  if (!canTransition(from, to)) {
    return { ok: false, error: `illegal launch transition ${from} -> ${to}` };
  }

  const { error: upErr } = await supabaseAdmin
    .from("tokens")
    .update({ ...patch, status: to })
    .eq("id", tokenId)
    .eq("status", from);
  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true, error: null };
}

// Move a launch to the terminal `failed` state (best-effort; logs on failure).
// Use ONLY for non-retryable terminal errors (e.g. the launch tx confirmed
// failed on-chain), never for transient errors the client can retry.
export async function markLaunchFailed(tokenId: string, reason: string): Promise<void> {
  const res = await transitionLaunch(tokenId, "failed");
  if (!res.ok) {
    console.error(`markLaunchFailed ${tokenId}: ${res.error} (reason: ${reason})`);
  }
}
