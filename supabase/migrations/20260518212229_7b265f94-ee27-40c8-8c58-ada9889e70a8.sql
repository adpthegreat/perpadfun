
-- Replace auth-only inserts with wallet-address-based inserts.
drop policy if exists "auth users create tokens" on public.tokens;
drop policy if exists "auth users create trades" on public.trades;
drop policy if exists "auth users manage own holdings" on public.holders;

create policy "anyone can launch a token with a wallet" on public.tokens
  for insert with check (creator_address is not null and length(creator_address) > 0);

create policy "anyone can update token state" on public.tokens
  for update using (true) with check (true);

create policy "anyone can record a trade with a wallet" on public.trades
  for insert with check (trader_address is not null and length(trader_address) > 0);

create policy "anyone can upsert holdings with a wallet" on public.holders
  for insert with check (holder_address is not null and length(holder_address) > 0);
create policy "anyone can update holdings" on public.holders
  for update using (true) with check (true);
