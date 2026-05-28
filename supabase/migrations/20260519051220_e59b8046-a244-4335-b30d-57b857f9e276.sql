
-- Drop legacy tables (data lives on-chain after the pivot)
DROP TABLE IF EXISTS public.trades CASCADE;
DROP TABLE IF EXISTS public.holders CASCADE;

-- Mark existing tokens as deprecated so new UI hides them
UPDATE public.tokens SET status = 'deprecated' WHERE status <> 'deprecated';

-- Drop dead columns from the old bonding-curve model
ALTER TABLE public.tokens
  DROP COLUMN IF EXISTS base_price_usd,
  DROP COLUMN IF EXISTS supply_sold,
  DROP COLUMN IF EXISTS reserve_usdc,
  DROP COLUMN IF EXISTS graduated,
  DROP COLUMN IF EXISTS graduated_at,
  DROP COLUMN IF EXISTS raydium_pool_id,
  DROP COLUMN IF EXISTS pool_seed_signature,
  DROP COLUMN IF EXISTS pool_seeded_at,
  DROP COLUMN IF EXISTS usdc_seeded,
  DROP COLUMN IF EXISTS tokens_seeded,
  DROP COLUMN IF EXISTS treasury_token_ata;

-- Rename base_mid to launch_mid to reflect new purpose (thesis reference only)
ALTER TABLE public.tokens RENAME COLUMN base_mid TO launch_mid;

-- Add new Meteora DBC columns
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS dbc_pool_address text,
  ADD COLUMN IF NOT EXISTS dbc_config_address text,
  ADD COLUMN IF NOT EXISTS quote_token text NOT NULL DEFAULT 'SOL',
  ADD COLUMN IF NOT EXISTS sol_raised numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graduated_pool_address text,
  ADD COLUMN IF NOT EXISTS migration_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS curve_preset text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS pool_state_refreshed_at timestamp with time zone;

-- Ticker uniqueness for active tokens (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS tokens_ticker_active_unique
  ON public.tokens (lower(ticker))
  WHERE status <> 'deprecated';

-- Helpful index for live token listings
CREATE INDEX IF NOT EXISTS tokens_live_created_idx
  ON public.tokens (created_at DESC)
  WHERE status = 'live';
