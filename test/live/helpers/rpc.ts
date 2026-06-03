// Pick the RPC URL the live test wallet should use. We deliberately do NOT
// fall through to config.rpcUrl — that's the production keeper's RPC and
// hammering it from tests is bad citizenship. If LIVE_TEST_RPC_URL isn't
// set, we use the public mainnet endpoint (rate-limited but at least it's
// not the prod keeper's).
export function liveRpcUrl(): string {
  const explicit = process.env.LIVE_TEST_RPC_URL?.trim();
  if (explicit) return explicit;
  if (process.env.IMPERIAL_LIVE_TESTS === "1") {
    process.stderr.write(
      "[live-suite] LIVE_TEST_RPC_URL not set, falling back to " +
        "https://api.mainnet-beta.solana.com (rate-limited; tests may be flaky). " +
        "Set LIVE_TEST_RPC_URL in test/live/.env to your own Helius / QuickNode endpoint.\n",
    );
  }
  return "https://api.mainnet-beta.solana.com";
}
