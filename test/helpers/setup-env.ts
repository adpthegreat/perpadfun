// Runs before any test module is imported (vitest setupFiles). The keeper's
// config.js throws on missing TREASURY_SOLANA_PRIVATE_KEY / KEEPER_SECRET, so we
// inject dummy values here — tests never touch a real wallet, RPC, or Supabase
// unless the live-tests opt-in is set.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Live-tests opt-in: load test/live/.env so LIVE_TEST_PRIVATE_KEY,
// LIVE_TEST_RPC_URL, etc. are available to the live suite. Done BEFORE the
// dummy injection below so a real key in test/live/.env wins if present.
if (process.env.IMPERIAL_LIVE_TESTS === "1") {
  const liveEnvPath = resolve(process.cwd(), "test/live/.env");
  if (existsSync(liveEnvPath)) {
    const raw = readFileSync(liveEnvPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip wrapping single or double quotes; JSON byte arrays stay intact.
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } else {
    process.stderr.write(
      "[live-suite] IMPERIAL_LIVE_TESTS=1 but test/live/.env is missing. " +
      "Copy test/live/.env.example to test/live/.env and fill in " +
      "LIVE_TEST_PRIVATE_KEY before running.\n",
    );
  }
}

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
