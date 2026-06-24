
ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_ticker_key;
DROP INDEX IF EXISTS public.tokens_ticker_active_unique;
CREATE UNIQUE INDEX tokens_ticker_perpspad_active_unique
  ON public.tokens (lower(ticker))
  WHERE source = 'perpspad' AND status <> 'deprecated';
