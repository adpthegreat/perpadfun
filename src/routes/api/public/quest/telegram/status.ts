// GET /api/public/quest/telegram/status?session_id=... — the real server-side Telegram check.
//
// Verification half of the TG step: looks up the telegram_user_id bound to the session (by
// the webhook), asks Telegram getChatMember whether they are in the channel, and persists
// tg_joined on success. The frontend polls this after sending the user to the bot.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiOk, apiErr } from "@/lib/api/respond";
import { rateLimit } from "@/lib/api/rateLimit";
import { clientIp, getChannelMembership } from "@/lib/quest/server";

const SessionId = z.string().uuid();

export const Route = createFileRoute("/api/public/quest/telegram/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ip = clientIp(request);
        // Polled endpoint → a looser bucket than the write routes.
        const rl = rateLimit(`ip:${ip}:quest-tg-status`, 120);
        if (!rl.ok) {
          return apiErr(429, "rate_limited", "slow down", undefined, {
            "Retry-After": String(rl.retryAfter ?? 60),
          });
        }

        const session_id = new URL(request.url).searchParams.get("session_id") ?? "";
        if (!SessionId.safeParse(session_id).success) {
          return apiErr(400, "bad_request", "invalid session_id");
        }

        const { data: row, error } = await supabaseAdmin
          .from("quest_entries")
          .select("telegram_user_id, tg_joined")
          .eq("session_id", session_id)
          .maybeSingle();
        if (error) return apiErr(500, "db_error", error.message);
        if (!row) return apiErr(404, "unknown_session", "session not found");

        // Not linked to a Telegram account yet — the user hasn't opened the bot.
        if (row.telegram_user_id == null) return apiOk({ bound: false, joined: false });
        // Already verified — short-circuit, no need to hit Telegram again.
        if (row.tg_joined) return apiOk({ bound: true, joined: true });

        let membership: Awaited<ReturnType<typeof getChannelMembership>>;
        try {
          membership = await getChannelMembership(row.telegram_user_id);
        } catch (e) {
          return apiErr(500, "telegram_error", e instanceof Error ? e.message : "telegram unavailable");
        }

        const now = new Date().toISOString();
        if (membership.ok && membership.isMember) {
          await supabaseAdmin
            .from("quest_entries")
            .update({ tg_joined: true, tg_joined_at: now, tg_verified_at: now })
            .eq("session_id", session_id);
          return apiOk({ bound: true, joined: true });
        }

        // Bound but not (yet) in the channel — record the check timestamp and report back.
        await supabaseAdmin
          .from("quest_entries")
          .update({ tg_verified_at: now })
          .eq("session_id", session_id);
        return apiOk({ bound: true, joined: false, status: membership.status ?? null });
      },
    },
  },
});
