ALTER TABLE public.tokens ALTER COLUMN imperial_profile_index SET DEFAULT 1;

UPDATE public.tokens AS t
SET imperial_profile_index = 1,
    imperial_profile_pda = NULL
WHERE t.router = 'imperial'
  AND t.imperial_profile_index = 0
  AND t.position_opened_at IS NULL
  AND COALESCE(t.position_size_usd, 0) = 0
  AND COALESCE(t.position_collateral_usd, 0) = 0
  AND COALESCE(t.opened_collateral_usd, 0) = 0
  AND COALESCE(t.fees_accrued_usd, 0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM public.treasury_events e
    WHERE e.token_id = t.id
      AND e.kind = 'external_perp'
  );