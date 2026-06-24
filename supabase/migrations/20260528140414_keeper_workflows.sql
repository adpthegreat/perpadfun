-- Durable keeper workflow state and action ledger.
--
-- tokens remains the public projection used by the app. These tables are the
-- keeper's operational source of truth for partial progress, retry state, and
-- stuck-token diagnostics.

CREATE TABLE IF NOT EXISTS public.token_workflows (
  token_id uuid PRIMARY KEY REFERENCES public.tokens(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'idle' CHECK (
    state IN (
      'idle',
      'fees_claimed',
      'split_reserved',
      'imperial_deposited',
      'position_open_pending',
      'position_open',
      'topup_pending',
      'blocked',
      'error'
    )
  ),
  last_successful_step text,
  blocked_reason text,
  next_retry_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,

  perp_reserved_usd numeric NOT NULL DEFAULT 0,
  buyback_reserved_usd numeric NOT NULL DEFAULT 0,
  treasury_reserved_usd numeric NOT NULL DEFAULT 0,
  imperial_deposited_usd numeric NOT NULL DEFAULT 0,

  position_entry_price numeric,
  position_entry_source text CHECK (
    position_entry_source IS NULL OR position_entry_source IN ('imperial', 'perpspad_entry_mid', 'reconciled')
  ),
  position_size_usd numeric NOT NULL DEFAULT 0,
  position_collateral_usd numeric NOT NULL DEFAULT 0,

  last_observed_sub_sol numeric,
  last_observed_sub_usdc numeric,
  last_observed_imperial_usdc numeric,
  last_observed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS token_workflows_state_idx
  ON public.token_workflows (state, next_retry_at NULLS FIRST, updated_at DESC);

CREATE INDEX IF NOT EXISTS token_workflows_blocked_idx
  ON public.token_workflows (blocked_reason, updated_at DESC)
  WHERE blocked_reason IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.keeper_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL REFERENCES public.tokens(id) ON DELETE CASCADE,
  action_kind text NOT NULL CHECK (
    action_kind IN (
      'fee_claim_dbc',
      'fee_claim_amm',
      'fee_claim_pumpfun',
      'fee_claim_pump_amm',
      'split_fees',
      'treasury_skim',
      'buyback',
      'burn',
      'imperial_deposit',
      'imperial_open',
      'imperial_topup',
      'imperial_withdraw',
      'imperial_close',
      'reconcile',
      'blocked',
      'tick'
    )
  ),
  intent_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'confirmed', 'failed', 'blocked', 'skipped')
  ),
  signature text,
  external_id text,
  amount_usd numeric,
  amount_sol numeric,
  amount_tokens numeric,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

ALTER TABLE public.tx_log DROP CONSTRAINT IF EXISTS tx_log_kind_check;
ALTER TABLE public.tx_log ADD CONSTRAINT tx_log_kind_check
  CHECK (
    kind = ANY (
      ARRAY[
        'fee_claim_dbc',
        'fee_claim_amm',
        'swap',
        'burn',
        'drift_adjust',
        'drift_close',
        'imperial_deposit',
        'imperial_open',
        'imperial_close',
        'imperial_topup'
      ]
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS keeper_actions_intent_unique
  ON public.keeper_actions (token_id, action_kind, intent_hash);

CREATE INDEX IF NOT EXISTS keeper_actions_token_created_idx
  ON public.keeper_actions (token_id, created_at DESC);

CREATE INDEX IF NOT EXISTS keeper_actions_status_idx
  ON public.keeper_actions (status, updated_at DESC);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS token_workflows_touch_updated_at ON public.token_workflows;
CREATE TRIGGER token_workflows_touch_updated_at
BEFORE UPDATE ON public.token_workflows
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS keeper_actions_touch_updated_at ON public.keeper_actions;
CREATE TRIGGER keeper_actions_touch_updated_at
BEFORE UPDATE ON public.keeper_actions
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.token_workflows (
  token_id,
  state,
  perp_reserved_usd,
  buyback_reserved_usd,
  position_size_usd,
  position_collateral_usd,
  position_entry_price,
  position_entry_source,
  imperial_deposited_usd,
  last_successful_step
)
SELECT
  id,
  CASE
    WHEN position_opened_at IS NOT NULL THEN 'position_open'
    WHEN fees_accrued_usd > 0 THEN 'split_reserved'
    ELSE 'idle'
  END,
  GREATEST(COALESCE(fees_accrued_usd, 0), 0),
  GREATEST(COALESCE(buyback_reserve_usd, 0), 0),
  GREATEST(COALESCE(position_size_usd, 0), 0),
  GREATEST(COALESCE(position_collateral_usd, 0), 0),
  NULLIF(launch_mid, 0),
  CASE WHEN NULLIF(launch_mid, 0) IS NULL THEN NULL ELSE 'reconciled' END,
  GREATEST(COALESCE(position_collateral_usd, 0), 0),
  CASE WHEN position_opened_at IS NOT NULL THEN 'position_open' ELSE NULL END
FROM public.tokens
ON CONFLICT (token_id) DO NOTHING;

ALTER TABLE public.token_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keeper_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "token_workflows public read" ON public.token_workflows;
CREATE POLICY "token_workflows public read"
  ON public.token_workflows FOR SELECT
  TO public USING (true);

DROP POLICY IF EXISTS "keeper_actions public read" ON public.keeper_actions;
CREATE POLICY "keeper_actions public read"
  ON public.keeper_actions FOR SELECT
  TO public USING (true);
