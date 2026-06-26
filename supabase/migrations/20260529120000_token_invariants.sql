-- Every token is created with imperial_profile_index set (constant slot 1).
-- Default + NOT NULL: an insert that omits it gets 1, and NULL is not representable.

-- Backfill any rows missing an index (no-op on an empty DB).
UPDATE public.tokens
SET imperial_profile_index = 1
WHERE imperial_profile_index IS NULL;

ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET DEFAULT 1;
ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET NOT NULL;
