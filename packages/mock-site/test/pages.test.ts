import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyInterstitial,
  parseCart,
  parseInvoice,
  parseList,
  parseListsIndex,
  parseOffers,
  parseOrderDetails,
  parseOrderList,
  parseProduct,
  parseSearch,
  parseVariants,
} from "@rainforest/parsers";
import { FAKE } from "@rainforest/core";
import { CATALOG } from "../src/index.ts";
import { startSite, type Client } from "./helpers.ts";

/**
 * The served HTML goes through the REAL parsers: this is what keeps the mock's markup in
 * step with what the flows key on, without a browser.
 */

let c: Client;
beforeAll(async () => {
  c = await startSite();
});
afterAll(async () => {
  await c.site.close();
});

const aod = (asin: string): Promise<string> =>
  c.html(`/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin=${asin}&pc=dp`);

describe("catalog", () => {
  it("uses only invented ids", () => {
    for (const p of CATALOG.values()) {
      expect(p.asin).toMatch(/^B0FAKE[0-9A-Z]{4}$/);
      expect(p.asin).toMatch(FAKE.asinPattern);
    }
  });
});

describe("pages parse", () => {
  it("search: sponsored and organic cards, widget, refinements, pagination", async () => {
    const r = parseSearch(await c.capture("search", "/s?k=example"));
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.other_sections).toEqual([]);
    const sponsored = r.data.results.filter((x) => x.is_sponsored);
    expect(sponsored.map((x) => x.asin)).toEqual(["B0FAKE0002"]);
    expect(sponsored[0]!.sponsored_signals.length).toBeGreaterThan(3);
    expect(r.data.results.filter((x) => !x.is_sponsored).map((x) => x.asin)).toEqual([
      "B0FAKE0001",
      "B0FAKE0003",
      "B0FAKE0004",
      "B0FAKE0005",
    ]);
    expect(r.data.widgets.map((w) => [w.type, w.items.length])).toEqual([["carousel", 2]]);
    const brands = r.data.refinements.find((g) => g.key === "p_123")!;
    expect(brands.options.every((o) => o.token?.startsWith("/s?"))).toBe(true);
    expect(r.data.pagination?.has_next).toBe(true);
    const page2 = parseSearch(await c.capture("search", "/s?k=example&page=2"));
    expect(page2.data.pagination?.current_page).toBe(2);
    const filtered = parseSearch(
      await c.capture("search", "/s?k=example&rh=p_123%3ASample%20Optics"),
    );
    expect(filtered.data.results.filter((x) => !x.is_sponsored).map((x) => x.asin)).toEqual([
      "B0FAKE0006",
      "B0FAKE0008",
    ]);
  });

  it("product: one buy-box state per scenario", async () => {
    const expected: Record<string, string> = {
      B0FAKE0001: "featured_offer",
      B0FAKE0002: "featured_offer",
      B0FAKE0003: "featured_offer",
      B0FAKE0004: "no_featured_offer",
      B0FAKE0005: "unavailable",
      B0FAKE0006: "used_only",
      B0FAKE0007: "featured_offer",
      B0FAKE0008: "featured_offer",
      B0FAKE0009: "featured_offer",
      B0FAKE000A: "featured_offer",
      B0FAKE000B: "preorder",
      B0FAKE00V2: "featured_offer",
    };
    for (const [asin, state] of Object.entries(expected)) {
      const capture = await c.capture("product", `/dp/${asin}`);
      expect(classifyInterstitial(capture), asin).toBeNull();
      const r = parseProduct(capture);
      expect(r.meta.warnings, asin).toEqual([]);
      expect(r.meta.unparsed_text_chars, asin).toBe(0);
      expect(r.data.buy_box.state, asin).toBe(state);
    }
    const f = async (asin: string) =>
      parseProduct(await c.capture("product", `/dp/${asin}`)).data.featured_offer;
    expect((await f("B0FAKE0001"))?.fulfillment).toBe("amazon");
    expect((await f("B0FAKE0002"))?.fulfillment).toBe("fba");
    expect((await f("B0FAKE0003"))?.fulfillment).toBe("merchant");
    expect((await f("B0FAKE0007"))?.subscribe_and_save?.default_selected).toBe(true);
    expect((await f("B0FAKE0008"))?.coupon?.clippable).toBe(true);
    expect((await f("B0FAKE0009"))?.limits_text).toEqual(["Limit 2 per customer"]);
    expect((await f("B0FAKE0001"))?.buy_now_present).toBe(true);
  });

  it("offers: pinned vs listed offers, flags, and internal ids for every add control", async () => {
    const flagsOf = async (asin: string) => {
      const r = parseOffers(await c.capture("offers", `/dp/${asin}`, { aod: await aod(asin) }));
      return r.data;
    };
    const platform = await flagsOf("B0FAKE0001");
    expect(platform.pinned_offer?.flags).toEqual([]);
    // The sticky pinned duplicate is not an offer.
    expect(platform.offers).toHaveLength(2);
    for (const o of [platform.pinned_offer!, ...platform.offers]) {
      const internal = (o as unknown as { internal: { offer_listing_id: string | null } }).internal;
      expect(internal.offer_listing_id).toMatch(/^FAKEOLID/);
    }
    expect((await flagsOf("B0FAKE0002")).pinned_offer?.flags).toEqual(["third_party_seller"]);
    expect((await flagsOf("B0FAKE0003")).pinned_offer?.flags).toEqual(
      expect.arrayContaining(["third_party_seller", "merchant_fulfilled"]),
    );
    const none = await flagsOf("B0FAKE0004");
    expect(none.pinned_offer).toBeNull();
    expect(none.no_featured_offer).toBe(true);
    expect((await flagsOf("B0FAKE0006")).pinned_offer?.flags).toContain("used_or_renewed");
    expect((await flagsOf("B0FAKE0007")).pinned_offer?.flags).toEqual([
      "subscribe_and_save_default",
    ]);
    expect((await flagsOf("B0FAKE0009")).pinned_offer?.flags).toEqual(["quantity_limit"]);
    expect((await flagsOf("B0FAKE000A")).pinned_offer?.flags).toEqual(["protection_plan_prompt"]);
    expect((await flagsOf("B0FAKE000B")).pinned_offer?.flags).toEqual(["preorder_or_backorder"]);
  });

  it("variants: color x size with a missing combination", async () => {
    const r = parseVariants(await c.capture("product", "/dp/B0FAKE00V2"));
    expect(r.meta.warnings).toEqual([]);
    expect(r.data.parent_asin).toBe("B0FAKE00V0");
    expect(r.data.combinations).toHaveLength(4);
    const size = r.data.dimensions.find((d) => d.key === "size_name")!;
    expect(size.values.map((v) => [v.value, v.state])).toEqual([
      ["S", "available"],
      ["M", "available"],
      ["L", "see_options"],
    ]);
  });

  it("cart", async () => {
    const r = parseCart(await c.capture("cart", "/gp/cart/view.html"));
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.data.active_items.map((i) => [i.asin, i.quantity])).toEqual([
      ["B0FAKE0001", 1],
      ["B0FAKE0003", 2],
    ]);
    expect(r.data.saved_items.map((i) => i.asin)).toEqual(["B0FAKE0008"]);
    expect(r.data.subtotal?.amount).toBe(104.97);
    expect(r.data.checkout_available).toBe(true);
    for (const i of r.data.active_items) expect(i.item_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it("cart markup matches the real controls: stepper, hidden quantity box, hidden duplicate", async () => {
    const html = await c.html("/gp/cart/view.html");
    const r = parseCart(await c.capture("cart", "/gp/cart/view.html"));
    for (const i of r.data.active_items) {
      const box = new RegExp(
        `<span[^>]*sc-action-quantity[^>]*data-itemid="${i.item_id}"[^>]*data-old-value="${i.quantity}"`,
      );
      expect(html).toMatch(box);
      expect(html).toContain(`name="submit.delete-active.${i.item_id}"`);
    }
    expect(html).not.toContain('<select name="quantity"');
    expect(html).toMatch(
      /data-action="a-stepper-decrement" data-a-selector="decrement" aria-label="Decrease quantity by one, Quantity is 1, /,
    );
    expect(html).toMatch(
      /data-action="a-stepper-increment" data-a-selector="increment" aria-label="Increase quantity by one, Quantity is 2, /,
    );
    expect(html).toMatch(/<input name="quantityBox" type="number" value="2"/);
    const saved = r.data.saved_items[0]!;
    const moves = html.split(`name="submit.move-to-cart.${saved.item_id}"`).length - 1;
    expect(moves).toBe(2);
    expect(html).toMatch(/class="sc-hidden" style="display:none"><div data-action="move-to-cart">/);
  });

  it("lists index and list", async () => {
    const index = parseListsIndex(await c.capture("lists_index", "/hz/wishlist/ls"));
    expect(index.meta.unparsed_text_chars).toBe(0);
    expect(index.data.lists.map((l) => [l.name, l.privacy, l.is_default])).toEqual([
      ["Shopping List", "private", true],
      ["Gift Ideas", "shared", false],
    ]);
    const id = index.data.lists[1]!.list_id;
    expect(id).toMatch(/^[A-Z0-9]{8,16}$/);
    const list = parseList(await c.capture("list", `/hz/wishlist/ls/${id}`));
    expect(list.meta.warnings).toEqual([]);
    expect(list.data.list.name).toBe("Gift Ideas");
    expect(list.data.items.map((i) => [i.asin, i.quantity_wanted, i.priority])).toEqual([
      ["B0FAKE000B", 2, "high"],
    ]);
    const first = parseList(
      await c.capture("list", `/hz/wishlist/ls/${index.data.lists[0]!.list_id}`),
    );
    expect(first.data.items.map((i) => i.comment ?? null)).toEqual([
      null,
      "Compare scanners first",
    ]);
    expect((await c.get("/hz/wishlist/ls/ZZZZZZZZZZZZ")).status).toBe(404);
  });

  it("orders, details and invoice", async () => {
    const list = parseOrderList(await c.capture("order_list", "/your-orders/orders"));
    expect(list.meta.unparsed_text_chars).toBe(0);
    expect(list.data.orders.map((o) => [o.order_id, o.total?.amount])).toEqual([
      ["000-0000000-0000001", 113.57],
      ["000-0000000-0000002", 19.44],
    ]);
    expect(list.data.pagination?.has_next).toBe(false);
    const id = "000-0000000-0000001";
    const details = parseOrderDetails(
      await c.capture("order_details", `/gp/your-account/order-details?orderID=${id}`),
    );
    expect(details.meta.warnings).toEqual([]);
    expect(details.data.order_id).toBe(id);
    expect(details.data.ship_to?.name).toBe("Alex Example");
    const invoice = parseInvoice(
      await c.capture("invoice", `/gp/css/summary/print.html?orderID=${id}`),
    );
    expect(invoice.data.order_total?.amount).toBe(113.57);
    expect(() =>
      parseOrderDetails({
        kind: "order_details",
        url: "https://www.amazon.com/x",
        final_url: "https://www.amazon.com/x",
        captured_at: "2026-01-01T00:00:00Z",
        html: "",
      }),
    ).toThrow();
  });

  it("an unknown order is the error banner the flow maps to not_found", async () => {
    const capture = await c.capture(
      "order_details",
      "/gp/your-account/order-details?orderID=000-0000000-0000099",
    );
    expect(() => parseOrderDetails(capture)).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({
          details: expect.objectContaining({ reason: "error_banner" }),
        }),
      }),
    );
    expect(() => parseInvoice(capture)).toThrow();
  });
});

describe("friction pages classify", () => {
  it("each forced page is recognized, and normal pages are not", async () => {
    const kind = async (path: string) =>
      classifyInterstitial(await c.capture("search", path))?.kind ?? null;
    expect(await kind("/s?k=x&mock=captcha")).toBe("captcha");
    expect(await kind("/s?k=x&mock=checkpoint-inline")).toBe("soft_challenge");
    expect(await kind("/s?k=x&mock=throttle")).toBe("throttled");
    expect(await kind("/s?k=x&mock=notfound")).toBe("not_found");
    expect(await kind("/ap/signin")).toBe("sign_in");
    expect(await kind("/checkpoint/continue")).toBe("soft_challenge");
    expect(await kind("/errors/validateCaptcha")).toBe("captcha");
    for (const p of ["/", "/gp/cart/view.html", "/s?k=x", "/hz/wishlist/ls", "/your-orders/orders"])
      expect(await kind(p), p).toBeNull();
  });
});
