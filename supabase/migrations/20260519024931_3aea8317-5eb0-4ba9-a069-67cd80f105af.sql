
-- tokens: on-chain fields
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS mint_address text UNIQUE,
  ADD COLUMN IF NOT EXISTS metadata_address text,
  ADD COLUMN IF NOT EXISTS launch_signature text,
  ADD COLUMN IF NOT EXISTS treasury_token_ata text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'launching';

-- mark existing demo rows as legacy so they don't pollute the live UI
UPDATE public.tokens SET status = 'legacy' WHERE mint_address IS NULL AND status = 'launching';

-- trades: idempotent on-chain signatures
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS tx_signature text UNIQUE;

-- helpful index for status filtering
CREATE INDEX IF NOT EXISTS tokens_status_idx ON public.tokens(status);
