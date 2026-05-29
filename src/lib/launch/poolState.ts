// Pure pool-state guards (no I/O), extracted from refreshPoolState so they're
// unit-testable. See LAUNCH_REFACTOR.md / dbc.functions.ts.

// sol_raised: keep the last known value when the on-chain read exposes none.
// A graduated DBC pool whose reserve migrated to DAMM v2 reads no quoteReserve;
// we must NOT overwrite a real sol_raised with 0.
export function nextSolRaised(
  onchainSol: number | null | undefined,
  existing: number | null | undefined,
): number {
  return onchainSol != null && Number.isFinite(onchainSol) ? Number(onchainSol) : Number(existing ?? 0);
}

// migration_status: one-way. Once graduated, a transient/undefined isMigrated
// read must never flip it back to "curve" (which would send the keeper to the
// DBC fee-claim path on a DAMM v2 pool).
export function nextMigrationStatus(
  current: string | null | undefined,
  isMigrated: boolean | null | undefined,
): "curve" | "graduated" {
  return current === "graduated" || isMigrated ? "graduated" : "curve";
}
