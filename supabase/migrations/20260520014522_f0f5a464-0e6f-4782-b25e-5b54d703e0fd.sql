ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS fees_accrued_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS position_opened_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_sol_raised_seen numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buyback_reserve_usd numeric NOT NULL DEFAULT 0;