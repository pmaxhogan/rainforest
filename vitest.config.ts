import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared build machines are slow enough that the 5 s default fails healthy tests.
    testTimeout: 20_000,
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.mjs"],
    exclude: ["**/node_modules/**", ".claude/**", "packages/worker/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "json-summary", "cobertura"],
    },
  },
});
