ALTER TABLE public.treasury_events
  DROP CONSTRAINT IF EXISTS treasury_events_kind_check;

ALTER TABLE public.treasury_events
  ADD CONSTRAINT treasury_events_kind_check
  CHECK (kind = ANY (ARRAY['tick'::text, 'buyback'::text, 'burn'::text, 'skim'::text, 'open'::text, 'close'::text, 'graduation'::text, 'claim'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS tx_log_token_kind_intent_hash_idx
  ON public.tx_log (token_id, kind, intent_hash);