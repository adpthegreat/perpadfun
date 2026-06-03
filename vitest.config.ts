import { defineConfig } from "vitest/config";

// Root test runner for the keeper test suite (test/). See test/TEST_PLAN.md.
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/helpers/setup-env.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The DB-backed suites share ONE local Postgres and TRUNCATE between tests,
    // so files must NOT run in parallel (a parallel file's reset would wipe
    // another's seeded rows mid-test). Pure-logic files are fast regardless.
    fileParallelism: false,
    // Inline zod so vitest uses its ESM entry (the externalized CJS entry leaves
    // the named `z` export undefined under vitest's transform).
    server: { deps: { inline: ["zod"] } },
  },
});
