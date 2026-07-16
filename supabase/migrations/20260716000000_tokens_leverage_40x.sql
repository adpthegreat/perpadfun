-- Phoenix raised BTC's venue cap to 40x (ETH/SOL to 25x). Add 40 to the
-- allowed-leverage CHECK so a 40x BTC launch isn't rejected at insert.
--
-- Mirrors the UI's DEGEN_LEVERAGES in src/lib/imperial-markets.ts, which now
-- offers [10, 15, 20, 25, 40]. Prior constraint (20260706130000) allowed up to
-- 25 only. Other tiers unchanged.

ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_leverage_check;
ALTER TABLE public.tokens ADD CONSTRAINT tokens_leverage_check
  CHECK (leverage = ANY (ARRAY[2, 3, 5, 10, 15, 20, 25, 40]));
