import { createFileRoute } from "@tanstack/react-router";

// GET /api/docs — Scalar API reference (with a built-in "try it" client) that loads
// the OpenAPI spec from /api/v1/openapi. See plan/PERPSPAD_LAUNCH.md §7.
const html = `<!doctype html>
<html>
  <head>
    <title>perpspad API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export const Route = createFileRoute("/api/docs")({
  server: {
    handlers: {
      GET: async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  },
});
