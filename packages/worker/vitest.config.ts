import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ACCESS_AUD, BASE_URL, OWNER_EMAIL, TEAM_DOMAIN, TEST_PASSWORD } from "./test/constants.ts";

/**
 * Worker tests run inside workerd through @cloudflare/vitest-plugin.
 * Bindings come from wrangler.jsonc; the owner secrets and the KV namespace (which has no
 * id in wrangler.jsonc because it is provisioned at deploy) are supplied here.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          PUBLIC_BASE_URL: BASE_URL,
          ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
          ACCESS_AUD,
          OWNER_EMAIL,
          APP_PASSWORD_SHA256: createHash("sha256").update(TEST_PASSWORD).digest("hex"),
          MIN_DAEMON_VERSION: "0.1.0",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
