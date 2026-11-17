import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pacer, type PageContext, type PageType } from "@rainforest/browser";
import { RfError, type Capture, type PageKind } from "@rainforest/core";
import type { SessionProvider } from "../../daemon/src/browser-controller.ts";
import { addToCart } from "../../daemon/src/flows/add-to-cart.ts";
import { clearCaptureCache, type FlowContext } from "../../daemon/src/flows/common.ts";
import { getBuyingOptions, getProduct, search } from "../../daemon/src/flows/shopping.ts";
import { startSite, type Client } from "./helpers.ts";

/**
 * The real read flows and the real pacer over the mock storefront's HTML, without a
 * browser: a stand-in tab that fetches pages over HTTP and counts loads the way the
 * session does. This is where page-load accounting is pinned (which tool costs how many
 * loads); the browser itself is covered by the E2E suite.
 */

const ASIN = "B0FAKE0001";
const OTHER = "B0FAKE0002";

let c: Client;
beforeAll(async () => {
  c = await startSite();
});
afterAll(async () => {
  await c.site.close();
});

function clock(start = Date.parse("2026-11-16T15:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function rig(pacerOptions: ConstructorParameters<typeof Pacer>[0] = {}) {
  const time = clock();
  const pacer = new Pacer({ ...pacerOptions, now: time.now });
  let current = "about:blank";
  let html = "";
  const load = async (type: PageType): Promise<void> => {
    const plan = pacer.plan(type);
    if (!plan.ok)
      throw new RfError("throttled", `pacing limit reached (${plan.reason})`, {
        retry_after_s: Math.ceil(plan.retryAfterMs / 1000),
      });
    pacer.record(type);
  };
  const tab: PageContext = {
    goto: async (url, type) => {
      await load(type);
      current = url;
      const u = new URL(url);
      html = await c.html(u.pathname + u.search);
    },
    follow: async (url, type) => tab.goto(url, type),
    capture: async (kind: PageKind): Promise<Capture> => ({
      kind,
      url: current,
      final_url: current,
      captured_at: new Date(time.now()).toISOString(),
      html,
    }),
    fetchFragment: async (pathAndQuery, type) => {
      await load(type);
      return await c.html(pathAndQuery);
    },
    page: {
      url: () => current,
      waitForLoadState: async () => {},
    } as unknown as PageContext["page"],
    guard: {} as PageContext["guard"],
  };
  let queue: Promise<unknown> = Promise.resolve();
  const session = {
    run<T>(work: (ctx: PageContext) => Promise<T>): Promise<T> {
      const next = queue.catch(() => {}).then(() => work(tab));
      queue = next;
      return next;
    },
  };
  const browser = {
    session: async () => session,
    pacer: () => pacer,
    setSignedIn: () => {},
    showOnScreen: () => {},
  } as unknown as SessionProvider;
  const ctx: FlowContext = { browser, now: time.now, signal: new AbortController().signal };
  /** Loads recorded so far, per page type. */
  const loads = (): Record<string, number> =>
    Object.fromEntries(Object.entries(pacer.state.loads).map(([k, v]) => [k, v.length]));
  /** Requests the storefront saw for a path. */
  const hits = async (path: string): Promise<number> =>
    (await c.state()).hits.filter((h) => h.path === path).length;
  return { ctx, pacer, time, loads, hits, moveTab: (url: string) => (current = url) };
}

async function refused(run: Promise<unknown>): Promise<RfError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RfError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeEach(async () => {
  clearCaptureCache();
  await c.reset();
});

describe("get_buying_options page loads", () => {
  it("costs two loads on its own: the product page and its offers panel", async () => {
    const r = rig();
    const result = (await getBuyingOptions({ asin: ASIN }, r.ctx)) as {
      pinned_offer: { offer_id: string } | null;
    };
    expect(result.pinned_offer?.offer_id).toMatch(/^o1\./);
    expect(r.loads()).toEqual({ product: 1, offers: 1 });
    expect(await r.hits(`/dp/${ASIN}`)).toBe(1);
  });

  it("reuses the product page the tab still shows: one load after get_product", async () => {
    const r = rig();
    await getProduct({ asin: ASIN }, r.ctx);
    expect(r.loads()).toEqual({ product: 1 });
    const result = (await getBuyingOptions({ asin: ASIN }, r.ctx)) as {
      pinned_offer: { offer_id: string } | null;
      offers: unknown[];
    };
    expect(result.pinned_offer?.offer_id).toMatch(/^o1\./);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(r.loads()).toEqual({ product: 1, offers: 1 });
    expect(await r.hits(`/dp/${ASIN}`)).toBe(1);
  });

  it("leaves its product page for get_product to reuse", async () => {
    const r = rig();
    await getBuyingOptions({ asin: ASIN }, r.ctx);
    const product = (await getProduct({ asin: ASIN }, r.ctx)) as { asin?: string };
    expect(product.asin).toBe(ASIN);
    expect(r.loads()).toEqual({ product: 1, offers: 1 });
    expect(await r.hits(`/dp/${ASIN}`)).toBe(1);
  });

  it("loads the page again when the tab has moved on, or when it shows another product", async () => {
    const r = rig();
    await getProduct({ asin: ASIN }, r.ctx);
    await search({ query: "widget" }, r.ctx);
    await getBuyingOptions({ asin: ASIN }, r.ctx);
    expect(r.loads()).toEqual({ product: 2, search: 1, offers: 1 });
    await getBuyingOptions({ asin: OTHER }, r.ctx);
    expect(r.loads()).toEqual({ product: 3, search: 1, offers: 2 });
    expect(await r.hits(`/dp/${OTHER}`)).toBe(1);
  });

  it("is refused before any load when only one of its two loads fits", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.pacer.record("search");
      r.time.advance(8000);
    }
    const error = await refused(getBuyingOptions({ asin: ASIN }, r.ctx));
    expect(error.payload.code).toBe("throttled");
    // Five of six loads are used (at 0, 8, 16, 24 and 32 s) and now is 40 s. Two fit once
    // the oldest has left the 10 minute window.
    expect(error.payload.retry_after_s).toBe(560);
    expect(error.payload.details).toEqual({ needed: 2, available: 1 });
    expect(r.loads()).toEqual({ search: 5 });
    expect(await r.hits(`/dp/${ASIN}`)).toBe(0);
  });

  it("with the product page open, the one load it still needs is enough", async () => {
    const r = rig();
    for (let i = 0; i < 4; i++) {
      r.pacer.record("search");
      r.time.advance(8000);
    }
    await getProduct({ asin: ASIN }, r.ctx);
    await getBuyingOptions({ asin: ASIN }, r.ctx);
    expect(r.loads()).toEqual({ search: 4, product: 1, offers: 1 });
  });
});

describe("add_to_cart and the pacing budget", () => {
  async function offerId(r: ReturnType<typeof rig>): Promise<string> {
    const result = (await getBuyingOptions({ asin: ASIN }, r.ctx)) as {
      pinned_offer: { offer_id: string } | null;
    };
    return result.pinned_offer!.offer_id;
  }

  it("is refused with the real wait, and nothing is loaded", async () => {
    const r = rig();
    r.pacer.record("search");
    r.time.advance(8000);
    r.pacer.record("search");
    r.time.advance(8000);
    const offer_id = await offerId(r);
    r.time.advance(10_000);
    // 4 of 6 loads used (at 0, 8, 16 and 16 s); now is 26 s. Four fit when the two oldest
    // have left the window: 8 s + 600 s - 26 s.
    const error = await refused(addToCart({ offer_id }, r.ctx));
    expect(error.payload.code).toBe("throttled");
    expect(error.payload.retry_after_s).toBe(582);
    expect(error.payload.details).toEqual({ needed: 4, available: 2 });
    expect(error.payload.message).not.toMatch(/expired/);
    expect(r.loads()).toEqual({ search: 2, product: 1, offers: 1 });
    expect(await r.hits("/gp/cart/view.html")).toBe(0);
  });

  it("says so when the offer id will not outlive the wait", async () => {
    const r = rig();
    const offer_id = await offerId(r);
    // 25 minutes later the id has 5 minutes left; a fresh burst then fills the window.
    r.time.advance(25 * 60_000);
    for (let i = 0; i < 6; i++) {
      r.pacer.record("search");
      r.time.advance(5000);
    }
    const error = await refused(addToCart({ offer_id }, r.ctx));
    expect(error.payload.code).toBe("throttled");
    expect(error.payload.retry_after_s).toBe(585);
    expect(error.payload.message).toMatch(
      /the offer_id will have expired by then: call get_buying_options again before retrying$/,
    );
  });

  it("an offer id is still good after a full burst window", async () => {
    const r = rig({ burst: { loads: 16 }, global: { perHour: 30 } });
    const offer_id = await offerId(r);
    r.time.advance(11 * 60_000);
    // Past the old 10 minute lifetime: the id is accepted and the flow starts (the
    // stand-in tab cannot click, so it stops at the first control it needs).
    const error = await addToCart({ offer_id }, r.ctx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RfError && error.payload.code === "invalid_arguments").toBe(false);
    expect(r.loads().cart).toBe(1);
  });
});
