/**
 * @rainforest/mock-site: a deterministic fake storefront with real cart and list state,
 * for exercising the daemon's read and write flows without touching the real site.
 * Test-only. All content is invented.
 */
export { createHandler, createMockSite, MOCK_FLAGS, SESSION_COOKIE } from "./server.ts";
export type { MockSite, MockSiteOptions } from "./server.ts";
export { CATALOG, ORDERS, product, type Product, type Offer, type Scenario } from "./catalog.ts";
export { Store, initialSession, sessionView, type Session, type TrapName } from "./state.ts";
