import { createFileRoute } from "@tanstack/react-router";
import { apiOk, apiErr } from "@/lib/api/respond";
import { reconcilePendingLaunches } from "@/lib/launch/pipeline";

// POST /api/admin/reconcile-launches — server-owned promotion of public launches.
// Called from the keeper tick (x-keeper-secret). Promotes each transient `launching`
// row to `live` once its pool exists on-chain, or deletes it past the TTL. This is
// what guarantees every paid launch becomes a managed row without a client callback.
function normalizeSecret(v: string | null | undefined) {
  const t = v?.trim();
  if (!t) return "";
  const f = t[0],
    l = t[t.length - 1];
  return (f === '"' && l === '"') || (f === "'" && l === "'") ? t.slice(1, -1).trim() : t;
}

export const Route = createFileRoute("/api/admin/reconcile-launches")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) return apiErr(500, "server_error", "KEEPER_SECRET not configured");
        if (normalizeSecret(request.headers.get("x-keeper-secret")) !== expected)
          return apiErr(401, "unauthorized", "bad x-keeper-secret");
        const ttlMinutes = Number(new URL(request.url).searchParams.get("ttlMinutes") ?? 20);
        try {
          const res = await reconcilePendingLaunches({ ttlMinutes });
          return apiOk(res);
        } catch (e) {
          return apiErr(500, "reconcile_failed", (e as Error).message);
        }
      },
    },
  },
});
