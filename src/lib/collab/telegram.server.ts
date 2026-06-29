// Telegram Login Widget verification. Server-only (uses the bot token).
//
// The widget hands the client a signed payload; we re-derive the HMAC with the
// bot token to prove it's genuine (the client can't forge it), then optionally
// confirm the user is actually in our channel/group via getChatMember.
import crypto from "node:crypto";

export type TelegramAuth = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

// https://core.telegram.org/widgets/login#checking-authorization
// secret = SHA256(bot_token); valid when HMAC-SHA256(data_check_string) == hash.
export function verifyTelegramAuth(auth: TelegramAuth, botToken: string): boolean {
  const { hash, ...fields } = auth;
  const dataCheckString = Object.keys(fields)
    .filter((k) => (fields as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${k}=${(fields as Record<string, unknown>)[k]}`)
    .join("\n");

  const secret = crypto.createHash("sha256").update(botToken).digest();
  const hmac = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  // Constant-time compare to avoid leaking the hash via timing.
  const a = Buffer.from(hmac, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // Reject stale logins (older than 24h) to limit replay.
  if (Date.now() / 1000 - auth.auth_date > 86400) return false;
  return true;
}

// True when the user is in the configured chat. Requires the bot to be a member
// (admin, for channels) of that chat. chatId may be a numeric id or "@channel".
export async function checkTelegramMembership(
  userId: number,
  botToken: string,
  chatId: string,
): Promise<boolean> {
  try {
    const url =
      `https://api.telegram.org/bot${botToken}/getChatMember` +
      `?chat_id=${encodeURIComponent(chatId)}&user_id=${userId}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const json = (await res.json()) as { ok: boolean; result?: { status?: string } };
    if (!json.ok || !json.result?.status) return false;
    // "left" / "kicked" mean not a member; everything else counts.
    return ["creator", "administrator", "member", "restricted"].includes(json.result.status);
  } catch {
    return false;
  }
}
