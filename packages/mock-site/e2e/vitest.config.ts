import { defineConfig } from "vitest/config";

/**
 * The end-to-end suite: one real browser for the whole run, so files run one after the
 * other in a single fork. Not part of `npm run check`; run with `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    include: ["packages/mock-site/e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    pool: "forks",
    // A hang must fail fast with a message, not run forever. The browser starts in the test
    // file's top level (bounded by the stage timeouts in harness.ts); a test is one flow
    // call (a few steps of at most ~15 s each); the whole run is bounded by the harness
    // watchdog (RAINFOREST_E2E_MAX_MS, default 15 min).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    // Print each test as it finishes: the default reporter is silent until the end when
    // piped, which looks exactly like a hang.
    reporters: ["verbose"],
  },
});
