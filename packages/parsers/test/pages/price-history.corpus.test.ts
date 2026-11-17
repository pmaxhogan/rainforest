/**
 * Dev-only: runs the price history parsers over the owner's private captures. Set
 * RAINFOREST_CORPUS to the corpus root (<root>/<kind>/<case>/{page.html,capture.json}).
 * Asserts structural invariants only; no expected real value is embedded and nothing from a
 * page is printed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture, PageKind } from "@rainforest/core";
import { parseDocument, visibleTextChars } from "../../src/index.ts";
import {
  ASIN_PATTERN,
  amazonPriceRoot,
  camelContentRoot,
  isAllowedCamelChartUrl,
  parseAmazonPriceHistory,
  parseCamelPriceHistory,
} from "../../src/pages/price-history.ts";

const ROOT = process.env["RAINFOREST_CORPUS"];

function cases(kind: string): { name: string; dir: string }[] {
  if (ROOT === undefined) return [];
  const base = join(ROOT, kind);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .map((name) => ({ name, dir: join(base, name) }))
    .filter((c) => statSync(c.dir).isDirectory() && existsSync(join(c.dir, "page.html")));
}

function load(dir: string, kind: PageKind): Capture {
  const manifest = existsSync(join(dir, "capture.json"))
    ? (JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as Partial<Capture>)
    : {};
  return {
    kind,
    url: manifest.url ?? "https://www.example.com/",
    final_url: manifest.final_url ?? manifest.url ?? "https://www.example.com/",
    captured_at: manifest.captured_at ?? "2000-01-01T00:00:00.000Z",
    html: readFileSync(join(dir, "page.html"), "utf8"),
  };
}

describe.skipIf(!process.env["RAINFOREST_CORPUS"])("price history corpus: camelcamelcamel", () => {
  const found = cases("price_history_camel");

  it("has at least one capture", () => {
    expect(found.length).toBeGreaterThan(0);
  });

  for (const c of found) {
    it(`parses ${c.name}`, () => {
      const capture = load(c.dir, "price_history_camel");
      const r = parseCamelPriceHistory(capture);
      expect(r.data.blocked).toBe(false);
      expect(typeof r.data.title).toBe("string");
      expect(r.data.title?.length).toBeGreaterThan(0);
      expect(r.data.asin).toMatch(ASIN_PATTERN);
      expect(r.data.state).toBe("ok");
      expect(r.data.stats.length).toBeGreaterThanOrEqual(1);
      expect(r.data.stats.some((s) => s.has_data)).toBe(true);
      for (const s of r.data.stats) {
        expect(["amazon", "new", "used"]).toContain(s.type);
        if (s.has_data) {
          expect(s.average !== undefined || s.current !== undefined || s.lowest !== undefined).toBe(
            true,
          );
        }
        for (const m of [s.current, s.highest, s.lowest, s.average]) {
          if (m !== undefined) expect(m.amount).toBeGreaterThan(0);
        }
        if (s.lowest !== undefined && s.highest !== undefined) {
          expect(s.lowest.amount).toBeLessThanOrEqual(s.highest.amount);
        }
      }
      expect(r.data.chart_urls.length).toBeGreaterThanOrEqual(1);
      for (const u of r.data.chart_urls) expect(isAllowedCamelChartUrl(u)).toBe(true);
      expect(r.data.periods.length).toBeGreaterThanOrEqual(1);
      expect(r.data.buy_box.length).toBeGreaterThanOrEqual(1);
      expect(r.meta.warnings).toEqual([]);
      expect(() => JSON.stringify(r)).not.toThrow();

      // lossless coverage over the same root the parser used
      const doc = parseDocument(capture.html);
      const total = visibleTextChars(doc, { root: camelContentRoot(doc) });
      expect(r.meta.unparsed_text_chars).toBeLessThanOrEqual(total);
      const ratio = total === 0 ? 1 : 1 - r.meta.unparsed_text_chars / total;
      // Measured ~0.99; the floor leaves room for small labels (for example "Share:") that no
      // typed field owns.
      expect(ratio).toBeGreaterThanOrEqual(0.95);
      const keys = new Set<string>();
      for (const s of r.other_sections) {
        expect(s.text.trim()).not.toBe("");
        expect(keys.has(s.key)).toBe(false);
        keys.add(s.key);
      }
    });
  }
});

describe.skipIf(!process.env["RAINFOREST_CORPUS"])(
  "price history corpus: Amazon product and offers captures",
  () => {
    const found = [...cases("product"), ...cases("offers")].map((c) => ({
      ...c,
      name: `${c.dir.split("/").slice(-2).join("/")}`,
    }));

    it("has at least one capture", () => {
      expect(found.length).toBeGreaterThan(0);
    });

    for (const c of found) {
      it(`parses ${c.name}`, () => {
        const capture = load(c.dir, "price_history_amazon");
        const r = parseAmazonPriceHistory(capture);
        expect(r.data.series_available).toBe(false);
        expect(r.data.series_note.length).toBeGreaterThan(0);
        expect(Array.isArray(r.data.basis_prices)).toBe(true);
        for (const b of r.data.basis_prices) {
          expect(b.price.amount).toBeGreaterThan(0);
          expect(["typical", "list", "was", "other"]).toContain(b.kind);
        }
        if (r.data.typical_price !== undefined) {
          expect(r.data.basis_prices.some((b) => b.kind === "typical")).toBe(true);
        }
        if (r.data.current_price !== undefined) {
          expect(r.data.current_price.amount).toBeGreaterThan(0);
        }
        // ingress internal consistency: a rendered pill carries its query text and an ASIN
        const ing = r.data.ingress;
        expect(ing.present).toBe(ing.entries.length > 0);
        for (const e of ing.entries) {
          expect(typeof e.rendered).toBe("boolean");
          if (e.rendered) {
            expect(e.query_text).toBeDefined();
            expect(e.item_id).toMatch(ASIN_PATTERN);
          }
        }
        if (ing.entries.some((e) => e.rendered)) {
          expect(r.data.asin).toMatch(ASIN_PATTERN);
          expect(ing.declarative_action).toBeDefined();
          expect(ing.stream_qis).toBeDefined();
        }
        expect(() => JSON.stringify(r)).not.toThrow();

        const doc = parseDocument(capture.html);
        const root = amazonPriceRoot(doc);
        expect(root).toBeDefined();
        const total = visibleTextChars(doc, root === undefined ? {} : { root });
        expect(r.meta.unparsed_text_chars).toBeLessThanOrEqual(total);
        const ratio = total === 0 ? 1 : 1 - r.meta.unparsed_text_chars / total;
        expect(ratio).toBeGreaterThanOrEqual(0.95);
        const keys = new Set<string>();
        for (const s of r.other_sections) {
          expect(s.text.trim()).not.toBe("");
          expect(keys.has(s.key)).toBe(false);
          keys.add(s.key);
        }
      });
    }
  },
);
