ALTER TABLE public.tokens
ADD COLUMN IF NOT EXISTS pnl_high_water_usd numeric NOT NULL DEFAULT 0;