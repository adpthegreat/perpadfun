-- Bring tokens_leverage_check in line with the UI's DEGEN_LEVERAGES so users
-- can actually launch at every tier the picker shows.
--
-- The prior constraint (20260526083946) allowed [2, 3, 5, 10, 25, 50, 100]:
--   - 15 and 20 were missing — client offered 20x (and now 15x too), DB
--     rejected them (e.g. COPPER 20x → tokens_leverage_check).
--   - 50 and 100 were dead capacity — no client-side option proposed them,
--     so they could never be inserted by a legit path. Trimmed to keep the
--     DB honest about what the UI actually accepts.
--
-- Source of truth for the offered tiers stays in
-- src/lib/imperial-markets.ts:BASE_LEVERAGES + DEGEN_LEVERAGES. If those
-- ever gain 50x or 100x, add them in a follow-up migration.

ALTER TABLE public.tokens DROP CONSTRAINT IF EXISTS tokens_leverage_check;
ALTER TABLE public.tokens ADD CONSTRAINT tokens_leverage_check
  CHECK (leverage = ANY (ARRAY[2, 3, 5, 10, 15, 20, 25]));
