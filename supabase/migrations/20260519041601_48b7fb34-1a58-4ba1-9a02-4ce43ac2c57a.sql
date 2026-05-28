ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS raydium_pool_id text,
  ADD COLUMN IF NOT EXISTS pool_seeded_at timestamptz,
  ADD COLUMN IF NOT EXISTS usdc_seeded numeric,
  ADD COLUMN IF NOT EXISTS tokens_seeded numeric,
  ADD COLUMN IF NOT EXISTS pool_seed_signature text;