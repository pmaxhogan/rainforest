import { describe, expect, test } from "vitest";
import { assertClickAllowed } from "../src/flows/click-guard.ts";
import { handoffUrl } from "../src/flows/handoff.ts";
import { mintOfferToken, readOfferToken, OFFER_TOKEN_TTL_MS } from "../src/flows/offer-token.ts";

const CART = "https://www.amazon.com/gp/cart/view.html";
const id = "abcd1234-0000-4000-8000-000000000001";
const del = {
  text: "",
  value: "Delete",
  name: `submit.delete.${id}`,
  id: null,
  tag: "INPUT",
  type: "submit",
};
const expectDelete = { what: "delete", name: new RegExp(`^submit\\.delete\\.${id}$`) };

describe("click guard", () => {
  test("allows the expected control on an allowed page", () => {
    expect(() => assertClickAllowed(CART, del, expectDelete)).not.toThrow();
  });

  test("refuses on a page that is not allowlisted", () => {
    for (const url of [
      "https://www.amazon.com/gp/buy/spc/handlers/display.html",
      "https://www.example.com/",
      "about:srcdoc",
      "",
    ]) {
      expect(() => assertClickAllowed(url, del, expectDelete), url).toThrow(
        /not on an allowed page/,
      );
    }
  });

  test("refuses a control that is not the expected one", () => {
    expect(() =>
      assertClickAllowed(CART, { ...del, name: "submit.delete.other" }, expectDelete),
    ).toThrow(/expected control/);
    expect(() => assertClickAllowed(CART, { ...del, name: null }, expectDelete)).toThrow(
      /expected control/,
    );
    expect(() => assertClickAllowed(CART, del, { what: "x", id: /^add-to-cart-button$/ })).toThrow(
      /expected control/,
    );
    expect(() => assertClickAllowed(CART, del, { what: "x" })).toThrow(/did not say/);
  });

  // Hardcoded on purpose: each of these must be refused even when the selector matched.
  test("refuses purchase controls whatever the expectation says", () => {
    const purchase = [
      { text: "Proceed to checkout", name: "proceedToRetailCheckout" },
      { text: "", value: "Buy Now", name: "submit.buy-now", id: "buy-now-button" },
      { text: "Place your order", name: "placeYourOrder1" },
      { text: "Set up now", name: "submit.rcx-subscribe" },
      { text: "Go", name: `submit.delete.${id}`, formAction: "/gp/buy/spc/handlers/display.html" },
      { text: "Delete", name: `submit.delete.${id}`, href: "/checkout/entry/cart" },
    ];
    for (const control of purchase) {
      expect(
        () => assertClickAllowed(CART, { id: null, ...control }, { what: "x", name: /.*/ }),
        control.text,
      ).toThrow(/purchase/);
    }
  });

  test("refuses credential fields and uninspectable controls", () => {
    expect(() => assertClickAllowed(CART, { ...del, type: "password" }, expectDelete)).toThrow(
      /credential/,
    );
    expect(() => assertClickAllowed(CART, null, expectDelete)).toThrow(/could not be inspected/);
    expect(() => assertClickAllowed(CART, undefined, expectDelete)).toThrow(
      /could not be inspected/,
    );
  });
});

describe("hand-off URLs", () => {
  test("are built only from typed targets", () => {
    expect(handoffUrl({ type: "product", asin: "B0FAKE0001" })).toBe(
      "https://www.amazon.com/dp/B0FAKE0001",
    );
    expect(handoffUrl({ type: "cart" })).toBe("https://www.amazon.com/gp/cart/view.html");
    expect(handoffUrl({ type: "order", order_id: "000-0000000-0000001" })).toContain(
      "orderID=000-0000000-0000001",
    );
    for (const bad of [
      null,
      {},
      { type: "url", url: "https://www.example.com" },
      { type: "product", asin: "../../x" },
      { type: "list", list_id: "a b" },
    ]) {
      expect(() => handoffUrl(bad)).toThrow();
    }
  });
});

describe("offer tokens", () => {
  const snapshot = {
    asin: "B0FAKE0001",
    offer_listing_id: "opaque-listing-id",
    seller_id: null,
    seller_name: "Example Seller",
    condition: "new",
    sub_condition: null,
    price_cents: 1299,
    flags: [],
    out_of_stock: false,
    source: "aod" as const,
    index: 0,
  };

  test("round trip, and the listing id is not readable in the token", () => {
    const token = mintOfferToken(snapshot, 1000);
    expect(token).not.toContain("opaque-listing-id");
    expect(Buffer.from(token.slice(3), "base64url").toString("latin1")).not.toContain(
      "opaque-listing-id",
    );
    expect(readOfferToken(token, 2000)).toMatchObject({
      asin: "B0FAKE0001",
      offer_listing_id: "opaque-listing-id",
      price_cents: 1299,
    });
  });

  test("expired, altered, truncated and foreign tokens are refused the same way", () => {
    const token = mintOfferToken(snapshot, 1000);
    const flipped = token.slice(0, -2) + (token.endsWith("A") ? "B" : "A") + token.slice(-1);
    for (const bad of [
      flipped,
      token.slice(0, 20),
      "o1.",
      "o2." + token.slice(3),
      "",
      null,
      42,
      "o1.AAAA",
    ]) {
      expect(() => readOfferToken(bad, 2000)).toThrow(/offer_id is not valid/);
    }
    expect(() => readOfferToken(token, 1000 + OFFER_TOKEN_TTL_MS + 1)).toThrow(
      /offer_id is not valid/,
    );
  });
});
