import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from "vitest";
import { RfError } from "@rainforest/core";
import { MIN_GAP_MS, rawClient } from "@rainforest/browser";
import { guardedClick } from "../../daemon/src/flows/click-guard.ts";
import { MAX_QUANTITY_STEPS } from "../../daemon/src/flows/cart-writes.ts";
import { clearCaptureCache } from "../../daemon/src/flows/common.ts";
import { FastPacer, PlainTab, STOREFRONT, startHarness, type Harness } from "./harness.ts";

/**
 * The daemon's real BrowserSession and typed flows, driven through a real Chromium with
 * the quiet extension fork, against the mock storefront. See harness.ts for how the
 * storefront hostname is mapped inside the test browser only.
 */

const pacer = new FastPacer({ random: () => 0 });
const start = await startHarness({ pacer });

if (!start.ok) {
  console.warn(`[e2e] SKIPPED: ${start.skip}`);
  describe("storefront e2e", () => {
    it.skip(`skipped: ${start.skip}`, () => {});
  });
} else {
  const h: Harness = start.harness;
  console.warn(`[e2e] running in ${h.mode} mode`);
  afterAll(async () => {
    await h.close();
  });

  const expectRefusal = async (run: () => Promise<unknown>, code: string): Promise<RfError> => {
    let caught: unknown;
    try {
      await run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RfError);
    expect((caught as RfError).payload.code).toBe(code);
    return caught as RfError;
  };

  /**
   * After a refused navigation the session sends the tab to about:blank without waiting
   * for that navigation to finish, so a goto issued right away is "interrupted by another
   * navigation to about:blank" (reported). Wait until a plain load succeeds again.
   */
  const recover = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      try {
        await h.session.run(async (ctx) => {
          await ctx.goto(`${STOREFRONT}/`, "search");
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };

  /** Load a URL through the rails exactly as a flow would. */
  const goto = (path: string): Promise<void> =>
    h.session.run(async (ctx) => {
      await ctx.goto(`${STOREFRONT}${path}`, "search");
    });

  describe("reads parse the mock pages", () => {
    it("search: organic and sponsored results, a widget, refinements and pagination", async () => {
      const r = (await h.call("search", { query: "example" })) as {
        results: { asin: string; is_sponsored: boolean; title: string }[];
        widgets: { type: string; items: unknown[] }[];
        refinements: { key: string; options: { label: string; token: string | null }[] }[];
        pagination: { has_next: boolean; current_page: number };
        meta: { url: string };
      };
      expect(r.meta.url).toMatch(/^https:\/\/www\.amazon\.com\/s\?/);
      const sponsored = r.results.filter((x) => x.is_sponsored).map((x) => x.asin);
      expect(sponsored).toEqual(["B0FAKE0002"]);
      expect(r.results.filter((x) => !x.is_sponsored).length).toBeGreaterThan(0);
      expect(r.widgets.some((w) => w.type === "carousel" && w.items.length === 2)).toBe(true);
      const brands = r.refinements.find((g) => g.key === "p_123");
      expect(brands?.options.length).toBeGreaterThan(1);
      expect(r.pagination.has_next).toBe(true);

      // A refinement token from the response narrows the next search.
      const option = brands!.options.find((o) => o.label === "Sample Optics")!;
      const narrowed = (await h.call("search", {
        query: "example",
        refinements: [option.token],
      })) as {
        results: { asin: string; is_sponsored: boolean }[];
      };
      const organic = narrowed.results.filter((x) => !x.is_sponsored).map((x) => x.asin);
      expect(organic.sort()).toEqual(["B0FAKE0006", "B0FAKE0008"]);
    });

    const product = async (asin: string) =>
      (await h.call("get_product", { asin })) as {
        asin: string;
        buy_box: { state: string };
        featured_offer?: {
          seller?: { name: string };
          fulfillment?: string;
          coupon?: { clippable: boolean };
          limits_text?: string[];
          subscribe_and_save?: { default_selected: boolean };
          buy_now_present?: boolean;
        };
      };

    it("product pages: one buy-box state per footgun shape", async () => {
      const cases: [string, string][] = [
        ["B0FAKE0001", "featured_offer"],
        ["B0FAKE0004", "no_featured_offer"],
        ["B0FAKE0005", "unavailable"],
        ["B0FAKE0006", "used_only"],
        ["B0FAKE000B", "preorder"],
      ];
      for (const [asin, state] of cases) {
        const p = await product(asin);
        expect(p.asin, asin).toBe(asin);
        expect(p.buy_box.state, asin).toBe(state);
      }
      const platform = await product("B0FAKE0001");
      expect(platform.featured_offer?.seller?.name).toBe("Amazon.com");
      expect(platform.featured_offer?.buy_now_present).toBe(true);
      expect((await product("B0FAKE0002")).featured_offer?.fulfillment).toBe("fba");
      expect((await product("B0FAKE0003")).featured_offer?.fulfillment).toBe("merchant");
      expect(
        (await product("B0FAKE0007")).featured_offer?.subscribe_and_save?.default_selected,
      ).toBe(true);
      expect((await product("B0FAKE0008")).featured_offer?.coupon?.clippable).toBe(true);
      expect((await product("B0FAKE0009")).featured_offer?.limits_text).toEqual([
        "Limit 2 per customer",
      ]);
    });

    it("buying options: opaque offer ids, flags, and the sticky duplicate is not an offer", async () => {
      const r = (await h.call("get_buying_options", { asin: "B0FAKE0001" })) as {
        pinned_offer: { offer_id: string; flags: string[] } | null;
        offers: { offer_id: string | null; flags: string[] }[];
      };
      expect(r.pinned_offer?.offer_id).toMatch(/^o1\./);
      expect(r.pinned_offer?.flags).toEqual([]);
      expect(r.offers).toHaveLength(2);
      expect(r.offers[0]?.flags).toEqual(
        expect.arrayContaining(["third_party_seller", "merchant_fulfilled"]),
      );
      expect(r.offers[1]?.flags).toContain("used_or_renewed");
      // Raw offer listing ids never reach the caller.
      expect(JSON.stringify(r)).not.toMatch(/FAKEOLID/);

      const sns = (await h.call("get_buying_options", { asin: "B0FAKE0007" })) as {
        pinned_offer: { flags: string[] } | null;
      };
      expect(sns.pinned_offer?.flags).toContain("subscribe_and_save_default");
      const none = (await h.call("get_buying_options", { asin: "B0FAKE0004" })) as {
        pinned_offer: unknown;
        offers: { flags: string[] }[];
      };
      expect(none.pinned_offer).toBeNull();
      expect(none.offers.every((o) => o.flags.includes("no_featured_offer"))).toBe(true);
    });

    it("buying options reuses the product page the tab still shows", async () => {
      // Earlier reads may have left these pages in the two minute capture cache.
      clearCaptureCache();
      const loaded = async (): Promise<number> =>
        (await h.state()).hits.filter((x) => x.path === "/dp/B0FAKE0002").length;
      const before = await loaded();
      await h.call("get_product", { asin: "B0FAKE0002" });
      expect((await loaded()) - before).toBe(1);
      const r = (await h.call("get_buying_options", { asin: "B0FAKE0002" })) as {
        pinned_offer: { offer_id: string | null } | null;
        offers: unknown[];
      };
      // The offers came from the panel fetched inside the page that was already open.
      expect((r.pinned_offer ? 1 : 0) + r.offers.length).toBeGreaterThan(0);
      expect((await loaded()) - before).toBe(1);
      // And the other way round: the page buying options loads serves the product read.
      const other = async (): Promise<number> =>
        (await h.state()).hits.filter((x) => x.path === "/dp/B0FAKE0003").length;
      const start = await other();
      await h.call("get_buying_options", { asin: "B0FAKE0003" });
      await h.call("get_product", { asin: "B0FAKE0003" });
      expect((await other()) - start).toBe(1);
    });

    it("variants: the color x size matrix", async () => {
      const r = (await h.call("get_variants", { asin: "B0FAKE00V2" })) as {
        dimensions: { key: string; selected_value: string; values: { value: string }[] }[];
      };
      expect(r.dimensions.map((d) => [d.key, d.selected_value, d.values.length])).toEqual([
        ["color_name", "Red", 2],
        ["size_name", "M", 3],
      ]);
    });

    it("cart, lists and orders", async () => {
      await h.reset();
      const cart = (await h.call("get_cart")) as {
        active_items: { asin: string; quantity: number }[];
        saved_items: { asin: string }[];
        subtotal: { amount: number } | null;
      };
      expect(cart.active_items.map((i) => [i.asin, i.quantity])).toEqual([
        ["B0FAKE0001", 1],
        ["B0FAKE0003", 2],
      ]);
      expect(cart.saved_items.map((i) => i.asin)).toEqual(["B0FAKE0008"]);
      expect(cart.subtotal?.amount).toBe(104.97);

      const lists = (await h.call("list_lists")) as { lists: { list_id: string; name: string }[] };
      expect(lists.lists.map((l) => l.name)).toEqual(["Shopping List", "Gift Ideas"]);
      const list = (await h.call("get_list", { list_id: lists.lists[0]!.list_id })) as {
        items: { asin: string; comment?: string }[];
      };
      expect(list.items.map((i) => i.asin)).toEqual(["B0FAKE0002", "B0FAKE0006"]);

      const orders = (await h.call("list_orders")) as { orders: { order_id: string }[] };
      expect(orders.orders.map((o) => o.order_id)).toEqual([
        "000-0000000-0000001",
        "000-0000000-0000002",
      ]);
      const found = (await h.call("search_orders", { query: "canvas tote" })) as {
        order_count: number;
        results: { asin: string; order_id: string; ordered: { iso: string } }[];
        next_page?: number;
      };
      expect(found.order_count).toBe(1);
      expect(found.results.map((r) => [r.asin, r.order_id, r.ordered.iso])).toEqual([
        ["B0FAKE0003", "000-0000000-0000001", "2026-11-02"],
      ]);
      expect(found.next_page).toBeUndefined();
      const paged = (await h.call("search_orders", { query: "example" })) as {
        results: unknown[];
        next_page?: number;
      };
      expect(paged.results).toHaveLength(2);
      expect(paged.next_page).toBe(2);
      const nothing = (await h.call("search_orders", { query: "zzqx vvkk" })) as {
        results: unknown[];
        empty_text: string;
      };
      expect(nothing.results).toEqual([]);
      expect(nothing.empty_text).toContain("No results found");
      const order = (await h.call("get_order", { order_id: "000-0000000-0000001" })) as {
        order_id: string;
      };
      expect(order.order_id).toBe("000-0000000-0000001");
      const invoice = (await h.call("get_invoice", { order_id: "000-0000000-0000001" })) as {
        order_total: { amount: number };
      };
      expect(invoice.order_total.amount).toBe(113.57);
      await expectRefusal(
        () => h.call("get_order", { order_id: "000-0000000-0000099" }),
        "not_found",
      );
    });

    it("show_on_screen hands the page to the human, not to the automation tab", async () => {
      await h.call("show_on_screen", { target: { type: "cart" } });
      expect(h.provider.shown.at(-1)).toBe(`${STOREFRONT}/gp/cart/view.html`);
    });
  });

  describe("writes change real mock state", () => {
    beforeEach(async () => {
      await h.reset();
    });

    type Write = { changed: boolean; before: CartView; after: CartView };
    type CartView = {
      active: { item_id: string; asin: string | null }[];
      saved: { item_id: string; asin: string | null }[];
    };

    const ids = async () => {
      const st = await h.state();
      if (st.session) return st.session.cart;
      await h.call("get_cart");
      return (await h.state()).session!.cart;
    };

    it("remove_from_cart", async () => {
      const cart = await ids();
      const target = cart.active[0]!;
      const r = (await h.call("remove_from_cart", { item_id: target.item_id })) as Write;
      expect(r.changed).toBe(true);
      expect(r.before.active.map((i) => i.asin)).toContain(target.asin);
      expect(r.after.active.map((i) => i.asin)).not.toContain(target.asin);
      expect((await h.state()).session!.cart.active.map((i) => i.item_id)).not.toContain(
        target.item_id,
      );
    });

    it("save_for_later then move_to_cart", async () => {
      const cart = await ids();
      const target = cart.active[1]!;
      const saved = (await h.call("save_for_later", { item_id: target.item_id })) as Write;
      expect(saved.changed).toBe(true);
      expect(saved.after.saved.map((i) => i.asin)).toContain(target.asin);
      expect((await h.state()).session!.cart.saved.map((i) => i.asin)).toContain(target.asin);
      const back = (await h.call("move_to_cart", { item_id: target.item_id })) as Write;
      expect(back.changed).toBe(true);
      expect(back.after.active.map((i) => i.asin)).toContain(target.asin);
      expect((await h.state()).session!.cart.saved.map((i) => i.asin)).not.toContain(target.asin);
    });

    it("delete_saved_item", async () => {
      const cart = await ids();
      const target = cart.saved[0]!;
      const r = (await h.call("delete_saved_item", { item_id: target.item_id })) as Write;
      expect(r.changed).toBe(true);
      expect(r.after.saved).toEqual([]);
      expect((await h.state()).session!.cart.saved).toEqual([]);
    });

    it("a line control from the wrong section is refused without a click", async () => {
      const cart = await ids();
      const err = await expectRefusal(
        () => h.call("move_to_cart", { item_id: cart.active[0]!.item_id }),
        "not_found",
      );
      expect(err.payload.message).toMatch(/active cart/);
      expect((await h.state()).session!.cart.active).toHaveLength(2);
    });

    type Options = {
      pinned_offer: { offer_id: string; flags: string[] } | null;
      offers: { offer_id: string; flags: string[] }[];
    };
    const options = async (asin: string): Promise<Options> =>
      (await h.call("get_buying_options", { asin })) as Options;
    const quantityOf = async (asin: string): Promise<number> =>
      (await h.state())
        .session!.cart.active.filter((l) => l.asin === asin)
        .reduce((n, l) => n + l.quantity, 0);

    it("add_to_cart adds exactly the chosen pinned offer", async () => {
      const o = await options("B0FAKE0001");
      expect(o.pinned_offer?.flags).toEqual([]);
      const r = (await h.call("add_to_cart", { offer_id: o.pinned_offer!.offer_id })) as {
        changed: boolean;
        added: { asin: string } | null;
      };
      expect(r.changed).toBe(true);
      expect(r.added?.asin).toBe("B0FAKE0001");
      expect(await quantityOf("B0FAKE0001")).toBe(2);
      const st = await h.state();
      expect(st.traps).toEqual([]);
    });

    it("add_to_cart refuses an offer with unacknowledged flags and adds nothing", async () => {
      const o = await options("B0FAKE0001");
      const thirdParty = o.offers[0]!;
      await expectRefusal(
        () => h.call("add_to_cart", { offer_id: thirdParty.offer_id }),
        "needs_choice",
      );
      expect(await quantityOf("B0FAKE0001")).toBe(1);
      expect((await h.state()).hits.filter((x) => x.method === "POST")).toEqual([]);
      const r = (await h.call("add_to_cart", {
        offer_id: thirdParty.offer_id,
        acknowledge: thirdParty.flags,
      })) as { changed: boolean };
      expect(r.changed).toBe(true);
      const lines = (await h.state()).session!.cart.active.filter((l) => l.asin === "B0FAKE0001");
      expect(lines.length).toBe(2);
    });

    it("add_to_cart opens the folded other offers to reach an offer inside them", async () => {
      const o = await options("B0FAKE0001");
      // The second of the other offers: the panel shows one and folds the rest away.
      const folded = o.offers[1]!;
      const mark = h.pages.length;
      const r = (await h.call("add_to_cart", {
        offer_id: folded.offer_id,
        acknowledge: folded.flags,
      })) as { changed: boolean; added: { asin: string } | null };
      expect(r.changed).toBe(true);
      expect(r.added?.asin).toBe("B0FAKE0001");
      const lines = (await h.state()).session!.cart.active.filter((l) => l.asin === "B0FAKE0001");
      expect(lines.length).toBe(2);
      expect((await h.state()).traps).toEqual([]);
      // The panel the flow read really had that block folded: this was not the easy path.
      const panel = h.pages.slice(mark).find((p) => p.kind === "offers");
      expect(panel?.html).toMatch(
        /id="aod-retail-other-offers-content"[^>]*aod-oas-other-offers-hide/,
      );
    });

    it("add_to_cart never subscribes, even when Subscribe & Save is the default row", async () => {
      const o = await options("B0FAKE0007");
      await expectRefusal(
        () =>
          h.call("add_to_cart", {
            offer_id: o.pinned_offer!.offer_id,
            purchase_type: "subscribe_and_save",
          }),
        "blocked_by_policy",
      );
      await expectRefusal(
        () => h.call("add_to_cart", { offer_id: o.pinned_offer!.offer_id }),
        "needs_choice",
      );
      await h.call("add_to_cart", {
        offer_id: o.pinned_offer!.offer_id,
        acknowledge: o.pinned_offer!.flags,
      });
      const st = await h.state();
      const line = st.session!.cart.active.find((l) => l.asin === "B0FAKE0007") as
        { subscribe?: boolean } | undefined;
      expect(line).toBeDefined();
      expect(line!.subscribe).toBe(false);
    });

    it("add_to_cart declines the protection plan upsell", async () => {
      const o = await options("B0FAKE000A");
      const r = (await h.call("add_to_cart", {
        offer_id: o.pinned_offer!.offer_id,
        acknowledge: o.pinned_offer!.flags,
      })) as { changed: boolean; declined_upsells: string[] };
      expect(r.changed).toBe(true);
      expect(r.declined_upsells.length).toBeGreaterThan(0);
      expect(await quantityOf("B0FAKE00P1")).toBe(0);
    });

    describe("set_cart_quantity", () => {
      type QtyResult = {
        changed: boolean;
        before: { active: { item_id: string; quantity: number | null }[] };
        after: { active: { item_id: string; quantity: number | null }[] };
      };
      // The seeded cart holds B0FAKE0003 with quantity 2 (no per-customer limit).
      const line = async (): Promise<{ item_id: string; quantity: number }> => {
        await ids(); // seeds the session
        return (await h.state()).session!.cart.active.find((x) => x.asin === "B0FAKE0003")!;
      };
      const stored = async (itemId: string): Promise<number | undefined> =>
        (await h.state()).session!.cart.active.find((x) => x.item_id === itemId)?.quantity;

      it("increases by two with one stepper click per unit", async () => {
        const l = await line();
        expect(l.quantity).toBe(2);
        const posts = (await h.state()).hits.filter((x) => x.method === "POST").length;
        const r = (await h.call("set_cart_quantity", {
          item_id: l.item_id,
          quantity: 4,
        })) as QtyResult;
        expect(r.changed).toBe(true);
        expect(r.before.active.find((i) => i.item_id === l.item_id)?.quantity).toBe(2);
        expect(r.after.active.find((i) => i.item_id === l.item_id)?.quantity).toBe(4);
        expect(await stored(l.item_id)).toBe(4);
        expect((await h.state()).hits.filter((x) => x.method === "POST").length - posts).toBe(2);
      });

      it("decreases by one", async () => {
        const l = await line();
        const r = (await h.call("set_cart_quantity", {
          item_id: l.item_id,
          quantity: 1,
        })) as QtyResult;
        expect(r.changed).toBe(true);
        expect(r.after.active.find((i) => i.item_id === l.item_id)?.quantity).toBe(1);
        expect(await stored(l.item_id)).toBe(1);
      });

      it("the same value is changed:false and clicks nothing", async () => {
        const l = await line();
        const posts = (await h.state()).hits.filter((x) => x.method === "POST").length;
        const r = (await h.call("set_cart_quantity", {
          item_id: l.item_id,
          quantity: 2,
        })) as QtyResult;
        expect(r.changed).toBe(false);
        expect(await stored(l.item_id)).toBe(2);
        expect((await h.state()).hits.filter((x) => x.method === "POST").length).toBe(posts);
      });

      it("a jump larger than MAX_QUANTITY_STEPS is invalid_arguments and changes nothing", async () => {
        const l = await line();
        await expectRefusal(
          () =>
            h.call("set_cart_quantity", {
              item_id: l.item_id,
              quantity: 2 + MAX_QUANTITY_STEPS + 1,
            }),
          "invalid_arguments",
        );
        expect(await stored(l.item_id)).toBe(2);
      });

      it("an unknown item is not_found", async () => {
        await line();
        await expectRefusal(
          () =>
            h.call("set_cart_quantity", {
              item_id: "00000000-0000-0000-0000-000000000000",
              quantity: 3,
            }),
          "not_found",
        );
      });
    });

    test.todo(
      "create_list (the mock storefront does not model this page's real markup yet): #createList popover -> POST /hz/wishlist/create",
    );
    test.todo(
      "update_list (the mock storefront does not model this page's real markup yet): #editYourList settings popover -> POST /hz/wishlist/settings/<ID>",
    );
    test.todo(
      "delete_list (the mock storefront does not model this page's real markup yet): settings popover submit.deleteList",
    );
    test.todo(
      "add_to_list (the mock storefront does not model this page's real markup yet): #addToWishlist on the product page -> POST /hz/wishlist/additem",
    );
    it("remove_from_list deletes exactly that item", async () => {
      const lists = (await h.call("list_lists")) as { lists: { list_id: string }[] };
      const listId = lists.lists[0]!.list_id;
      const list = (await h.call("get_list", { list_id: listId })) as {
        items: { item_id: string; asin: string }[];
      };
      const target = list.items[1]!;
      const r = (await h.call("remove_from_list", {
        list_id: listId,
        item_id: target.item_id,
      })) as {
        changed: boolean;
        after: { items: { item_id: string }[] };
      };
      expect(r.changed).toBe(true);
      expect(r.after.items.map((i) => i.item_id)).toEqual([list.items[0]!.item_id]);
      const st = await h.state();
      expect(st.session!.lists[0]!.items.map((i) => i.asin)).toEqual([list.items[0]!.asin]);
      expect(st.session!.lists[1]!.items).toHaveLength(1);
    });
    test.todo(
      "update_list_item (the mock storefront does not model this page's real markup yet): reg-dispatch-modal edit-notes -> POST /hz/wishlist/cqp",
    );
    test.todo(
      "move_list_item (the mock storefront does not model this page's real markup yet): show-move-to-list-popover -> POST /hz/wishlist/movetolist",
    );
  });

  describe("rails", () => {
    beforeEach(async () => {
      await h.reset();
    });
    afterEach(async () => {
      h.clearCoolDown();
      await recover();
      await h.reset();
    });

    it("navigating to the checkout URL is refused before any request", async () => {
      await expectRefusal(() => goto("/gp/buy/spc/handlers/display.html"), "blocked_by_policy");
      const st = await h.state();
      expect(st.trap_counts.checkout).toBe(0);
      expect(st.hits.some((x) => x.path.startsWith("/gp/buy"))).toBe(false);
    });

    it("a link that 302s into checkout is blocked at the network layer", async () => {
      await expectRefusal(() => goto("/s?k=deal&mock=redirect-checkout"), "blocked_by_policy");
      const st = await h.state();
      // The allowlisted request went out; the redirect hop into checkout never did.
      expect(st.hits.some((x) => x.path === "/s" && x.search.includes("redirect-checkout"))).toBe(
        true,
      );
      expect(st.trap_counts.checkout).toBe(0);
    });

    it("the click guard refuses Proceed to checkout and Buy Now", async () => {
      await h.session.run(async (ctx) => {
        await ctx.goto(`${STOREFRONT}/gp/cart/view.html`, "cart");
        await expectRefusal(
          () =>
            guardedClick(ctx, ctx.page.locator('input[name="proceedToRetailCheckout"]'), {
              what: "a cart line control",
              name: /^proceedToRetailCheckout$/,
            }),
          "blocked_by_policy",
        );
        await ctx.goto(`${STOREFRONT}/dp/B0FAKE0001`, "product");
        await expectRefusal(
          () =>
            guardedClick(ctx, ctx.page.locator("#buy-now-button"), {
              what: "the add-to-cart button",
              name: /^submit\.buy-now$/,
            }),
          "blocked_by_policy",
        );
      });
      const st = await h.state();
      expect(st.traps).toEqual([]);
    });

    it("even a raw click past the guard cannot reach checkout or Buy Now", async () => {
      // Simulates a flow bug that clicks without the click guard: the network guard must
      // refuse the purchase POST, and the session must leave the refused page.
      for (const [path, selector] of [
        ["/gp/cart/view.html", 'input[name="proceedToRetailCheckout"]'],
        ["/dp/B0FAKE0001", "#buy-now-button"],
      ] as const) {
        let blockedSeen = false;
        await expectRefusal(
          () =>
            h.session.run(async (ctx) => {
              await ctx.goto(`${STOREFRONT}${path}`, "cart");
              ctx.guard.reset();
              await ctx.page.locator(selector).click();
              await ctx.page.waitForTimeout(1500);
              blockedSeen = ctx.guard.blocked().some((b) => b.mainFrameDocument);
            }),
          "blocked_by_policy",
        );
        expect(blockedSeen, path).toBe(true);
        await recover();
      }
      const st = await h.state();
      expect(st.traps).toEqual([]);
      expect(st.hits.filter((x) => x.method === "POST")).toEqual([]);
    });

    it("a redirect to /ap/signin is needs_human sign_in with a cool-down", async () => {
      const err = await expectRefusal(() => goto("/gp/cart/view.html?mock=signin"), "needs_human");
      expect(err.payload.kind).toBe("sign_in");
      expect(h.pacer.state.coolingDownUntil).toBeGreaterThan(Date.now());
      expect((await h.state()).trap_counts.sign_in).toBe(0);
      // While cooling down, nothing else loads.
      await expectRefusal(() => goto("/s?k=example"), "throttled");
    });

    for (const [flag, kind] of [
      ["captcha", "captcha"],
      ["checkpoint-inline", "soft_challenge"],
    ] as const) {
      it(`a ${flag} page served in place is needs_human ${kind} with a cool-down`, async () => {
        const err = await expectRefusal(
          () =>
            h.session.run(async (ctx) => {
              await ctx.goto(`${STOREFRONT}/s?k=example&mock=${flag}`, "search");
              await ctx.capture("search");
            }),
          "needs_human",
        );
        expect(err.payload.kind).toBe(kind);
        expect(h.pacer.state.coolingDownUntil).toBeGreaterThan(Date.now());
        // It says the page itself gave it away, and that very page was kept for later.
        expect(err.payload.details).toMatchObject({ seen: "page", while_opening: "/s" });
        expect(typeof err.payload.details?.evidence).toBe("string");
        const kept = h.pages[h.pages.length - 1]!;
        expect(kept.kind).toBe("search");
        expect(kept.html.length).toBeGreaterThan(100);
      });
    }

    for (const [flag, trap] of [
      ["checkpoint", "checkpoint"],
      ["captcha-redirect", "captcha"],
    ] as const) {
      it(`a 302 into the ${trap} page never loads it and asks for a human`, async () => {
        const err = await expectRefusal(() => goto(`/s?k=example&mock=${flag}`), "needs_human");
        expect((await h.state()).trap_counts[trap]).toBe(0);
        expect(h.pacer.state.coolingDownUntil).toBeGreaterThan(Date.now());
        // The refusal names the redirect that was refused, by path, and the session's
        // log has the same line: enough to tell afterwards what Amazon sent.
        expect(err.payload.details).toMatchObject({ seen: "redirect", while_opening: "/s" });
        expect(String(err.payload.details?.friction_path)).toMatch(
          trap === "checkpoint" ? /^\/checkpoint/ : /captcha/i,
        );
        expect(h.log.some((line) => /^needs human: .* seen on redirect at \//.test(line))).toBe(
          true,
        );
      });
    }

    describe("with the storefront's service worker installed and active", () => {
      /**
       * Install the mock's pass-through service worker the way a human visit would: in a
       * NORMAL tab of the same profile (outside the automation session), and prove it is
       * active and controls navigations there. In the automation tab the guard's bypass
       * keeps it from serving anything, which is exactly what the tests below check.
       */
      let plain: PlainTab | undefined;
      beforeAll(async () => {
        plain = await PlainTab.open(h.userDataDir, `${STOREFRONT}/`);
        await plain.navigate(`${STOREFRONT}/`);
        await plain.resumeWorkers();
        const active = await plain.evaluate(
          "Promise.race([navigator.serviceWorker.ready.then((r) => !!r.active), new Promise((r) => setTimeout(() => r('timeout'), 10000))])",
        );
        expect(active).toBe(true);
        await plain.navigate(`${STOREFRONT}/s?k=controlled`);
        expect(await plain.evaluate("!!navigator.serviceWorker.controller")).toBe(true);
      });
      afterAll(async () => {
        await plain?.close();
      });

      it("an allowed navigation is seen by the guard and not served by the worker", async () => {
        await h.session.run(async (ctx) => {
          await ctx.goto(`${STOREFRONT}/s?k=example`, "search");
          expect(ctx.guard.mainDocumentsSeen()).toBeGreaterThanOrEqual(1);
          await ctx.goto(`${STOREFRONT}/s?k=example2`, "search");
          expect(ctx.guard.mainDocumentsSeen()).toBeGreaterThanOrEqual(1);
          expect(await ctx.page.evaluate("!!navigator.serviceWorker.controller")).toBe(false);
        });
      });

      it("a direct page.goto to the checkout trap (no flow pre-check) is aborted", async () => {
        let error: unknown;
        try {
          await h.session.run(async (ctx) => {
            await ctx.page.goto(`${STOREFRONT}/gp/buy/spc/handlers/display.html`);
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeDefined();
        const st = await h.state();
        expect(st.trap_counts.checkout).toBe(0);
        expect(st.hits.some((x) => x.path.startsWith("/gp/buy"))).toBe(false);
      });

      it("the 302-into-checkout link is blocked with zero hits", async () => {
        await expectRefusal(() => goto("/s?k=deal&mock=redirect-checkout"), "blocked_by_policy");
        expect((await h.state()).trap_counts.checkout).toBe(0);
      });

      it("regression: without the service-worker bypass the same goto WOULD reach the trap", async () => {
        // Test-only: undo the guard's bypass on the live automation tab, which is exactly
        // the state before the fix. The worker then serves the navigation itself.
        let controlled: unknown = null;
        await h.session
          .run(async (ctx) => {
            await rawClient(ctx.page).send("Network.setBypassServiceWorker", { bypass: false });
            await ctx.page.goto(`${STOREFRONT}/s?k=unguarded`);
            controlled = await ctx.page.evaluate("!!navigator.serviceWorker.controller");
            await ctx.page.goto(`${STOREFRONT}/gp/buy/spc/handlers/display.html`).catch(() => {});
          })
          .catch(() => {});
        expect(controlled).toBe(true);
        // The trap recorded a hit: the tests above would catch a blind guard.
        expect((await h.state()).trap_counts.checkout).toBeGreaterThanOrEqual(1);
        // The session poisoned itself (framenavigated layer); start the next test clean.
        await h.session.detach();
      });
    });

    it("reads are reported as they happen, and a failed call leaves its page behind", async () => {
      const before = h.pages.length;
      await h.call("search", { query: "widget" });
      const read = h.pages.slice(before);
      expect(read.map((p) => p.kind)).toEqual(["search"]);
      expect(read[0]!.final_url).toContain("/s?");
      expect(read[0]!.html).toContain("<");
      const mark = h.pages.length;
      await expectRefusal(
        () =>
          h.session.run(async (ctx) => {
            await ctx.goto(`${STOREFRONT}/dp/B0FAKE0001`, "product");
            throw new RfError("layout_unrecognized", "the panel did not open");
          }),
        "layout_unrecognized",
      );
      const left = h.pages.slice(mark);
      expect(left.map((p) => p.kind)).toEqual(["failure"]);
      expect(left[0]!.note).toBe("layout_unrecognized: the panel did not open");
      expect(left[0]!.final_url).toContain("/dp/B0FAKE0001");
      expect(left[0]!.html.length).toBeGreaterThan(100);
      expect(h.log.some((line) => line === "goto product /dp/B0FAKE0001")).toBe(true);
    });

    it("the automation window is opened at the size of the screen, not a fixed size", async () => {
      const seen = (await h.session.run(async (ctx) =>
        ctx.page.evaluate(
          `({ outerW: window.outerWidth, outerH: window.outerHeight, availW: screen.availWidth, availH: screen.availHeight })`,
        ),
      )) as { outerW: number; outerH: number; availW: number; availH: number };
      // The session read the screen once and has had no reason to change its mind.
      expect(h.screens).toHaveLength(1);
      expect(h.screens[0]).toMatchObject({ width: seen.availW, height: seen.availH });
      // The window really has that size (a window manager may trim a few pixels), and it
      // is not the extension's fixed 1280 x 900 unless the screen happens to be that.
      expect(Math.abs(seen.outerW - seen.availW)).toBeLessThanOrEqual(24);
      expect(Math.abs(seen.outerH - seen.availH)).toBeLessThanOrEqual(64);
      expect(h.log.some((line) => /^window \d+x\d+ at -?\d+,-?\d+ /.test(line))).toBe(true);
    });

    it("pacing gaps are honored with the real pacer", async () => {
      pacer.fast = false;
      pacer.state.loads = {};
      pacer.state.lastLoadAt = 0;
      try {
        await goto("/s?k=first");
        await goto("/s?k=second");
      } finally {
        pacer.fast = true;
      }
      const hits = (await h.state()).hits.filter((x) => x.path === "/s");
      const first = hits.find((x) => x.search.includes("first"))!;
      const second = hits.find((x) => x.search.includes("second"))!;
      expect(second.at - first.at).toBeGreaterThanOrEqual(MIN_GAP_MS - 150);
    });
  });
}
