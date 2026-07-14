import { createFileRoute } from "@tanstack/react-router";
import { getServerSolanaRpcUrl } from "@/lib/wallet/solanaConfig";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Solana-Client",
  "Access-Control-Max-Age": "86400",
} as const;

function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function isAllowedPreviewOrigin(origin: string | null) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith("lovableproject.com") ||
      hostname.endsWith("lovable.app") ||
      hostname === "perpspad.fun" ||
      hostname === "www.perpspad.fun"
    );
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/public/solana/rpc")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        if (!isAllowedPreviewOrigin(request.headers.get("origin"))) {
          return jsonError(403, "Origin not allowed");
        }

        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return jsonError(415, "Expected application/json");
        }

        const body = await request.text();
        if (body.length > 1_000_000) return jsonError(413, "RPC request too large");

        const upstream = await fetch(getServerSolanaRpcUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("content-type") ?? "application/json",
            ...corsHeaders,
          },
        });
      },
    },
  },
});
