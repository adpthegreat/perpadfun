-- Collab onboarding campaign: 500 invite codes for the first 500 community
-- collaborators who follow X, join Telegram, and prove a Solana wallet.
--
-- Two tables:
--   collab_codes   — the fixed pool of 500 pre-generated unique codes.
--   collab_signups — one row per wallet, tracking task completion + assignment.
--
-- Assignment is done through claim_collab_code() which uses FOR UPDATE SKIP
-- LOCKED so concurrent claimers can never be handed the same code, and the pool
-- can never be over-drawn (overflow signups are flagged waitlisted instead).

-- (no extensions needed — codes use built-in md5(random()); ids are bigserial)

-- ── code pool ────────────────────────────────────────────────────────────────
create table if not exists public.collab_codes (
  id           bigserial primary key,
  code         text not null unique,
  assigned     boolean not null default false,
  assigned_to  text,                       -- solana wallet address
  assigned_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- Partial index: the hot path is "next unassigned code".
create index if not exists collab_codes_unassigned_idx
  on public.collab_codes (id) where assigned = false;

-- ── signups ──────────────────────────────────────────────────────────────────
create table if not exists public.collab_signups (
  id               bigserial primary key,
  wallet_address   text not null unique,
  x_followed       boolean not null default false,
  x_handle         text,
  tg_joined        boolean not null default false,
  tg_user_id       bigint,
  tg_username      text,
  wallet_verified  boolean not null default false,
  code_id          bigint references public.collab_codes(id),
  code             text,
  waitlisted       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One Telegram account can only back one signup (anti-sybil on the TG side).
create unique index if not exists collab_signups_tg_user_idx
  on public.collab_signups (tg_user_id) where tg_user_id is not null;

create or replace function public.touch_collab_signup_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists collab_signups_touch on public.collab_signups;
create trigger collab_signups_touch
  before update on public.collab_signups
  for each row execute function public.touch_collab_signup_updated_at();

-- ── seed 500 unique, non-sequential codes (PERP-XXXXXXXX) ─────────────────────
-- Idempotent: only seeds when the pool is empty. Overshoots then trims so that
-- random collisions (dropped by the UNIQUE constraint) still leave exactly 500.
do $$
declare existing int;
begin
  select count(*) into existing from public.collab_codes;
  if existing = 0 then
    insert into public.collab_codes (code)
    select 'PERP-' || upper(substr(md5(random()::text || g::text), 1, 8))
    from generate_series(1, 750) as g
    on conflict (code) do nothing;

    delete from public.collab_codes
    where id not in (select id from public.collab_codes order by id limit 500);
  end if;
end $$;

-- ── atomic claim ─────────────────────────────────────────────────────────────
-- Returns the assigned code, or NULL when the pool is exhausted (caller is
-- waitlisted). Idempotent: a wallet that already holds a code gets it back.
-- Raises 'no_signup' / 'tasks_incomplete' for invalid callers.
create or replace function public.claim_collab_code(p_wallet text)
returns text
language plpgsql
as $$
declare
  v_signup  public.collab_signups%rowtype;
  v_code_id bigint;
  v_code    text;
begin
  select * into v_signup
  from public.collab_signups
  where wallet_address = p_wallet;

  if not found then
    raise exception 'no_signup';
  end if;

  if v_signup.code is not null then
    return v_signup.code;                       -- already claimed, idempotent
  end if;

  if not (v_signup.x_followed and v_signup.tg_joined and v_signup.wallet_verified) then
    raise exception 'tasks_incomplete';
  end if;

  -- Grab the next free code without blocking on rows other claimers hold.
  select id, code into v_code_id, v_code
  from public.collab_codes
  where assigned = false
  order by id
  for update skip locked
  limit 1;

  if v_code_id is null then
    update public.collab_signups
    set waitlisted = true
    where wallet_address = p_wallet;
    return null;                                -- pool exhausted -> waitlist
  end if;

  update public.collab_codes
  set assigned = true, assigned_to = p_wallet, assigned_at = now()
  where id = v_code_id;

  update public.collab_signups
  set code_id = v_code_id, code = v_code, waitlisted = false
  where wallet_address = p_wallet;

  return v_code;
end;
$$;

-- ── RLS: service-role only ───────────────────────────────────────────────────
-- Both tables are read/written EXCLUSIVELY by the service-role server functions
-- (src/lib/collab.functions.ts), which bypass RLS. Enabling RLS with NO policies
-- denies the public anon key any access — so the code pool can't be scraped, and
-- a signup's task flags (x_followed / tg_joined / wallet_verified) can't be forged
-- directly via PostgREST to bypass the server checks in claim_collab_code().
alter table public.collab_codes   enable row level security;
alter table public.collab_signups enable row level security;

