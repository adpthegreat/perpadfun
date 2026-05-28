UPDATE public.tokens
SET status = 'deprecated', migration_status = 'deprecated'
WHERE id = 'dcc6f913-a036-449a-9147-95efd9b7bd4d'
  AND status = 'launching'
  AND mint_address IS NULL;