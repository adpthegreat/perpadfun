-- 1. New columns on tokens
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'perpspad',
  ADD COLUMN IF NOT EXISTS external_platform TEXT,
  ADD COLUMN IF NOT EXISTS external_mint TEXT,
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

ALTER TABLE public.tokens
  ADD CONSTRAINT tokens_source_check
  CHECK (source IN ('perpspad', 'external'));

ALTER TABLE public.tokens
  ADD CONSTRAINT tokens_external_platform_check
  CHECK (external_platform IS NULL OR external_platform IN ('pump_fun', 'other'));

-- 2. Relax NOT NULL on perpspad-launch-only fields so external rows can omit them
ALTER TABLE public.tokens ALTER COLUMN launch_mid DROP NOT NULL;

-- 3. Hard uniqueness guarantee on sub-wallet addresses (no reuse, ever)
CREATE UNIQUE INDEX IF NOT EXISTS tokens_treasury_wallet_address_unique
  ON public.tokens (treasury_wallet_address)
  WHERE treasury_wallet_address IS NOT NULL;

-- 4. Index for keeper lookups by source
CREATE INDEX IF NOT EXISTS tokens_source_idx ON public.tokens (source);

-- 5. RLS: allow anonymous creation of external-source tokens
--    (perpspad-source insert rule already requires auth.uid() = creator_id and stays in force)
CREATE POLICY "anyone can create external-source tokens"
  ON public.tokens
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    source = 'external'
    AND creator_id IS NULL
    AND mint_address IS NULL
    AND dbc_pool_address IS NULL
    AND external_mint IS NOT NULL
    AND claim_token IS NOT NULL
  );