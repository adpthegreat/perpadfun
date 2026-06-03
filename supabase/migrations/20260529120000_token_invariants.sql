-- Enforce the per-token creation invariant (LAUNCH_REFACTOR.md).
--
-- The launch refactor makes every creation path write imperial_profile_index +
-- treasury_wallet_address atomically in the insert. This migration enforces the
-- half that is safe to enforce in pure SQL: imperial_profile_index.
--
-- treasury_wallet_address is an app-side ed25519 derivation that SQL cannot
-- reproduce, so a strict NOT NULL / CHECK on it is intentionally deferred: it
-- requires an app-side backfill of legacy NULL rows first (otherwise the
-- keeper's routine UPDATEs to any legacy broken row would start failing). See
-- the "Follow-ups" section of LAUNCH_REFACTOR.md.

-- 1. Backfill any legacy rows that never got an index (constant slot 1).
UPDATE public.tokens
SET imperial_profile_index = 1
WHERE imperial_profile_index IS NULL;

-- 2. Default + NOT NULL: an insert that omits it now gets 1, and a NULL is
--    no longer representable.
ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET DEFAULT 1;
ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET NOT NULL;
