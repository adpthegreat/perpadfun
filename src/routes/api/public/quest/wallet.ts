// POST /api/public/quest/wallet — submit the SOL address (quest step 4 / wallet capture).
// Validates the address and binds it to the session. The partial unique index on sol_address
// enforces one entry per wallet.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { apiOk, apiErr } from "@/lib/api/respond";
import { rateLimit } from "@/lib/api/rateLimit";
import { clientIp, isValidSolAddress, safeJson } from "@/lib/quest/server";
import { isLikelySolAddress, stepsOf } from "@/lib/quest/shared";

const Body = z.object({
  session_id: z.string().uuid(),
  sol_address: z.string().trim().min(32).max(64),
});

export const Route = createFileRoute("/api/public/quest/wallet")({
  server: {
    handlers: {
      POST: ({ request }) =>
        safeJson(async () => {
          const ip = clientIp(request);
          const rl = rateLimit(`ip:${ip}:quest-wallet`, 30);
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
          const { session_id, sol_address } = parsed.data;

          if (!isLikelySolAddress(sol_address) || !isValidSolAddress(sol_address)) {
            return apiErr(400, "bad_address", "that doesn't look like a Solana address");
          }

          // Gate: steps 1–3 (follow, retweet, join TG) must be done before a wallet is accepted.
          const { data: state, error: selErr } = await supabaseAdmin
            .from("quest_entries")
            .select("x_followed, x_retweeted, tg_joined")
            .eq("session_id", session_id)
            .maybeSingle();
          if (selErr) return apiErr(500, "db_error", selErr.message);
          if (!state) return apiErr(404, "unknown_session", "session not found");
          if (!(state.x_followed && state.x_retweeted && state.tg_joined)) {
            return apiErr(400, "steps_incomplete", "complete the follow, retweet, and Telegram steps first");
          }

          const { data, error } = await supabaseAdmin
            .from("quest_entries")
            .update({ sol_address })
            .eq("session_id", session_id)
            .select("sol_address, x_followed, x_retweeted, tg_joined")
            .maybeSingle();
          if (error) {
            // 23505 = this wallet is already bound to a different quest entry.
            if (error.code === "23505") {
              return apiErr(409, "wallet_taken", "that wallet is already on another entry");
            }
            return apiErr(500, "db_error", error.message);
          }
          if (!data) return apiErr(404, "unknown_session", "session not found");

          return apiOk({ sol_address: data.sol_address, steps: stepsOf(data) });
        }),
    },
  },
});
