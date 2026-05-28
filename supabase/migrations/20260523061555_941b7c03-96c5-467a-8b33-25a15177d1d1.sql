
-- Remove stale external router rows that were created before metadata + first-fee gating existed
DELETE FROM public.tokens WHERE id IN (
  '5303ab7d-29ab-49fd-a191-b27c4febc399',
  'b577f633-b8ba-457e-b556-450a30146baa'
);

-- Gate external routers from public market listings until they have actually routed a fee
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS first_fee_routed_at timestamptz;

CREATE INDEX IF NOT EXISTS tokens_first_fee_routed_at_idx
  ON public.tokens (first_fee_routed_at);
