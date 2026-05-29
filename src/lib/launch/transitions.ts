// Pure launch-status transition rules (no I/O), extracted from launchState.ts so
// they're unit-testable. launchState.ts re-exports these and adds the DB
// compare-and-set. See LAUNCH_REFACTOR.md Phase 4.

export type LaunchStatus = "launching" | "live" | "failed" | "deprecated";

// Statuses excluded from keeper processing AND public token listings.
export const HIDDEN_LAUNCH_STATUSES = ["deprecated", "failed"] as const;

// PostgREST `in` list, e.g. "(deprecated,failed)".
export const HIDDEN_STATUS_PG_LIST = `(${HIDDEN_LAUNCH_STATUSES.join(",")})`;

// Legal status transitions. Anything not listed is rejected.
//  - `failed` is terminal-ish but a retry that finally lands can recover it to live.
//  - `deprecated` is fully terminal.
export const ALLOWED: Record<LaunchStatus, LaunchStatus[]> = {
  launching: ["live", "failed", "deprecated"],
  live: ["deprecated"],
  failed: ["live", "deprecated"],
  deprecated: [],
};

// A transition is legal if it is a no-op (from === to, so retries are idempotent)
// or explicitly allowed. Anything else is rejected.
export function canTransition(from: LaunchStatus, to: LaunchStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from]?.includes(to) ?? false;
}
