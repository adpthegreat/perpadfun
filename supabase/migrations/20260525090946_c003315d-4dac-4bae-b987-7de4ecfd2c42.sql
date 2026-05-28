ALTER TABLE public.tokens
  ADD COLUMN router text NOT NULL DEFAULT 'imperial',
  ADD COLUMN imperial_profile_index smallint;

UPDATE public.tokens SET router = 'jupiter' WHERE router = 'imperial';

ALTER TABLE public.tokens
  ADD CONSTRAINT tokens_router_check CHECK (router IN ('jupiter', 'imperial')),
  ADD CONSTRAINT tokens_imperial_profile_index_range CHECK (imperial_profile_index IS NULL OR (imperial_profile_index >= 0 AND imperial_profile_index <= 5));

CREATE UNIQUE INDEX tokens_imperial_profile_index_unique
  ON public.tokens (imperial_profile_index)
  WHERE imperial_profile_index IS NOT NULL;