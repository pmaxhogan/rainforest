import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBrowsingHistory } from "../../src/pages/browsing-history.ts";
import { expectLosslessCoverage, loadFixture } from "../../src/testing.ts";

const root = process.env.RAINFOREST_CORPUS;

function cases(): string[] {
  if (root === undefined) return [];
  const base = join(root, "browsing_history");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .map((n) => join(base, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "capture.json")));
}

describe.skipIf(root === undefined)("browsing_history corpus (dev only)", () => {
  const dirs = cases();

  it("has at least one capture", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const [i, dir] of dirs.entries()) {
    it(`capture #${i} satisfies the sanity invariants`, () => {
      const capture = loadFixture(dir);
      const r = parseBrowsingHistory(capture);
      const d = r.data;

      expect(d.heading).toBeTruthy();
      expect(d.history_status).not.toBe("unknown");
      expect(d.items.length).toBeGreaterThan(0);
      expect(d.is_empty).toBe(false);

      // positions are consecutive from zero, in page order
      expect(d.items.map((x) => x.position)).toEqual(d.items.map((_, n) => n));
      const seen = new Set<string>();
      for (const item of d.items) {
        expect(item.asin).toMatch(/^[A-Z0-9]{10}$/);
        expect(seen.has(item.asin as string)).toBe(false);
        seen.add(item.asin as string);
        expect(item.title).toBeTruthy();
        expect(item.url_path).toContain(`/dp/${item.asin}`);
        expect(item.image_url).toBeTruthy();
        expect(item.remove_label).toBeTruthy();
        if (item.price !== null) expect(item.price.amount).toBeGreaterThan(0);
        if (item.rating !== null) expect(item.rating.value).toBeLessThanOrEqual(5);
      }

      // every rendered card is part of the page's own full id list, in the same order
      expect(d.all_asins.length).toBeGreaterThanOrEqual(d.items.length);
      expect(d.all_asins.slice(0, d.items.length)).toEqual(d.items.map((x) => x.asin));
      expect(d.unrendered_asins.length + d.items.length).toBe(d.all_asins.length);
      expect(d.has_more).toBe(d.unrendered_asins.length > 0);

      const ratio = expectLosslessCoverage(r, capture, 0.98);
      expect(ratio).toBeGreaterThanOrEqual(0.98);
    });
  }
});
