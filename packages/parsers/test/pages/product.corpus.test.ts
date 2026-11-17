/**
 * Dev-only sanity run of the product parser over the owner's private corpus (never in the
 * repo). Skipped unless RAINFOREST_CORPUS points at the corpus root. Product pages are read
 * from `<root>/product/<case>/` and from the main page of `<root>/offers/<case>/`.
 * Assertions are structural invariants only: no real value is embedded and no page content
 * is printed (failure messages name the case directory and the field).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { parseDocument, visibleTextChars } from "../../src/index.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";
import { BUY_BOX_STATES, parseProduct } from "../../src/pages/product.ts";

const ROOT = process.env.RAINFOREST_CORPUS;
const ASIN = /^[0-9A-Z]{10}$/;

/**
 * Minimum share of visible main-content text that is either typed or in other_sections.
 * Accounting is exact (every visible text node lands in a bucket), so anything below 1.0
 * would mean a block escaped both the typed parser and the lossless fallback.
 */
const MIN_COVERAGE = 0.99;
/**
 * Minimum share of visible text the typed parser consumes itself. The rest is mostly the
 * individual top reviews (owned by the reviews parser) and long-tail blocks reported in
 * other_sections; on the real corpus this sits between about 0.2 and 0.45.
 */
const MIN_CONSUMED = 0.15;

function cases(): { name: string; dir: string }[] {
  if (ROOT === undefined) return [];
  const out: { name: string; dir: string }[] = [];
  for (const kind of ["product", "offers"]) {
    const base = join(ROOT, kind);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, "page.html"))) continue;
      out.push({ name: `${kind}/${name}`, dir });
    }
  }
  return out;
}

function load(dir: string): Capture {
  const meta = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")) as Partial<Capture>;
  return {
    kind: "product",
    url: meta.url ?? "",
    final_url: meta.final_url ?? meta.url ?? "",
    captured_at: meta.captured_at ?? "",
    html: readFileSync(join(dir, "page.html"), "utf8"),
  };
}

describe.skipIf(ROOT === undefined)("product parser over the private corpus", () => {
  const all = cases();

  it("finds captures", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const { name, dir } of all) {
    it(`${name}: identity, buy box and lossless accounting`, () => {
      const capture = load(dir);
      const r = parseProduct(capture);
      const d = r.data;
      expect(ASIN.test(d.asin ?? ""), `${name}: asin`).toBe(true);
      expect((d.title ?? "").length, `${name}: title`).toBeGreaterThan(0);
      expect(BUY_BOX_STATES as readonly string[], `${name}: state`).toContain(d.buy_box.state);
      expect(d.buy_box.state, `${name}: state decided`).not.toBe("unknown");
      if (d.buy_box.state === "featured_offer" || d.buy_box.state === "renewed") {
        const o = d.featured_offer;
        expect(o?.price?.amount ?? 0, `${name}: price`).toBeGreaterThan(0);
        expect(o?.add_to_cart_present, `${name}: add to cart`).toBe(true);
        expect((o?.seller?.name ?? "").length, `${name}: seller`).toBeGreaterThan(0);
        expect(o?.fulfillment, `${name}: fulfillment`).toBeDefined();
        expect(o?.delivery.length ?? 0, `${name}: delivery`).toBeGreaterThan(0);
      }
      // Optional blocks (new or unavailable listings may lack them): check shape when present.
      if (d.rating !== undefined) {
        if (d.rating.value !== undefined) {
          expect(d.rating.value, `${name}: rating`).toBeGreaterThan(0);
          expect(d.rating.value, `${name}: rating`).toBeLessThanOrEqual(d.rating.out_of ?? 5);
        }
        if (d.rating.histogram.length > 0) {
          expect(d.rating.histogram.length, `${name}: histogram`).toBe(5);
          const sum = d.rating.histogram.reduce((n, h) => n + h.percent, 0);
          expect(Math.abs(sum - 100), `${name}: histogram sum`).toBeLessThanOrEqual(5);
        }
      }
      for (const t of d.spec_tables) expect(t.rows.length, `${name}: spec rows`).toBeGreaterThan(0);
      for (const b of d.best_seller_ranks) expect(b.rank, `${name}: rank`).toBeGreaterThan(0);
      for (const b of d.sponsored_blocks) {
        for (const item of b.items) {
          if (item.asin !== undefined)
            expect(ASIN.test(item.asin), `${name}: sponsored asin`).toBe(true);
        }
      }
      for (const w of d.related) {
        expect(w.items.length, `${name}: related items`).toBeGreaterThan(0);
      }
      // Output stays compact and free of markup.
      const json = JSON.stringify(r);
      expect(json.length, `${name}: size`).toBeLessThan(200_000);
      expect(/<(div|span|script)\b/i.test(JSON.stringify(d)), `${name}: no html`).toBe(false);
      const ratio = expectLosslessCoverage(r, capture, MIN_COVERAGE);
      expect(ratio, `${name}: coverage`).toBeGreaterThanOrEqual(MIN_COVERAGE);
      expect(r.meta.unparsed_text_chars, `${name}: unparsed`).toBe(0);
      // Typed share: main-content text minus what other_sections re-emits (approximate).
      const doc = parseDocument(capture.html);
      const total = visibleTextChars(doc, { root: doc.querySelector("#dp") ?? undefined });
      const emitted = r.other_sections.reduce((n, s) => n + s.text.length, 0);
      expect(1 - emitted / total, `${name}: consumed share`).toBeGreaterThan(MIN_CONSUMED);
    });
  }
});
