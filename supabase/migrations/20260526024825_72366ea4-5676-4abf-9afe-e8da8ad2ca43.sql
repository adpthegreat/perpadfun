ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_imperial_profile_index_unique;

CREATE UNIQUE INDEX IF NOT EXISTS tokens_wallet_profile_unique
  ON public.tokens (treasury_wallet_address, imperial_profile_index)
  WHERE treasury_wallet_address IS NOT NULL
    AND imperial_profile_index IS NOT NULL;