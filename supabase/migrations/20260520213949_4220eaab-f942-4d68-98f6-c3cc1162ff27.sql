ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS position_collateral_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opened_collateral_usd numeric NOT NULL DEFAULT 0;