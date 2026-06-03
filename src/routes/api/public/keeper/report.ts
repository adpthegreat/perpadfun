import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Keeper posts here after each Drift tick. Server writes treasury_events
// and updates tokens with new pnl / position state.
//
// Auth: x-keeper-secret header matched against KEEPER_SECRET env.

const EventSchema = z.object({
  kind: z.enum(["tick", "buyback", "burn", "skim", "open", "close", "graduation", "claim"]),
  mid: z.number().finite().optional(),
  pnl_delta_usd: z.number().finite().optional(),
  sol_amount: z.number().finite().optional(),
  tokens_amount: z.number().finite().optional(),
  note: z.string().max(500).optional(),
  tx_sig: z.string().max(128).optional(),
});

const TxLogSchema = z.object({
  kind: z.enum([
    "fee_claim_dbc",
    "fee_claim_amm",
    "swap",
    "burn",
    "drift_adjust",
    "drift_close",
    "imperial_deposit",
    "imperial_open",
    "imperial_close",
    "imperial_topup",
  ]),
  intent_hash: z.string().min(8).max(64),
  status: z.enum(["pending", "confirmed", "failed"]),
  signature: z.string().max(128).nullable().optional(),
  amount_usd: z.number().finite().nullable().optional(),
  amount_sol: z.number().finite().nullable().optional(),
  amount_tokens: z.number().finite().nullable().optional(),
  error: z.string().max(500).nullable().optional(),
});

const ReportSchema = z.object({
  reports: z
    .array(
      z.object({
        token_id: z.string().uuid(),
        position_size_usd: z.number().finite().min(0).optional(),
        position_collateral_usd: z.number().finite().min(0).optional(),
        opened_collateral_usd: z.number().finite().min(0).optional(),
        launch_mid: z.number().finite().min(0).nullable().optional(),
        treasury_pnl_usd: z.number().finite().optional(),
        pnl_high_water_usd: z.number().finite().optional(),
        treasury_sol_delta: z.number().finite().optional(),
        tokens_burned_delta: z.number().finite().min(0).optional(),
        fees_accrued_usd_delta: z.number().finite().optional(),
        buyback_reserve_usd_delta: z.number().finite().optional(),
        last_sol_raised_seen: z.number().finite().min(0).optional(),
        position_opened: z.boolean().optional(),
        pending_drift_sig: z.string().max(128).nullable().optional(),
        last_fee_claim_at: z.string().datetime().optional(),
        last_fee_claim_signature: z.string().max(128).nullable().optional(),
        lp_position_address: z.string().max(64).nullable().optional(),
        migration_status: z.enum(["pending", "graduated"]).optional(),
        graduated_pool_address: z.string().max(64).nullable().optional(),
        imperial_profile_pda: z.string().min(32).max(64).nullable().optional(),
        events: z.array(EventSchema).max(20).default([]),
        tx_log: z.array(TxLogSchema).max(20).default([]),
      }),
    )
    .max(200),
});

function actionKindFromTx(kind: z.infer<typeof TxLogSchema>["kind"]) {
  switch (kind) {
    case "fee_claim_dbc":
    case "fee_claim_amm":
    case "imperial_deposit":
    case "imperial_open":
    case "imperial_topup":
    case "imperial_close":
      return kind;
    case "swap":
      return "buyback";
    case "burn":
      return "burn";
    case "drift_close":
    case "drift_adjust":
    default:
      return "tick";
  }
}

function blockedReasonFromEvents(events: z.infer<typeof EventSchema>[]) {
  const notes = events.map((event) => event.note?.trim()).filter((note): note is string => !!note);
  const stuck = [...notes]
    .reverse()
    .find((note) =>
      /\b(skip|defer|deferred|failed|err|error|below|unsupported|capacity|unavailable|refunded|dropped)\b/i.test(
        note,
      ),
    );
  return stuck ? stuck.slice(0, 240) : null;
}

function workflowStateForReport({
  report,
  currentPositionOpen,
  nextFees,
  blockedReason,
}: {
  report: z.infer<typeof ReportSchema>["reports"][number];
  currentPositionOpen: boolean;
  nextFees: number;
  blockedReason: string | null;
}) {
  if (blockedReason) return "blocked";
  if (report.pending_drift_sig) {
    return currentPositionOpen || report.position_opened === true
      ? "topup_pending"
      : "position_open_pending";
  }
  if (report.position_opened === false) return nextFees > 0 ? "split_reserved" : "idle";
  if (report.position_opened === true || currentPositionOpen) return "position_open";
  if ((report.position_collateral_usd ?? 0) > 0) return "imperial_deposited";
  if (nextFees > 0 || (report.buyback_reserve_usd_delta ?? 0) > 0) return "split_reserved";
  if ((report.fees_accrued_usd_delta ?? 0) > 0) return "fees_claimed";
  return "idle";
}

function jsonErr(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeSecret(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export const Route = createFileRoute("/api/public/keeper/report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) return jsonErr(500, "KEEPER_SECRET not configured");
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return jsonErr(401, "unauthorized");

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonErr(400, "invalid json");
        }
        const parsed = ReportSchema.safeParse(body);
        if (!parsed.success) return jsonErr(400, parsed.error.message);

        const now = new Date().toISOString();
        let eventsInserted = 0;
        let tokensUpdated = 0;
        let txLogInserted = 0;

        for (const r of parsed.data.reports) {
          // Read current treasury_sol / tokens_burned to apply deltas
          const { data: cur } = await supabaseAdmin
            .from("tokens")
            .select(
              "treasury_sol, tokens_burned, fees_accrued_usd, buyback_reserve_usd, position_opened_at, position_collateral_usd, opened_collateral_usd, launch_mid, leverage, router",
            )
            .eq("id", r.token_id)
            .maybeSingle();
          if (!cur) continue;

          const patch: {
            last_tick_at: string;
            last_tick_mid?: number;
            position_size_usd?: number;
            position_collateral_usd?: number;
            opened_collateral_usd?: number;
            launch_mid?: number | null;
            treasury_pnl_usd?: number;
            pnl_high_water_usd?: number;
            treasury_sol?: number;
            tokens_burned?: number;
            fees_accrued_usd?: number;
            buyback_reserve_usd?: number;
            last_sol_raised_seen?: number;
            position_opened_at?: string | null;
            pending_drift_sig?: string | null;
            last_fee_claim_at?: string;
            last_fee_claim_signature?: string | null;
            lp_position_address?: string | null;
            migration_status?: "pending" | "graduated";
            graduated_pool_address?: string | null;
            imperial_profile_pda?: string | null;
          } = { last_tick_at: now };
          const latestMid = r.events.find((e) => e.mid !== undefined)?.mid;
          if (latestMid !== undefined) patch.last_tick_mid = latestMid;
          const currentColl = Number(cur.position_collateral_usd ?? 0);
          const reportedColl = r.position_collateral_usd;
          const reportedSize = r.position_size_usd;
          if (reportedColl !== undefined) patch.position_collateral_usd = reportedColl;
          if (reportedSize !== undefined) patch.position_size_usd = reportedSize;
          // Always honor opened_collateral_usd, including 0 (reset case).
          if (r.opened_collateral_usd !== undefined)
            patch.opened_collateral_usd = r.opened_collateral_usd;
          if (r.launch_mid !== undefined) patch.launch_mid = r.launch_mid;
          if (r.treasury_pnl_usd !== undefined) patch.treasury_pnl_usd = r.treasury_pnl_usd;
          if (r.pnl_high_water_usd !== undefined) patch.pnl_high_water_usd = r.pnl_high_water_usd;
          if (r.treasury_sol_delta)
            patch.treasury_sol = Number(cur.treasury_sol ?? 0) + r.treasury_sol_delta;
          if (r.tokens_burned_delta)
            patch.tokens_burned = Number(cur.tokens_burned ?? 0) + r.tokens_burned_delta;
          if (r.fees_accrued_usd_delta)
            patch.fees_accrued_usd = Math.max(
              0,
              Number(cur.fees_accrued_usd ?? 0) + r.fees_accrued_usd_delta,
            );
          if (r.buyback_reserve_usd_delta)
            patch.buyback_reserve_usd = Math.max(
              0,
              Number(cur.buyback_reserve_usd ?? 0) + r.buyback_reserve_usd_delta,
            );
          if (r.last_sol_raised_seen !== undefined)
            patch.last_sol_raised_seen = r.last_sol_raised_seen;
          if (r.position_opened === true && !cur.position_opened_at) patch.position_opened_at = now;
          if (r.position_opened === false)
            (patch as { position_opened_at?: string | null }).position_opened_at = null;

          if (r.pending_drift_sig !== undefined) patch.pending_drift_sig = r.pending_drift_sig;
          if (r.last_fee_claim_at !== undefined) patch.last_fee_claim_at = r.last_fee_claim_at;
          if (r.last_fee_claim_signature !== undefined)
            patch.last_fee_claim_signature = r.last_fee_claim_signature;
          if (r.lp_position_address !== undefined)
            patch.lp_position_address = r.lp_position_address;
          if (r.migration_status !== undefined) patch.migration_status = r.migration_status;
          if (r.graduated_pool_address !== undefined)
            patch.graduated_pool_address = r.graduated_pool_address;
          if (r.imperial_profile_pda !== undefined)
            patch.imperial_profile_pda = r.imperial_profile_pda;

          const { error: upErr } = await supabaseAdmin
            .from("tokens")
            .update(patch)
            .eq("id", r.token_id);
          if (!upErr) tokensUpdated++;

          if (r.events.length) {
            const rows = r.events.map((e) => ({
              token_id: r.token_id,
              kind: e.kind,
              mid: e.mid ?? null,
              pnl_delta_usd: e.pnl_delta_usd ?? null,
              sol_amount: e.sol_amount ?? null,
              tokens_amount: e.tokens_amount ?? null,
              note: e.note ?? null,
              tx_sig: e.tx_sig ?? null,
            }));
            const { error: evErr } = await supabaseAdmin.from("treasury_events").insert(rows);
            if (!evErr) eventsInserted += rows.length;
          }

          // tx_log: idempotent insert; unique (token_id, kind, intent_hash) means
          // a retry of the same intent collapses to a single row. We use upsert
          // to also update status/signature when a previously-pending intent
          // confirms or fails in a later tick.
          if (r.tx_log.length) {
            const rows = r.tx_log.map((t) => ({
              token_id: r.token_id,
              kind: t.kind,
              intent_hash: t.intent_hash,
              status: t.status,
              signature: t.signature ?? null,
              amount_usd: t.amount_usd ?? null,
              amount_sol: t.amount_sol ?? null,
              amount_tokens: t.amount_tokens ?? null,
              error: t.error ?? null,
              confirmed_at: t.status === "confirmed" ? now : null,
            }));
            const { error: txErr } = await supabaseAdmin
              .from("tx_log")
              .upsert(rows, { onConflict: "token_id,kind,intent_hash" });
            if (!txErr) txLogInserted += rows.length;

            const actionRows = r.tx_log.map((t) => ({
              token_id: r.token_id,
              action_kind: actionKindFromTx(t.kind),
              intent_hash: t.intent_hash,
              status:
                t.status === "pending"
                  ? "pending"
                  : t.status === "confirmed"
                    ? "confirmed"
                    : "failed",
              signature: t.signature ?? null,
              amount_usd: t.amount_usd ?? null,
              amount_sol: t.amount_sol ?? null,
              amount_tokens: t.amount_tokens ?? null,
              request_payload: { source: "keeper-report", tx_kind: t.kind },
              response_payload: {},
              error: t.error ?? null,
              confirmed_at: t.status === "confirmed" ? now : null,
            }));
            await supabaseAdmin
              .from("keeper_actions")
              .upsert(actionRows, { onConflict: "token_id,action_kind,intent_hash" });
          }

          const nextFees = patch.fees_accrued_usd ?? Number(cur.fees_accrued_usd ?? 0);
          const nextReserve = patch.buyback_reserve_usd ?? Number(cur.buyback_reserve_usd ?? 0);
          const nextColl =
            patch.position_collateral_usd ?? Number(cur.position_collateral_usd ?? 0);
          const nextSize = patch.position_size_usd ?? 0;
          const nextEntry = patch.launch_mid ?? cur.launch_mid ?? null;
          const blockedReason = blockedReasonFromEvents(r.events);
          const currentPositionOpen =
            r.position_opened === true ||
            (r.position_opened !== false && Boolean(cur.position_opened_at));
          const workflowRow = {
            token_id: r.token_id,
            state: workflowStateForReport({
              report: r,
              currentPositionOpen,
              nextFees,
              blockedReason,
            }),
            last_successful_step: blockedReason ? undefined : "keeper_report",
            blocked_reason: blockedReason,
            next_retry_at: blockedReason ? new Date(Date.now() + 60_000).toISOString() : null,
            perp_reserved_usd: Math.max(0, nextFees),
            buyback_reserved_usd: Math.max(0, nextReserve),
            treasury_reserved_usd: 0,
            imperial_deposited_usd: Math.max(0, nextColl),
            position_entry_price: nextEntry,
            position_entry_source: nextEntry ? "reconciled" : null,
            position_size_usd: Math.max(0, nextSize),
            position_collateral_usd: Math.max(0, nextColl),
            last_observed_at: now,
            metadata: {
              source: "keeper-report",
              router: cur.router,
              event_count: r.events.length,
            },
          };
          await supabaseAdmin
            .from("token_workflows")
            .upsert(workflowRow, { onConflict: "token_id" });
        }

        return Response.json({
          ok: true,
          tokens_updated: tokensUpdated,
          events_inserted: eventsInserted,
          tx_log_inserted: txLogInserted,
        });
      },
    },
  },
});
