import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

function jsonErr(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const Schema = z.object({
  token_ids: z.array(z.string().uuid()).min(1).max(500),
  owner: z.string().min(1).max(120),
  stale_after_seconds: z.number().int().min(30).max(3600).default(300),
});

export const Route = createFileRoute("/api/public/keeper/workflow-locks")({
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

        const now = new Date();
        const staleBefore = new Date(
          now.getTime() - parsed.data.stale_after_seconds * 1000,
        ).toISOString();
        const tokenIds = [...new Set(parsed.data.token_ids)];

        await supabaseAdmin.from("token_workflows").upsert(
          tokenIds.map((tokenId) => ({ token_id: tokenId })),
          { onConflict: "token_id" },
        );

        const { data: candidates, error: readErr } = await supabaseAdmin
          .from("token_workflows")
          .select("token_id, locked_at, locked_by")
          .in("token_id", tokenIds);
        if (readErr) return jsonErr(500, readErr.message);

        const claimable = (candidates ?? [])
          .filter(
            (row) =>
              !row.locked_at ||
              row.locked_by === parsed.data.owner ||
              new Date(row.locked_at).toISOString() < staleBefore,
          )
          .map((row) => row.token_id);

        if (!claimable.length) return Response.json({ ok: true, locked_token_ids: [] });

        const { data: locked, error: lockErr } = await supabaseAdmin
          .from("token_workflows")
          .update({
            locked_at: now.toISOString(),
            locked_by: parsed.data.owner,
          })
          .in("token_id", claimable)
          .select("token_id");
        if (lockErr) return jsonErr(500, lockErr.message);

        return Response.json({
          ok: true,
          locked_token_ids: (locked ?? []).map((row) => row.token_id),
        });
      },
    },
  },
});
