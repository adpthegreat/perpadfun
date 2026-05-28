// Idempotency helpers.
//
// Every on-chain intent is keyed by a stable hash so a keeper retry after a
// crash cannot insert two rows in tx_log or double-submit the same intent.
//
// The hash is sha256(token_id|kind|...parts).slice(0, 32). We bucket by
// `tickMinute` (or a finer slice) when we want "same intent inside this
// window" semantics, e.g. so a swap retried within the same tick collapses
// to a single row but a fresh tick can issue a new intent.

import { createHash } from 'crypto';

export function intentHash(parts) {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p));
  h.update('|');
  return h.digest('hex').slice(0, 32);
}

export function tickBucket(date = new Date(), minutes = 1) {
  const ms = minutes * 60_000;
  return Math.floor(date.getTime() / ms);
}

// Build a tx_log entry payload destined for /api/public/keeper/report.
// Server is the source of truth and dedupes on (token_id, kind, intent_hash).
export function buildTxLogEntry({
  kind,
  intent,
  status,
  signature,
  amountUsd,
  amountSol,
  amountTokens,
  error,
}) {
  return {
    kind,
    intent_hash: intent,
    status,
    signature: signature ?? null,
    amount_usd: amountUsd ?? null,
    amount_sol: amountSol ?? null,
    amount_tokens: amountTokens ?? null,
    error: error ?? null,
  };
}
