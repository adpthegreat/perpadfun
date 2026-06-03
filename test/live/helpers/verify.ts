// Verification helpers — the meat of the live tests.
//
// Imperial's /mobile/orders is unreliable: it often 200-OKs but the on-chain
// tx never lands (silent no-op), AND sometimes returns success:false even
// when the order actually fills. The only reliable verification is to
// snapshot profile USDC + position state before/after and check what
// actually moved on-chain.
import { getPositions } from "../../../keeper/src/imperial.js";
import { getProfileUsdcUi } from "./profile.js";

interface ImperialPositionLike {
  source?: string;
  status?: string;
  profileIndex?: number | string;
  profile?: number | string;
  symbol?: string;
  asset?: string;
  market?: string;
  side?: number | string;
  direction?: number | string;
  positionSide?: number | string;
  openedAt?: number | string;
  opened_at?: number | string;
  id?: string;
  positionId?: string;
  position_id?: string;
  sizeUsd?: number | string;
  positionSizeUsd?: number | string;
  notionalUsd?: number | string;
  notional?: number | string;
  collateralUsd?: number | string;
  marginUsd?: number | string;
  collateral?: number | string;
}

function normalizeSide(value: number | string | undefined): string {
  if (value === 0 || value === "0") return "long";
  if (value === 1 || value === "1") return "short";
  const raw = String(value ?? "").toLowerCase();
  if (raw === "long" || raw === "buy") return "long";
  if (raw === "short" || raw === "sell") return "short";
  return raw;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Find a freshly-opened position matching (symbol, side) in the given profile.
// `since` = unix seconds; positions with openedAt < since are ignored so we
// don't pick up stale state from a previous test.
export async function pollForFreshPosition(opts: {
  token: string;
  wallet: string;
  profileIndex: number;
  symbol: string;
  side: "long" | "short";
  since: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  log?: (msg: string) => void;
}): Promise<ImperialPositionLike | null> {
  const {
    token,
    wallet,
    profileIndex,
    symbol,
    side,
    since,
    pollIntervalMs = 2000,
    maxAttempts = 15,
    log = () => {},
  } = opts;
  const sym = symbol.toUpperCase();

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let raw;
    try {
      raw = await getPositions(wallet, { token });
    } catch (e) {
      log(`poll ${i + 1}/${maxAttempts}: getPositions threw: ${(e as Error).message}`);
      continue;
    }
    const list: ImperialPositionLike[] = Array.isArray(raw?.dataList)
      ? raw.dataList
      : Array.isArray(raw)
        ? raw
        : raw?.positions || raw?.data || [];
    const hit = list.find((p) => {
      const pi = num(p?.profileIndex ?? p?.profile);
      if (Number.isFinite(pi) && pi !== profileIndex) return false;
      const psym = String(p?.symbol || p?.asset || p?.market || "").toUpperCase();
      if (psym !== sym) return false;
      const pside = normalizeSide(p?.side ?? p?.direction ?? p?.positionSide);
      if (pside && pside !== side) return false;
      if (p?.source && p.source !== "imperial") return false;
      if (p?.status && p.status !== "open") return false;
      const openedAt = num(p?.openedAt ?? p?.opened_at ?? 0);
      if (openedAt && openedAt < since) return false;
      return true;
    });
    log(`poll ${i + 1}/${maxAttempts}: fresh ${sym} ${side} match=${hit ? "YES" : "no"}`);
    if (hit) return hit;
  }
  return null;
}

// Poll until a position matching (symbol, side, profile) is gone (or sees
// `status: 'closed'`). Used to verify close orders fill.
export async function pollForPositionGone(opts: {
  token: string;
  wallet: string;
  profileIndex: number;
  symbol: string;
  side: "long" | "short";
  pollIntervalMs?: number;
  maxAttempts?: number;
  log?: (msg: string) => void;
}): Promise<boolean> {
  const {
    token,
    wallet,
    profileIndex,
    symbol,
    side,
    pollIntervalMs = 2000,
    maxAttempts = 15,
    log = () => {},
  } = opts;
  const sym = symbol.toUpperCase();

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    let raw;
    try {
      raw = await getPositions(wallet, { token });
    } catch (e) {
      log(`close-poll ${i + 1}/${maxAttempts}: getPositions threw: ${(e as Error).message}`);
      continue;
    }
    const list: ImperialPositionLike[] = Array.isArray(raw?.dataList)
      ? raw.dataList
      : Array.isArray(raw)
        ? raw
        : raw?.positions || raw?.data || [];
    const still = list.find((p) => {
      const pi = num(p?.profileIndex ?? p?.profile);
      if (Number.isFinite(pi) && pi !== profileIndex) return false;
      const psym = String(p?.symbol || p?.asset || p?.market || "").toUpperCase();
      if (psym !== sym) return false;
      const pside = normalizeSide(p?.side ?? p?.direction ?? p?.positionSide);
      if (pside && pside !== side) return false;
      if (p?.source && p.source !== "imperial") return false;
      if (p?.status && p.status !== "open") return false;
      return true;
    });
    log(`close-poll ${i + 1}/${maxAttempts}: still-open=${still ? "YES" : "no"}`);
    if (!still) return true;
  }
  return false;
}

// Refund detection — the production keeper's defense against gmtrade's
// (and historically other venues') sign-and-refund-in-same-tx behaviour.
// We snapshot USDC pre-order; if the drain is < half the expected
// collateral, the order didn't actually attach. See
// keeper/src/loop.js:1771-1812 for the production equivalent.
export interface UsdcSnapshot {
  before: number;
  after: number;
  delta: number;
  expectedDrain: number;
  attached: boolean;
}

export async function snapshotUsdc(token: string, profileIndex: number): Promise<number> {
  return getProfileUsdcUi(token, profileIndex);
}

export async function verifyAttachedByUsdcDrain(opts: {
  token: string;
  profileIndex: number;
  beforeUi: number;
  expectedDrainUsd: number;
  waitMs?: number;
}): Promise<UsdcSnapshot> {
  const { token, profileIndex, beforeUi, expectedDrainUsd, waitMs = 2500 } = opts;
  await new Promise((r) => setTimeout(r, waitMs));
  const afterUi = await getProfileUsdcUi(token, profileIndex);
  const delta = Math.max(0, beforeUi - afterUi);
  return {
    before: beforeUi,
    after: afterUi,
    delta,
    expectedDrain: expectedDrainUsd,
    attached: delta >= expectedDrainUsd * 0.5,
  };
}

// Helper for tests: read position size + collateral from the Imperial
// /positions row (without going through imperialReadPosition's defensive
// normalization, which the test wants to verify separately).
export function readPositionRow(p: ImperialPositionLike | null): {
  sizeUsd: number;
  collateralUsd: number;
  positionId: string | null;
} {
  if (!p) return { sizeUsd: 0, collateralUsd: 0, positionId: null };
  const sizeUsd = num(p.sizeUsd ?? p.positionSizeUsd ?? p.notionalUsd ?? p.notional);
  const collateralUsd = num(p.collateralUsd ?? p.marginUsd ?? p.collateral);
  const positionId = p.id || p.positionId || p.position_id || null;
  return { sizeUsd, collateralUsd, positionId };
}
