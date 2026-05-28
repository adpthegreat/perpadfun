
-- Authenticated users can launch (insert) tokens they own
CREATE POLICY "authenticated users can insert their tokens"
ON public.tokens
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = creator_id);

-- Creators can update their own token rows (e.g. set mint_address after launch tx confirms)
CREATE POLICY "creators can update their tokens"
ON public.tokens
FOR UPDATE
TO authenticated
USING (auth.uid() = creator_id)
WITH CHECK (auth.uid() = creator_id);

-- Treasury events: creators can insert events for their tokens (used by client-side launch flow)
CREATE POLICY "creators can insert treasury events for their tokens"
ON public.treasury_events
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.tokens t
    WHERE t.id = treasury_events.token_id
      AND t.creator_id = auth.uid()
  )
);
