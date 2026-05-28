
insert into storage.buckets (id, name, public) values ('token-images', 'token-images', true) on conflict (id) do nothing;

create policy "public read token-images" on storage.objects for select using (bucket_id = 'token-images');
create policy "anyone upload token-images" on storage.objects for insert with check (bucket_id = 'token-images');
