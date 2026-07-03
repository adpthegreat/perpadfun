-- External fee-router ownership / anti-squatting.
-- See plan/FEE_ROUTING_AND_MINT_INDEX.md §6.
--
-- Before: unique(external_mint) meant the FIRST caller to reserve a mint locked
-- it forever — including its asset/leverage/direction — even if they don't own
-- the coin. The real creator then couldn't route with their own params.
--
-- After: only ONE *connected* router per mint (first_fee_routed_at stamped).
-- Multiple *pending* reservations for the same mint are allowed. Connection is
-- proven on-chain by the keeper (bonding_curve.creator == the router sub-wallet),
-- which only the coin's true creator can cause — so the owner always wins and a
-- squatter's pending row can never lock the mint.

DROP INDEX IF EXISTS public.tokens_external_mint_unique;

CREATE UNIQUE INDEX IF NOT EXISTS tokens_external_mint_connected_unique
  ON public.tokens (external_mint)
  WHERE external_mint IS NOT NULL AND first_fee_routed_at IS NOT NULL;
