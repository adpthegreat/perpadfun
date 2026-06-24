-- Test schema for the keeper suite. Mirrors the constraint-bearing parts of
-- supabase/migrations/* (tables + CHECK + unique) WITHOUT the Supabase-only
-- grants/RLS/policies, so it applies to any throwaway Postgres. This is the
-- automated counterpart to LOCAL_TESTING_GUIDE.md's hand SQL.

create table if not exists public.tokens (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ticker text not null default '',
  underlying text not null default '',
  leverage smallint not null default 1,
  direction text not null default 'long',
  status text not null default 'live',
  source text not null default 'perpspad',
  router text not null default 'imperial',
  mint_address text,
  fees_accrued_usd numeric not null default 0,
  buyback_reserve_usd numeric not null default 0,
  treasury_pnl_usd numeric not null default 0,
  pnl_high_water_usd numeric not null default 0,
  position_size_usd numeric not null default 0,
  position_collateral_usd numeric not null default 0,
  position_opened_at timestamptz,
  launch_mid numeric,
  pending_drift_sig text,
  last_tick_at timestamptz,
  treasury_wallet_address text not null,
  imperial_profile_index smallint not null default 1,
  imperial_profile_pda text
);

-- token_workflows: the durable per-token state machine. The 9-state CHECK is the
-- post-cleanup set (the 3 dead states were removed).
create table if not exists public.token_workflows (
  token_id uuid primary key references public.tokens(id) on delete cascade,
  state text not null default 'idle' check (
    state in (
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
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_at timestamptz,
  locked_by text,
  position_entry_price numeric,
  position_entry_source text check (
    position_entry_source is null or position_entry_source in ('imperial', 'perpspad_entry_mid', 'reconciled')
  ),
  updated_at timestamptz not null default now()
);

-- keeper_actions: idempotent action ledger. The unique key is the double-execute guard.
create table if not exists public.keeper_actions (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  action_kind text not null,
  intent_hash text not null,
  status text not null default 'pending',
  signature text,
  error text,
  created_at timestamptz not null default now(),
  unique (token_id, action_kind, intent_hash)
);

create table if not exists public.tx_log (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null,
  kind text not null,
  intent_hash text not null,
  signature text,
  amount_usd numeric,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  unique (token_id, kind, intent_hash)
);

create table if not exists public.treasury_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  token_id uuid not null,
  kind text not null,
  sol_amount numeric,
  tokens_amount numeric,
  mid numeric,
  pnl_delta_usd numeric,
  note text
);

-- durable per-token log store (KEEPER_PER_TOKEN_LOGS.md)
create table if not exists public.keeper_logs (
  id bigserial primary key,
  token_id uuid references public.tokens(id) on delete cascade,
  tick_id text,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  event text,
  message text not null,
  fields jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists keeper_logs_token_created_idx on public.keeper_logs (token_id, created_at desc);
