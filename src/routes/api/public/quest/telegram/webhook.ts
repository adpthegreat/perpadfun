// POST /api/public/quest/telegram/webhook — Telegram Bot API webhook.
//
// Identity-capture half of the TG check: when a user opens the bot via the quest deep-link
// (t.me/<bot>?start=<session_id>) and presses Start, Telegram delivers `/start <session_id>`
// with the user's numeric id. We bind that telegram_user_id onto the quest session, then
// reply with a button to join the channel. Actual membership is confirmed separately by
// telegram/status.ts via getChatMember.
//
// Register once after deploy:
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d url=https://<host>/api/public/quest/telegram/webhook \
//        -d secret_token=<TELEGRAM_WEBHOOK_SECRET>
//
// Telegram sends the secret back in the X-Telegram-Bot-Api-Secret-Token header on every call.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { telegramCall } from "@/lib/quest/server";

// Always 200 so Telegram does not retry; the user-facing outcome is conveyed via sendMessage.
function ok() {
  return new Response("ok", { status: 200 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TgUpdate = {
  message?: {
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
  };
};

async function reply(chatId: number, text: string, withJoinButton: boolean) {
  const channelUrl = process.env.TELEGRAM_CHANNEL_URL;
  const reply_markup =
    withJoinButton && channelUrl
      ? { inline_keyboard: [[{ text: "Join PerpsPad channel →", url: channelUrl }]] }
      : undefined;
  try {
    await telegramCall("sendMessage", { chat_id: chatId, text, reply_markup });
  } catch {
    // best-effort; the webhook still acks 200
  }
}

// Bind the Telegram identity onto the session and tell the user what to do next. Isolated so
// any throw (e.g. a misconfigured supabaseAdmin) still lets the webhook ack 200.
async function handleStart(chatId: number, userId: number, username: string | undefined, payload: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from("quest_entries")
      .update({ telegram_user_id: userId, telegram_username: username ?? null })
      .eq("session_id", payload)
      .is("telegram_user_id", null)
      .select("session_id")
      .maybeSingle();

    if (error) {
      // 23505 = this Telegram account is already bound to a different quest entry.
      const msg =
        error.code === "23505"
          ? "This Telegram account is already linked to another entry."
          : "Something went wrong linking your entry. Try again from the site.";
      await reply(chatId, msg, false);
      return;
    }

    if (data) {
      await reply(chatId, "✅ Linked! Join the channel below, then head back to the site to finish.", true);
    } else {
      // No row updated: either already linked to this session, or the session expired.
      await reply(chatId, "Already linked. Join the channel below, then return to the site.", true);
    }
  } catch {
    await reply(chatId, "Something went wrong on our side. Please try again in a moment.", false);
  }
}

export const Route = createFileRoute("/api/public/quest/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
        if (!expected) return new Response("not configured", { status: 500 });
        if (request.headers.get("x-telegram-bot-api-secret-token") !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        let update: TgUpdate;
        try {
          update = (await request.json()) as TgUpdate;
        } catch {
          return ok();
        }

        const msg = update.message;
        const chatId = msg?.chat?.id;
        const userId = msg?.from?.id;
        const text = msg?.text ?? "";
        if (!chatId || !userId || !text.startsWith("/start")) return ok();

        const payload = text.split(/\s+/)[1]; // session_id
        if (!payload || !UUID_RE.test(payload)) {
          await reply(chatId, "Open the quest from the PerpsPad site so I can link your entry.", false);
          return ok();
        }

        await handleStart(chatId, userId, msg?.from?.username, payload);
        return ok();
      },
    },
  },
});
