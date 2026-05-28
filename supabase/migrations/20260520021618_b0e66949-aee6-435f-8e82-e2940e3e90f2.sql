-- 1. tx_log for every on-chain action
CREATE TABLE IF NOT EXISTS public.tx_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fee_claim_dbc','fee_claim_amm','swap','burn','drift_adjust','drift_close')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
  signature text,
  intent_hash text NOT NULL,
  amount_usd numeric,
  amount_sol numeric,
  amount_tokens numeric,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS tx_log_intent_unique
  ON public.tx_log (token_id, kind, intent_hash);

CREATE INDEX IF NOT EXISTS tx_log_token_created_idx
  ON public.tx_log (token_id, created_at DESC);

ALTER TABLE public.tx_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tx_log public read"
  ON public.tx_log FOR SELECT
  TO public USING (true);

-- 2. tokens: in-flight state + LP position
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS pending_drift_sig text,
  ADD COLUMN IF NOT EXISTS last_fee_claim_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_fee_claim_signature text,
  ADD COLUMN IF NOT EXISTS lp_position_address text;