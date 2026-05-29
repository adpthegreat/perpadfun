// Generates a randomized fleet of feed-shaped tokens (the shape the keeper's
// /tokens feed returns, with an embedded token_workflows row) for the RPC-pressure
// (4b cadence) tests. Each token is tagged with `_expect`, its cadence outcome:
//   'process'  -> hot: must run EVERY tick (live position, pending sig, fees >= gate,
//                 or any mid-flow workflow state like split_reserved/topup_pending)
//   'throttle' -> cold: idle, probed at most once per COLD_PROBE_INTERVAL_MS
//   'defer'    -> next_retry_at in the future: skipped until due
//
// Category mix is guaranteed (cycled) so assertions are stable; the order is
// shuffled and the within-category values (fee amounts) are randomized.

const FEE_GATE = Number(process.env.FEE_GATE_USD ?? 20); // mirrors config.feeGateUsd

export type FleetToken = {
  id: string;
  ticker: string;
  fees_accrued_usd: number;
  position_opened_at: string | null;
  pending_drift_sig: string | null;
  token_workflows: { state: string; next_retry_at: string | null };
  _expect: "process" | "throttle" | "defer";
};

export const FLEET_CATEGORIES = [
  "idle", // cold
  "live", // hot: open position
  "pending", // hot: in-flight sig
  "near_gate", // hot: fees >= gate
  "few_fees", // hot: a few RECORDED fees -> split_reserved (mid-flow), still hot
  "deferred", // skipped: blocked with a future next_retry_at
] as const;

function makeOne(i: number, category: string): FleetToken {
  const base: FleetToken = {
    id: `tok-${i}-${Math.floor(Math.random() * 1e9)}`,
    ticker: `T${i}`,
    fees_accrued_usd: 0,
    position_opened_at: null,
    pending_drift_sig: null,
    token_workflows: { state: "idle", next_retry_at: null },
    _expect: "throttle",
  };
  switch (category) {
    case "live":
      return {
        ...base,
        position_opened_at: new Date().toISOString(),
        token_workflows: { state: "position_open", next_retry_at: null },
        _expect: "process",
      };
    case "pending":
      return {
        ...base,
        position_opened_at: new Date().toISOString(),
        pending_drift_sig: `sig-${i}`,
        token_workflows: { state: "topup_pending", next_retry_at: null },
        _expect: "process",
      };
    case "near_gate":
      return {
        ...base,
        fees_accrued_usd: FEE_GATE + Math.random() * 50,
        token_workflows: { state: "split_reserved", next_retry_at: null },
        _expect: "process",
      };
    case "few_fees":
      return {
        ...base,
        fees_accrued_usd: 0.5 + Math.random() * (FEE_GATE - 1), // below gate, but recorded
        token_workflows: { state: "split_reserved", next_retry_at: null },
        _expect: "process",
      };
    case "deferred":
      return {
        ...base,
        token_workflows: { state: "blocked", next_retry_at: new Date(Date.now() + 3_600_000).toISOString() },
        _expect: "defer",
      };
    case "idle":
    default:
      return base; // idle -> throttle
  }
}

// --- stuck fleet (for the reconcile suite) ------------------------------------
// Each scenario is a spec for seeding (token overrides + a workflow row with a
// controlled age) plus the expected reconcile outcome. `venue` is the scripted
// venue read for the stale-open case (undefined = couldn't read).
const ISO = () => new Date().toISOString();

export type StuckScenario = {
  name: string;
  token: Record<string, unknown>;
  wf: { state: string; blocked_reason?: string | null; ageMin: number };
  venue?: undefined | null | { sizeUsd: number; collateralUsd: number };
  expect: { isCandidate: boolean; action?: string; resolve?: string; finalState?: string };
  _id?: string;
};

const STUCK_SCENARIOS: StuckScenario[] = [
  // --- recoverable / actionable ---
  { name: "error", token: {}, wf: { state: "error", ageMin: 5 }, expect: { isCandidate: true, action: "reset-error", finalState: "idle" } },
  { name: "blocked_perp_leg_failed", token: {}, wf: { state: "blocked", blocked_reason: "perp_leg_failed", ageMin: 90 }, expect: { isCandidate: true, action: "escalate" } },
  { name: "stale_open_dropped", token: { pending_drift_sig: "sig" }, wf: { state: "position_open_pending", ageMin: 30 }, venue: null, expect: { isCandidate: true, action: "needs-venue-check", resolve: "clear-open", finalState: "idle" } },
  { name: "stale_open_late_indexed", token: { pending_drift_sig: "sig" }, wf: { state: "position_open_pending", ageMin: 30 }, venue: { sizeUsd: 100, collateralUsd: 20 }, expect: { isCandidate: true, action: "needs-venue-check", resolve: "confirm-open" } },
  { name: "stale_open_venue_unknown", token: { pending_drift_sig: "sig" }, wf: { state: "position_open_pending", ageMin: 30 }, venue: undefined, expect: { isCandidate: true, action: "needs-venue-check", resolve: "hold" } },
  { name: "stale_topup", token: { position_opened_at: ISO(), pending_drift_sig: "sig" }, wf: { state: "topup_pending", ageMin: 30 }, expect: { isCandidate: true, action: "clear-topup" } },
  // --- candidate by state, but NOT actionable this tick ---
  { name: "blocked_terminal", token: {}, wf: { state: "blocked", blocked_reason: "market_unsupported", ageMin: 90 }, expect: { isCandidate: true, action: "none" } },
  { name: "blocked_fresh", token: {}, wf: { state: "blocked", blocked_reason: "capacity-below-floor", ageMin: 5 }, expect: { isCandidate: true, action: "none" } },
  { name: "fresh_open", token: { pending_drift_sig: "sig" }, wf: { state: "position_open_pending", ageMin: 2 }, expect: { isCandidate: true, action: "none" } },
  // --- NOT stuck candidates (the query must exclude these) ---
  { name: "idle", token: {}, wf: { state: "idle", ageMin: 0 }, expect: { isCandidate: false } },
  { name: "live", token: { position_opened_at: ISO() }, wf: { state: "position_open", ageMin: 0 }, expect: { isCandidate: false } },
  { name: "split_reserved", token: { fees_accrued_usd: 8 }, wf: { state: "split_reserved", ageMin: 0 }, expect: { isCandidate: false } },
];

// Cycle the scenarios to n tokens. Returns fresh spec objects (so `_id` can be
// stamped per seeding) covering every stuck reason + non-candidate states.
export function makeStuckFleet(n = 100): StuckScenario[] {
  return Array.from({ length: n }, (_, i) => {
    const s = STUCK_SCENARIOS[i % STUCK_SCENARIOS.length];
    return { ...s, token: { ...s.token }, wf: { ...s.wf } };
  });
}

export function makeTokenFleet(n = 100): FleetToken[] {
  const fleet = Array.from({ length: n }, (_, i) => makeOne(i, FLEET_CATEGORIES[i % FLEET_CATEGORIES.length]));
  // Fisher-Yates shuffle so order is randomized (the filter must not depend on it).
  for (let i = fleet.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fleet[i], fleet[j]] = [fleet[j], fleet[i]];
  }
  return fleet;
}
