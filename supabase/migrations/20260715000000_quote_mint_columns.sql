-- Pair-with-any-SPL-token: store the quote token's mint + decimals directly, so a
-- launch is no longer limited to the SOL/USDC/ANSEM/UWU enum. `quote_token` stays
-- as a human display label; `quote_mint` + `quote_decimals` are authoritative for
-- the bonding-curve config, pool derivation, and the keeper's fee normalization.
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS quote_mint text,
  ADD COLUMN IF NOT EXISTS quote_decimals integer;

-- Backfill existing rows from their quote_token enum (SOL is native/9dp; every
-- SPL quote so far is 6dp).
UPDATE public.tokens
SET
  quote_mint = CASE quote_token
    WHEN 'USDC' THEN 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    WHEN 'ANSEM' THEN '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'
    WHEN 'UWU' THEN 'UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump'
    ELSE 'So11111111111111111111111111111111111111112'
  END,
  quote_decimals = CASE quote_token WHEN 'SOL' THEN 9 ELSE 6 END
WHERE quote_mint IS NULL;
