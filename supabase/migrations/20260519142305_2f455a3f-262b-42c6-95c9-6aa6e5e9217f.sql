
alter table public.tokens
  add column if not exists treasury_sol numeric not null default 0,
  add column if not exists tokens_burned numeric not null default 0,
  add column if not exists position_size_usd numeric not null default 0,
  add column if not exists last_tick_mid numeric,
  add column if not exists last_tick_at timestamptz,
  add column if not exists treasury_pnl_usd numeric not null default 0;

create table if not exists public.treasury_events (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  kind text not null check (kind in ('tick','buyback','burn','skim','open','close')),
  mid numeric,
  pnl_delta_usd numeric,
  sol_amount numeric,
  tokens_amount numeric,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists treasury_events_token_created_idx
  on public.treasury_events (token_id, created_at desc);

alter table public.treasury_events enable row level security;

drop policy if exists "treasury events public read" on public.treasury_events;
create policy "treasury events public read"
  on public.treasury_events for select
  to public
  using (true);
