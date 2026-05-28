-- Restrict creator UPDATE on tokens to safe presentation columns only.
-- Sensitive financial / operational columns (sol_raised, treasury_sol, status,
-- migration_status, claim_token, router, buyback_reserve_usd, etc.) must only
-- be written by the backend keeper using the service role (which bypasses RLS
-- and column grants).

REVOKE UPDATE ON public.tokens FROM authenticated;
REVOKE UPDATE ON public.tokens FROM anon;

GRANT UPDATE (
  name,
  description,
  image_url,
  website_url,
  twitter_url
) ON public.tokens TO authenticated;