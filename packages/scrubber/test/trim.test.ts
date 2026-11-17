import type { Capture, PageKind } from "@rainforest/core";
import { describe, expect, test } from "vitest";
import { TRIM_RULES, scrubCapture } from "../src/index.ts";

// Invented markup only: ASINs B0ZZZZ00NN, ids made up for the test.
const asin = (n: number) => `B0ZZZZ${String(n).padStart(4, "0")}`;

function scrub(kind: PageKind, body: string, seed?: string): string {
  const capture: Capture = {
    kind,
    url: "https://shop.invalid/x",
    final_url: "https://shop.invalid/x",
    captured_at: "2025-01-08T15:30:00.000Z",
    html: `<!DOCTYPE html><html><body>${body}</body></html>`,
  };
  return scrubCapture(capture, seed === undefined ? {} : { seed }).capture.html;
}

function count(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

describe("item-count trim", () => {
  test("the rule list is pinned", () => {
    expect(
      TRIM_RULES.map((r) => [
        r.name,
        r.kinds.join(","),
        r.item,
        r.stopAt ?? "",
        r.standardSize ?? 0,
      ]),
    ).toEqual([
      ["cart items", "cart", ".sc-list-item[data-itemid]", "", 0],
      ["subscriptions", "subscriptions", "[data-edit-url]", "", 0],
      ["history cards", "browsing_history", "[id^='p13n-asin-index-']", "", 0],
      ["list items", "list,lists_index", "li[data-itemid]", "", 0],
      ["orders per page", "order_list", ".order-card", "", 10],
      ["shipments per order", "order_list", ".delivery-box", ".order-header", 0],
      ["items per order", "order_list", ".item-box", ".delivery-box", 0],
      ["shipments per order", "order_details,invoice", "[data-component='shipmentStatus']", "", 0],
      [
        "items per shipment",
        "order_details,invoice",
        "[data-component='purchasedItemsRightGrid']",
        "[data-component='shipmentStatus']",
        0,
      ],
      ["carousel cards", "*", "li.a-carousel-card", "", 0],
    ]);
  });

  test("a saved list keeps 2..6 of 7 items, and its count text and attribute follow", () => {
    const items = [1, 2, 3, 4, 5, 6, 7]
      .map(
        (n) =>
          `<div class="sc-list-item" data-itemid="item-zz-${n}0000" data-asin="${asin(n)}"><span>x</span></div>`,
      )
      .join("");
    const sizes = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const out = scrub(
        "cart",
        `<div id="sc-saved-cart" data-saved-item-quantity="7"><h2>Saved for later (7 items)</h2><div id="saved">${items}</div></div>`,
        `cart-${i}`,
      );
      const k = count(out, /class="sc-list-item"/g);
      expect(k).toBeGreaterThanOrEqual(2);
      expect(k).toBeLessThanOrEqual(6);
      expect(out).toContain(`data-saved-item-quantity="${k}"`);
      expect(out).toContain(`(${k} items)`);
      sizes.add(k);
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  test("two items stay two", () => {
    const items = [1, 2].map((n) => `<li data-itemid="item-zz-${n}0000">x</li>`).join("");
    expect(count(scrub("list", `<ul id="g-items">${items}</ul>`), /<li /g)).toBe(2);
  });

  test("embedded id lists lose the removed items and some off-page entries", () => {
    const cards = [1, 2, 3, 4, 5]
      .map(
        (n) =>
          `<div class="cell"><div id="p13n-asin-index-${n}" data-asin="${asin(n)}">x</div></div>`,
      )
      .join("");
    const recs = JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: asin(n) })));
    const out = scrub(
      "browsing_history",
      `<div id="grid" data-client-recs-list='${recs}'>${cards}</div>`,
    );
    const kept = count(out, /id="p13n-asin-index-/g);
    expect(kept).toBeLessThan(5);
    const list = JSON.parse(
      (/data-client-recs-list="([^"]*)"/.exec(out)?.[1] ?? "[]").replace(/&quot;/g, '"'),
    ) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(kept);
    expect(list.length).toBeLessThan(9);
  });

  test("carousel set sizes and positions follow the kept cards", () => {
    const cards = [1, 2, 3, 4, 5, 6, 7, 8]
      .map(
        (n) =>
          `<li class="a-carousel-card" aria-setsize="8" aria-posinset="${n}"><a href="/dp/${asin(n)}">x</a></li>`,
      )
      .join("");
    const out = scrub("cart", `<ol class="a-carousel">${cards}</ol>`);
    const k = count(out, /class="a-carousel-card"/g);
    expect(k).toBeLessThan(8);
    expect(count(out, new RegExp(`aria-setsize="${k}"`, "g"))).toBe(k);
    expect([...out.matchAll(/aria-posinset="(\d)"/g)].map((m) => Number(m[1]))).toEqual(
      Array.from({ length: k }, (_, i) => i + 1),
    );
  });

  test("items per order stay inside their order; a standard page of orders is kept", () => {
    const order = (boxes: number) =>
      `<div class="order-card"><div class="order-header">h</div>${Array.from({ length: boxes }, () => '<div class="delivery-box"><div class="item-box">i</div></div>').join("")}</div>`;
    const ten = Array.from({ length: 10 }, (_, i) => order(i === 0 ? 4 : 1)).join("");
    const out = scrub("order_list", `<div class="orders">${ten}</div>`);
    expect(count(out, /class="order-card"/g)).toBe(10);
    const boxes = count(out, /class="delivery-box"/g);
    expect(boxes).toBeGreaterThanOrEqual(11);
    expect(boxes).toBeLessThan(13);
    const four = Array.from({ length: 4 }, () => order(1)).join("");
    expect(
      count(scrub("order_list", `<div class="orders">${four}</div>`), /class="order-card"/g),
    ).toBeLessThan(4);
  });
});
