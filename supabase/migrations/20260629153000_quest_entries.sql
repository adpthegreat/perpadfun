-- Pre-launch quest funnel (relaunch GTM Phase 0). One row per participant, anchored by a
-- server-issued session_id. Honorary X steps (follow / retweet) plus a real Telegram
-- membership flag set only after a getChatMember check. Wallet and referral attribution
-- bind onto the same row later in the funnel.
--
-- All writes go through the service-role server. RLS is enabled with NO policies, so direct
-- client access is denied; aggregate counters are exposed via a server endpoint, never a
-- direct client read of these rows (they hold wallet / Telegram / IP signal).

CREATE TABLE IF NOT EXISTS public.quest_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE,

  sol_address text,

  telegram_user_id bigint,
  telegram_username text,

  x_followed boolean NOT NULL DEFAULT false,
  x_followed_at timestamptz,
  x_retweeted boolean NOT NULL DEFAULT false,
  x_retweeted_at timestamptz,

  tg_joined boolean NOT NULL DEFAULT false,
  tg_joined_at timestamptz,
  tg_verified_at timestamptz,

  referral_code text NOT NULL UNIQUE,
  referred_by text,

  ip_hash text,
  user_agent text,

  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'completed', 'claimed', 'disqualified')
  ),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One quest claim per Telegram identity — the load-bearing sybil constraint for the TG step.
CREATE UNIQUE INDEX IF NOT EXISTS quest_entries_telegram_user_id_unique
  ON public.quest_entries (telegram_user_id)
  WHERE telegram_user_id IS NOT NULL;

-- One entry per submitted wallet.
CREATE UNIQUE INDEX IF NOT EXISTS quest_entries_sol_address_unique
  ON public.quest_entries (sol_address)
  WHERE sol_address IS NOT NULL;

-- Referral attribution: count referees by their referrer's code.
CREATE INDEX IF NOT EXISTS quest_entries_referred_by_idx
  ON public.quest_entries (referred_by);

CREATE INDEX IF NOT EXISTS quest_entries_created_at_idx
  ON public.quest_entries (created_at DESC);

ALTER TABLE public.quest_entries ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: clients cannot read or write these rows directly. The
-- service-role server bypasses RLS for all quest reads/writes.

-- Reuse the shared updated_at trigger function (defined in the keeper_workflows migration).
DROP TRIGGER IF EXISTS quest_entries_touch_updated_at ON public.quest_entries;
CREATE TRIGGER quest_entries_touch_updated_at
BEFORE UPDATE ON public.quest_entries
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
