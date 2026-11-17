/**
 * Test-only configuration shared by vitest.config.ts (Node) and the tests (workerd).
 * Everything here is synthetic: example.com hosts and emails, generated hex values.
 */
export const BASE_URL = "https://hub.example.com";
export const TEAM_DOMAIN = "team.cloudflareaccess.com";
export const ACCESS_AUD = "ab".repeat(32);
export const OWNER_EMAIL = "owner@example.com";
/** The app password used by every test (at least 22 characters). */
export const TEST_PASSWORD = "test-app-password-0123456789-abcdef";
export const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
