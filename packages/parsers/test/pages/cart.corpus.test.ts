/**
 * Dev-only: runs the cart parser over every private corpus capture. Skipped unless
 * RAINFOREST_CORPUS points at the corpus root (`<root>/cart/<case>/page.html` + capture.json).
 * Assertions are sanity invariants only and use boolean checks, so a failure never prints
 * page content. No expected real value is embedded here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { parseCart } from "../../src/pages/cart.ts";
import type { CartItem } from "../../src/pages/cart.ts";
import { parseDocument, q } from "../../src/index.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";

const CORPUS = process.env["RAINFOREST_CORPUS"];

function cases(): { name: string; capture: Capture }[] {
  if (CORPUS === undefined) return [];
  const base = join(CORPUS, "cart");
  if (!existsSync(base)) return [];
  const out: { name: string; capture: Capture }[] = [];
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    if (!existsSync(join(dir, "page.html")) || !existsSync(join(dir, "capture.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as Capture;
    out.push({
      name,
      capture: { ...manifest, html: readFileSync(join(dir, "page.html"), "utf8") },
    });
  }
  return out;
}

const ASIN = /^[A-Z0-9]{10}$/;

describe.skipIf(CORPUS === undefined)("cart corpus", () => {
  const all = cases();

  it("has at least one capture", () => {
    expect(all.length > 0).toBe(true);
  });

  for (const { name, capture } of all) {
    describe(`case ${name}`, () => {
      const result = parseCart(capture);
      const { data, meta } = result;
      const items: CartItem[] = [...data.active_items, ...data.saved_items];

      it("finds items or an empty active cart", () => {
        expect(data.active_count + data.saved_count > 0 || data.is_empty).toBe(true);
        expect(data.active_count).toBe(data.active_items.length);
        expect(data.saved_count).toBe(data.saved_items.length);
        expect(data.is_empty).toBe(data.active_items.length === 0);
      });

      it("gives every item an id, asin and title with unique ids per list", () => {
        expect(items.every((i) => i.item_id.length >= 4)).toBe(true);
        expect(items.every((i) => i.asin !== null && ASIN.test(i.asin))).toBe(true);
        expect(items.every((i) => i.title !== null && i.title.length > 0)).toBe(true);
        for (const list of [data.active_items, data.saved_items]) {
          expect(new Set(list.map((i) => i.item_id)).size).toBe(list.length);
        }
      });

      it("prices, quantities and url paths are well formed", () => {
        expect(items.every((i) => i.price === null || Number.isFinite(i.price.amount))).toBe(true);
        expect(items.every((i) => i.price === null || i.price.amount >= 0)).toBe(true);
        expect(items.every((i) => i.quantity === null || i.quantity >= 1)).toBe(true);
        expect(items.every((i) => i.url_path === null || !/[?#]/.test(i.url_path))).toBe(true);
        expect(items.filter((i) => i.price === null).length <= Math.floor(items.length / 4)).toBe(
          true,
        );
      });

      it("matches the saved caption and warns about nothing", () => {
        if (data.saved_declared_count !== null) {
          expect(data.saved_declared_count).toBe(data.saved_count);
        }
        expect(meta.warnings).toEqual([]);
      });

      it("never leaks tokens or offer ids", () => {
        const json = JSON.stringify(result);
        expect(/csrf|encoded-offering|best-offer-id|previous-offer-id/i.test(json)).toBe(false);
        expect(JSON.parse(json)).toEqual(result);
      });

      it("accounts for the main content (coverage >= 0.95 of visible text)", () => {
        // Measured over the whole body minus chrome, so the ratio is a lower bound on the
        // parser's own root. Unparsed text in the main content is expected to be ~0.
        const root = q(parseDocument(capture.html), "#sc-page-content");
        expect(root !== undefined).toBe(true);
        const ratio = expectLosslessCoverage(result, capture, 0.95, root ? { root } : {});
        expect(ratio >= 0.95).toBe(true);
      });
    });
  }
});
