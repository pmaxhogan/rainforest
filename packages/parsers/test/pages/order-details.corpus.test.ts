/**
 * Dev-only: runs the order_details parser over every capture under $RAINFOREST_CORPUS/order_details.
 * Skipped when the variable is unset. Asserts invariants only (no expected real values) and
 * never prints page content.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { parseDocument, q, visibleTextChars } from "../../src/index.ts";
import { parseOrderDetails } from "../../src/pages/order-details.ts";

const root = process.env["RAINFOREST_CORPUS"];

function cases(): { name: string; capture: Capture }[] {
  if (root === undefined) return [];
  const base = join(root, "order_details");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((n) => statSync(join(base, n)).isDirectory() && existsSync(join(base, n, "page.html")))
    .map((name) => {
      const dir = join(base, name);
      const manifest = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as Omit<
        Capture,
        "html"
      >;
      return { name, capture: { ...manifest, html: readFileSync(join(dir, "page.html"), "utf8") } };
    });
}

/** Coverage threshold: everything visible under the main root is consumed or emitted. */
const MIN_COVERAGE = 0.99;

describe.skipIf(root === undefined)("order_details corpus", () => {
  const all = cases();

  it("has captures", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const { name, capture } of all) {
    it(`parses ${name} (or is a known error banner)`, () => {
      let result;
      try {
        result = parseOrderDetails(capture);
      } catch (e) {
        // Only a capture of the "unable to load" banner may throw, and only that way.
        expect(capture.html).toContain('data-component="errorbanner"');
        expect(e).toBeInstanceOf(RfError);
        expect((e as RfError).payload.code).toBe("layout_unrecognized");
        return;
      }
      const d = result.data;
      expect(d.order_id).toMatch(/^[A-Z0-9]{3}-\d{7}-\d{7}$/);
      expect(d.placed?.raw).toBeTruthy();
      expect(d.placed?.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.ship_to?.name).toBeTruthy();
      expect(d.totals.length).toBeGreaterThan(0);
      expect(d.totals.some((t) => t.type === "grand_total" && t.amount !== undefined)).toBe(true);
      expect(d.shipments.length).toBeGreaterThan(0);
      for (const s of d.shipments) {
        expect(s.items.length).toBeGreaterThan(0);
        for (const it of s.items) {
          expect(it.title).toBeTruthy();
          expect(it.asin).toMatch(/^[A-Z0-9]{10}$/);
          expect(it.quantity).toBeGreaterThanOrEqual(1);
          expect(it.price?.amount).toBeGreaterThan(0);
        }
      }

      // privacy rails on the output itself
      expect(d.payment.methods.length).toBeGreaterThan(0);
      expect(d.payment.last4 === undefined || /^\d{4}$/.test(d.payment.last4)).toBe(true);
      expect(JSON.stringify(d.payment)).not.toMatch(/\d{5,}/);
      // no href of a mutating flow ever reaches the data
      expect(JSON.stringify(d)).not.toMatch(
        /\/spr\/returns\/cart|\/review\/review-your|\/hz\/feedback|\/gcx\//,
      );
      expect(() => JSON.stringify(result)).not.toThrow();

      // lossless accounting
      const doc = parseDocument(capture.html);
      const main = q(doc, "[role=main]") ?? q(doc, "#orderDetails") ?? doc.body;
      const total = visibleTextChars(doc, { root: main });
      const unparsed = result.meta.unparsed_text_chars;
      expect(unparsed).toBeGreaterThanOrEqual(0);
      expect(unparsed).toBeLessThanOrEqual(total);
      const ratio = total === 0 ? 1 : 1 - unparsed / total;
      expect(ratio).toBeGreaterThanOrEqual(MIN_COVERAGE);
      // nothing parsed may also sit in other_sections
      const rest = result.other_sections.map((s) => s.text).join(" ");
      for (const s of d.shipments) for (const it of s.items) expect(rest).not.toContain(it.title);
      const keys = result.other_sections.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  it("parses at least one capture completely", () => {
    const ok = all.filter(({ capture }) => {
      try {
        parseOrderDetails(capture);
        return true;
      } catch {
        return false;
      }
    });
    expect(ok.length).toBeGreaterThan(0);
  });
});
