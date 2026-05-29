-- Durable, per-token, queryable log store (KEEPER_PER_TOKEN_LOGS.md).
--
-- The keeper writes structured per-token log rows here (via the batched
-- /workflow-report path) so a token's full timeline -- events, decisions, and
-- the failure logs that were previously stdout-only -- can be queried by
-- token_id instead of grepping the ephemeral Fly stream. A future UI reads it.

CREATE TABLE IF NOT EXISTS public.keeper_logs (
  id          bigserial PRIMARY KEY,
  token_id    uuid REFERENCES public.tokens(id) ON DELETE CASCADE,
  tick_id     text,
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  event       text,
  message     text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The per-token timeline query: WHERE token_id = $1 ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS keeper_logs_token_created_idx
  ON public.keeper_logs (token_id, created_at DESC);
