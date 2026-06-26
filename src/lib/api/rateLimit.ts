// Per-key/endpoint rate limiting. In production the blanket edge limit is a
// Cloudflare WAF Rate Limiting Rule on /api/v1/* (configured in the dashboard);
// this in-Worker token bucket adds the per-key tier. See plan/PERPSPAD_LAUNCH.md §5.
// NOTE: the bucket is per-Worker-instance (coarse). For exact global counters,
// swap this for the Workers rate-limit binding or a Durable Object (plan §11b).
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limitPerMin: number): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const slot = buckets.get(key);
  if (!slot || now > slot.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (slot.count >= limitPerMin) return { ok: false, retryAfter: Math.ceil((slot.resetAt - now) / 1000) };
  slot.count += 1;
  return { ok: true };
}
