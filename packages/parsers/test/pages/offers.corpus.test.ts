/**
 * Dev-only sanity run of parseOffers over real captures in $RAINFOREST_CORPUS/offers/<case>/.
 * Skipped when the variable is unset. Embeds no expected real value and prints no page
 * content: assertions are structural invariants only.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFER_FLAGS } from "@rainforest/core";
import { parseCapture, q, visibleTextChars } from "../../src/index.ts";
import { loadFixture } from "../../src/testing.ts";
import {
  REQUEST_TIME_FLAGS,
  computeOfferFlags,
  normalizeAodVisibility,
  offerFlagContext,
  parseOffers,
} from "../../src/pages/offers.ts";
import type { Offer } from "../../src/pages/offers.ts";

const corpus = process.env.RAINFOREST_CORPUS;
const base = corpus === undefined ? "" : join(corpus, "offers");
const cases =
  corpus === undefined || !existsSync(base)
    ? []
    : readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(base, d.name, "capture.json")))
        .map((d) => d.name)
        .sort();

/**
 * Minimum share of visible text (panel + buy box) that is consumed or emitted. The panel is
 * id-addressed end to end, so only loose text outside every block can be unparsed; 0.98
 * leaves room for a stray label without hiding a real regression.
 */
const MIN_COVERAGE = 0.98;
/**
 * Maximum share of the panel's visible text left to other_sections. Typed fields should
 * cover nearly all of the panel; a jump means a block moved out from under a selector.
 */
const MAX_PANEL_LEFTOVER = 0.1;

describe.skipIf(corpus === undefined)("offers corpus", () => {
  it("has at least one case", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    describe(name, () => {
      const capture = loadFixture(join(base, name));
      const result = parseOffers(capture);
      const d = result.data;
      const all: Offer[] = d.pinned_offer === null ? d.offers : [d.pinned_offer, ...d.offers];

      it("finds offers with the fields an add needs", () => {
        expect(all.length).toBeGreaterThan(0);
        for (const o of all) {
          expect(o.price, `offer ${o.index} price`).not.toBeNull();
          expect(o.condition, `offer ${o.index} condition`).not.toBeNull();
          expect(o.seller.name, `offer ${o.index} seller`).toBeTruthy();
          expect(o.prime, `offer ${o.index} prime`).not.toBeNull();
          expect(o.shipping, `offer ${o.index} shipping`).toBeDefined();
          expect(o.delivery?.options.length ?? 0, `offer ${o.index} delivery`).toBeGreaterThan(0);
          expect(o.internal.asin ?? "").toMatch(/^[A-Z0-9]{10}$/);
          expect((o.internal.offer_listing_id ?? "").length).toBeGreaterThan(20);
          expect(o.internal.condition).toBe(o.condition);
          expect(o.out_of_stock).toBe(false);
        }
        if (d.total_offer_count !== undefined) {
          expect(d.offers.length).toBeLessThanOrEqual(d.total_offer_count);
        }
        expect(d.pagination.has_more).toBe(
          d.total_offer_count !== undefined && d.total_offer_count > d.offers.length,
        );
      });

      it("emits only known flags, static ones from the parser", () => {
        for (const o of all) {
          for (const f of o.flags) expect(OFFER_FLAGS).toContain(f);
          for (const f of REQUEST_TIME_FLAGS) expect(o.flags).not.toContain(f);
          const full = computeOfferFlags(o, offerFlagContext(d, o, { now: capture.captured_at }));
          for (const f of o.flags) expect(full).toContain(f);
        }
      });

      it("reads the product page parts", () => {
        expect(d.purchase_types.length).toBeGreaterThan(0);
        expect(d.purchase_types.filter((p) => p.default)).toHaveLength(1);
        expect(d.buybox.state).not.toBe("unknown");
        expect(d.product.title).toBeTruthy();
      });

      it("never leaks tokens outside internal", () => {
        const json = JSON.stringify(result);
        const aod = capture.fragments?.["aod"] ?? "";
        for (const m of aod.matchAll(/name="anti-csrftoken-a2z" value="([^"]+)"/g)) {
          expect(json.includes(m[1] as string)).toBe(false);
        }
        for (const m of capture.html.matchAll(/name="anti-csrftoken-a2z" value="([^"]+)"/g)) {
          expect(json.includes(m[1] as string)).toBe(false);
        }
        const stripped = JSON.parse(json) as {
          data: { pinned_offer: { internal?: unknown } | null; offers: { internal?: unknown }[] };
        };
        if (stripped.data.pinned_offer !== null) delete stripped.data.pinned_offer.internal;
        for (const o of stripped.data.offers) delete o.internal;
        const outside = JSON.stringify(stripped);
        for (const o of all) {
          expect(outside.includes(o.internal.offer_listing_id as string)).toBe(false);
        }
      });

      it("accounts for the visible text", () => {
        const parsed = parseCapture(capture);
        const aodDoc = parsed.fragments["aod"];
        let total = 0;
        if (aodDoc !== undefined) {
          normalizeAodVisibility(aodDoc);
          const root = q(aodDoc, "#aod-container");
          if (root !== undefined) total += visibleTextChars(aodDoc, { root });
        }
        const panelTotal = total;
        const buybox = q(parsed.doc, "#desktop_buybox") ?? q(parsed.doc, "#buybox");
        if (buybox !== undefined) total += visibleTextChars(parsed.doc, { root: buybox });
        expect(total).toBeGreaterThan(0);
        const coverage = 1 - result.meta.unparsed_text_chars / total;
        expect(coverage).toBeGreaterThanOrEqual(MIN_COVERAGE);
        const panelLeft = result.other_sections
          .filter((s) => s.key.startsWith("aod:"))
          .reduce((n, s) => n + s.text.length, 0);
        expect(panelLeft / Math.max(1, panelTotal)).toBeLessThanOrEqual(MAX_PANEL_LEFTOVER);
        const keys = new Set(result.other_sections.map((s) => s.key));
        expect(keys.size).toBe(result.other_sections.length);
      });

      it("stays compact", () => {
        expect(JSON.stringify(result).length).toBeLessThan(200_000);
        expect(result.meta.warnings.length).toBeLessThan(5);
      });
    });
  }
});
