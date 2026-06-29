// POST /api/public/quest/session — create or resume a quest session. Issues a session_id
// (the funnel anchor, stored client-side) + the entrant's own referral_code, and binds an
// optional ?ref= referrer. Public + IP rate-limited; writes via the service-role admin client.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiOk, apiErr } from "@/lib/api/respond";
import { rateLimit } from "@/lib/api/rateLimit";
import { clientIp, ipHash, randomReferralCode, safeJson } from "@/lib/quest/server";
import { stepsOf, isWellFormedReferralCode } from "@/lib/quest/shared";

const SELECT = "session_id, referral_code, referred_by, x_followed, x_retweeted, tg_joined";

const Body = z.object({
  session_id: z.string().uuid().optional(),
  ref: z.string().max(32).optional(),
});

export const Route = createFileRoute("/api/public/quest/session")({
  server: {
    handlers: {
      POST: ({ request }) =>
        safeJson(async () => {
          const ip = clientIp(request);
          const rl = rateLimit(`ip:${ip}:quest-session`, 30);
          if (!rl.ok) {
            return apiErr(429, "rate_limited", "slow down", undefined, {
              "Retry-After": String(rl.retryAfter ?? 60),
            });
          }

          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            raw = {};
          }
          const parsed = Body.safeParse(raw ?? {});
          if (!parsed.success) return apiErr(400, "bad_request", parsed.error.message);
          const { session_id, ref } = parsed.data;

          // Resume an existing session if the client already has one.
          if (session_id) {
            const { data: existing, error } = await supabaseAdmin
              .from("quest_entries")
              .select(SELECT)
              .eq("session_id", session_id)
              .maybeSingle();
            if (error) return apiErr(500, "db_error", error.message);
            if (existing) {
              return apiOk({
                session_id: existing.session_id,
                referral_code: existing.referral_code,
                referred_by: existing.referred_by,
                steps: stepsOf(existing),
              });
            }
            // Unknown/stale session_id → fall through and mint a fresh one.
          }

          // Resolve the referrer only if well-formed and real (a brand-new row can't self-refer).
          let referred_by: string | null = null;
          if (ref && isWellFormedReferralCode(ref)) {
            const { data: referrer } = await supabaseAdmin
              .from("quest_entries")
              .select("referral_code")
              .eq("referral_code", ref)
              .maybeSingle();
            if (referrer) referred_by = referrer.referral_code;
          }

          const ua = request.headers.get("user-agent")?.slice(0, 400) ?? null;
          const iphash = await ipHash(ip);

          // Insert, retrying on the (rare) referral_code unique collision.
          for (let attempt = 0; attempt < 5; attempt++) {
            const { data, error } = await supabaseAdmin
              .from("quest_entries")
              .insert({
                session_id: crypto.randomUUID(),
                referral_code: randomReferralCode(),
                referred_by,
                ip_hash: iphash,
                user_agent: ua,
              })
              .select(SELECT)
              .single();
            if (!error && data) {
              return apiOk({
                session_id: data.session_id,
                referral_code: data.referral_code,
                referred_by: data.referred_by,
                steps: stepsOf(data),
              });
            }
            if (error && error.code !== "23505") return apiErr(500, "db_error", error.message);
            // 23505 = unique_violation on referral_code/session_id → retry with fresh values.
          }
          return apiErr(500, "code_collision", "could not allocate a referral code");
        }),
    },
  },
});
