import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { WorkflowState } from "@/lib/keeperWorkflowStates";
import { KeeperLogSchema } from "@/lib/keeperLogSchema";
import type { Json } from "@/integrations/supabase/types";

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

const WorkflowPatchSchema = z.object({
  token_id: z.string().uuid(),
  state: WorkflowState.optional(),
  last_successful_step: z.string().max(80).nullable().optional(),
  blocked_reason: z.string().max(240).nullable().optional(),
  next_retry_at: z.string().datetime().nullable().optional(),
  attempt_count: z.number().int().min(0).optional(),
  locked_at: z.string().datetime().nullable().optional(),
  locked_by: z.string().max(120).nullable().optional(),
  perp_reserved_usd: z.number().finite().min(0).optional(),
  buyback_reserved_usd: z.number().finite().min(0).optional(),
  treasury_reserved_usd: z.number().finite().min(0).optional(),
  imperial_deposited_usd: z.number().finite().min(0).optional(),
  position_entry_price: z.number().finite().min(0).nullable().optional(),
  position_entry_source: z
    .enum(["imperial", "perpspad_entry_mid", "reconciled"])
    .nullable()
    .optional(),
  position_size_usd: z.number().finite().min(0).optional(),
  position_collateral_usd: z.number().finite().min(0).optional(),
  last_observed_sub_sol: z.number().finite().min(0).nullable().optional(),
  last_observed_sub_usdc: z.number().finite().min(0).nullable().optional(),
  last_observed_imperial_usdc: z.number().finite().min(0).nullable().optional(),
  last_observed_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ActionSchema = z.object({
  token_id: z.string().uuid(),
  action_kind: z.enum([
    "fee_claim_dbc",
    "fee_claim_amm",
    "fee_claim_pumpfun",
    "fee_claim_pump_amm",
    "split_fees",
    "treasury_skim",
    "buyback",
    "burn",
    "imperial_deposit",
    "imperial_open",
    "imperial_topup",
    "imperial_withdraw",
    "imperial_close",
    "reconcile",
    "blocked",
    "tick",
  ]),
  intent_hash: z.string().min(8).max(80),
  status: z.enum(["pending", "confirmed", "failed", "blocked", "skipped"]),
  signature: z.string().max(200).nullable().optional(),
  external_id: z.string().max(200).nullable().optional(),
  amount_usd: z.number().finite().nullable().optional(),
  amount_sol: z.number().finite().nullable().optional(),
  amount_tokens: z.number().finite().nullable().optional(),
  request_payload: z.record(z.unknown()).optional(),
  response_payload: z.record(z.unknown()).optional(),
  error: z.string().max(1000).nullable().optional(),
});

const Schema = z.object({
  workflows: z.array(WorkflowPatchSchema).max(500).default([]),
  actions: z.array(ActionSchema).max(1000).default([]),
  logs: z.array(KeeperLogSchema).max(1000).default([]),
});

export const Route = createFileRoute("/api/public/keeper/workflow-report")({
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
        const parsed = Schema.safeParse(body);
        if (!parsed.success) return jsonErr(400, parsed.error.message);

        const now = new Date().toISOString();
        let workflowsUpserted = 0;
        let actionsUpserted = 0;
        let logsInserted = 0;

        if (parsed.data.workflows.length) {
          const rows = parsed.data.workflows.map((w) => ({
            ...w,
            // jsonb column: Zod gives Record<string, unknown>, cast to the
            // generated Json type (same as the logs `fields` cast below).
            metadata: w.metadata as unknown as Json | undefined,
            updated_at: now,
          }));
          const { error } = await supabaseAdmin
            .from("token_workflows")
            .upsert(rows, { onConflict: "token_id" });
          if (error) return jsonErr(500, error.message);
          workflowsUpserted = rows.length;
        }

        if (parsed.data.actions.length) {
          const rows = parsed.data.actions.map((a) => ({
            ...a,
            signature: a.signature ?? null,
            external_id: a.external_id ?? null,
            amount_usd: a.amount_usd ?? null,
            amount_sol: a.amount_sol ?? null,
            amount_tokens: a.amount_tokens ?? null,
            request_payload: (a.request_payload ?? {}) as unknown as Json,
            response_payload: (a.response_payload ?? {}) as unknown as Json,
            error: a.error ?? null,
            confirmed_at: a.status === "confirmed" ? now : null,
            updated_at: now,
          }));
          const { error } = await supabaseAdmin
            .from("keeper_actions")
            .upsert(rows, { onConflict: "token_id,action_kind,intent_hash" });
          if (error) return jsonErr(500, error.message);
          actionsUpserted = rows.length;
        }

        if (parsed.data.logs.length) {
          const rows = parsed.data.logs.map((l) => ({
            token_id: l.token_id,
            tick_id: l.tick_id ?? null,
            level: l.level,
            event: l.event ?? null,
            message: l.message,
            fields: l.fields as unknown as Json,
          }));
          const { error } = await supabaseAdmin.from("keeper_logs").insert(rows);
          if (error) return jsonErr(500, error.message);
          logsInserted = rows.length;
        }

        return Response.json({
          ok: true,
          workflows_upserted: workflowsUpserted,
          actions_upserted: actionsUpserted,
          logs_inserted: logsInserted,
        });
      },
    },
  },
});
