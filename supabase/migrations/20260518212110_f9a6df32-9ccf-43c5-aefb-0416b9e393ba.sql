
-- Profiles for wallet identity
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  evm_address text unique,
  solana_address text unique,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles readable by all" on public.profiles for select using (true);
create policy "users manage own profile" on public.profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Launched tokens
create table public.tokens (
  id uuid primary key default gen_random_uuid(),
  ticker text not null unique,
  name text not null,
  description text,
  image_url text,
  underlying text not null,           -- HL perp coin name (BTC, ETH, HYPE, ...)
  leverage smallint not null check (leverage in (2,3,5)),
  direction text not null check (direction in ('long','short')),
  creator_id uuid references auth.users(id) on delete set null,
  creator_address text,
  base_mid numeric not null,          -- mid price of underlying at launch
  base_price_usd numeric not null default 0.00004, -- bonding-curve starting price
  supply_sold numeric not null default 0,
  reserve_usdc numeric not null default 0,
  graduated boolean not null default false,
  graduated_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.tokens enable row level security;
create policy "tokens public read" on public.tokens for select using (true);
create policy "auth users create tokens" on public.tokens for insert with check (auth.uid() = creator_id);

-- Trades
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  trader_id uuid references auth.users(id) on delete set null,
  trader_address text,
  side text not null check (side in ('buy','sell')),
  amount_usdc numeric not null,
  amount_tokens numeric not null,
  price_usd numeric not null,
  created_at timestamptz not null default now()
);
create index trades_token_idx on public.trades(token_id, created_at desc);
alter table public.trades enable row level security;
create policy "trades public read" on public.trades for select using (true);
create policy "auth users create trades" on public.trades for insert with check (auth.uid() = trader_id);

-- Holders (one row per (token, user))
create table public.holders (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete cascade,
  holder_id uuid references auth.users(id) on delete cascade,
  holder_address text,
  balance numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique(token_id, holder_id)
);
alter table public.holders enable row level security;
create policy "holders public read" on public.holders for select using (true);
create policy "auth users manage own holdings" on public.holders for all using (auth.uid() = holder_id) with check (auth.uid() = holder_id);

-- Realtime streams
alter publication supabase_realtime add table public.trades;
alter publication supabase_realtime add table public.tokens;
