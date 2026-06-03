import { config } from "./config.js";
import { intentHash } from "./idempotency.js";
import { logInfo, logWarn, logError } from "./structuredLog.js";

// The per-token workflow states. Keys are SCREAMING_SNAKE; values are the exact
// strings persisted to token_workflows.state (and validated by the migration
// CHECK + the app-side Zod enum) — so always compare/assign via State.X, never a
// bare string literal. Ordered along the token lifecycle, with the two
// cross-cutting terminal-ish states (BLOCKED/ERROR) last.
export const State = Object.freeze({
  IDLE: "idle",
  FEES_CLAIMED: "fees_claimed",
  SPLIT_RESERVED: "split_reserved",
  IMPERIAL_DEPOSITED: "imperial_deposited",
  POSITION_OPEN_PENDING: "position_open_pending",
  POSITION_OPEN: "position_open",
  TOPUP_PENDING: "topup_pending",
  BLOCKED: "blocked",
  ERROR: "error",
});

const BASE = config.perpadBaseUrl;
const SECRET = config.keeperSecret;
const KEEP_TOKEN_RECENT_MS = Number(process.env.WORKFLOW_TOKEN_RECENT_MS ?? 60_000);

const _workflowBatch = [];
const _actionBatch = [];
const _logBatch = [];
let _flushTimer = null;
let _lastTokenState = new Map();

function truncate(value, max = 1000) {
  if (!value) return value;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function finite(value, fallback = undefined) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-keeper-secret": SECRET,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.ok === false) {
    throw new Error(`workflow ${path} ${res.status}: ${json.error ?? text}`);
  }
  return json;
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushWorkflow().catch((e) => {
      logWarn("workflow flush failed", { error: e.message });
    });
  }, 1000);
}

export function classifyState(token, patch = {}, context = {}) {
  const hasLivePosition = Boolean(patch.position_opened || token?.position_opened_at);
  const pendingSig = patch.pending_drift_sig ?? token?.pending_drift_sig;
  const fees = finite(context.feesAccruedAfter, finite(token?.fees_accrued_usd, 0)) ?? 0;
  const reserve = finite(context.buybackReserveUsd, finite(token?.buyback_reserve_usd, 0)) ?? 0;
  const deposited = finite(context.imperialDepositedThisTickUsd, 0) ?? 0;

  if (context.blockedReason) return State.BLOCKED;
  if (context.error) return State.ERROR;
  if (pendingSig && hasLivePosition) return State.TOPUP_PENDING;
  if (pendingSig && !hasLivePosition) return State.POSITION_OPEN_PENDING;
  if (hasLivePosition) return State.POSITION_OPEN;
  if (deposited > 0) return State.IMPERIAL_DEPOSITED;
  if (fees > 0 || reserve > 0) return State.SPLIT_RESERVED;
  if (context.claimedFeesUsd > 0) return State.FEES_CLAIMED;
  return State.IDLE;
}

/**
 * Fix 3a anti-double-open guard, as a pure predicate. The durable workflow state
 * is authoritative even when the venue's /positions read lags: if it says a
 * position is live (POSITION_OPEN) or a recent open is still pending within its
 * retry window (POSITION_OPEN_PENDING), a second open must be refused. A live
 * position (handled by the caller's gate) or an idle/missing row disables it.
 * See OPEN_CHAIN_REFACTOR_V2.md.
 * @param {{ state?: string|null, nextRetryAt?: string|null, hasLivePosition?: boolean, now?: number }} args
 * @returns {boolean}
 */
export function workflowBlocksOpen({ state, nextRetryAt = null, hasLivePosition = false, now = Date.now() }) {
  if (hasLivePosition) return false;
  if (state === State.POSITION_OPEN) return true;
  if (state === State.POSITION_OPEN_PENDING) {
    const retryMs = nextRetryAt ? new Date(nextRetryAt).getTime() : null;
    return retryMs == null || now < retryMs;
  }
  return false;
}

export function workflowPatch(token, patch = {}, context = {}) {
  if (!token?.id) return null;
  const state = context.state ?? classifyState(token, patch, context);
  const blockedReason = context.blockedReason ?? null;
  return {
    token_id: token.id,
    state,
    last_successful_step:
      context.lastSuccessfulStep ?? (state === State.BLOCKED || state === State.ERROR ? undefined : state),
    blocked_reason: blockedReason,
    // Omit when unset (undefined → dropped from JSON → upsert preserves the
    // existing value) so a per-tick state write doesn't clobber an open
    // deadline / blocked retry-at set elsewhere (Fix 3a). queueBlocked still
    // passes an explicit value when it wants one.
    next_retry_at: context.nextRetryAt,
    attempt_count: context.attemptCount,
    locked_at: null,
    locked_by: null,
    perp_reserved_usd: finite(
      context.perpReservedUsd,
      finite(patch.fees_accrued_usd, finite(token.fees_accrued_usd, 0)),
    ),
    buyback_reserved_usd: finite(
      context.buybackReservedUsd,
      finite(patch.buyback_reserve_usd, finite(token.buyback_reserve_usd, 0)),
    ),
    treasury_reserved_usd: finite(context.treasuryReservedUsd, 0),
    imperial_deposited_usd: finite(
      context.imperialDepositedUsd,
      finite(patch.position_collateral_usd, finite(token.position_collateral_usd, 0)),
    ),
    position_entry_price:
      finite(
        context.positionEntryPrice,
        finite(patch.launch_mid, finite(token.launch_mid, undefined)),
      ) ?? null,
    position_entry_source:
      context.positionEntrySource ?? (patch.launch_mid || token.launch_mid ? "reconciled" : null),
    position_size_usd: finite(
      context.positionSizeUsd,
      finite(patch.position_size_usd, finite(token.position_size_usd, 0)),
    ),
    position_collateral_usd: finite(
      context.positionCollateralUsd,
      finite(patch.position_collateral_usd, finite(token.position_collateral_usd, 0)),
    ),
    last_observed_sub_sol: finite(context.subSol),
    last_observed_sub_usdc: finite(context.subUsdc),
    last_observed_imperial_usdc: finite(context.imperialUsdc),
    last_observed_at: context.observedAt ?? new Date().toISOString(),
    metadata: {
      ticker: token.ticker ?? null,
      router: token.router ?? null,
      source: token.source ?? null,
      note: context.note ?? null,
    },
  };
}

export function queueWorkflow(patch) {
  if (!patch?.token_id) return;
  _workflowBatch.push(patch);
  scheduleFlush();
}

export function queueAction(action) {
  if (!action?.token_id || !action?.action_kind || !action?.intent_hash) return;
  _actionBatch.push({
    token_id: action.token_id,
    action_kind: action.action_kind,
    intent_hash: action.intent_hash,
    status: action.status ?? "pending",
    signature: action.signature ?? null,
    external_id: action.external_id ?? null,
    amount_usd: finite(action.amount_usd ?? action.amountUsd, null),
    amount_sol: finite(action.amount_sol ?? action.amountSol, null),
    amount_tokens: finite(action.amount_tokens ?? action.amountTokens, null),
    request_payload: action.request_payload ?? action.requestPayload ?? {},
    response_payload: action.response_payload ?? action.responsePayload ?? {},
    error: truncate(action.error ?? null),
  });
  scheduleFlush();
}

export function queueBlocked(token, reason, context = {}) {
  if (!token?.id || !reason) return;
  const now = Date.now();
  const prev = _lastTokenState.get(token.id);
  if (prev?.reason === reason && now - prev.at < KEEP_TOKEN_RECENT_MS) return;
  _lastTokenState.set(token.id, { reason, at: now });
  queueWorkflow(
    workflowPatch(token, context.patch ?? {}, {
      ...context,
      state: State.BLOCKED,
      blockedReason: reason,
      lastSuccessfulStep: context.lastSuccessfulStep,
    }),
  );
  queueAction({
    token_id: token.id,
    action_kind: "blocked",
    intent_hash: intentHash([token.id, "blocked", reason]),
    status: "blocked",
    error: reason,
    request_payload: context.requestPayload ?? {},
    response_payload: context.responsePayload ?? {},
  });
}

// --- durable per-token logs (KEEPER_PER_TOKEN_LOGS.md) ------------------------

// Pure: shape one durable log row from a token + level + message. Exported for
// unit tests; queueLog/keeperLog build on it. `tick_id`/`event` are promoted to
// columns (for filtering) and also kept in `fields` (full context).
export function buildLogRow(token, level, message, fields = {}) {
  return {
    token_id: token?.id ?? null,
    tick_id: fields?.tick_id ?? null,
    level: level === "warn" || level === "error" ? level : "info",
    event: fields?.event ?? null,
    message: String(message ?? ""),
    fields: fields ?? {},
  };
}

// Buffer a per-token log row for the next batched flush. Only token-scoped rows
// are stored — a null token_id (a tick-level / banner log) is dropped.
export function queueLog(row) {
  if (!row?.token_id || !row?.message) return;
  _logBatch.push(row);
  scheduleFlush();
}

// The sink: print the structured line to stdout (live grep) AND buffer a durable
// per-token row. Single chokepoint the keeper routes per-token logs through
// (converted from the old per-token console.error/warn).
export function keeperLog(token, level, message, fields = {}) {
  const line = { token_id: token?.id ?? null, ticker: token?.ticker ?? null, ...fields };
  if (level === "error") logError(message, line);
  else if (level === "warn") logWarn(message, line);
  else logInfo(message, line);
  queueLog(buildLogRow(token, level, message, fields));
}

// Test-only: drain + return the buffered rows (assert what would be persisted
// without hitting the network).
export function _drainLogs() {
  return _logBatch.splice(0, _logBatch.length);
}

export async function flushWorkflow() {
  if (!_workflowBatch.length && !_actionBatch.length && !_logBatch.length) return { ok: true };
  const workflows = _workflowBatch.splice(0, _workflowBatch.length);
  const actions = _actionBatch.splice(0, _actionBatch.length);
  const logs = _logBatch.splice(0, _logBatch.length);
  return call("/api/public/keeper/workflow-report", {
    method: "POST",
    body: JSON.stringify({ workflows, actions, logs }),
  });
}

export async function listWorkflows(params = {}) {
  const qs = new URLSearchParams();
  if (params.token_id) qs.set("token_id", params.token_id);
  if (params.limit) qs.set("limit", String(params.limit));
  return call(`/api/public/keeper/workflows${qs.toString() ? `?${qs}` : ""}`, {
    method: "GET",
  });
}

export async function claimWorkflowLocks(tokenIds, owner, staleAfterSeconds = 300) {
  if (!tokenIds?.length) return new Set();
  const res = await call("/api/public/keeper/workflow-locks", {
    method: "POST",
    body: JSON.stringify({
      token_ids: [...new Set(tokenIds)],
      owner,
      stale_after_seconds: staleAfterSeconds,
    }),
  });
  return new Set(res.locked_token_ids ?? []);
}

// Fix 3b: synchronous, minimal state write. Unlike queueWorkflow (batched and
// flushed at end of tick), this AWAITS the upsert so the new state is durable
// BEFORE the keeper sends the open order — so a crash right after the send
// still leaves a position_open_pending marker that next tick's 3a guard sees.
// Only the provided columns are sent; Supabase upsert leaves the rest of the
// row (reserve/position ledger) untouched on conflict.
export async function setWorkflowStateSync(tokenId, state, extra = {}) {
  if (!tokenId || !state) return null;
  return call("/api/public/keeper/workflow-report", {
    method: "POST",
    body: JSON.stringify({
      workflows: [{ token_id: tokenId, state, ...extra }],
      actions: [],
    }),
  });
}

// Normalize the token_workflows embed from the /tokens feed (PostgREST may
// return a to-one embed as an object or a single-element array).
export function workflowStateFromToken(token) {
  const wf = token?.token_workflows;
  const row = Array.isArray(wf) ? wf[0] : wf;
  return row ?? null;
}
