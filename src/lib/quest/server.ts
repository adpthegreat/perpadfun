// Server-only quest helpers: client IP, IP hashing, referral-code generation, and the
// Telegram Bot API wrapper used by the webhook + membership check. Pure logic lives in
// ./shared.ts so it can be tested without env or network.
import { genReferralCode, isJoinedStatus } from "@/lib/quest/shared";

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Store a hash, never the raw IP. Salted SHA-256, truncated to 16 bytes hex.
export async function ipHash(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`perpspad-quest:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function randomReferralCode(len = 8): string {
  return genReferralCode(crypto.getRandomValues(new Uint8Array(len)));
}

const TG_API = "https://api.telegram.org";

// Minimal Telegram Bot API call. Returns the parsed JSON envelope ({ ok, result } | { ok:false }).
export async function telegramCall(
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not configured");
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
}

// Ask Telegram whether `userId` is currently in the configured channel. The bot must be an
// admin of the channel for this to resolve arbitrary users.
export async function getChannelMembership(
  userId: number,
): Promise<{ ok: boolean; isMember: boolean; status?: string }> {
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  if (!chatId) throw new Error("TELEGRAM_CHANNEL_ID not configured");
  const r = await telegramCall("getChatMember", { chat_id: chatId, user_id: userId });
  if (!r?.ok) return { ok: false, isMember: false };
  const result = r.result as { status?: string; is_member?: boolean } | undefined;
  return {
    ok: true,
    isMember: isJoinedStatus(result?.status, result?.is_member),
    status: result?.status,
  };
}
