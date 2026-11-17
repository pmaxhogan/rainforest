/**
 * Dev-only: runs the variants parser over every product and offers capture under the
 * directory in RAINFOREST_CORPUS (cases are `<kind>/<case>/page.html` + `capture.json`).
 * Asserts structural invariants only; it embeds no real value and prints no page content.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVariants } from "../../src/pages/variants.ts";
import type { VariantsData } from "../../src/pages/variants.ts";
import { loadFixture } from "../../src/testing.ts";

const root = process.env["RAINFOREST_CORPUS"];
const ASIN_RE = /^[A-Z0-9]{10}$/;

function caseDirs(): string[] {
  if (root === undefined || root === "") return [];
  const out: string[] = [];
  for (const kind of ["product", "offers"]) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, "capture.json"))) out.push(dir);
    }
  }
  return out;
}

const dirs = caseDirs();

describe.skipIf(!process.env["RAINFOREST_CORPUS"])(
  "variants parser over the private corpus",
  () => {
    it("finds captures to parse", () => {
      expect(dirs.length).toBeGreaterThan(0);
    });

    const withDimensions: VariantsData[] = [];
    const withoutDimensions: VariantsData[] = [];

    dirs.forEach((dir, i) => {
      it(`case #${i}: structural invariants`, () => {
        const capture = loadFixture(dir);
        const { data, other_sections, meta } = parseVariants(capture);

        expect(other_sections).toEqual([]);
        expect(meta.unparsed_text_chars).toBe(0);
        // No JSON-vs-DOM disagreement and no malformed variant blob on real pages.
        expect(
          meta.warnings.filter((w) => /disagree|malformed|could not be decoded/.test(w)),
        ).toEqual([]);
        expect(meta.warnings.filter((w) => w.includes("dropped"))).toEqual([]);
        expect(() => JSON.stringify(data)).not.toThrow();

        expect(data.current_asin).toMatch(ASIN_RE);
        if (data.parent_asin !== null) expect(data.parent_asin).toMatch(ASIN_RE);

        if (data.dimensions.length === 0) {
          withoutDimensions.push(data);
          expect(data.combinations).toEqual([]);
          expect(data.missing_offer_asins).toEqual([]);
          return;
        }
        withDimensions.push(data);

        const keys = new Set<string>();
        for (const dim of data.dimensions) {
          expect(dim.key).not.toBe("");
          expect(keys.has(dim.key)).toBe(false);
          keys.add(dim.key);
          expect(dim.label.trim()).not.toBe("");
          expect(dim.values.length).toBeGreaterThan(0);
          expect(dim.selected_value).not.toBeNull();
          expect(dim.values.filter((v) => v.selected)).toHaveLength(1);
          const seen = new Set<string>();
          for (const v of dim.values) {
            expect(v.value.trim()).not.toBe("");
            expect(seen.has(v.value)).toBe(false);
            seen.add(v.value);
            expect(v.state).not.toBe("unknown");
            if (v.asin !== null) expect(v.asin).toMatch(ASIN_RE);
            if (v.index !== null) expect(Number.isInteger(v.index)).toBe(true);
          }
        }

        // Every combination names every dimension with a value the dimension lists.
        expect(data.combinations.length).toBeGreaterThan(0);
        const asins = new Set<string>();
        for (const c of data.combinations) {
          expect(c.asin).toMatch(ASIN_RE);
          expect(asins.has(c.asin)).toBe(false);
          asins.add(c.asin);
          expect(new Set(Object.keys(c.values))).toEqual(keys);
          for (const dim of data.dimensions) {
            expect(dim.values.map((v) => v.value)).toContain(c.values[dim.key]);
          }
          if (c.price !== undefined) expect(c.price.amount).toBeGreaterThan(0);
          expect(c.selected).toBe(c.asin === data.current_asin);
        }
        expect(asins.has(data.current_asin as string)).toBe(true);
        expect(data.combinations.filter((c) => c.selected)).toHaveLength(1);

        if (data.total_variations !== null && data.combinations_complete) {
          expect(data.combinations.length).toBe(data.total_variations);
        }

        // Selected values name the current combination.
        const current = data.combinations.find((c) => c.selected);
        for (const dim of data.dimensions) {
          expect(current?.values[dim.key]).toBe(dim.selected_value);
        }

        // State semantics, measured against the map: swapping one dimension of the current
        // selection to an `available` value lands on a real combination whose ASIN is the
        // value's default ASIN; a `see_options` value has no such combination.
        if (data.combinations_complete && current !== undefined) {
          for (const dim of data.dimensions) {
            for (const v of dim.values) {
              const wanted = { ...current.values, [dim.key]: v.value };
              const combo = data.combinations.find((c) =>
                Object.keys(wanted).every((k) => c.values[k] === wanted[k]),
              );
              if (v.state === "available") {
                expect(combo).toBeDefined();
                expect(combo?.asin).toBe(v.asin);
              } else if (v.state === "see_options") {
                expect(combo).toBeUndefined();
              }
              // Badge pictures inside a text swatch are not swatch images (a singleton value
              // may still carry the picture the JSON attaches to it).
              if (v.swatch_kind === "text" && !dim.singleton) {
                expect(v.swatch?.image ?? null).toBeNull();
              }
            }
          }
        }

        // missing_offer_asins: known children, never the current one, none with an offer.
        const byAsin = new Map(data.combinations.map((c) => [c.asin, c]));
        for (const asin of data.missing_offer_asins) {
          expect(asin).not.toBe(data.current_asin);
          const c = byAsin.get(asin);
          if (c !== undefined) {
            expect(
              c.price === undefined && c.availability === undefined && c.delivery === undefined,
            ).toBe(true);
          }
        }
        expect(new Set(data.missing_offer_asins).size).toBe(data.missing_offer_asins.length);
      });
    });

    it("covers both variant and no-variant pages", () => {
      expect(withDimensions.length).toBeGreaterThan(0);
      expect(withoutDimensions.length).toBeGreaterThan(0);
    });
  },
);
