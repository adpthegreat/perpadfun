// General workflow-state reconciliation (Fix 3c). See KEEPER_RECONCILE.md.
//
// PASSIVE by design: this NEVER opens/closes/claims/deposits. It scans
// token_workflows and either (a) nudges a token the forward tick can't fix on
// its own back into the normal flow by resetting its workflow state, or
// (b) escalates a token that is genuinely stuck. All real recovery work is then
// done by loop.js, which already owns every trading guard.
//
// Complements positionReconcile.js (which only corrects collateral/size for
// recently-opened imperial positions). This pass handles the dead-ends that
// neither the forward tick nor positionReconcile recover:
//   1. error            -> reset to idle (bounded) so the tick re-evaluates
//   2. *_pending (stale) -> clear so the tick re-drives (open: ONLY after a
//                           venue read confirms no live position — double-open
//                           is catastrophic; topup: just drop the stuck sig)
//   3. blocked (too long) -> escalate (log/alert); never auto-unblock

import { config } from './config.js';
import { listStuckTokens, sendReport } from './perpad.js';
import { authenticate as imperialAuthenticate } from './imperial.js';
import { imperialReadPosition } from './imperialPerps.js';
import { readPerpPosition } from './jupiterPerps.js';
import { loadKeypair, walletForToken } from './wallet.js';
import { workflowStateFromToken, State, setWorkflowStateSync, keeperLog } from './workflow.js';

// A pending workflow row older than this with no resolution is treated as
// abandoned. Set FAR beyond venue indexing lag and positionReconcile's window
// (15 min) so we never act on an open that is merely indexing slowly.
export const STALE_PENDING_MS = Number(process.env.RECONCILE_STALE_PENDING_MS ?? 1_200_000); // 20 min
// A token blocked longer than this gets escalated for human attention.
export const BLOCKED_ESCALATE_MS = Number(process.env.RECONCILE_BLOCKED_ESCALATE_MS ?? 3_600_000); // 1 h
// After this many error->idle resets, stop looping and park it as blocked.
export const ERROR_MAX_RESETS = Number(process.env.RECONCILE_ERROR_MAX_RESETS ?? 5);
// Don't re-alert the same blocked token more often than this.
const ESCALATE_REALERT_MS = Number(process.env.RECONCILE_ESCALATE_REALERT_MS ?? 3_600_000); // 1 h

// blocked_reasons that are intentional long defers — never escalate/auto-touch.
export const TERMINAL_BLOCKED = new Set(['market_unsupported']);

// --- pure decision functions (no I/O; unit-testable) --------------------------

/**
 * The non-venue recovery decision for one token. Returns an action descriptor.
 * `needs-venue-check` means the caller must read the venue, then call
 * resolveStaleOpen() with the result (the open case is the only one that needs
 * the venue, because clearing it blind risks a double-open).
 * @param {{ state?: string|null, ageMs?: number, hasLivePosition?: boolean, blockedReason?: string|null, errorResetCount?: number }} args
 * @returns {{ action: string }}
 */
export function reconcileNeed({ state, ageMs, hasLivePosition, blockedReason, errorResetCount = 0 } = {}) {
  if (state === State.ERROR) {
    return errorResetCount >= ERROR_MAX_RESETS ? { action: 'park-error' } : { action: 'reset-error' };
  }
  if (state === State.POSITION_OPEN_PENDING && !hasLivePosition && ageMs > STALE_PENDING_MS) {
    return { action: 'needs-venue-check' };
  }
  if (state === State.TOPUP_PENDING && ageMs > STALE_PENDING_MS) {
    return { action: 'clear-topup' };
  }
  if (state === State.BLOCKED && !TERMINAL_BLOCKED.has(blockedReason) && ageMs > BLOCKED_ESCALATE_MS) {
    return { action: 'escalate' };
  }
  return { action: 'none' };
}

// The venue-dependent decision for a stale position_open_pending. `venuePos`:
//   undefined -> couldn't read     => HOLD (never risk a double-open)
//   has size  -> a real position   => CONFIRM (record it; the 3a guard then blocks re-open)
//   null/0    -> venue is empty     => CLEAR (the open never landed; let the tick re-open)
export function resolveStaleOpen(venuePos) {
  if (venuePos === undefined) return { action: 'hold' };
  if (venuePos && Number(venuePos.sizeUsd) > 0) return { action: 'confirm-open', pos: venuePos };
  return { action: 'clear-open' };
}

// Per-instance bookkeeping (resets on restart, which is fine: a restart just
// re-allows a few error resets / re-arms one escalation).
const _errorResetCount = new Map(); // token_id -> count
const _lastEscalateAt = new Map(); // token_id -> ms

let _master = null;
function master() {
  if (!_master) _master = loadKeypair(config.treasuryKey);
  return _master;
}

const _authCache = new Map(); // base58 pubkey -> { token, expiresAt }
async function getAuthToken(kp) {
  const key = kp.publicKey.toBase58();
  const now = Date.now();
  const cached = _authCache.get(key);
  if (cached && (!cached.expiresAt || cached.expiresAt - now > 30 * 60_000)) return cached.token;
  const r = await imperialAuthenticate(kp);
  _authCache.set(key, { token: r.token, expiresAt: r.expiresAt ?? null });
  return r.token;
}

function sym(t) {
  return (t.underlying || t.ticker || '').toString().toUpperCase();
}
function side(t) {
  return (t.direction || 'long').toString().toLowerCase();
}
function ageMs(wf) {
  const u = wf?.updated_at ? new Date(wf.updated_at).getTime() : null;
  return Number.isFinite(u) ? Date.now() - u : Infinity;
}

// Read the live position from whichever venue this token trades on.
// Returns: undefined = "couldn't determine" (caller must NOT clear), null =
// confirmed no position, or { sizeUsd, collateralUsd } when one exists.
async function readVenuePosition(t) {
  const router = (t.router || 'imperial').toString();
  let kp;
  try {
    kp = walletForToken(master(), t);
  } catch {
    return undefined;
  }
  if (!kp) return undefined;

  if (router === 'imperial') {
    if (t.imperial_profile_index == null) return undefined;
    let auth;
    try {
      auth = await getAuthToken(kp);
    } catch {
      return undefined;
    }
    try {
      return await imperialReadPosition({
        profileIndex: t.imperial_profile_index,
        symbol: sym(t),
        side: side(t),
        token: auth,
        wallet: kp.publicKey.toBase58(),
      });
    } catch {
      return undefined;
    }
  }

  if (router === 'jupiter' || router === 'external') {
    try {
      return await readPerpPosition({ symbol: sym(t), side: side(t), kp });
    } catch {
      return undefined;
    }
  }

  return undefined; // unknown router -> never clear
}

let _running = false;
let _lastRunAt = null;
let _lastActions = 0;

export function getStateReconcileStatus() {
  return {
    enabled: config.stateReconcileEnabled,
    running: _running,
    lastRunAt: _lastRunAt,
    lastActions: _lastActions,
  };
}

async function safeWrite(label, fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    keeperLog(null, 'warn', `state-reconcile: ${label} write failed`, { error: e.message });
    return false;
  }
}

export async function runStateReconcileTick() {
  if (!config.stateReconcileEnabled) return { skipped: 'disabled' };
  if (_running) return { skipped: 'already-running' };
  _running = true;
  const started = Date.now();
  let actions = 0;

  try {
    let tokens;
    try {
      tokens = await listStuckTokens(); // targeted, index-backed, uncapped (see KEEPER_RECONCILE.md)
    } catch (e) {
      keeperLog(null, 'warn', 'state-reconcile: listStuckTokens failed', { error: e.message });
      return { actions: 0, errors: 1 };
    }

    for (const t of tokens) {
      const wf = workflowStateFromToken(t);
      if (!wf) continue;
      const age = ageMs(wf);
      const need = reconcileNeed({
        state: wf.state,
        ageMs: age,
        hasLivePosition: !!t.position_opened_at,
        blockedReason: wf.blocked_reason,
        errorResetCount: _errorResetCount.get(t.id) ?? 0,
      });

      switch (need.action) {
        case 'reset-error': {
          // error -> idle (bounded) so the tick re-evaluates. The only state with
          // no other recovery path.
          if (await safeWrite('error-reset', () => setWorkflowStateSync(t.id, State.IDLE, { next_retry_at: null }))) {
            const n = (_errorResetCount.get(t.id) ?? 0) + 1;
            _errorResetCount.set(t.id, n);
            keeperLog(t, 'info', `state-reconcile: error -> idle (reset ${n}/${ERROR_MAX_RESETS})`, { reset: n, max: ERROR_MAX_RESETS });
            actions++;
          }
          break;
        }
        case 'park-error': {
          // looped too many times -> stop; park as blocked for a human.
          if (
            await safeWrite('error-park', () =>
              setWorkflowStateSync(t.id, State.BLOCKED, {
                blocked_reason: 'error_recovery_exhausted',
                next_retry_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
              }),
            )
          ) {
            keeperLog(t, 'warn', 'state-reconcile: error recovery exhausted', {
              resets: _errorResetCount.get(t.id) ?? ERROR_MAX_RESETS,
            });
            actions++;
          }
          break;
        }
        case 'needs-venue-check': {
          // stale position_open_pending: confirm via the venue BEFORE clearing
          // (clearing blind risks a double-open).
          const r = resolveStaleOpen(await readVenuePosition(t));
          if (r.action === 'confirm-open') {
            const pos = r.pos;
            const note = `[state-reconcile] ${t.ticker}: confirmed stale open coll=$${Number(pos.collateralUsd ?? 0).toFixed(2)} size=$${Number(pos.sizeUsd).toFixed(2)}`;
            if (
              await safeWrite('pending-confirm', () =>
                sendReport([
                  {
                    token_id: t.id,
                    position_opened: true,
                    position_collateral_usd: Number(pos.collateralUsd ?? 0) || undefined,
                    position_size_usd: Number(pos.sizeUsd),
                    events: [{ kind: 'tick', note }],
                  },
                ]),
              )
            ) {
              keeperLog(t, 'info', note);
              actions++;
            }
          } else if (r.action === 'clear-open') {
            const note = `[state-reconcile] ${t.ticker}: cleared stale open sig (venue empty, age ${Math.round(age / 60000)}m)`;
            if (
              await safeWrite('pending-clear', () =>
                sendReport([{ token_id: t.id, pending_drift_sig: null, events: [{ kind: 'tick', note }] }]),
              )
            ) {
              await safeWrite('pending-reset', () => setWorkflowStateSync(t.id, State.IDLE, { next_retry_at: null }));
              keeperLog(t, 'info', note);
              actions++;
            }
          }
          // r.action === 'hold' -> couldn't read the venue; leave untouched.
          break;
        }
        case 'clear-topup': {
          // stale topup sig (live position). Low risk: a re-topup is recoverable
          // over-collateralization, not a second position.
          const note = `[state-reconcile] ${t.ticker}: cleared stale topup sig (age ${Math.round(age / 60000)}m)`;
          if (
            await safeWrite('topup-clear', () =>
              sendReport([{ token_id: t.id, pending_drift_sig: null, events: [{ kind: 'tick', note }] }]),
            )
          ) {
            keeperLog(t, 'info', note);
            actions++;
          }
          break;
        }
        case 'escalate': {
          // never auto-unblock; just surface a token blocked too long (throttled).
          const last = _lastEscalateAt.get(t.id) ?? 0;
          if (Date.now() - last >= ESCALATE_REALERT_MS) {
            _lastEscalateAt.set(t.id, Date.now());
            keeperLog(t, 'warn', 'state-reconcile: token blocked too long', {
              blocked_reason: wf.blocked_reason ?? null,
              blocked_for_min: Math.round(age / 60000),
            });
            actions++;
          }
          break;
        }
        // 'none' -> nothing to do this tick.
      }

      if (wf.state !== State.ERROR) _errorResetCount.delete(t.id); // not in error -> clear any prior count
    }
  } finally {
    _running = false;
    _lastRunAt = new Date().toISOString();
    _lastActions = actions;
    if (actions > 0) keeperLog(null, 'info', 'state-reconcile: tick done', { actions, ms: Date.now() - started });
  }
  return { actions };
}
