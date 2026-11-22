/**
 * Dev-only: runs the order_search parser over every capture under
 * $RAINFOREST_CORPUS/order_search/<case>/ and checks sanity invariants. Skipped when the
 * variable is unset. Embeds no expected values and prints no page content: every
 * assertion on a text value is a boolean, so a failure message cannot echo private data.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { parseDocument } from "../../src/dom.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";
import { orderSearchLosslessOptions, parseOrderSearch } from "../../src/pages/order-search.ts";

const root = process.env["RAINFOREST_CORPUS"];
const DEFAULT_URL = "https://www.amazon.com/your-orders/search";

function cases(): { name: string; capture: Capture }[] {
  if (root === undefined || root === "") return [];
  const base = join(root, "order_search");
  if (!existsSync(base)) return [];
  const out: { name: string; capture: Capture }[] = [];
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, "page.html"))) continue;
    const manifest = JSON.parse(
      readFileSync(join(dir, "capture.json"), "utf8"),
    ) as Partial<Capture>;
    out.push({
      name,
      capture: {
        kind: "order_search",
        url: manifest.url ?? DEFAULT_URL,
        final_url: manifest.final_url ?? manifest.url ?? DEFAULT_URL,
        captured_at: manifest.captured_at ?? "2000-01-01T00:00:00.000Z",
        html: readFileSync(join(dir, "page.html"), "utf8"),
      },
    });
  }
  return out;
}

const ORDER_ID = /^[A-Z0-9]{3}-\d{7}-\d{7}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const READ_ONLY = /^\/(?:your-orders\/order-details|gp\/your-account\/order-details|dp\/)/;

describe.skipIf(root === undefined || root === "")("order_search corpus", () => {
  const all = cases();

  it("finds captures", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const { name, capture } of all) {
    describe(`case ${name}`, () => {
      const result = parseOrderSearch(capture);
      const d = result.data;

      it("has rows, or says that nothing matched", () => {
        if (d.empty_text !== undefined) {
          expect(d.results.length).toBe(0);
          expect(d.order_count).toBeUndefined();
        } else {
          expect(d.results.length).toBeGreaterThan(0);
          expect(d.results.length).toBeLessThanOrEqual(10);
          expect((d.order_count ?? 0) > 0).toBe(true);
          const orders = new Set(d.results.map((h) => h.order_id)).size;
          expect(orders).toBeLessThanOrEqual(d.order_count ?? 0);
          if (d.pagination === undefined) expect(orders).toBe(d.order_count);
        }
      });

      it("gives every row a product, an order and a date", () => {
        for (const h of d.results) {
          expect(h.title.length).toBeGreaterThan(0);
          expect(ASIN.test(h.asin ?? "")).toBe(true);
          expect((h.url_path ?? "").startsWith("/dp/")).toBe(true);
          expect(ORDER_ID.test(h.order_id ?? "")).toBe(true);
          expect((h.order_details_path ?? "").includes(h.order_id ?? "missing")).toBe(true);
          expect(ISO_DATE.test(h.ordered?.iso ?? "")).toBe(true);
          expect(h.image_url !== undefined).toBe(true);
        }
      });

      it("never exposes a path outside the read-only allowlist", () => {
        const paths = d.results.flatMap((h) => [
          h.order_details_path,
          h.url_path,
          ...h.actions.map((a) => a.path),
        ]);
        expect(paths.every((p) => p === undefined || READ_ONLY.test(p))).toBe(true);
      });

      it("reads the page chrome and shows the requested query", () => {
        expect(d.heading !== undefined).toBe(true);
        expect(d.breadcrumbs.length).toBeGreaterThan(0);
        expect(d.query !== undefined && d.query === d.requested.query).toBe(true);
        if (d.pagination !== undefined) {
          expect(d.pagination.index_param).toBe("page");
          expect(d.pagination.index_base).toBe(1);
          expect(d.pagination.current_label !== undefined).toBe(true);
        }
      });

      it("uses the primary strategies and raises no warning", () => {
        expect(result.meta.warnings.length).toBe(0);
        if (d.results.length > 0) {
          expect(result.meta.strategies["results"]).toBe("left-grid");
          expect(result.meta.strategies["match_text"]).toBe("summary-class");
          expect(result.meta.strategies["result.order_id"]).toBe("order-link");
          expect(result.meta.strategies["result.ordered"]).toBe("order-row");
        }
        expect(result.meta.strategies["query"]).toBe("search-box");
      });

      it("accounts for the visible text (lossless)", () => {
        const opts = orderSearchLosslessOptions(parseDocument(capture.html));
        expect(expectLosslessCoverage(result, capture, 0.98, opts)).toBeGreaterThanOrEqual(0.98);
        const other = result.other_sections.reduce((n, s) => n + s.text.length, 0);
        expect(other).toBeLessThan(200);
      });
    });
  }
});
