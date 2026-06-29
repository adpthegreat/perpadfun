// POST /api/public/quest/step — record an honorary quest step (follow / retweet / join-TG)
// against a session. These are NOT verified against X or Telegram (no paid X API / OAuth, and
// TG join is click-through); we record a server timestamp so claim eligibility is tracked.
// The real getChatMember verification path still exists in telegram/status.ts if you want to
// upgrade tg_joined from honorary to verified.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiOk, apiErr } from "@/lib/api/respond";
import { rateLimit } from "@/lib/api/rateLimit";
import { clientIp, safeJson } from "@/lib/quest/server";
import { stepsOf } from "@/lib/quest/shared";

const SELECT = "x_followed, x_retweeted, tg_joined";

const Body = z.object({
  session_id: z.string().uuid(),
  step: z.enum(["x_follow", "x_retweet", "tg_join"]),
});

export const Route = createFileRoute("/api/public/quest/step")({
  server: {
    handlers: {
      POST: ({ request }) =>
        safeJson(async () => {
          const ip = clientIp(request);
          const rl = rateLimit(`ip:${ip}:quest-step`, 60);
          if (!rl.ok) {
            return apiErr(429, "rate_limited", "slow down", undefined, {
              "Retry-After": String(rl.retryAfter ?? 60),
            });
          }

          let raw: unknown;
          try {
            raw = await request.json();
          } catch {
            return apiErr(400, "bad_request", "invalid json");
          }
          const parsed = Body.safeParse(raw);
          if (!parsed.success) return apiErr(400, "bad_request", parsed.error.message);
          const { session_id, step } = parsed.data;

          const now = new Date().toISOString();
          const patch =
            step === "x_follow"
              ? { x_followed: true, x_followed_at: now }
              : step === "x_retweet"
                ? { x_retweeted: true, x_retweeted_at: now }
                : { tg_joined: true, tg_joined_at: now };

          const { data, error } = await supabaseAdmin
            .from("quest_entries")
            .update(patch)
            .eq("session_id", session_id)
            .select(SELECT)
            .maybeSingle();
          if (error) return apiErr(500, "db_error", error.message);
          if (!data) return apiErr(404, "unknown_session", "session not found");

          return apiOk({ steps: stepsOf(data) });
        }),
    },
  },
});
