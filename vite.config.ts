// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
// Note: CJS-global shims (__filename, __dirname, exports, module, require)
// for Worker SSR are installed at runtime in src/server.ts before the
// TanStack handler is imported. Putting them here as `define` was unreliable
// because Vite's text replacement only fires for *static* references; UMD
// wrappers reference these via `typeof X` checks the bundler skips.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
});
