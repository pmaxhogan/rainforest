import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSubscriptions } from "../../src/pages/subscriptions.ts";
import { expectLosslessCoverage, loadFixture } from "../../src/testing.ts";

const root = process.env.RAINFOREST_CORPUS;

function cases(): string[] {
  if (root === undefined) return [];
  const base = join(root, "subscriptions");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .map((n) => join(base, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "capture.json")));
}

describe.skipIf(root === undefined)("subscriptions corpus (dev only)", () => {
  const dirs = cases();

  it("has at least one capture", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const [i, dir] of dirs.entries()) {
    it(`capture #${i} satisfies the sanity invariants`, () => {
      const capture = loadFixture(dir);
      const r = parseSubscriptions(capture);
      const d = r.data;

      // the hub pills and the program tab are recognised
      expect(d.tabs.length).toBeGreaterThan(0);
      expect(d.program).not.toBeNull();

      // something was found, and it is not reported as empty
      expect(d.subscriptions.length + d.upcoming_deliveries.length).toBeGreaterThan(0);
      expect(d.is_empty).toBe(false);

      // every subscription is identified and described
      for (const s of d.subscriptions) {
        expect(s.subscription_id).toBeTruthy();
        expect(s.asin).toMatch(/^[A-Z0-9]{10}$/);
        expect(s.title).toBeTruthy();
        expect(s.quantity).toBeGreaterThan(0);
        expect(s.frequency).not.toBeNull();
        expect(s.next_delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(s.edit_path).toBeTruthy();
      }
      // category counts add up to the tiles on the page
      if (d.category_filters.length > 0) {
        const total = d.category_filters.reduce((n, c) => n + (c.count ?? 0), 0);
        expect(total).toBe(d.subscriptions.length);
      }

      // deliveries carry a date that agrees with its weekday label
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (const dv of d.upcoming_deliveries) {
        expect(dv.bundle_id).toBeTruthy();
        expect(dv.delivery_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const wd = new Date(`${dv.delivery_date}T00:00:00Z`).getUTCDay();
        if (/^[A-Z][a-z]{2},/.test(dv.date_text ?? "")) {
          expect((dv.date_text ?? "").slice(0, 3)).toBe(days[wd]);
        }
        expect(dv.item_count).toBeGreaterThan(0);
      }
      // the carousel slide count is fully explained (deliveries plus the paging sentinel)
      expect(r.meta.warnings.filter((w) => w.startsWith("upcoming_deliveries"))).toEqual([]);

      // recommended offers are identified and priced
      for (const o of d.recommended) {
        expect(o.asin).toMatch(/^[A-Z0-9]{10}$/);
        expect(o.title).toBeTruthy();
        expect(o.price?.amount).toBeGreaterThan(0);
      }

      // nothing silently dropped: at least 98% of visible text is parsed or reported
      const ratio = expectLosslessCoverage(r, capture, 0.98);
      expect(ratio).toBeGreaterThanOrEqual(0.98);
    });
  }
});
