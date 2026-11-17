/**
 * Dev-only: runs the reviews parsers over every capture under $RAINFOREST_CORPUS (reviews/* for
 * parseReviews, product/* for parseReviewSummary). Skipped when the variable is unset. Asserts
 * structural invariants only, never real values, and never prints page content: every assertion
 * is a boolean with the case name as its label.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import {
  type Review,
  parseReviewSummary,
  parseReviews,
  reviewSummaryRoot,
  reviewsMainRoot,
} from "../../src/pages/reviews.ts";
import { parseDocument, visibleTextChars } from "../../src/index.ts";
import { loadFixture } from "../../src/testing.ts";

const corpus = process.env.RAINFOREST_CORPUS;

function cases(kind: string): { name: string; capture: Capture }[] {
  if (corpus === undefined) return [];
  const base = join(corpus, kind);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .filter((name) => existsSync(join(base, name, "capture.json")))
    .map((name) => ({ name: `${kind}/${name}`, capture: loadFixture(join(base, name)) }));
}

/**
 * Accounting of the main root. `coverage` is 1 - unparsed/total; consumed text counts as covered,
 * so it can only fail when text sits outside every block. `emittedShare` is the more telling
 * number: the share of the root's text that lands in other_sections instead of typed fields.
 */
function accounting(
  capture: Capture,
  unparsed: number,
  sectionChars: number,
  rootOf: (d: ReturnType<typeof parseDocument>) => ReturnType<typeof reviewsMainRoot> | undefined,
): { total: number; coverage: number; emittedShare: number } {
  const doc = parseDocument(capture.html);
  const root = rootOf(doc);
  const total = root === undefined ? 0 : visibleTextChars(doc, { root });
  return {
    total,
    coverage: total === 0 ? 1 : 1 - unparsed / total,
    emittedShare: total === 0 ? 0 : sectionChars / total,
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function checkReview(label: string, r: Review): void {
  const where = `${label} ${r.review_id ?? "?"}`.replace(/[A-Z0-9]{8,}/, "<id>");
  expect(/^R[A-Z0-9]{6,}$/.test(r.review_id ?? ""), `${where}: id`).toBe(true);
  expect(r.rating !== null && r.rating >= 1 && r.rating <= 5, `${where}: rating`).toBe(true);
  expect((r.title ?? "") !== "" || r.body !== "", `${where}: has text`).toBe(true);
  expect(r.date?.iso != null && /^\d{4}-\d{2}-\d{2}$/.test(r.date.iso), `${where}: iso date`).toBe(
    true,
  );
  expect((r.country ?? "") !== "", `${where}: country`).toBe(true);
  expect((r.author?.name ?? "") !== "", `${where}: author`).toBe(true);
  expect(Number.isInteger(r.helpful_votes) && r.helpful_votes >= 0, `${where}: votes`).toBe(true);
  expect(r.body === r.body.trim(), `${where}: body trimmed`).toBe(true);
  expect(!/(\.\.\.|\u2026)\s*Read more$/i.test(r.body), `${where}: body not clamped`).toBe(true);
  expect(!/^Reviewed in /i.test(r.title ?? ""), `${where}: title is not the date line`).toBe(true);
}

describe.skipIf(corpus === undefined)("reviews corpus", () => {
  const pages = cases("reviews");

  it("has captures", () => {
    expect(pages.length > 0, "reviews captures present").toBe(true);
  });

  for (const { name, capture } of pages) {
    describe(name, () => {
      const result = parseReviews(capture);
      const d = result.data;
      const url = new URL(capture.final_url);

      it("parses cards with the required fields", () => {
        expect(d.reviews.length > 0, `${name}: reviews`).toBe(true);
        expect(d.is_empty, `${name}: is_empty`).toBe(false);
        for (const r of d.reviews) checkReview(name, r);
        const ids = d.reviews.map((r) => r.review_id);
        expect(new Set(ids).size === ids.length, `${name}: unique ids`).toBe(true);
      });

      it("reads the page level data", () => {
        expect(/^[A-Z0-9]{10}$/.test(d.asin ?? ""), `${name}: asin`).toBe(true);
        expect((d.product.title ?? "") !== "", `${name}: product title`).toBe(true);
        expect(d.rating !== null && d.rating >= 1 && d.rating <= 5, `${name}: rating`).toBe(true);
        expect((d.rating_count ?? 0) > 0, `${name}: rating_count`).toBe(true);
        expect(
          (d.review_count ?? d.matching_count ?? 0) > 0,
          `${name}: a review or matching count`,
        ).toBe(true);
        expect(Object.keys(d.histogram).length === 5, `${name}: histogram rows`).toBe(true);
        const pct = sum(Object.values(d.histogram));
        expect(pct >= 95 && pct <= 105, `${name}: histogram sums to about 100`).toBe(true);
      });

      it("echoes the filters the capture URL asked for", () => {
        for (const param of [
          "sortBy",
          "filterByStar",
          "reviewerType",
          "formatType",
          "mediaType",
        ] as const) {
          const asked = url.searchParams.get(param);
          if (asked !== null) {
            expect(d.filters[param]?.value === asked, `${name}: ${param} echoed`).toBe(true);
          }
        }
        if (url.searchParams.get("filterByStar") === "critical") {
          expect(
            d.reviews.every((r) => (r.rating ?? 5) <= 3),
            `${name}: critical filter shows only 1-3 stars`,
          ).toBe(true);
          expect(d.filter_banner !== null, `${name}: filter banner`).toBe(true);
        }
        const sort = d.filter_options.find((f) => f.param === "sortBy");
        const star = d.filter_options.find((f) => f.param === "filterByStar");
        expect((sort?.choices.length ?? 0) >= 2, `${name}: sort choices`).toBe(true);
        expect((star?.choices.length ?? 0) >= 6, `${name}: star choices`).toBe(true);
        expect(
          d.filter_options.every((f) => f.choices.every((c) => c.value !== "" && c.label !== "")),
          `${name}: choices have label and value`,
        ).toBe(true);
      });

      it("reads pagination consistently", () => {
        const p = d.pagination;
        expect(p.page >= 1, `${name}: page`).toBe(true);
        if (p.has_next) {
          expect(p.next_url !== null, `${name}: next_url`).toBe(true);
          expect(p.next_page_number === p.page + 1, `${name}: next number`).toBe(true);
          if (p.mechanism === "show_more") {
            expect((p.next_page_token ?? "") !== "", `${name}: next token`).toBe(true);
          }
        }
      });

      it("accounts for the main content", () => {
        const sectionChars = sum(result.other_sections.map((s) => s.text.length));
        const acc = accounting(
          capture,
          result.meta.unparsed_text_chars,
          sectionChars,
          reviewsMainRoot,
        );
        expect(acc.total > 1000, `${name}: root has text`).toBe(true);
        expect(acc.coverage >= 0.98, `${name}: coverage ${acc.coverage.toFixed(3)} >= 0.98`).toBe(
          true,
        );
        expect(
          acc.emittedShare <= 0.1,
          `${name}: other_sections share ${acc.emittedShare.toFixed(3)} <= 0.10`,
        ).toBe(true);
      });

      it("never leaks tokens or ids from the page state", () => {
        const json = JSON.stringify(result);
        expect(!/csrf/i.test(json), `${name}: no csrf`).toBe(true);
        expect(!json.includes("customerId"), `${name}: no customerId`).toBe(true);
      });
    });
  }
});

describe.skipIf(corpus === undefined)("product review summary corpus", () => {
  const pages = cases("product");

  it("has captures", () => {
    expect(pages.length > 0, "product captures present").toBe(true);
  });

  for (const { name, capture } of pages) {
    describe(name, () => {
      const result = parseReviewSummary(capture);
      const d = result.data;

      it("reads rating, count and histogram", () => {
        expect(/^[A-Z0-9]{10}$/.test(d.asin ?? ""), `${name}: asin`).toBe(true);
        expect(d.rating !== null && d.rating >= 1 && d.rating <= 5, `${name}: rating`).toBe(true);
        expect((d.rating_count ?? 0) > 0, `${name}: rating_count`).toBe(true);
        expect(Object.keys(d.histogram).length === 5, `${name}: histogram rows`).toBe(true);
        const pct = sum(Object.values(d.histogram));
        expect(pct >= 95 && pct <= 105, `${name}: histogram sums to about 100`).toBe(true);
      });

      it("reads the AI summary and aspect chips when present", () => {
        expect((d.customers_say?.text ?? "") !== "", `${name}: customers say`).toBe(true);
        expect(d.customers_say?.ai_generated === true, `${name}: ai flag`).toBe(true);
        expect(d.aspects.length > 0, `${name}: aspects`).toBe(true);
        for (const a of d.aspects) {
          expect(
            a.label !== "" && a.sentiment !== null,
            `${name}: aspect label and sentiment`,
          ).toBe(true);
          expect((a.mentions ?? 0) > 0, `${name}: aspect mentions`).toBe(true);
        }
      });

      it("reads the embedded review cards", () => {
        expect(d.featured_reviews.length > 0, `${name}: featured reviews`).toBe(true);
        for (const r of [...d.featured_reviews, ...d.other_country_reviews]) checkReview(name, r);
        expect(
          [...d.featured_reviews, ...d.other_country_reviews].every((r) => r.body !== ""),
          `${name}: bodies present`,
        ).toBe(true);
        expect(
          (d.see_all_reviews_path ?? "").includes(d.asin ?? "?"),
          `${name}: see-all path`,
        ).toBe(true);
      });

      it("accounts for the reviews section", () => {
        const sectionChars = sum(result.other_sections.map((s) => s.text.length));
        const acc = accounting(
          capture,
          result.meta.unparsed_text_chars,
          sectionChars,
          reviewSummaryRoot,
        );
        expect(acc.total > 1000, `${name}: root has text`).toBe(true);
        expect(acc.coverage >= 0.98, `${name}: coverage ${acc.coverage.toFixed(3)} >= 0.98`).toBe(
          true,
        );
        expect(
          acc.emittedShare <= 0.05,
          `${name}: other_sections share ${acc.emittedShare.toFixed(3)} <= 0.05`,
        ).toBe(true);
        expect(!/csrf/i.test(JSON.stringify(result)), `${name}: no csrf`).toBe(true);
      });
    });
  }
});
