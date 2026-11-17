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
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
