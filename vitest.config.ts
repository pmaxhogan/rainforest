import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.mjs"],
    exclude: ["**/node_modules/**", ".claude/**", "packages/worker/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "json-summary", "cobertura"],
    },
  },
});
