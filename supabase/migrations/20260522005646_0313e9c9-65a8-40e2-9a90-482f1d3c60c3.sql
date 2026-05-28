ALTER TABLE public.tokens ADD COLUMN IF NOT EXISTS treasury_wallet_address text;
CREATE INDEX IF NOT EXISTS idx_tokens_treasury_wallet_address ON public.tokens(treasury_wallet_address);