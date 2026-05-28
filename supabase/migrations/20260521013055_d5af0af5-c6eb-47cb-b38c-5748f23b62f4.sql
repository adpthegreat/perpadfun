ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS current_price_sol numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_supply numeric DEFAULT 1000000000;