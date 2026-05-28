
drop policy if exists "anyone can launch a token with a wallet" on public.tokens;
drop policy if exists "anyone can update token state" on public.tokens;
drop policy if exists "anyone can record a trade with a wallet" on public.trades;
drop policy if exists "anyone can upsert holdings with a wallet" on public.holders;
drop policy if exists "anyone can update holdings" on public.holders;
-- Reads stay public; writes are blocked at the row level. Server functions use
-- the service role key which bypasses RLS, so the launch/trade flow still works.
