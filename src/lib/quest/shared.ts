// Pure, environment-free helpers shared by the quest server routes. Kept separate from
// server.ts so the membership decision and step projection can be unit-tested without a
// live Telegram bot or Supabase connection.

export type QuestStep = "x_follow" | "x_retweet" | "tg_join";

export type QuestSteps = {
  x_follow: boolean;
  x_retweet: boolean;
  tg_joined: boolean;
};

// Whether a Telegram getChatMember status counts as "in the channel". `restricted` members
// are only present if is_member is explicitly true; left/kicked/banned are not.
export function isJoinedStatus(status: string | undefined | null, isMemberFlag?: boolean): boolean {
  if (!status) return false;
  if (status === "restricted") return isMemberFlag === true;
  return status === "creator" || status === "administrator" || status === "member";
}

// Project a quest_entries row onto the public step state the frontend consumes.
export function stepsOf(row: {
  x_followed: boolean;
  x_retweeted: boolean;
  tg_joined: boolean;
}): QuestSteps {
  return { x_follow: row.x_followed, x_retweet: row.x_retweeted, tg_joined: row.tg_joined };
}

// URL-safe short referral code. Alphabet excludes 0/O/1/l/I to stay unambiguous when shared.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function genReferralCode(randomBytes: Uint8Array): string {
  let out = "";
  for (const b of randomBytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// A referral code is valid input if it is the right shape — cheap pre-filter before a DB hit.
export function isWellFormedReferralCode(code: string): boolean {
  return /^[2-9A-HJ-NP-Za-km-z]{6,16}$/.test(code);
}

// Cheap client/server shape check for a Solana address (base58, 32–44 chars, no 0/O/I/l).
// The authoritative check (bs58 decodes to 32 bytes) lives server-side in server.ts.
export function isLikelySolAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}
