// Platform-wide stats aggregator for the /stats dashboard.
// Everything is rolled up server-side (supabaseAdmin) and only compact numbers
// are returned to the client. See plan/STATS_PAGE.md.
import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchAllMids } from "@/lib/tokens.functions";

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// tokens_burned / tokens_amount are stored in raw base units (SPL mints are
// 6 decimals across pump.fun + DBC — the whole app assumes this; see
// treasury.functions.ts). Divide to get whole tokens.
const TOKEN_DECIMALS_DIVISOR = 1e6;

type Bucket = { label: string; value: number };
type LevBucket = Bucket & { tier: "base" | "degen" };
type Leader = { id: string; ticker: string; underlying: string; value: number };
type DayPoint = {
  day: string;
  launches: number;
  buybackUsd: number;
  cumBuybackUsd: number;
  feeUsd: number;
};
type Kpis = {
  total: number;
  live: number;
  graduated: number;
  oiUsd: number;
  collUsd: number;
  pnlUsd: number;
  feesUsd: number;
  reserveUsd: number;
  raisedUsd: number;
  burnedTokens: number;
  buybackUsd: number;
  routedUsd: number;
  claimUsd: number;
  burnEvents: number;
};
type Distributions = {
  assets: Bucket[];
  leverages: LevBucket[];
  direction: Bucket[];
  router: Bucket[];
  source: Bucket[];
  status: Bucket[];
  wfStates: Bucket[];
};
type Leaderboards = { fees: Leader[]; pnl: Leader[]; size: Leader[]; burned: Leader[] };
type StatsResult = {
  ok: boolean;
  error: string | null;
  solUsd: number;
  kpis: Kpis | null;
  distributions: Distributions | null;
  series: DayPoint[];
  leaderboards: Leaderboards | null;
};

// Server-side cache so repeated/concurrent /stats loads don't re-run the heavy
// aggregation (3 large DB pulls + the SOL price feed) on every request. The
// server process is long-lived, so a module-level clock is enough.
const CACHE_TTL_MS = 60_000;
let _statsCache: { at: number; data: unknown } | null = null;
// Last good SOL price — reused when the price feed times out so USD figures
// don't collapse to 0 on a transient miss.
let _lastGoodSolUsd = 0;

function countBy(
  rows: Record<string, unknown>[],
  key: string,
  norm: (v: unknown) => string,
): Bucket[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = norm(r[key]) || "unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export const getPlatformStats = createServerFn({ method: "GET" }).handler(async () => {
  if (_statsCache && Date.now() - _statsCache.at < CACHE_TTL_MS) {
    return _statsCache.data as StatsResult;
  }
  try {
    const [tokRes, evRes, wfRes] = await Promise.all([
      supabaseAdmin
        .from("tokens")
        .select(
          "id,ticker,underlying,leverage,direction,router,source,status,migration_status,position_size_usd,position_collateral_usd,buyback_reserve_usd,sol_raised,quote_token,fees_accrued_usd,treasury_pnl_usd,tokens_burned,created_at,position_opened_at",
        )
        .limit(5000),
      supabaseAdmin
        .from("treasury_events")
        // Exclude zero-value 'tick' rows (written every loop iteration, no
        // amounts) so the row cap isn't wasted on them and real value events
        // (buyback/claim/burn/sweep) aren't truncated out of the aggregation.
        .select("token_id,kind,sol_amount,tokens_amount,created_at")
        .neq("kind", "tick")
        .limit(60000),
      supabaseAdmin.from("token_workflows").select("state").limit(5000),
    ]);
    if (tokRes.error) throw tokRes.error;

    const tokens = (tokRes.data ?? []) as Record<string, unknown>[];
    const events = (evRes.data ?? []) as Record<string, unknown>[];
    const workflows = (wfRes.data ?? []) as Record<string, unknown>[];

    // SOL price is non-critical (display + SOL→USD only). Never let the external
    // price feed hang the whole aggregation — cap it with a short timeout.
    const mids = await Promise.race([
      fetchAllMids().catch(() => ({}) as Record<string, string>),
      new Promise<Record<string, string>>((res) => setTimeout(() => res({}), 2500)),
    ]);
    // Fall back to the last good price if the feed missed, so USD figures don't
    // collapse to 0 on a transient timeout.
    const solUsd = num(mids["SOL"]) || _lastGoodSolUsd;
    if (num(mids["SOL"]) > 0) _lastGoodSolUsd = num(mids["SOL"]);

    // ── KPIs ──
    const total = tokens.length;
    const live = tokens.filter((t) => t.status === "live").length;
    const graduated = tokens.filter((t) =>
      ["graduated", "completed"].includes(String(t.migration_status)),
    ).length;
    const oiUsd = tokens.reduce(
      (s, t) => s + (t.position_opened_at ? num(t.position_size_usd) : 0),
      0,
    );
    const collUsd = tokens.reduce((s, t) => s + num(t.position_collateral_usd), 0);
    const pnlUsd = tokens.reduce((s, t) => s + num(t.treasury_pnl_usd), 0);
    const feesUsd = tokens.reduce((s, t) => s + num(t.fees_accrued_usd), 0);
    const reserveUsd = tokens.reduce((s, t) => s + num(t.buyback_reserve_usd), 0);
    // Internal (DBC/DAMM) burns roll up into tokens.tokens_burned; external
    // (pump.fun) burns are NEVER written there — they exist only as
    // external_buyback event rows (tokens_amount). Sum both, aggregating the
    // external side per token so the leaderboard credits pump.fun tokens too.
    const burnedInternalRaw = tokens.reduce((s, t) => s + num(t.tokens_burned), 0);

    // Aggregate raised across every launched token, in USD. sol_raised is the
    // pool's quote-reserve raised amount, denominated in the pool's quote token:
    // USDC pools already read in USD; SOL pools convert at the SOL price. (This
    // is capital raised, not cumulative trading volume — the app doesn't index
    // per-token swap volume anywhere.)
    const raisedUsd = tokens.reduce((s, t) => {
      const raised = num(t.sol_raised);
      if (raised <= 0) return s;
      return s + (String(t.quote_token) === "USDC" ? raised : raised * solUsd);
    }, 0);

    // Event roll-ups. Amounts land in sol_amount (SOL, UI units) → convert to USD.
    // Burns and claims are recorded differently on the internal vs external
    // (pump.fun) paths, so both must be counted:
    //   - burn:  internal buyback emits a `burn` row; external buy+burn is folded
    //            into a single `external_buyback` row carrying tokens_amount.
    //   - claim: internal fee claim is `claim`; external creator-fee claim is
    //            `external_sweep`.
    let buybackSol = 0;
    let routedSol = 0;
    let claimSol = 0;
    let burnEvents = 0;
    let externalBurnedRaw = 0;
    const externalBurnedByToken = new Map<string, number>(); // token_id -> raw base units
    for (const e of events) {
      const sol = num(e.sol_amount);
      routedSol += sol;
      if (e.kind === "buyback" || e.kind === "external_buyback") buybackSol += sol;
      if (e.kind === "claim" || e.kind === "external_sweep") claimSol += sol;
      if (e.kind === "burn") burnEvents += 1;
      else if (e.kind === "external_buyback") {
        const tb = num(e.tokens_amount);
        if (tb > 0) {
          burnEvents += 1;
          externalBurnedRaw += tb;
          const id = String(e.token_id ?? "");
          if (id) externalBurnedByToken.set(id, (externalBurnedByToken.get(id) ?? 0) + tb);
        }
      }
    }
    const buybackUsd = buybackSol * solUsd;
    const routedUsd = routedSol * solUsd;
    const claimUsd = claimSol * solUsd;
    const burnedTokens = (burnedInternalRaw + externalBurnedRaw) / TOKEN_DECIMALS_DIVISOR;

    // ── distributions ──
    const assets = countBy(tokens, "underlying", (v) => String(v ?? "").toUpperCase());
    const levRaw = countBy(tokens, "leverage", (v) => String(num(v)));
    const leverages: LevBucket[] = levRaw
      .map((b) => ({
        label: `${b.label}x`,
        value: b.value,
        tier: (Number(b.label) <= 5 ? "base" : "degen") as "base" | "degen",
      }))
      .sort((a, b) => parseInt(a.label) - parseInt(b.label));
    const direction = countBy(tokens, "direction", (v) => String(v ?? "unknown"));
    const router = countBy(tokens, "router", (v) => String(v ?? "unknown"));
    const source = countBy(tokens, "source", (v) => String(v ?? "unknown"));
    const status = countBy(tokens, "status", (v) => String(v ?? "unknown"));
    const wfStates = countBy(workflows, "state", (v) => String(v ?? "unknown"));

    // ── time-series (last 30 days) ──
    const dayKey = (iso: unknown) => String(iso ?? "").slice(0, 10);
    const launchByDay = new Map<string, number>();
    const bbByDay = new Map<string, number>();
    const feeByDay = new Map<string, number>();
    for (const t of tokens) {
      const d = dayKey(t.created_at);
      if (d) launchByDay.set(d, (launchByDay.get(d) ?? 0) + 1);
    }
    for (const e of events) {
      const d = dayKey(e.created_at);
      if (!d) continue;
      if (e.kind === "buyback" || e.kind === "external_buyback")
        bbByDay.set(d, (bbByDay.get(d) ?? 0) + num(e.sol_amount));
      if (e.kind === "claim" || e.kind === "external_sweep")
        feeByDay.set(d, (feeByDay.get(d) ?? 0) + num(e.sol_amount));
    }
    const allDays = [...new Set([...launchByDay.keys(), ...bbByDay.keys(), ...feeByDay.keys()])]
      .sort()
      .slice(-30);
    // Historical rows are converted at the current SOL price — an approximation
    // (we don't store per-day price), fine for a trend view.
    let cum = 0;
    const series: DayPoint[] = allDays.map((day) => {
      cum += bbByDay.get(day) ?? 0;
      return {
        day,
        launches: launchByDay.get(day) ?? 0,
        buybackUsd: (bbByDay.get(day) ?? 0) * solUsd,
        cumBuybackUsd: cum * solUsd,
        feeUsd: (feeByDay.get(day) ?? 0) * solUsd,
      };
    });

    // ── leaderboards ──
    const topBy = (key: string): Leader[] =>
      [...tokens]
        .sort((a, b) => num(b[key]) - num(a[key]))
        .slice(0, 8)
        .map((t) => ({
          id: String(t.id),
          ticker: String(t.ticker ?? "?"),
          underlying: String(t.underlying ?? ""),
          value: num(t[key]),
        }));
    // Burned leaderboard: internal (tokens_burned) + external (per-token
    // external_buyback), scaled to whole tokens (fixes both the PERPSPAD "5.6T"
    // mis-scale and the pump.fun-tokens-show-0 undercount).
    const burned: Leader[] = [...tokens]
      .map((t) => ({
        id: String(t.id),
        ticker: String(t.ticker ?? "?"),
        underlying: String(t.underlying ?? ""),
        raw: num(t.tokens_burned) + (externalBurnedByToken.get(String(t.id)) ?? 0),
      }))
      .sort((a, b) => b.raw - a.raw)
      .slice(0, 8)
      .map(({ raw, ...r }) => ({ ...r, value: raw / TOKEN_DECIMALS_DIVISOR }));
    const leaderboards = {
      fees: topBy("fees_accrued_usd"),
      pnl: topBy("treasury_pnl_usd"),
      size: topBy("position_size_usd"),
      burned,
    };

    const result: StatsResult = {
      ok: true as const,
      error: null as string | null,
      solUsd,
      kpis: {
        total,
        live,
        graduated,
        oiUsd,
        collUsd,
        pnlUsd,
        feesUsd,
        reserveUsd,
        raisedUsd,
        burnedTokens,
        buybackUsd,
        routedUsd,
        claimUsd,
        burnEvents,
      },
      distributions: { assets, leverages, direction, router, source, status, wfStates },
      series,
      leaderboards,
    };
    _statsCache = { at: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error("getPlatformStats", e);
    return {
      ok: false as const,
      error: (e as Error)?.message ?? "Failed to load stats",
      solUsd: 0,
      kpis: null,
      distributions: null,
      series: [] as DayPoint[],
      leaderboards: null,
    };
  }
});
