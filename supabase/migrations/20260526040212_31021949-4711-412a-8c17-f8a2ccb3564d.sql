ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET DEFAULT 0;
UPDATE public.tokens SET imperial_profile_index = 0 WHERE imperial_profile_index IS NULL;