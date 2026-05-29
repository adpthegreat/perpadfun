// Client-side resilience for the keeper's OUTBOUND calls. When an external
// provider (Solana RPC / Imperial / Jupiter) returns 429 or a transient error,
// back off (exponential + jitter, honoring Retry-After) and retry. This is
// deliberately just a wrapper + a retry fallback — no proactive token buckets
// or connection proxies. See KEEPER_RATE_LIMIT_REFACTOR.md.

import { backOff } from "./backoff.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP (Imperial / Jupiter): a moderate budget; 429s come with Retry-After.
const HTTP_RETRY = { numOfAttempts: 5, startingDelay: 300, timeMultiple: 2, maxDelay: 8000, jitter: "full" };
// Solana reads: cheap + high-volume, so a SMALL budget with a short cap — a
// flaky read must never stall a tick. (A read is not a confirmation poll.)
const READ_RETRY = { numOfAttempts: 3, startingDelay: 200, timeMultiple: 2, maxDelay: 1500, jitter: "full" };

// Thrown by poll loops (e.g. waiting for a tx to confirm) so backOff schedules
// the next poll instead of giving up.
export class TransactionNotYetConfirmedError extends Error {
  constructor() {
    super("transaction not yet confirmed");
    this.name = "TransactionNotYetConfirmedError";
  }
}

// HTTP wrapper (Imperial / Jupiter). On 429/503 it waits Retry-After (capped)
// then retries; transient network errors also retry. Any other status is
// returned for the caller to handle, so business 4xx behave exactly as before.
// Returns the unread Response.
export async function limitedFetch(url, init = {}) {
  return backOff(
    async () => {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after"));
        if (ra > 0) await sleep(Math.min(ra * 1000, 8000));
        throw new Error(`http ${res.status}`);
      }
      return res;
    },
    {
      ...HTTP_RETRY,
      retry: (e) =>
        /http (429|503)|fetch failed|network|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(e?.message ?? ""),
    },
  );
}

// Drop-in for fetch() on Jupiter calls.
export const jupFetch = (url, init) => limitedFetch(url, init);

// Generic call wrapper (Solana RPC reads, etc.). Retries ONLY when the error
// looks like a rate limit / transient network blip — never on a real RPC error,
// so callers that treat a failure as a valid answer (e.g. "account not found")
// are unaffected.
export async function withRetry(fn, opts = {}) {
  return backOff(fn, {
    ...READ_RETRY,
    ...opts, // callers can widen the budget for higher-stakes reads (e.g. checkSig)
    retry: (e) =>
      /\b429\b|rate.?limit|too many requests|\b503\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|socket hang up/i.test(
        e?.message ?? "",
      ),
  });
}
