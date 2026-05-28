ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_leverage_check;
ALTER TABLE public.tokens ADD CONSTRAINT tokens_leverage_check CHECK (leverage = ANY (ARRAY[2, 3, 5, 10, 25, 50, 100]));