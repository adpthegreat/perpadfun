// Pure PnL / entry-mid helpers, extracted from loop.js so they're unit-testable
// without the venue/RPC. See KEEPER_PNL.md and test/phase3-pnl/.

// Entry-mid precedence (tiers 1-3 of resolveImperialEntryPrice): the venue's
// entry price wins, else the venue's current mark, else our previously-stored
// launch_mid. Returns { price, source } or { price: null, source: null }.
// (The 4th tier - a live mark-price API call - stays in loop.js as it's I/O.)
export function pickEntryMid({ venueEntry, venueMark, existingMid } = {}) {
  const e = Number(venueEntry);
  if (Number.isFinite(e) && e > 0) return { price: e, source: "imperial" };
  const m = Number(venueMark);
  if (Number.isFinite(m) && m > 0) return { price: m, source: "perpspad_entry_mid" };
  const x = Number(existingMid);
  if (Number.isFinite(x) && x > 0) return { price: x, source: "reconciled" };
  return { price: null, source: null };
}

// Windowed mark capture: when the venue never returned an entry and launch_mid is
// still null, adopt the current mark as the entry basis - but ONLY within
// `windowMs` of open (where mark ~ entry). Returns the mark to store, or null.
// Past the window we never adopt the current mark (that would erase a moved
// position's real PnL); and we never overwrite an existing entry.
export function captureMarkAsEntry({ existingMid, mark, openedAt, now, windowMs } = {}) {
  if (Number(existingMid) > 0) return null; // already have an entry basis
  const m = Number(mark);
  if (!(m > 0)) return null; // no usable mark
  if (!openedAt) return null;
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return null;
  if (Number(now) - opened >= Number(windowMs)) return null; // aged -> never adopt current mark
  return m;
}

// PnL from a stored entry, used when the venue reports pnl=$0:
//   pnl = ((mark - entryMid) / entryMid) * sizeUsd * dir
// Guards: a non-positive entry/mark/size yields 0 (can't compute).
export function computePnlFromEntry({ mark, entryMid, sizeUsd, side } = {}) {
  const m = Number(mark);
  const e = Number(entryMid);
  const s = Number(sizeUsd);
  if (!(e > 0) || !(m > 0) || !(s > 0)) return 0;
  const dir = String(side).toLowerCase() === "short" ? -1 : 1;
  return ((m - e) / e) * s * dir;
}
