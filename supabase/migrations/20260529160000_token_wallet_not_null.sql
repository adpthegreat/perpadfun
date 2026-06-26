-- Every token must have a signer address. Tokens are created with
-- treasury_wallet_address set atomically, so this applies cleanly on an empty DB.
ALTER TABLE public.tokens ALTER COLUMN treasury_wallet_address SET NOT NULL;
