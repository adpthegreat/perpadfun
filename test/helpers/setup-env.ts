// Runs before any test module is imported (vitest setupFiles). The keeper's
// config.js throws on missing TREASURY_SOLANA_PRIVATE_KEY / KEEPER_SECRET, so we
// inject dummy values here — tests never touch a real wallet, RPC, or Supabase.
const defaults: Record<string, string> = {
  TREASURY_SOLANA_PRIVATE_KEY: "[1,2,3]",
  KEEPER_SECRET: "test-keeper-secret",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  SOLANA_RPC_URL: "http://localhost:8899",
  PERPAD_BASE_URL: "http://localhost:3000",
};
for (const [k, v] of Object.entries(defaults)) {
  if (!process.env[k]) process.env[k] = v;
}
