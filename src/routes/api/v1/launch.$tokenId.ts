import { createFileRoute } from "@tanstack/react-router";
import { apiOk, apiErr } from "@/lib/api/respond";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// GET /api/v1/launch/:tokenId — launch status / pool state. Public.
export const Route = createFileRoute("/api/v1/launch/$tokenId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { data, error } = await supabaseAdmin
          .from("tokens")
          .select("id, ticker, status, migration_status, mint_address, dbc_pool_address, launch_signature")
          .eq("id", params.tokenId)
          .maybeSingle();
        if (error) return apiErr(500, "server_error", error.message);
        if (!data) return apiErr(404, "not_found", "token not found");
        return apiOk({
          tokenId: data.id,
          ticker: data.ticker,
          status: data.status,
          migrationStatus: data.migration_status,
          mint: data.mint_address,
          poolAddress: data.dbc_pool_address,
          launchSignature: data.launch_signature,
        });
      },
    },
  },
});
