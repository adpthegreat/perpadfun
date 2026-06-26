import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// GET /api/v1/launch/$tokenId/metadata — Metaplex-style token metadata JSON. This is the
// deterministic `uri` baked into the pool at build time; it resolves once the launch is
// confirmed (the row exists). 404s before confirmation.
export const Route = createFileRoute("/api/v1/launch/$tokenId/metadata")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { data } = await supabaseAdmin
          .from("tokens")
          .select("name, ticker, description, image_url, website_url, twitter_url")
          .eq("id", params.tokenId)
          .maybeSingle();
        if (!data) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

        const json: Record<string, unknown> = {
          name: data.name,
          symbol: data.ticker,
          description: data.description ?? "",
          image: data.image_url ?? "",
        };
        if (data.website_url) json.external_url = data.website_url;
        const ext: Record<string, string> = {};
        if (data.twitter_url) ext.twitter = data.twitter_url;
        if (data.website_url) ext.website = data.website_url;
        if (Object.keys(ext).length) json.extensions = ext;

        return new Response(JSON.stringify(json), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
        });
      },
    },
  },
});
