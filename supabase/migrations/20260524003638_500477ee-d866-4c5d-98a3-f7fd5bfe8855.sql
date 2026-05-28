ALTER TABLE public.treasury_events
DROP CONSTRAINT IF EXISTS treasury_events_kind_check;

ALTER TABLE public.treasury_events
ADD CONSTRAINT treasury_events_kind_check
CHECK (
  kind = ANY (ARRAY[
    'tick'::text,
    'buyback'::text,
    'burn'::text,
    'skim'::text,
    'open'::text,
    'close'::text,
    'graduation'::text,
    'claim'::text,
    'external_sweep'::text,
    'external_split_treasury'::text,
    'external_buyback'::text,
    'external_perp'::text
  ])
);