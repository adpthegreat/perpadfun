import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Keeper posts sweep results here. We log a treasury_event per sweep.
// Auth: shared secret in x-keeper-secret header.

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

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

const ALLOWED_KINDS = [
  "external_sweep", // legacy: full balance swept to master
  "external_split_treasury", // 25% leg sent to master treasury
  "external_buyback", // 25% leg swapped to external_mint + burned
  "external_perp", // 50% leg routed to perp position
] as const;

function actionKindForSweep(kind: (typeof ALLOWED_KINDS)[number]) {
  switch (kind) {
    case "external_split_treasury":
      return "treasury_skim";
    case "external_buyback":
      return "buyback";
    case "external_perp":
      return "imperial_deposit";
    case "external_sweep":
    default:
      return "fee_claim_pumpfun";
  }
}

async function upsertExternalWorkflow(
  rows: Array<{
    token_id: string;
    kind: string;
    sol_amount: number;
    tokens_amount: number | null;
    tx_sig: string | null;
    note: string | null;
  }>,
) {
  if (!rows.length) return;
  const now = new Date().toISOString();
  const byToken = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byToken.get(row.token_id) ?? [];
    list.push(row);
    byToken.set(row.token_id, list);
  }

  for (const [tokenId, tokenRows] of byToken) {
    const blocked = [...tokenRows]
      .reverse()
      .find((row) =>
        /\b(skip|defer|deferred|failed|err|error|below|unsupported|capacity|unavailable)\b/i.test(
          row.note ?? "",
        ),
      );
    const hasPerp = tokenRows.some((row) => row.kind === "external_perp");
    const hasClaim = tokenRows.some((row) => row.kind === "external_sweep" && row.sol_amount > 0);
    const hasBuyback = tokenRows.some((row) => row.kind === "external_buyback");
    const state = blocked
      ? "blocked"
      : hasPerp
        ? "imperial_deposited"
        : hasClaim || hasBuyback
          ? "split_reserved"
          : "idle";

    await supabaseAdmin.from("token_workflows").upsert(
      {
        token_id: tokenId,
        state,
        last_successful_step: blocked ? undefined : "external_sweep",
        blocked_reason: blocked?.note?.slice(0, 240) ?? null,
        next_retry_at: blocked ? new Date(Date.now() + 60_000).toISOString() : null,
        last_observed_at: now,
        metadata: {
          source: "external-sweep-report",
          event_count: tokenRows.length,
        },
      },
      { onConflict: "token_id" },
    );

    const actionRows = tokenRows.map((row) => ({
      token_id: row.token_id,
      action_kind: actionKindForSweep(row.kind as (typeof ALLOWED_KINDS)[number]),
      intent_hash:
        `${row.kind}:${row.tx_sig ?? now}:${Math.round((row.sol_amount ?? 0) * 1e9)}`.slice(0, 80),
      status: blocked && row === blocked ? "blocked" : "confirmed",
      signature: row.tx_sig,
      amount_sol: row.sol_amount,
      amount_tokens: row.tokens_amount,
      request_payload: { source: "external-sweep-report" },
      response_payload: { note: row.note },
      error: blocked && row === blocked ? row.note : null,
      confirmed_at: blocked && row === blocked ? null : now,
    }));
    await supabaseAdmin
      .from("keeper_actions")
      .upsert(actionRows, { onConflict: "token_id,action_kind,intent_hash" });
  }
}

const Schema = z.object({
  sweeps: z
    .array(
      z.object({
        token_id: z.string().uuid(),
        kind: z.enum(ALLOWED_KINDS).optional(),
        swept_sol: z.number().min(0).max(1_000_000),
        tokens_amount: z.number().min(0).max(1_000_000_000_000_000).optional().nullable(),
        tx_sig: z.string().min(8).max(200).optional().nullable(),
        note: z.string().max(500).optional().nullable(),
      }),
    )
    .max(500),
});

export const Route = createFileRoute("/api/public/keeper/external-sweep-report")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) {
          return new Response(
            JSON.stringify({ ok: false, error: "KEEPER_SECRET not configured" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return unauthorized();

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ ok: false, error: "invalid json" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return new Response(JSON.stringify({ ok: false, error: parsed.error.message }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const rows = parsed.data.sweeps.map((s) => ({
          token_id: s.token_id,
          kind: s.kind ?? "external_sweep",
          sol_amount: s.swept_sol,
          tokens_amount: s.tokens_amount ?? null,
          tx_sig: s.tx_sig ?? null,
          note: s.note ?? `${s.kind ?? "external_sweep"} ${s.swept_sol} SOL`,
        }));

        if (!rows.length) return Response.json({ ok: true, inserted: 0 });

        const { error } = await supabaseAdmin.from("treasury_events").insert(rows);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        await upsertExternalWorkflow(rows);

        // Bump cumulative fees_accrued_usd per token from the actual perp-margin
        // leg. Prefer the explicit external_perp event when present; otherwise
        // fall back to 50% of the gross external_sweep claim.
        let solUsd = 0;
        try {
          const r = await fetch(
            "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112",
            { headers: { accept: "application/json" } },
          );
          if (r.ok) {
            const j = (await r.json()) as Record<string, { usdPrice?: number }>;
            const p = j["So11111111111111111111111111111111111111112"]?.usdPrice;
            if (typeof p === "number" && p > 0) solUsd = p;
          }
        } catch {
          // best-effort; skip the bump if price is unavailable.
        }
        if (solUsd > 0) {
          const claimSolByToken = new Map<string, number>();
          const perpUsdByToken = new Map<string, number>();
          for (const r of rows) {
            if (r.kind === "external_sweep" && r.sol_amount && r.sol_amount > 0) {
              claimSolByToken.set(
                r.token_id,
                (claimSolByToken.get(r.token_id) ?? 0) + r.sol_amount,
              );
            }
            if (r.kind === "external_perp" && r.note && !r.note.includes("pre-deposit swap")) {
              const depositUsd = r.note.match(/imperial deposit: \+\$([0-9]+(?:\.[0-9]+)?)/)?.[1];
              const addUsd = depositUsd ? Number(depositUsd) : Number(r.sol_amount ?? 0) * solUsd;
              if (Number.isFinite(addUsd) && addUsd > 0) {
                perpUsdByToken.set(r.token_id, (perpUsdByToken.get(r.token_id) ?? 0) + addUsd);
              }
            }
          }
          const tokenIds = new Set([...claimSolByToken.keys(), ...perpUsdByToken.keys()]);
          for (const tokenId of tokenIds) {
            const addUsd =
              perpUsdByToken.get(tokenId) ?? (claimSolByToken.get(tokenId) ?? 0) * solUsd * 0.5;
            if (addUsd <= 0) continue;
            const { data: cur } = await supabaseAdmin
              .from("tokens")
              .select("fees_accrued_usd")
              .eq("id", tokenId)
              .maybeSingle();
            const next = Number(cur?.fees_accrued_usd ?? 0) + addUsd;
            await supabaseAdmin.from("tokens").update({ fees_accrued_usd: next }).eq("id", tokenId);
          }
        }

        // Stamp first_fee_routed_at for any external tokens that just
        // received their first sweep. This unblocks them from showing up
        // in the public market listings.
        const sweptIds = [...new Set(rows.filter((r) => r.sol_amount > 0).map((r) => r.token_id))];
        if (sweptIds.length) {
          await supabaseAdmin
            .from("tokens")
            .update({ first_fee_routed_at: new Date().toISOString() })
            .in("id", sweptIds)
            .is("first_fee_routed_at", null);
        }

        return Response.json({ ok: true, inserted: rows.length });
      },
    },
  },
});
