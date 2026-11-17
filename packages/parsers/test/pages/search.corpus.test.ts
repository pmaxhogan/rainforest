/**
 * Dev-only sanity run over real captures (RAINFOREST_CORPUS, outside the repo). Asserts
 * invariants only and prints counts only: no page content, no expected real values.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument, type DomElement } from "../../src/index.ts";
import { expectLosslessCoverage, loadFixture } from "../../src/testing.ts";
import { SPONSORED_SIGNALS, parseSearch } from "../../src/pages/search.ts";

const CORPUS = process.env.RAINFOREST_CORPUS;
const dir = CORPUS === undefined ? "" : join(CORPUS, "search");
const cases =
  CORPUS !== undefined && existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .filter((c) => existsSync(join(dir, c, "capture.json")))
    : [];

/**
 * Coverage floor. The parser consumes every block it reads and keeps unclassified lines as
 * per-item `notes`, so near-total coverage is expected; 0.95 leaves room for small markup
 * drift while still failing when a whole block (a shelf, the rail, a card section) is dropped.
 */
const MIN_COVERAGE = 0.95;

const ASIN = /^[A-Z0-9]{10}$/;

/**
 * Independent label counter for the cross-check: written against the raw DOM here, not with
 * the parser's helpers. A card counts once when it contains a disclosure label element: own
 * text "Sponsored", or an element whose class names a sponsored label (the "Featured from
 * Amazon brands" placements carry the class but not the word).
 */
function ownText(el: DomElement): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent ?? "";
  return s.replace(/\s+/g, " ").trim();
}

function labelKind(card: DomElement): "sponsored" | "featured" | undefined {
  const all = Array.from(card.querySelectorAll("*"));
  if (all.some((e) => /^Sponsored$/i.test(ownText(e)))) return "sponsored";
  if (
    all.some(
      (e) =>
        /(^|\s)puis-sponsored-label-text(\s|$)/.test(e.getAttribute("class") ?? "") ||
        /^Featured from Amazon brands$/i.test(ownText(e)),
    )
  ) {
    return "featured";
  }
  return undefined;
}

function isHidden(el: DomElement, stop: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null && cur !== stop; cur = cur.parentElement) {
    if (cur.getAttribute("data-rf-hidden") === "1") return true;
  }
  return false;
}

describe.skipIf(CORPUS === undefined)("search parser over the private corpus", () => {
  it("has captures to check", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    it(`parses capture ${cases.indexOf(name) + 1}`, () => {
      const capture = loadFixture(join(dir, name));
      const result = parseSearch(capture);
      const { data } = result;

      // Results: present, identified, titled, canonical links, positions 1..n over visible cards.
      expect(data.results.length).toBeGreaterThan(0);
      for (const r of data.results) {
        expect(r.asin).toMatch(ASIN);
        expect(r.title ?? "").not.toBe("");
        expect(r.url_path).toBe(`/dp/${r.asin}`);
        expect(r.is_sponsored).toBe(r.sponsored_signals.length > 0);
        expect(r.hidden_in_browser ? r.position === null : typeof r.position === "number").toBe(
          true,
        );
        // A hidden card is only ever reported because it is sponsored.
        if (r.hidden_in_browser) expect(r.is_sponsored).toBe(true);
        for (const s of r.sponsored_signals) expect(SPONSORED_SIGNALS).toContain(s);
      }
      const positions = data.results.flatMap((r) => (r.position === null ? [] : [r.position]));
      expect(positions).toEqual(positions.map((_, i) => i + 1));
      expect(data.query ?? "").not.toBe("");
      expect(data.refinements.length).toBeGreaterThan(0);
      expect(data.sort_options.length).toBeGreaterThan(0);
      expect(data.pagination).toBeDefined();
      for (const w of data.widgets) {
        expect(w.is_sponsored).toBe(w.sponsored_signals.length > 0);
        if (w.hidden_in_browser) expect(w.is_sponsored).toBe(true);
      }

      // Tokens are relative same-site /s URLs within the tool's 512-char input cap.
      const tokens = [
        ...data.refinements.flatMap((g) => g.options.map((o) => o.token)),
        ...data.sort_options.map((o) => o.token),
        data.pagination?.next_token,
        data.pagination?.prev_token,
        ...data.widgets.flatMap((w) => w.links.map((l) => l.token)),
      ].filter((t): t is string => typeof t === "string");
      for (const t of tokens) {
        expect(t).toMatch(/^\/s(\/|\?|$)/);
        expect(t.length).toBeLessThanOrEqual(512);
      }

      // Sponsored cross-check against an independent count of label elements in result cards.
      const doc = parseDocument(capture.html);
      const slot = doc.querySelector(".s-main-slot") as DomElement;
      const cards = Array.from(slot.children).filter(
        (c) => c.getAttribute("data-component-type") === "s-search-result",
      );
      let sponsoredLabels = 0;
      let featuredLabels = 0;
      let visibleLabels = 0;
      for (const c of cards) {
        const k = labelKind(c);
        if (k === "sponsored") sponsoredLabels++;
        if (k === "featured") featuredLabels++;
        if (k !== undefined && !isHidden(c, slot)) visibleLabels++;
      }
      const flagged = data.results.filter((r) => r.is_sponsored);
      const flaggedVisible = flagged.filter((r) => !r.hidden_in_browser);
      expect(flagged.length).toBe(sponsoredLabels + featuredLabels);
      expect(flaggedVisible.length).toBe(visibleLabels);
      const fragile = flagged.filter((r) => r.sponsored_signals.length === 1).length;

      // Same cross-check for widgets: non-card children of the results list that hold a label,
      // visible or hidden, must each come back as one sponsored widget.
      const shelves = Array.from(slot.children).filter(
        (c) =>
          c.getAttribute("data-component-type") !== "s-search-result" &&
          !["script", "style", "link", "noscript"].includes(c.localName),
      );
      const labelShelves = shelves.filter((c) => labelKind(c) !== undefined).length;
      const sponsoredWidgets = data.widgets.filter((w) => w.is_sponsored);
      expect(sponsoredWidgets.length).toBe(labelShelves);
      const fragileWidgets = sponsoredWidgets.filter(
        (w) => w.sponsored_signals.length === 1,
      ).length;

      // False-positive watch for text-anchor strategies that the corpus never exercises.
      const selected = data.refinements.flatMap((g) => g.options).filter((o) => o.selected).length;

      const ratio = expectLosslessCoverage(result, capture, MIN_COVERAGE, {
        root: doc.querySelector("#search") ?? undefined,
      });
      const notes = data.results.reduce((n, r) => n + (r.notes?.length ?? 0), 0);
      // Counts only, never content.
      console.log(
        `[search corpus ${cases.indexOf(name) + 1}] results=${data.results.length} ` +
          `flagged_sponsored=${flagged.length} (visible ${flaggedVisible.length}) ` +
          `label_cards=${sponsoredLabels}+${featuredLabels}featured (visible ${visibleLabels}) ` +
          `single_signal=${fragile} multi_signal=${flagged.length - fragile} ` +
          `widgets=${data.widgets.length} (sponsored ${sponsoredWidgets.length}, label_shelves ${labelShelves}, single_signal ${fragileWidgets}) ` +
          `selected_options=${selected} applied_filters=${data.applied_filters.length} ` +
          `corrections=${data.corrections.length} department=${data.department === undefined ? "no" : "yes"} ` +
          `refinement_groups=${data.refinements.length} max_token=${Math.max(0, ...tokens.map((t) => t.length))} ` +
          `notes=${notes} other_sections=${result.other_sections.length} coverage=${ratio.toFixed(3)} ` +
          `warnings=${result.meta.warnings.length}`,
      );
    });
  }
});
