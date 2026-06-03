// Position reconcile pass.
//
// Problem this solves:
//   When the perp opens but Imperial's /positions hasn't indexed the new
//   position yet, loop.js does an "OPTIMISTIC WRITE" that writes the
//   REQUESTED collateral/size, not the venue's actual fill. If Imperial
//   eventually fills with different numbers, our DB is wrong forever.
//
// Fix: every reconcileTickMs, look at every imperial-routed token whose
// position was opened in the last reconcileWindowMin minutes. Re-query
// /positions. If the venue now reports a real position and it differs from
// the DB by more than a small epsilon, write the venue's values back.
//
// This module ONLY corrects (collateral, size). It does NOT open, close, or
// top up. Realized PnL / withdrawals stay in loop.js.

import { config } from './config.js';
import { listActiveTokens, sendReport } from './perpad.js';
import { authenticate as imperialAuthenticate } from './imperial.js';
import { imperialReadPosition } from './imperialPerps.js';
import { loadKeypair, walletForToken } from './wallet.js';
import { workflowStateFromToken, State } from './workflow.js';

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
  if (cached && (!cached.expiresAt || cached.expiresAt - now > 30 * 60_000)) {
    return cached.token;
  }
  const r = await imperialAuthenticate(kp);
  _authCache.set(key, { token: r.token, expiresAt: r.expiresAt ?? null });
  return r.token;
}

let _lastRunAt = null;
let _lastFixed = 0;
let _lastChecked = 0;
let _running = false;

export function getReconcileStatus() {
  return {
    enabled: config.reconcileEnabled,
    tickMs: config.reconcileTickMs,
    windowMin: config.reconcileWindowMin,
    running: _running,
    lastRunAt: _lastRunAt,
    lastFixed: _lastFixed,
    lastChecked: _lastChecked,
  };
}

const EPS_USD = 1; // ignore sub-$1 drift; venue rounding is noisy

function within(a, b, eps) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= eps;
}

function sym(t) {
  return (t.underlying || t.ticker || '').toString().toUpperCase();
}

function side(t) {
  return (t.direction || 'long').toString().toLowerCase();
}

export async function runReconcileTick() {
  if (!config.reconcileEnabled) return { skipped: 'disabled' };
  if (!config.imperial.enabled) return { skipped: 'imperial-disabled' };
  if (_running) return { skipped: 'already-running' };
  _running = true;
  const startedAt = Date.now();
  let tokens = [];
  let checked = 0;
  let fixed = 0;
  const reports = [];

  try {
    try {
      tokens = await listActiveTokens();
    } catch (e) {
      console.warn(`[reconcile] listActiveTokens failed: ${e.message}`);
      return { checked: 0, fixed: 0, errors: 1 };
    }

    const windowMs = config.reconcileWindowMin * 60_000;
    const cutoff = Date.now() - windowMs;

    for (const t of tokens) {
      if ((t.router || 'imperial') !== 'imperial') continue;

      // 3c: confirm a late-indexed open. A token stuck in position_open_pending
      // with no recorded position — re-read /positions; if the venue now shows
      // one, record it (position_opened + coll/size) so the keeper's 3a guard
      // sees position_open and won't re-open. Catches positions that index
      // AFTER the open tick, before 3a's retry deadline could let a duplicate
      // through. See OPEN_CHAIN_REFACTOR_V2.md.
      const wf = workflowStateFromToken(t);
      if (
        wf?.state === State.POSITION_OPEN_PENDING &&
        !t.position_opened_at &&
        t.imperial_profile_index != null
      ) {
        checked++;
        let kpp;
        try {
          kpp = walletForToken(master(), t);
        } catch {
          continue;
        }
        if (!kpp) continue;
        let authTokenP;
        try {
          authTokenP = await getAuthToken(kpp);
        } catch {
          continue;
        }
        let posP;
        try {
          posP = await imperialReadPosition({
            profileIndex: t.imperial_profile_index,
            symbol: sym(t),
            side: side(t),
            token: authTokenP,
            wallet: kpp.publicKey.toBase58(),
          });
        } catch {
          continue;
        }
        if (posP && Number(posP.sizeUsd) > 0 && Number(posP.collateralUsd) > 0) {
          fixed++;
          const note = `[reconcile] ${t.ticker}: confirmed late-indexed open coll=$${Number(posP.collateralUsd).toFixed(2)} size=$${Number(posP.sizeUsd).toFixed(2)}`;
          console.log(note);
          reports.push({
            token_id: t.id,
            position_opened: true,
            position_collateral_usd: Number(posP.collateralUsd),
            position_size_usd: Number(posP.sizeUsd),
            events: [{ kind: 'tick', note }],
          });
        }
        continue; // pending handled (confirmed) or still genuinely pending
      }

      if (!t.position_opened_at) continue;
      const openedAt = new Date(t.position_opened_at).getTime();
      if (!Number.isFinite(openedAt) || openedAt < cutoff) continue;
      if (Number(t.position_collateral_usd ?? 0) <= 0) continue; // not an open
      if (t.imperial_profile_index == null) continue;

      checked++;
      let kp;
      try {
        kp = walletForToken(master(), t);
      } catch {
        continue;
      }
      if (!kp) continue;

      let authToken;
      try {
        authToken = await getAuthToken(kp);
      } catch (e) {
        if (config.logVerbose) console.warn(`[reconcile] ${t.ticker} auth failed: ${e.message}`);
        continue;
      }

      let pos;
      try {
        pos = await imperialReadPosition({
          profileIndex: t.imperial_profile_index,
          symbol: sym(t),
          side: side(t),
          token: authToken,
          wallet: kp.publicKey.toBase58(),
        });
      } catch (e) {
        if (config.logVerbose) console.warn(`[reconcile] ${t.ticker} readPos failed: ${e.message}`);
        continue;
      }

      if (!pos || !Number(pos.sizeUsd)) continue; // still not indexed; leave optimistic write

      const venueColl = Number(pos.collateralUsd ?? 0);
      const venueSize = Number(pos.sizeUsd ?? 0);
      const dbColl = Number(t.position_collateral_usd ?? 0);
      const dbSize = Number(t.position_size_usd ?? 0);
      if (venueColl <= 0 || venueSize <= 0) continue;
      if (within(dbColl, venueColl, EPS_USD) && within(dbSize, venueSize, EPS_USD)) continue;

      fixed++;
      const note = `[reconcile] ${t.ticker}: db coll=$${dbColl.toFixed(2)} size=$${dbSize.toFixed(2)} -> venue coll=$${venueColl.toFixed(2)} size=$${venueSize.toFixed(2)}`;
      console.log(note);
      reports.push({
        token_id: t.id,
        position_collateral_usd: venueColl,
        position_size_usd: venueSize,
        events: [
          { kind: 'tick', note },
        ],
      });
    }

    if (reports.length) {
      try {
        await sendReport(reports);
      } catch (e) {
        console.warn(`[reconcile] sendReport failed: ${e.message}`);
      }
    }
  } finally {
    _running = false;
    _lastRunAt = new Date().toISOString();
    _lastFixed = fixed;
    _lastChecked = checked;
    if (fixed > 0 || checked > 0) {
      console.log(`[reconcile] done checked=${checked} fixed=${fixed} ms=${Date.now() - startedAt}`);
    }
  }
  return { checked, fixed };
}
