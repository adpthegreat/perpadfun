-- Restrict UPDATE on public.tokens at the column level for the `authenticated` role.
-- The existing RLS policy "creators can update their tokens" still scopes rows
-- to auth.uid() = creator_id; this layer additionally restricts WHICH columns
-- can be updated. Service role bypasses both RLS and column grants, so the
-- keeper retains full write access.

-- Revoke blanket UPDATE first, then grant only safe cosmetic columns.
REVOKE UPDATE ON public.tokens FROM authenticated;
REVOKE UPDATE ON public.tokens FROM anon;

GRANT UPDATE (
  name,
  description,
  image_url,
  website_url,
  twitter_url
) ON public.tokens TO authenticated;
