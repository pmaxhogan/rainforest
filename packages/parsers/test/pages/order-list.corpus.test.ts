/**
 * Dev-only: runs the order_list parser over every capture under
 * $RAINFOREST_CORPUS/order_list/<case>/ and checks sanity invariants. Skipped when the
 * variable is unset. Embeds no expected values and prints no page content.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { parseDocument } from "../../src/dom.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";
import { orderListLosslessOptions, parseOrderList } from "../../src/pages/order-list.ts";

const root = process.env["RAINFOREST_CORPUS"];

function cases(): { name: string; capture: Capture }[] {
  if (root === undefined || root === "") return [];
  const base = join(root, "order_list");
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
        kind: "order_list",
        url: manifest.url ?? "https://www.amazon.com/your-orders/orders",
        final_url:
          manifest.final_url ?? manifest.url ?? "https://www.amazon.com/your-orders/orders",
        captured_at: manifest.captured_at ?? "2000-01-01T00:00:00.000Z",
        html: readFileSync(join(dir, "page.html"), "utf8"),
      },
    });
  }
  return out;
}

const ORDER_ID = /^[A-Z0-9]{3}-\d{7}-\d{7}$/;
const ASIN = /^[A-Z0-9]{10}$/;

describe.skipIf(root === undefined || root === "")("order_list corpus", () => {
  const all = cases();

  it("finds captures", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const { name, capture } of all) {
    describe(`case ${name}`, () => {
      const result = parseOrderList(capture);
      const d = result.data;

      it("finds orders unless the page says there are none", () => {
        if (d.order_count === 0 || d.empty_text !== undefined) {
          expect(d.orders.length).toBe(0);
        } else {
          expect(d.orders.length).toBeGreaterThan(0);
        }
        if (d.order_count !== undefined && d.pagination === undefined) {
          expect(d.orders.length).toBeLessThanOrEqual(d.order_count);
        }
      });

      it("gives every order an id, a date and at least one shipment with items", () => {
        for (const o of d.orders) {
          expect(o.order_id).toMatch(ORDER_ID);
          expect(o.placed?.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(o.total?.currency).toBeTruthy();
          expect(o.shipments.length).toBeGreaterThan(0);
          expect(o.item_count).toBeGreaterThan(0);
          for (const s of o.shipments) {
            expect(s.items.length).toBeGreaterThan(0);
            for (const item of s.items) {
              expect(item.title.length).toBeGreaterThan(0);
              expect(item.asin ?? "").toMatch(ASIN);
              expect(item.url_path).toMatch(/^\/dp\//);
            }
          }
        }
        const ids = d.orders.map((o) => o.order_id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("never exposes a path outside the read-only allowlist", () => {
        const paths: string[] = [];
        for (const o of d.orders) {
          paths.push(...o.actions.flatMap((a) => (a.path === undefined ? [] : [a.path])));
          for (const s of o.shipments) {
            paths.push(...s.actions.flatMap((a) => (a.path === undefined ? [] : [a.path])));
            for (const i of s.items) {
              paths.push(...i.actions.flatMap((a) => (a.path === undefined ? [] : [a.path])));
            }
          }
        }
        for (const p of paths) {
          expect(p).toMatch(
            /^\/(?:your-orders\/order-details|gp\/css\/summary\/print\.html|progress-tracker\/|gp\/css\/order-details|gp\/your-account\/|gp\/css\/shiptrack|dp\/|gp\/product\/)/,
          );
        }
      });

      it("reads the page chrome that is present", () => {
        expect(d.heading).toBeTruthy();
        expect(d.tabs.length).toBeGreaterThan(0);
        expect(d.tabs.filter((t) => t.selected).length).toBe(1);
        expect(d.order_count_text).toMatch(/\d+ orders?/);
        // The time filter is absent on some orderFilter responses; when present it must be complete.
        if (d.time_filter !== undefined) {
          expect(d.time_filter.options.length).toBeGreaterThan(2);
          expect(d.time_filter.options.some((o) => /^year-\d{4}$/.test(o.value))).toBe(true);
          expect(d.time_filter.options.filter((o) => o.selected).length).toBe(1);
        }
        if (d.pagination !== undefined) {
          expect(d.pagination.index_param).toBe("page");
          expect(d.pagination.pages.length).toBeGreaterThan(0);
          expect(d.pagination.current_label).toBeTruthy();
        }
      });

      it("only warns about requested filters the page ignores", () => {
        for (const w of result.meta.warnings) expect(w.startsWith("requested ")).toBe(true);
      });

      it("accounts for the visible text (lossless) and leaves little in other_sections", () => {
        const opts = orderListLosslessOptions(parseDocument(capture.html));
        // The parser consumes every block it understands and reports the rest, so the
        // unparsed share must be tiny; 0.98 leaves room for new decoration on the page.
        const ratio = expectLosslessCoverage(result, capture, 0.98, opts);
        expect(ratio).toBeGreaterThanOrEqual(0.98);
        const other = result.other_sections.reduce((n, s) => n + s.text.length, 0);
        const total = parseDocument(capture.html).body.textContent?.length ?? 1;
        expect(other / total).toBeLessThan(0.05);
      });

      it("is JSON serializable and compact", () => {
        const json = JSON.stringify(result);
        expect(JSON.parse(json)).toBeTruthy();
        expect(json.length).toBeLessThan(250_000);
        expect(json).not.toMatch(/<(?:div|span|a|li)\b/);
      });
    });
  }
});
