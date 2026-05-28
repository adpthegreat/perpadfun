ALTER TABLE public.tx_log DROP CONSTRAINT IF EXISTS tx_log_kind_check;
ALTER TABLE public.tx_log ADD CONSTRAINT tx_log_kind_check
  CHECK (kind = ANY (ARRAY['fee_claim_dbc','fee_claim_amm','swap','burn','drift_adjust','drift_close','imperial_deposit']));