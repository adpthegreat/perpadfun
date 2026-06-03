// Local-dev seed: populate a LOCAL Supabase Postgres with realistic dummy data so
// the app UI (/, /tokens, /token/$id) renders populated AND the keeper JSON APIs
// (/api/public/keeper/workflows, /stuck-tokens) return real rows to inspect.
//
// Reuses the test helpers (test/helpers/db.ts + fleet.ts) so seeding stays in lock-
// step with the real migrated schema and the keeper's own state vocabulary.
//
// RUN (local only):
//   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//     bun run scripts/seed-keeper.ts --yes
//
// SAFETY: this calls resetDb() which TRUNCATEs the whole tokens table (+cascades).
// It refuses to run unless TEST_DATABASE_URL points at a local 127.0.0.1/localhost
// host and --yes is passed. NEVER point this at a production database.
import {
  ensureSchema,
  resetDb,
  seedToken,
  applyWorkflow,
  seedWorkflow,
  recordAction,
  recordTx,
  insertKeeperLog,
  query,
  closeDb,
} from "../test/helpers/db";
import { makeTokenFleet, makeStuckFleet } from "../test/helpers/fleet";

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const LOCAL = /(@|\/\/)(127\.0\.0\.1|localhost)(:|\/)/.test(URL);
if (!URL) throw new Error("TEST_DATABASE_URL not set - refusing to run.");
if (!LOCAL) throw new Error(`TEST_DATABASE_URL is not local (${URL}) - refusing (this TRUNCATEs all tokens).`);
if (!process.argv.includes("--yes")) {
  throw new Error("resetDb() wipes ALL tokens. Re-run with --yes to confirm against the LOCAL db.");
}

const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const mint = (s: string) => `Mint${s}${"1".repeat(Math.max(0, 32 - s.length))}`;

// supported perp underlyings (match the markets sidebar) and allowed leverages
const LEV = [2, 3, 5, 10, 25, 50, 100];

// 1. SHOWCASE tokens -- fully populated for a live-looking UI feed + token detail.
//    Each is UI-visible (mint_address set, status 'live', not deprecated/failed).
type Showcase = {
  ticker: string;
  name: string;
  underlying: string;
  leverage: number;
  direction: "long" | "short";
  sol_raised: number;
  migration_status?: string;
  open?: boolean; // seed an open perp hedge
  state: string; // token_workflows.state
};
const SHOWCASE: Showcase[] = [
  { ticker: "DEGEN", name: "Degen Ape", underlying: "SOL", leverage: 50, direction: "long", sol_raised: 72, open: true, state: "position_open" },
  { ticker: "MOON", name: "Moonshot", underlying: "BTC", leverage: 25, direction: "long", sol_raised: 84, open: true, state: "topup_pending" },
  { ticker: "BEAR", name: "Bear Market", underlying: "ETH", leverage: 10, direction: "short", sol_raised: 41, open: true, state: "position_open" },
  { ticker: "HYPER", name: "Hyper Liquid", underlying: "HYPE", leverage: 25, direction: "long", sol_raised: 85, migration_status: "graduated", open: true, state: "position_open" },
  { ticker: "PEPE2", name: "Pepe Two", underlying: "SOL", leverage: 100, direction: "long", sol_raised: 18, state: "split_reserved" },
  { ticker: "SAFE", name: "Safe Bet", underlying: "BTC", leverage: 3, direction: "long", sol_raised: 55, open: true, state: "position_open" },
  { ticker: "CHOP", name: "Chop City", underlying: "ETH", leverage: 5, direction: "short", sol_raised: 9, state: "fees_claimed" },
  { ticker: "GRAD", name: "Graduated Gem", underlying: "SOL", leverage: 10, direction: "long", sol_raised: 85, migration_status: "graduated", open: true, state: "position_open" },
  { ticker: "CHAD", name: "Chad Coin", underlying: "SOL", leverage: 25, direction: "long", sol_raised: 33, state: "blocked" },
  { ticker: "WOJAK", name: "Wojak World", underlying: "ETH", leverage: 50, direction: "short", sol_raised: 27, state: "error" },
];

async function seedShowcase() {
  let i = 0;
  const ids: { id: string; sc: Showcase }[] = [];
  for (const sc of SHOWCASE) {
    i++;
    const overrides: Record<string, unknown> = {
      ticker: sc.ticker,
      name: sc.name,
      description: `${sc.name} - a perpad token backed by a leveraged ${sc.underlying} perp.`,
      image_url: null,
      underlying: sc.underlying,
      leverage: sc.leverage,
      direction: sc.direction,
      source: "perpad",
      router: "imperial",
      status: "live",
      mint_address: mint(sc.ticker),
      creator_address: `Creator${sc.ticker}1111111111111111111111111`,
      website_url: "https://perpad.fun",
      twitter_url: "https://x.com/perpadfun",
      sol_raised: sc.sol_raised,
      current_price_sol: 0.0000004 * (i + 1),
      total_supply: 1_000_000_000,
      migration_status: sc.migration_status ?? "active",
      created_at: ISO(i * 3 * HOUR),
      fees_accrued_usd: 5 + i * 2,
      treasury_sol: 0.2 * i,
      tokens_burned: 1_000_000 * i,
      treasury_pnl_usd: (i % 2 === 0 ? 1 : -1) * 12.5 * i,
      launch_mid: sc.open ? 100 + i : null,
      last_tick_mid: sc.open ? 100 + i + (sc.direction === "long" ? 3 : -3) : null,
      last_tick_at: sc.open ? ISO(2 * MIN) : null,
      position_opened_at: sc.open ? ISO(i * HOUR) : null,
      position_size_usd: sc.open ? 100 * i : 0,
      position_collateral_usd: sc.open ? (100 * i) / sc.leverage : 0,
      opened_collateral_usd: sc.open ? (100 * i) / sc.leverage : 0,
    };
    const id = await seedToken(overrides);
    // workflow row (upsert) consistent with the card
    const wf: Record<string, unknown> = { state: sc.state };
    if (sc.state === "blocked") {
      wf.blocked_reason = "capacity-below-floor";
      wf.next_retry_at = ISO(-30 * MIN); // 30m in the future
    }
    if (sc.state === "error") wf.attempt_count = 3;
    if (sc.open) {
      wf.position_size_usd = overrides.position_size_usd;
      wf.position_collateral_usd = overrides.position_collateral_usd;
      wf.position_entry_price = overrides.launch_mid;
      wf.position_entry_source = "imperial";
    }
    await applyWorkflow(id, wf);
    ids.push({ id, sc });
  }
  return ids;
}

// 2. treasury_events + ledger + logs for the showcase tokens (drives token detail
//    "Live feed", buyback/burn stats, the protocol-stats footer, and the keeper APIs).
async function seedActivity(rows: { id: string; sc: Showcase }[]) {
  let h = 0;
  for (const { id, sc } of rows) {
    h++;
    // treasury_events timeline
    const events: Array<[string, number | null, number | null, number | null, number | null, string | null]> = [
      ["claim", sc.sol_raised / 100, null, null, null, "fees claimed"],
      ["skim", 0.05 * h, null, null, 2.5, "treasury skim"],
      ["buyback", 0.1 * h, 250_000 * h, 0.0000004 * h, null, "buyback executed"],
      ["burn", null, 250_000 * h, null, null, "tokens burned"],
    ];
    if (sc.open) events.push(["open", null, null, 100 + h, 0, "opened perp hedge"]);
    if (sc.open) events.push(["tick", null, null, 100 + h + 2, 7.5, "tick mark update"]);
    // error-pattern notes so the /admin/logs keeper_issues tab populates (matches its
    // %backoff%/%wallet capacity%/%below floor%/%insufficient lamports% filter)
    if (sc.state === "blocked")
      events.push(["tick", null, null, null, null, "imperial deposit err: wallet capacity below floor"]);
    if (sc.state === "error") {
      events.push(["tick", null, null, null, null, "buyback drain err: insufficient lamports for tx fees"]);
      events.push(["tick", null, null, null, null, "fee claim error: rpc 429 backoff exhausted"]);
    }
    let ago = events.length;
    for (const [kind, sol, toks, mid, pnl, note] of events) {
      await query(
        "insert into public.treasury_events (token_id, kind, sol_amount, tokens_amount, mid, pnl_delta_usd, note, created_at) values ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' minutes')::interval)",
        [id, kind, sol, toks, mid, pnl, note, String(ago-- * 7)],
      );
    }
    // idempotent action ledger
    await recordAction(id, { action_kind: "fee_claim_dbc", intent_hash: `h-${h}-claim`, status: "confirmed" });
    await recordAction(id, { action_kind: "split_fees", intent_hash: `h-${h}-split`, status: "confirmed" });
    if (sc.open) {
      await recordAction(id, { action_kind: "imperial_open", intent_hash: `h-${h}-open`, status: "confirmed" });
      await recordTx(id, { kind: "imperial_open", intent_hash: `h-${h}-open`, status: "confirmed" });
    }
    if (sc.state === "error") {
      await recordAction(id, { action_kind: "imperial_open", intent_hash: `h-${h}-openfail`, status: "failed" });
      // a stuck pending tx_log row so the keeper_issues tab's "stuck pending tx" classification surfaces
      await recordTx(id, { kind: "imperial_open", intent_hash: `h-${h}-pending`, status: "pending", error: "rpc 429 backoff exhausted" });
    }
    if (sc.state === "blocked") {
      await recordTx(id, { kind: "fee_claim_dbc", intent_hash: `h-${h}-blocked`, status: "pending", error: "wallet capacity below floor" });
    }
    // per-token structured log timeline (info/warn/error)
    await insertKeeperLog(id, { level: "info", event: "tick", message: "tick processed", fields: { state: sc.state }, ageSec: 600 });
    await insertKeeperLog(id, { level: "info", event: "fee_claim", message: "fees claimed", fields: { usd: 5 + h }, ageSec: 420 });
    if (sc.open)
      await insertKeeperLog(id, { level: "info", event: "open", message: "imperial position opened", fields: { sizeUsd: 100 * h, tick_id: `tk-${h}` }, ageSec: 300 });
    if (sc.state === "blocked")
      await insertKeeperLog(id, { level: "warn", event: "blocked", message: "blocked: capacity-below-floor", fields: { tick_id: `tk-${h}` }, ageSec: 120 });
    if (sc.state === "error")
      await insertKeeperLog(id, { level: "error", event: "open", message: "imperial open failed", fields: { error: "simulated rpc 503", tick_id: `tk-${h}` }, ageSec: 90 });
  }
}

// 3. WORKFLOW-STATE COVERAGE: guarantee every one of the 9 live states exists and
//    is UI-visible (mint_address set) + queryable via the workflows API.
const ALL_STATES = [
  "idle",
  "fees_claimed",
  "split_reserved",
  "imperial_deposited",
  "position_open_pending",
  "position_open",
  "topup_pending",
  "blocked",
  "error",
];
// realistic meme names (NOT state names) so these never read as a false positive in the UI
const COVERAGE_NAMES: Array<[string, string]> = [
  ["VIBE", "Vibe Check"],
  ["LAMBO", "Lambo Dreams"],
  ["WAGMI", "We All Gonna"],
  ["FOMO", "Fomo Frenzy"],
  ["YOLO", "Yolo Labs"],
  ["FREN", "Fren Token"],
  ["GIGA", "Giga Brain"],
  ["TURBO", "Turbo Tom"],
  ["NORM", "Normie Net"],
];
async function seedStateCoverage() {
  let i = 0;
  for (const state of ALL_STATES) {
    const [ticker, name] = COVERAGE_NAMES[i];
    i++;
    const open = state === "position_open" || state === "position_open_pending" || state === "topup_pending";
    const id = await seedToken({
      ticker,
      name,
      underlying: "SOL",
      leverage: LEV[i % LEV.length],
      direction: i % 2 ? "long" : "short",
      status: "live",
      mint_address: mint(ticker),
      sol_raised: 5 + i * 4,
      current_price_sol: 0.0000003,
      total_supply: 1_000_000_000,
      fees_accrued_usd: state === "idle" ? 0 : 8,
      position_opened_at: open ? ISO(i * HOUR) : null,
      pending_drift_sig: state === "position_open_pending" || state === "topup_pending" ? `sig-${i}` : null,
      position_size_usd: open ? 120 : 0,
      position_collateral_usd: open ? 24 : 0,
      launch_mid: open ? 100 : null,
    });
    const wf: Record<string, unknown> = { state };
    if (state === "blocked") {
      wf.blocked_reason = "perp_leg_failed";
      wf.next_retry_at = ISO(-1 * HOUR);
    }
    if (state === "error") wf.attempt_count = 2;
    await applyWorkflow(id, wf);
  }
}

// 4. STUCK SCENARIOS for the /stuck-tokens endpoint (12 distinct reasons x2).
//    These use seedToken defaults (no mint_address) so they exercise the keeper API
//    without cluttering the UI feed; seedWorkflow backdates updated_at for staleness.
async function seedStuck() {
  const fleet = makeStuckFleet(24);
  for (const s of fleet) {
    const id = await seedToken({ status: "live", ...s.token });
    await seedWorkflow(id, s.wf);
  }
  return fleet.length;
}

// 5. CADENCE MIX for the keeper loop (hot/cold/throttle/defer categories).
async function seedFleet() {
  const fleet = makeTokenFleet(20);
  for (const t of fleet) {
    const id = await seedToken({
      fees_accrued_usd: t.fees_accrued_usd,
      position_opened_at: t.position_opened_at,
      pending_drift_sig: t.pending_drift_sig,
    });
    await applyWorkflow(id, {
      state: t.token_workflows.state,
      next_retry_at: t.token_workflows.next_retry_at,
    });
  }
  return fleet.length;
}

async function main() {
  console.log(`[seed] target: ${URL}`);
  await ensureSchema();
  await resetDb();
  console.log("[seed] reset clean.");

  const showcase = await seedShowcase();
  console.log(`[seed] ${showcase.length} showcase tokens (UI-visible, with workflows).`);
  await seedActivity(showcase);
  console.log(`[seed] treasury_events + keeper_actions + tx_log + keeper_logs for showcase.`);
  await seedStateCoverage();
  console.log(`[seed] ${ALL_STATES.length} state-coverage tokens (all 9 workflow states).`);
  const stuck = await seedStuck();
  console.log(`[seed] ${stuck} stuck-scenario tokens (for /stuck-tokens API).`);
  const fleet = await seedFleet();
  console.log(`[seed] ${fleet} cadence-mix tokens (keeper loop).`);

  // one global (unattributed) log row
  await insertKeeperLog(null, { level: "warn", event: "boot", message: "keeper booted (seed)", ageSec: 30 });

  const counts = await query(
    "select (select count(*) from public.tokens) tokens, (select count(*) from public.token_workflows) workflows, (select count(*) from public.keeper_actions) actions, (select count(*) from public.keeper_logs) logs, (select count(*) from public.treasury_events) events, (select count(*) from public.tx_log) txlog",
  );
  console.log("[seed] DONE:", counts.rows[0]);
  console.log("[seed] UI-visible tokens (mint_address set):", showcase.length + ALL_STATES.length);
}

main()
  .catch((e) => {
    console.error("[seed] FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
