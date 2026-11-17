import { describe, expect, test } from "vitest";
import {
  BUY_BODY_MARKERS,
  FRAGMENT_ALLOWLIST,
  HARD_DENY_RULES,
  MAIN_FRAME_ALLOWLIST,
  PURCHASE_CONTROL_PATTERNS,
  TELEMETRY_HOSTS,
  checkFragment,
  checkNavigation,
  checkRequest,
  isAmazonHost,
  isPurchaseControl,
} from "../src/policy.ts";

const A = "https://www.amazon.com";

// Hardcoded on purpose: deleting a rule must fail a test, not shrink a count.
const EXPECTED_DENY_RULES = [
  "gp-buy",
  "checkout",
  "checkoutportal",
  "go-to-checkout",
  "proceed-to-checkout",
  "cart-checkout",
  "buy-now",
  "one-click",
  "turbo-checkout",
  "digital-buy",
  "dmusic-purchase",
  "video-purchase",
  "kindle-buy",
  "prime-signup",
  "subscribe-create",
  "auth-portal",
  "addresses",
  "address-book",
  "glow-address-change",
  "payments",
  "wallet",
  "your-payments",
  "account-settings",
  "account-home",
  "login-security",
  "order-edit",
  "order-cancel",
  "order-change",
  "returns-center",
];

const EXPECTED_ALLOW_RULES = [
  "home",
  "home-ref",
  "search",
  "product",
  "product-gp",
  "all-offers",
  "offer-listing",
  "reviews",
  "cart",
  "orders",
  "orders-legacy",
  "order-details",
  "invoice",
  "tracking",
  "lists",
  "lists-legacy",
  "subscriptions",
  "subscriptions-legacy",
  "browsing-history",
  "camel-product",
  "camel-chart",
  "keepa-graph",
];

// Every URL here must be refused for every resource type.
const MUST_DENY_ANYWHERE = [
  `${A}/gp/buy/spc/handlers/display.html`,
  `${A}/gp/buy/spc/handlers/static-submit-decoupled.html`,
  `${A}/gp/buy/thankyou/handlers/display.html`,
  `${A}/checkout/p/p-106-1234567-1234567/spc`,
  `${A}/checkout/entry/cart`,
  `${A}/gp/checkoutportal/enter-checkout.html`,
  `${A}/gp/cart/desktop/go-to-checkout.html/ref=ox_sc_proceed`,
  `${A}/cart/checkout`,
  `${A}/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance?submit.buy-now=1`,
  `${A}/gp/buy-now/handlers/display.html`,
  `${A}/gp/oneclick/purchase`,
  `${A}/gp/digital/fiona/buy.html`,
  `${A}/gp/dmusic/purchase/confirm`,
  `${A}/gp/video/offers/signup`,
  `${A}/gp/prime/pipeline/landing`,
  `${A}/ap/signin?openid.return_to=x`,
  `${A}/ap/cvf/request`,
  `${A}/a/addresses`,
  `${A}/a/addresses/add`,
  `${A}/gp/css/account/address/view.html`,
  `${A}/cpe/yourpayments/wallet`,
  `${A}/cpe/managepaymentmethods`,
  `${A}/gp/wallet`,
  `${A}/gp/css/account/info/view.html`,
  `${A}/gp/css/homepage.html`,
  `${A}/gp/css/order/edit.html?orderID=000-0000000-0000001`,
  `${A}/gp/your-account/order-history/cancel?orderID=000-0000000-0000001`,
  `${A}/progress-tracker/package-tracking/cancel`,
  `${A}/spr/returns/cart?orderId=000-0000000-0000001`,
  `${A}/gp/orc/returns/homepage.html`,
  `https://smile.amazon.com/gp/buy/spc/handlers/display.html`,
  `${A}/GP/BUY/spc/handlers/display.html`,
  `${A}/gp/%62uy/spc/handlers/display.html`,
];

const MUST_ALLOW_MAIN_FRAME = [
  `${A}/`,
  `${A}/s?k=usb+c+cable`,
  `${A}/s/ref=nb_sb_noss?k=test`,
  `${A}/dp/B0FAKE0001`,
  `${A}/dp/B0FAKE0001/ref=sr_1_1?th=1`,
  `${A}/Some-Product-Title/dp/B0FAKE0001/`,
  `${A}/gp/product/B0FAKE0001`,
  `${A}/gp/aod/ajax?asin=B0FAKE0001`,
  `${A}/product-reviews/B0FAKE0001/ref=cm_cr_arp_d_paging_btm_2?pageNumber=2`,
  `${A}/gp/cart/view.html`,
  `${A}/gp/cart/view.html/ref=nav_cart`,
  `${A}/cart`,
  `${A}/your-orders/orders?timeFilter=year-2024&startIndex=10`,
  `${A}/gp/your-account/order-details?orderID=000-0000000-0000001`,
  `${A}/gp/css/summary/print.html?orderID=000-0000000-0000001`,
  `${A}/hz/wishlist/ls/FAKELIST0001`,
  `${A}/hz/wishlist/intro`,
  `${A}/auto-deliveries`,
  `${A}/gp/history`,
  "https://camelcamelcamel.com/product/B0FAKE0001",
  "https://graph.keepa.com/pricehistory.png?asin=B0FAKE0001&domain=com",
];

const MUST_DENY_MAIN_FRAME = [
  "https://www.example.com/",
  "http://www.amazon.com/",
  `${A}/gp/product/handle-buy-box`,
  `${A}/gp/help/customer/display.html`,
  `${A}/gp/css/order-history/cancel`,
  `${A}/dp/B0FAKE0001/../../gp/buy/spc`,
  "https://www.amazon.co.uk/dp/B0FAKE0001",
  "https://www.amazon.com.evil.example/dp/B0FAKE0001",
  "https://evil.example/https://www.amazon.com/dp/B0FAKE0001",
  "javascript:alert(1)",
  "file:///etc/passwd",
  "chrome://settings",
  "https://camelcamelcamel.com/login",
  "",
  "not a url",
];

describe("hard deny layer", () => {
  test("rule list is exactly the expected list", () => {
    expect(HARD_DENY_RULES.map((r) => r.name).sort()).toEqual([...EXPECTED_DENY_RULES].sort());
    for (const name of EXPECTED_DENY_RULES)
      expect(HARD_DENY_RULES.some((r) => r.name === name)).toBe(true);
  });

  test("denies purchase, payment, address, account and sign-in URLs for every resource type", () => {
    for (const url of MUST_DENY_ANYWHERE) {
      for (const isMainFrameDocument of [true, false]) {
        for (const method of ["GET", "POST"]) {
          const verdict = checkRequest({ url, method, isMainFrameDocument, postData: "" });
          expect(verdict.allow, `${method} ${url} main=${isMainFrameDocument}`).toBe(false);
        }
      }
    }
  });

  test("cart posts are refused when the body is unreadable or carries a buy marker", () => {
    const url = `${A}/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance`;
    const base = { url, method: "POST", isMainFrameDocument: false };
    expect(
      checkRequest({ ...base, postData: "ASIN=B0FAKE0001&submit.add-to-cart=Add+to+Cart" }).allow,
    ).toBe(true);
    expect(
      checkRequest({ ...base, postData: "ASIN=B0FAKE0001&submit.buy-now=Buy+Now" }).allow,
    ).toBe(false);
    expect(checkRequest({ ...base, postData: "ASIN=B0FAKE0001&submit%2Ebuy%2Dnow=1" }).allow).toBe(
      false,
    );
    expect(checkRequest({ ...base }).allow).toBe(false);
    expect(checkRequest({ ...base, postData: "a=1", hasUnreadPostData: true }).allow).toBe(false);
    expect(
      checkRequest({
        url: `${A}/cart/add-to-cart?proceedToCheckout=1`,
        method: "POST",
        isMainFrameDocument: false,
        postData: "a=1",
      }).allow,
    ).toBe(false);
  });

  test("buy body markers are exactly the expected list", () => {
    const expected = [
      "submit\\.buy-?now",
      "buy-?now",
      "one-?click",
      "proceedToRetailCheckout",
      "proceedToCheckout",
      "turbo",
      "placeYourOrder",
      "place-?order",
    ];
    expect(BUY_BODY_MARKERS.map((m) => m.source).sort()).toEqual([...expected].sort());
  });
});

describe("main-frame allowlist", () => {
  test("rule list is exactly the expected list", () => {
    expect(MAIN_FRAME_ALLOWLIST.map((r) => r.name).sort()).toEqual(
      [...EXPECTED_ALLOW_RULES].sort(),
    );
    for (const name of EXPECTED_ALLOW_RULES)
      expect(MAIN_FRAME_ALLOWLIST.some((r) => r.name === name)).toBe(true);
  });

  test("allows the pages the flows need", () => {
    for (const url of MUST_ALLOW_MAIN_FRAME) expect(checkNavigation(url).allow, url).toBe(true);
  });

  test("refuses everything else, including lookalike hosts and non-https", () => {
    for (const url of MUST_DENY_MAIN_FRAME) expect(checkNavigation(url).allow, url).toBe(false);
  });

  test("main-frame documents must be GET", () => {
    expect(
      checkRequest({
        url: `${A}/gp/cart/view.html`,
        method: "POST",
        isMainFrameDocument: true,
        postData: "",
      }).allow,
    ).toBe(false);
  });

  test("sub-resources on other hosts are allowed, the hard deny still applies to Amazon hosts", () => {
    expect(
      checkRequest({
        url: "https://m.media-amazon.com/images/I/x.jpg",
        method: "GET",
        isMainFrameDocument: false,
      }).allow,
    ).toBe(true);
    expect(
      checkRequest({
        url: `${A}/hz/reviews-render/ajax/reviews/get/`,
        method: "POST",
        isMainFrameDocument: false,
        postData: "a",
      }).allow,
    ).toBe(true);
    expect(
      checkRequest({
        url: `${A}/gp/buy/spc/handlers/display.html`,
        method: "GET",
        isMainFrameDocument: false,
      }).allow,
    ).toBe(false);
  });
});

describe("fragments", () => {
  test("allowlist is exactly the expected list", () => {
    expect(FRAGMENT_ALLOWLIST.map((r) => r.name)).toEqual(["all-offers"]);
  });

  test("only allowlisted same-site fragments pass", () => {
    expect(
      checkFragment(`${A}/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin=B0FAKE0001&pc=dp`)
        .allow,
    ).toBe(true);
    for (const url of [
      `${A}/gp/product/ajax/other`,
      `${A}/gp/buy/spc/handlers/display.html`,
      `${A}/dp/B0FAKE0001`,
      "https://www.example.com/gp/product/ajax/aodAjaxMain",
      "not a url",
    ]) {
      expect(checkFragment(url).allow, url).toBe(false);
    }
  });
});

describe("telemetry hosts", () => {
  test("exemption list is exactly the expected list", () => {
    const expected = [
      "fls-na.amazon.com",
      "unagi.amazon.com",
      "unagi-na.amazon.com",
      "completion.amazon.com",
    ];
    expect([...TELEMETRY_HOSTS].sort()).toEqual([...expected].sort());
    expect(isAmazonHost("fls-na.amazon.com")).toBe(false);
    expect(isAmazonHost("www.amazon.com")).toBe(true);
    expect(isAmazonHost("anything.amazon.com")).toBe(true);
    expect(isAmazonHost("amazon.com.example")).toBe(false);
  });

  test("telemetry hosts can never be a main-frame document", () => {
    expect(checkNavigation("https://fls-na.amazon.com/gp/buy/spc").allow).toBe(false);
  });
});

describe("fail closed", () => {
  test("missing or malformed input is a denial", () => {
    expect(checkRequest(undefined).allow).toBe(false);
    expect(checkRequest(null).allow).toBe(false);
    expect(
      checkRequest({
        url: undefined as unknown as string,
        method: "GET",
        isMainFrameDocument: false,
      }).allow,
    ).toBe(false);
    expect(
      checkRequest({
        url: `${A}/`,
        method: undefined as unknown as string,
        isMainFrameDocument: true,
      }).allow,
    ).toBe(false);
    expect(
      checkRequest({ url: `${A}/%E0%A4%A`, method: "GET", isMainFrameDocument: false }).allow,
    ).toBe(false);
  });
});

describe("purchase controls", () => {
  test("pattern list is exactly the expected size and catches the known controls", () => {
    expect(PURCHASE_CONTROL_PATTERNS.length).toBe(17);
    const mustRefuse = [
      "Buy Now",
      "Place your order",
      "Proceed to checkout",
      "Proceed to Retail Checkout",
      "Buy now with 1-Click",
      "Pay now",
      "Use this payment method",
      "Use this address",
      "Set up now",
      "Subscribe now",
      "Start your free trial",
      "Try Prime",
      "Cancel items",
      "Return or replace items",
      "Pre-order now",
      "Confirm purchase",
    ];
    for (const text of mustRefuse) expect(isPurchaseControl({ text }), text).toBe(true);
  });

  test("ids, names and targets are checked too", () => {
    expect(isPurchaseControl({ text: "Go", id: "buy-now-button" })).toBe(true);
    expect(isPurchaseControl({ text: "Go", name: "proceedToRetailCheckout" })).toBe(true);
    expect(isPurchaseControl({ text: "Go", href: "/gp/buy/spc/handlers/display.html" })).toBe(true);
    expect(
      isPurchaseControl({ text: "Go", formAction: "https://www.amazon.com/checkout/entry/cart" }),
    ).toBe(true);
  });

  test("ordinary cart and list controls pass, missing input fails closed", () => {
    for (const text of [
      "Add to Cart",
      "Delete",
      "Save for later",
      "Move to cart",
      "Add to List",
      "Clip coupon",
    ]) {
      expect(isPurchaseControl({ text }), text).toBe(false);
    }
    expect(isPurchaseControl(undefined)).toBe(true);
    expect(isPurchaseControl({ text: undefined as unknown as string })).toBe(true);
  });
});
