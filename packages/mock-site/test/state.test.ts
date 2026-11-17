import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockSite, initialSession, MOCK_FLAGS, Store } from "../src/index.ts";
import {
  addToCart,
  addToList,
  cartAction,
  clipCoupon,
  createList,
  linePrice,
  moveListItem,
  removeFromList,
  setQuantity,
  updateList,
  updateListItem,
} from "../src/state.ts";
import { parseCli } from "../src/cli.ts";
import { startSite, type Client } from "./helpers.ts";

describe("state transitions (pure)", () => {
  const fresh = () => initialSession("s", 7);

  it("cart line actions move lines between the sections", () => {
    const s = fresh();
    const [a, b] = s.active;
    const saved = s.saved[0]!;
    expect(cartAction(s, "save-for-later", a!.itemId).ok).toBe(true);
    expect(s.saved.map((l) => l.itemId)).toEqual([a!.itemId, saved.itemId]);
    expect(cartAction(s, "move-to-cart", saved.itemId).ok).toBe(true);
    expect(s.active.map((l) => l.asin)).toEqual([b!.asin, saved.asin]);
    expect(cartAction(s, "delete", b!.itemId).ok).toBe(true);
    expect(cartAction(s, "delete-saved", a!.itemId).ok).toBe(true);
    expect(s.saved).toEqual([]);
    // Controls are bound to their section.
    expect(cartAction(s, "delete", "nope").ok).toBe(false);
    expect(cartAction(s, "delete-saved", s.active[0]!.itemId).ok).toBe(false);
  });

  it("adds merge per offer, respect limits, and only subscribe when asked", () => {
    const s = fresh();
    expect(addToCart(s, "FAKEOLID0001A", 1).ok).toBe(true);
    expect(s.active.find((l) => l.olid === "FAKEOLID0001A")?.quantity).toBe(2);
    expect(addToCart(s, "FAKEOLID0009A", 5).ok).toBe(true);
    const limited = s.active.find((l) => l.asin === "B0FAKE0009")!;
    expect(limited.quantity).toBe(2);
    expect(limited.notice).toMatch(/limit of 2/);
    expect(addToCart(s, "FAKEOLID0007A", 1, { subscribe: true }).ok).toBe(true);
    const sns = s.active.find((l) => l.asin === "B0FAKE0007")!;
    expect(sns.subscribe).toBe(true);
    expect(linePrice(s, sns)).toBe(1710);
    expect(addToCart(s, "FAKEOLID0001A", 1, { subscribe: true }).ok).toBe(true);
    expect(s.active.filter((l) => l.olid === "FAKEOLID0001A").every((l) => !l.subscribe)).toBe(
      true,
    );
    expect(addToCart(s, "NOPE", 1).ok).toBe(false);
    expect(addToCart(s, "FAKEOLID000AA", 1).upsell).toBe("B0FAKE00P1");
  });

  it("quantity changes, including zero and the limit", () => {
    const s = fresh();
    const line = s.active[0]!;
    expect(setQuantity(s, line.itemId, 3).ok).toBe(true);
    expect(line.quantity).toBe(3);
    expect(setQuantity(s, line.itemId, -1).ok).toBe(false);
    expect(setQuantity(s, s.saved[0]!.itemId, 2).ok).toBe(false);
    expect(setQuantity(s, line.itemId, 0).ok).toBe(true);
    expect(s.active.some((l) => l.itemId === line.itemId)).toBe(false);
    addToCart(s, "FAKEOLID0009A", 1);
    const limited = s.active.find((l) => l.asin === "B0FAKE0009")!;
    setQuantity(s, limited.itemId, 9);
    expect(limited.quantity).toBe(2);
  });

  it("coupons lower the line price once clipped", () => {
    const s = fresh();
    const line = s.saved[0]!;
    expect(linePrice(s, line)).toBe(1999);
    expect(clipCoupon(s, "B0FAKE0008").ok).toBe(true);
    expect(clipCoupon(s, "B0FAKE0008").ok).toBe(true);
    expect(s.clippedCoupons).toEqual(["B0FAKE0008"]);
    expect(linePrice(s, line)).toBe(1799);
    expect(clipCoupon(s, "B0FAKE0001").ok).toBe(false);
  });

  it("list writes", () => {
    const s = fresh();
    const [shopping, gifts] = s.lists;
    expect(createList(s, "  Camping  ", "public").ok).toBe(true);
    const camping = s.lists[2]!;
    expect([camping.name, camping.privacy, camping.id]).toEqual([
      "Camping",
      "public",
      expect.stringMatching(/^[A-Z0-9]{13}$/),
    ]);
    expect(createList(s, "   ", "public").ok).toBe(false);
    expect(updateList(s, camping.id, { name: "Hiking", privacy: "shared" }).ok).toBe(true);
    expect([camping.name, camping.privacy]).toEqual(["Hiking", "shared"]);
    expect(updateList(s, camping.id, { privacy: "everyone" }).ok).toBe(false);
    expect(updateList(s, camping.id, { name: "" }).ok).toBe(false);
    expect(addToList(s, camping.id, "B0FAKE0001").ok).toBe(true);
    expect(addToList(s, camping.id, "B0FAKE0001").ok).toBe(true);
    expect(camping.items).toHaveLength(1);
    expect(camping.items[0]!.requested).toBe(2);
    expect(addToList(s, camping.id, "B0FAKEZZZZ").ok).toBe(false);
    const item = camping.items[0]!;
    expect(
      updateListItem(s, camping.id, item.itemId, {
        comment: "for the trip",
        requested: "4",
        priority: "highest",
      }).ok,
    ).toBe(true);
    expect([item.comment, item.requested, item.priority]).toEqual(["for the trip", 4, "highest"]);
    expect(updateListItem(s, camping.id, item.itemId, { priority: "urgent" }).ok).toBe(false);
    expect(updateListItem(s, camping.id, item.itemId, { requested: "0" }).ok).toBe(false);
    expect(moveListItem(s, camping.id, item.itemId, gifts!.id).ok).toBe(true);
    expect(camping.items).toEqual([]);
    expect(gifts!.items[0]!.asin).toBe("B0FAKE0001");
    expect(moveListItem(s, gifts!.id, gifts!.items[0]!.itemId, shopping!.id, true).ok).toBe(true);
    expect(gifts!.items[0]!.asin).toBe("B0FAKE0001");
    expect(shopping!.items[0]!.asin).toBe("B0FAKE0001");
    expect(moveListItem(s, gifts!.id, gifts!.items[0]!.itemId, gifts!.id).ok).toBe(false);
    expect(removeFromList(s, shopping!.id, shopping!.items[0]!.itemId).ok).toBe(true);
    expect(removeFromList(s, shopping!.id, "nope").ok).toBe(false);
    expect(updateList(s, shopping!.id, { delete: true }).ok).toBe(true);
    expect(s.lists[0]!.isDefault).toBe(true);
    expect(updateList(s, "NOPE", { delete: true }).ok).toBe(false);
  });

  it("is deterministic for a seed and differs across seeds", () => {
    const a = initialSession("a", 7);
    const b = initialSession("b", 7);
    const c = initialSession("c", 8);
    expect(a.active.map((l) => l.itemId)).toEqual(b.active.map((l) => l.itemId));
    expect(a.lists.map((l) => l.id)).toEqual(b.lists.map((l) => l.id));
    expect(a.active.map((l) => l.itemId)).not.toEqual(c.active.map((l) => l.itemId));
  });
});

describe("server", () => {
  let c: Client;
  beforeEach(async () => {
    c = await startSite();
  });
  afterEach(async () => {
    await c.site.close();
  });

  it("keeps state per session cookie and re-renders from it", async () => {
    await c.get("/gp/cart/view.html");
    const st = await c.state();
    const id = st.session!.cart.active[0]!.item_id;
    const r = await c.post("/cart/ref=ox_sc_cart_actions_1", { [`submit.delete.${id}`]: "Delete" });
    expect(await r.json()).toEqual({ ok: true, message: "was removed from Shopping Cart." });
    expect((await c.html("/gp/cart/view.html")).includes(id)).toBe(false);
    // A second, cookie-less visitor gets a fresh session from the seed.
    const other = await fetch(`${c.site.origin}/gp/cart/view.html`);
    expect((await other.text()).includes(id)).toBe(true);
    expect((await c.state()).session).not.toBeNull();
  });

  it("cart endpoints: add, quantity, save, move, delete saved, coupon", async () => {
    await c.get("/");
    let r = await c.post("/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance", {
      ASIN: "B0FAKE0007",
      offerListingID: "FAKEOLID0007A",
      snsOfferListingId: "FAKEOLID0007A",
      quantity: "1",
      "submit.add-to-cart": "Add to cart",
    });
    expect(r.status).toBe(200);
    let st = await c.state();
    // Submitting the default (subscription) row subscribes: the footgun a flow must avoid.
    expect(st.session!.cart.active.find((l) => l.asin === "B0FAKE0007")?.subscribe).toBe(true);
    r = await c.post("/cart/add-to-cart/ref=aod_dpdsk_new_1", {
      "items[0.base][asin]": "B0FAKE000A",
      "items[0.base][offerListingId]": "FAKEOLID000AA",
      "items[0.base][quantity]": "1",
      "submit.addToCart": "",
    });
    const body = (await r.json()) as { ok: boolean; upsell_html?: string };
    expect(body.ok).toBe(true);
    expect(body.upsell_html).toContain("attachSiNoCoverage");
    r = await c.post("/gp/product/handle-buy-box/ref=x", { ASIN: "B0FAKE0001" });
    expect(r.status).toBe(400);
    st = await c.state();
    const line = st.session!.cart.active[0]!;
    r = await c.post("/cart/ref=ox_sc_update_quantity", {
      action: "update-quantity",
      itemID: line.item_id,
      quantity: "4",
    });
    expect(r.status).toBe(200);
    expect((await c.state()).session!.cart.active[0]!.quantity).toBe(4);
    await c.post("/cart/ref=ox_sc_cart_actions_1", {
      [`submit.save-for-later.${line.item_id}`]: "Save",
    });
    await c.post("/cart/ref=ox_sc_cart_actions_1", {
      [`submit.move-to-cart.${line.item_id}`]: "Move",
    });
    const saved = (await c.state()).session!.cart.saved[0]!;
    await c.post("/cart/ref=ox_sc_cart_actions_1", {
      [`submit.delete-saved.${saved.item_id}`]: "Delete",
    });
    st = await c.state();
    expect(st.session!.cart.saved).toEqual([]);
    expect(st.session!.cart.active.some((l) => l.item_id === line.item_id)).toBe(true);
    expect((await c.post("/cart/ref=x", { nothing: "1" })).status).toBe(400);
    await c.post("/gp/coupon/clip", { asin: "B0FAKE0008" });
    expect((await c.state()).session!.clipped_coupons).toEqual(["B0FAKE0008"]);
    expect(await c.html("/dp/B0FAKE0008")).toContain("coupon applied");
    // Without the JSON accept header a write answers with a redirect back to the page.
    r = await c.post(
      "/cart/ref=ox_sc_cart_actions_1",
      { [`submit.delete.${line.item_id}`]: "Delete" },
      false,
    );
    expect([r.status, r.headers.get("location")]).toEqual([303, "/gp/cart/view.html"]);
  });

  it("list endpoints and popovers", async () => {
    await c.get("/hz/wishlist/ls");
    let st = await c.state();
    const [shopping, gifts] = st.session!.lists;
    expect(await c.html("/hz/wishlist/create?isPopover=1")).toContain('name="listName"');
    await c.post("/hz/wishlist/create", { listName: "Camping", privacy: "public" });
    st = await c.state();
    const camping = st.session!.lists[2]!;
    expect(camping.name).toBe("Camping");
    expect(await c.html(`/hz/wishlist/settings/${camping.id}?type=WishList&ajax=true`)).toContain(
      "Camping",
    );
    await c.post(`/hz/wishlist/settings/${camping.id}`, { listName: "Hiking", privacy: "private" });
    await c.post("/hz/wishlist/additem", { listId: camping.id, asin: "B0FAKE0003" });
    st = await c.state();
    const hiking = st.session!.lists[2]!;
    expect([hiking.name, hiking.privacy, hiking.items.map((i) => i.asin)]).toEqual([
      "Hiking",
      "private",
      ["B0FAKE0003"],
    ]);
    const item = hiking.items[0]!;
    expect(
      await c.html(`/hz/wishlist/cqp/ref=hz_lv_cqp_ajax?listId=${hiking.id}&itemId=${item.itemId}`),
    ).toContain("cqp-form");
    await c.post("/hz/wishlist/cqp", {
      listId: hiking.id,
      itemId: item.itemId,
      comment: "boots",
      requestedQty: "2",
      priority: "low",
    });
    expect(
      await c.html(`/hz/wishlist/movetolist/?listId=${hiking.id}&itemId=${item.itemId}`),
    ).toContain(`move-to-${gifts!.id}`);
    await c.post("/hz/wishlist/movetolist", {
      listId: hiking.id,
      itemId: item.itemId,
      toListId: gifts!.id,
    });
    st = await c.state();
    const moved = st.session!.lists[1]!.items[0]!;
    expect([moved.asin, moved.comment, moved.requested, moved.priority]).toEqual([
      "B0FAKE0003",
      "boots",
      2,
      "low",
    ]);
    await c.post("/hz/wishlist/removeitem/form", {
      listId: gifts!.id,
      itemId: moved.itemId,
      "submit.deleteItem": "",
    });
    await c.post(`/hz/wishlist/settings/${hiking.id}`, { "submit.deleteList": "" });
    st = await c.state();
    expect(st.session!.lists.map((l) => l.id)).toEqual([shopping!.id, gifts!.id]);
    expect(await c.html("/hz/wishlist/settings/ZZZZZZZZZZZZ")).toContain("does not exist");
    expect((await c.get("/hz/wishlist/intro")).headers.get("location")).toBe("/hz/wishlist/ls");
  });

  it("records every trap hit and answers purchase controls with a trap", async () => {
    for (const p of [
      "/gp/buy/spc/handlers/display.html",
      "/checkout/x",
      "/ap/signin",
      "/checkpoint/continue",
      "/errors/validateCaptcha",
    ])
      expect((await c.get(p)).status).toBe(200);
    let r = await c.post("/gp/product/handle-buy-box/ref=x", { "submit.buy-now": "1" });
    expect(r.headers.get("location")).toBe("/gp/buy/spc/handlers/display.html");
    r = await c.post("/gp/cart/view.html/ref=ox_sc_proceed", {
      proceedToRetailCheckout: "Proceed to checkout",
    });
    expect(r.status).toBe(303);
    const st = await c.state();
    expect(st.trap_counts).toEqual({
      checkout: 2,
      proceed_to_checkout: 1,
      buy_now: 1,
      sign_in: 1,
      checkpoint: 1,
      captcha: 1,
    });
    await c.reset();
    expect((await c.state()).traps).toEqual([]);
  });

  it("mock flags force friction responses on any page", async () => {
    const at = (flag: string) => c.get(`/dp/B0FAKE0001?mock=${flag}`);
    expect(MOCK_FLAGS.length).toBe(8);
    expect((await at("captcha")).status).toBe(200);
    expect((await at("captcha-redirect")).headers.get("location")).toMatch(
      /^\/errors\/validateCaptcha/,
    );
    expect((await at("checkpoint")).headers.get("location")).toMatch(/^\/checkpoint\/continue/);
    expect(await (await at("checkpoint-inline")).text()).toContain("continue shopping");
    expect((await at("signin")).headers.get("location")).toMatch(/^\/ap\/signin/);
    expect((await at("redirect-checkout")).headers.get("location")).toMatch(/^\/gp\/buy\//);
    expect((await at("throttle")).status).toBe(503);
    expect((await at("notfound")).status).toBe(404);
    expect((await at("other")).status).toBe(200);
  });

  it("serves the service worker, the offers panel, and 404s", async () => {
    const sw = await c.get("/mock-sw.js");
    expect(sw.headers.get("service-worker-allowed")).toBe("/");
    expect(sw.headers.get("content-type")).toMatch(/javascript/);
    expect(await sw.text()).toContain('addEventListener("fetch"');
    expect(await c.html("/")).toContain('navigator.serviceWorker.register("/mock-sw.js"');
    expect(await c.html("/dp/B0FAKE0001?aod=1")).toContain('id="aod-container"');
    expect((await c.get("/gp/product/ajax/aodAjaxMain/?asin=B0FAKEZZZZ")).status).toBe(404);
    expect((await c.get("/gp/aod/ajax/x")).status).toBe(404);
    expect((await c.get("/dp/B0FAKEZZZZ")).status).toBe(404);
    expect((await c.get("/dp/B0FAKE00P1")).status).toBe(404);
    expect((await c.get("/nope")).status).toBe(404);
    expect((await c.post("/nope", {})).status).toBe(404);
    expect((await fetch(`${c.site.origin}/`, { method: "PUT" })).status).toBe(405);
    for (const p of [
      "/your-orders/orders?timeFilter=year-2026",
      "/gp/css/summary/print.html?orderID=000-0000000-0000002",
    ])
      expect((await c.get(p)).status).toBe(200);
  });
});

describe("determinism and CLI", () => {
  it("two sites with the same seed serve identical pages", async () => {
    const now = () => new Date("2026-11-16T15:00:00Z");
    const a = await createMockSite({ seed: 5, now });
    const b = await createMockSite({ seed: 5, now });
    try {
      for (const p of ["/gp/cart/view.html", "/hz/wishlist/ls", "/s?k=example", "/dp/B0FAKE0007"]) {
        const [x, y] = await Promise.all([
          fetch(a.origin + p).then((r) => r.text()),
          fetch(b.origin + p).then((r) => r.text()),
        ]);
        expect(x, p).toBe(y);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("the store resets sessions, hits and traps", () => {
    const store = new Store(3);
    store.record("GET", "/", "", "x", 1);
    store.trap("checkout", "GET", "/gp/buy", 1);
    store.session(store.newSessionId());
    store.reset();
    expect([store.hits, store.traps, store.sessions.size, store.lastSessionId]).toEqual([
      [],
      [],
      0,
      null,
    ]);
    expect(store.newSessionId()).toBe("mock-0001");
  });

  it("parses CLI arguments", () => {
    expect(parseCli([])).toEqual({ port: 8080, seed: 1 });
    expect(parseCli(["--port", "0", "--seed", "9"])).toEqual({ port: 0, seed: 9 });
    expect(() => parseCli(["--port", "70000"])).toThrow();
    expect(() => parseCli(["--seed", "x"])).toThrow();
  });
});
