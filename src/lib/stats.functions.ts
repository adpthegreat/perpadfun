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

type Bucket = { label: string; value: number };
type LevBucket = Bucket & { tier: "base" | "degen" };
type Leader = { id: string; ticker: string; underlying: string; value: number };
type DayPoint = {
  day: string;
  launches: number;
  buybackSol: number;
  cumBuybackSol: number;
  feeSol: number;
};

function countBy(rows: Record<string, unknown>[], key: string, norm: (v: unknown) => string): Bucket[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = norm(r[key]) || "unknown";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

export const getPlatformStats = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const [tokRes, evRes, wfRes] = await Promise.all([
      supabaseAdmin
        .from("tokens")
        .select(
          "id,ticker,underlying,leverage,direction,router,source,status,migration_status,position_size_usd,position_collateral_usd,buyback_reserve_usd,sol_raised,fees_accrued_usd,treasury_pnl_usd,tokens_burned,created_at,position_opened_at",
        )
        .limit(5000),
      supabaseAdmin.from("treasury_events").select("kind,sol_amount,tokens_amount,created_at").limit(60000),
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
    const solUsd = num(mids["SOL"]);

    // ── KPIs ──
    const total = tokens.length;
    const live = tokens.filter((t) => t.status === "live").length;
    const graduated = tokens.filter((t) =>
      ["graduated", "completed"].includes(String(t.migration_status)),
    ).length;
    const oiUsd = tokens.reduce((s, t) => s + (t.position_opened_at ? num(t.position_size_usd) : 0), 0);
    const collUsd = tokens.reduce((s, t) => s + num(t.position_collateral_usd), 0);
    const pnlUsd = tokens.reduce((s, t) => s + num(t.treasury_pnl_usd), 0);
    const feesUsd = tokens.reduce((s, t) => s + num(t.fees_accrued_usd), 0);
    const reserveUsd = tokens.reduce((s, t) => s + num(t.buyback_reserve_usd), 0);
    const burnedTokensCol = tokens.reduce((s, t) => s + num(t.tokens_burned), 0);

    let buybackSol = 0;
    let volumeSol = 0;
    let claimSol = 0;
    let burnEvents = 0;
    for (const e of events) {
      const sol = num(e.sol_amount);
      volumeSol += sol;
      if (e.kind === "buyback" || e.kind === "external_buyback") buybackSol += sol;
      if (e.kind === "claim") claimSol += sol;
      if (e.kind === "burn") burnEvents += 1;
    }

    // ── distributions ──
    const assets = countBy(tokens, "underlying", (v) => String(v ?? "").toUpperCase());
    const levRaw = countBy(tokens, "leverage", (v) => String(num(v)));
    const leverages: LevBucket[] = levRaw
      .map((b) => ({ label: `${b.label}x`, value: b.value, tier: (Number(b.label) <= 5 ? "base" : "degen") as "base" | "degen" }))
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
      if (e.kind === "claim") feeByDay.set(d, (feeByDay.get(d) ?? 0) + num(e.sol_amount));
    }
    const allDays = [...new Set([...launchByDay.keys(), ...bbByDay.keys(), ...feeByDay.keys()])]
      .sort()
      .slice(-30);
    let cum = 0;
    const series: DayPoint[] = allDays.map((day) => {
      cum += bbByDay.get(day) ?? 0;
      return {
        day,
        launches: launchByDay.get(day) ?? 0,
        buybackSol: bbByDay.get(day) ?? 0,
        cumBuybackSol: cum,
        feeSol: feeByDay.get(day) ?? 0,
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
    const leaderboards = {
      fees: topBy("fees_accrued_usd"),
      pnl: topBy("treasury_pnl_usd"),
      size: topBy("position_size_usd"),
      burned: topBy("tokens_burned"),
    };

    return {
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
        burnedTokensCol,
        buybackSol,
        volumeSol,
        claimSol,
        burnEvents,
      },
      distributions: { assets, leverages, direction, router, source, status, wfStates },
      series,
      leaderboards,
    };
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
