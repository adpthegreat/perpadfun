
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS mint_pending boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS tokens_external_mint_unique
  ON public.tokens (external_mint)
  WHERE external_mint IS NOT NULL;

CREATE INDEX IF NOT EXISTS tokens_mint_pending_idx
  ON public.tokens (mint_pending)
  WHERE mint_pending = true;

-- Loosen the insert policy so a pending router (no mint yet) is allowed.
DROP POLICY IF EXISTS "anyone can create external-source tokens" ON public.tokens;
CREATE POLICY "anyone can create external-source tokens"
ON public.tokens
FOR INSERT
TO anon, authenticated
WITH CHECK (
  source = 'external'
  AND creator_id IS NULL
  AND mint_address IS NULL
  AND dbc_pool_address IS NULL
  AND claim_token IS NOT NULL
  AND (
    external_mint IS NOT NULL
    OR mint_pending = true
  )
);
