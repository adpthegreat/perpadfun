// Client-visible quest config. Public values only (handles, tweet id, bot/channel) — all
// overridable at build time via VITE_* env, with sane PerpsPad defaults.
const env = import.meta.env;

export const X_HANDLE: string = env.VITE_PERPSPAD_X_HANDLE ?? "perpspadfun";
export const X_TWEET_ID: string = env.VITE_PERPSPAD_X_TWEET_ID ?? ""; // pinned launch tweet id
export const TG_BOT_USERNAME: string = env.VITE_TELEGRAM_BOT_USERNAME ?? "PerpsPadBot";
export const TG_CHANNEL_URL: string = env.VITE_TELEGRAM_CHANNEL_URL ?? "https://t.me/+Uq5NsdlR0So1YWNk";

export const xFollowUrl = (): string =>
  `https://x.com/intent/follow?screen_name=${encodeURIComponent(X_HANDLE)}`;

// Retweet intent needs a tweet id; without one, fall back to the profile so the step still works.
export const xRetweetUrl = (): string =>
  X_TWEET_ID
    ? `https://x.com/intent/retweet?tweet_id=${encodeURIComponent(X_TWEET_ID)}`
    : `https://x.com/${encodeURIComponent(X_HANDLE)}`;

export const tgBotDeepLink = (sessionId: string): string =>
  `https://t.me/${TG_BOT_USERNAME}?start=${encodeURIComponent(sessionId)}`;
