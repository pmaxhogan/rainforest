import { describe, expect, test } from "vitest";
import {
  checkNavigation,
  checkRequest,
  isPurchaseControl,
  lenientDecode,
  normalizePath,
} from "../src/policy.ts";

const sub = (url: string, method = "GET", postData?: string) =>
  checkRequest({ url, method, isMainFrameDocument: false, postData });

describe("path and host variants cannot slip past the deny rules", () => {
  const denied: [string, string][] = [
    ["POST", "https://www.amazon.com/-/es/gp/buy/spc/handlers/static-submit-decoupled.html"],
    ["POST", "https://www.amazon.com//gp/buy/spc/handlers/x"],
    ["POST", "https://www.amazon.com/gp;x/buy/spc/handlers/x"],
    ["POST", "https://www.amazon.com/./gp/buy/x"],
    ["POST", "https://www.amazon.com/gp/%62uy/x"],
    ["POST", "https://www.amazon.com/gp/%2562uy/x"],
    ["GET", "https://www.amazon.com/-/es/a/addresses"],
    ["GET", "https://www.amazon.com/-/es/ap/signin"],
    ["GET", "https://www.amazon.com/-/es/cpe/yourpayments/wallet"],
    ["GET", "https://www.amazon.com/-/es/gp/css/account/info/view.html"],
    ["GET", "https://www.amazon.com/-/zh_TW/-/es/checkout/p/x"],
    ["POST", "https://www.amazon.com./gp/buy/spc/handlers/x"],
    ["GET", "https://WWW.AMAZON.COM./ap/signin"],
  ];
  for (const [method, url] of denied) {
    test(`${method} ${url}`, () => {
      expect(sub(url, method, method === "POST" ? "a=1" : undefined).allow).toBe(false);
    });
  }

  test("a trailing-dot host is not accepted as a main-frame page either", () => {
    expect(checkNavigation("https://www.amazon.com./dp/B0FAKE0001").allow).toBe(false);
    expect(checkNavigation("https://www.amazon.com/-/es/dp/B0FAKE0001").allow).toBe(false);
  });

  test("ordinary sub-resource requests are still allowed", () => {
    expect(sub("https://www.amazon.com/gp/product/ajax/x").allow).toBe(true);
    expect(sub("https://www.amazon.com/-/es/dp/B0FAKE0001").allow).toBe(true);
  });
});

describe("a malformed escape does not hide a buy marker", () => {
  const path = "https://www.amazon.com/cart/add-to-cart/ref=x";
  test("in the body", () => {
    expect(sub(path, "POST", "submit.buy%2Dnow=1").allow).toBe(false);
    expect(sub(path, "POST", "submit.buy%2Dnow=1&z=%zz").allow).toBe(false);
    expect(sub(path, "POST", "submit.buy%252Dnow=1&z=%").allow).toBe(false);
    expect(sub(path, "POST", "submit.addToCart=1&z=%zz").allow).toBe(true);
  });
  test("in the query", () => {
    expect(sub(`${path}?submit.buy%2Dnow=1&z=%zz`).allow).toBe(false);
  });
});

test("lenientDecode and normalizePath", () => {
  expect(lenientDecode("a%2Db%zz%")).toBe("a-b%zz%");
  expect(lenientDecode("%E2%82")).toBe("â\u0082");
  expect(normalizePath("/-/es//gp;v=1/./buy/")).toBe("/gp/buy");
  expect(normalizePath("/-/es")).toBe("/");
  expect(normalizePath("/dp/B0FAKE0001")).toBe("/dp/B0FAKE0001");
});

test("more purchase and sign-up wording is refused", () => {
  for (const text of [
    "Start your 30-day free trial",
    "Start my free trial",
    "Get FREE delivery with Prime",
    "Sign up for Prime",
    "Deliver to this address",
  ]) {
    expect(isPurchaseControl({ text }), text).toBe(true);
  }
  for (const text of ["Add to Cart", "Save for later", "Delete", "Move to cart", "Add to List"]) {
    expect(isPurchaseControl({ text }), text).toBe(false);
  }
});
