/**
 * Dev-only: runs the lists parsers over every capture of the private corpus and asserts
 * sanity invariants. Skipped unless RAINFOREST_CORPUS points at the corpus root
 * (`<root>/<kind>/<case>/{capture.json,page.html}`). No expected value is embedded here and
 * nothing from a page is ever printed: failures name only the case and the invariant.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument, q, visibleTextChars } from "../../src/index.ts";
import { parseList, parseListsIndex } from "../../src/pages/lists.ts";
import { expectLosslessCoverage, loadFixture } from "../../src/testing.ts";

const CORPUS = process.env["RAINFOREST_CORPUS"];
const LIST_ID = /^[A-Z0-9]{8,16}$/;
const ASIN = /^[A-Z0-9]{10}$/;

function cases(kind: string): string[] {
  if (CORPUS === undefined) return [];
  const base = join(CORPUS, kind);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .map((name) => join(base, name))
    .filter(
      (dir) =>
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "capture.json")) &&
        existsSync(join(dir, "page.html")),
    );
}

/** Share of the main content (#wishlist-page) the parser neither typed nor emitted. */
function unparsedShare(html: string, unparsed: number): number {
  const doc = parseDocument(html);
  const root = q(doc, "#wishlist-page");
  const total = visibleTextChars(doc, root === undefined ? {} : { root });
  return total === 0 ? 0 : unparsed / total;
}

describe.skipIf(!process.env["RAINFOREST_CORPUS"])("lists parsers over the corpus", () => {
  const indexCases = cases("lists_index");
  const listCases = cases("list");

  it("finds captures to run", () => {
    expect(indexCases.length + listCases.length).toBeGreaterThan(0);
  });

  describe.each(indexCases.map((dir) => [dir.split("/").slice(-2).join("/"), dir] as const))(
    "lists_index %s",
    (_name, dir) => {
      it("parses the navigation or the intro page", () => {
        const capture = loadFixture(dir);
        const result = parseListsIndex(capture);
        const d = result.data;
        expect(["lists", "intro"]).toContain(d.variant);
        if (d.variant === "lists") {
          expect(d.lists.length).toBeGreaterThan(0);
          const ids = new Set<string>();
          for (const l of d.lists) {
            expect(l.list_id).toMatch(LIST_ID);
            expect(l.name).not.toBe("");
            expect(["private", "shared", "public"]).toContain(l.privacy);
            expect(["wish_list", "shopping_list", "idea_list", "registry"]).toContain(l.list_kind);
            ids.add(l.list_id);
          }
          expect(ids.size).toBe(d.lists.length);
          expect(d.lists.filter((l) => l.is_default).length).toBeLessThanOrEqual(1);
          expect(d.lists.filter((l) => l.selected).length).toBeLessThanOrEqual(1);
          if (d.selected_list_id !== undefined) expect(ids.has(d.selected_list_id)).toBe(true);
        } else {
          expect(d.lists).toEqual([]);
          expect(result.meta.warnings.length).toBeGreaterThan(0);
        }
        expect(d.tabs.length).toBeGreaterThan(0);
        if (d.selected_list !== undefined) assertListPage(d.selected_list);
        expect(() => JSON.stringify(result)).not.toThrow();
        // Everything visible in the main content is typed or emitted; allow a sliver of slack.
        expect(unparsedShare(capture.html, result.meta.unparsed_text_chars)).toBeLessThan(0.02);
        expectLosslessCoverage(result, capture, 0.9);
      });
    },
  );

  describe.each(listCases.map((dir) => [dir.split("/").slice(-2).join("/"), dir] as const))(
    "list %s",
    (_name, dir) => {
      it("parses header, controls and items", () => {
        const capture = loadFixture(dir);
        const result = parseList(capture);
        assertListPage(result.data);
        expect(result.data.list.list_id).toMatch(LIST_ID);
        expect(result.data.list.name).toBeTruthy();
        expect(result.data.items.length).toBeGreaterThan(0);
        expect(result.meta.warnings.filter((w) => w.startsWith("item."))).toEqual([]);
        expect(() => JSON.stringify(result)).not.toThrow();
        expect(unparsedShare(capture.html, result.meta.unparsed_text_chars)).toBeLessThan(0.02);
        expectLosslessCoverage(result, capture, 0.9);
      });
    },
  );
});

function assertListPage(page: ReturnType<typeof parseList>["data"]): void {
  const ids = new Set<string>();
  page.items.forEach((item, index) => {
    expect(item.item_id).toBeTruthy();
    expect(item.title).toBeTruthy();
    expect(item.position).toBe(index + 1);
    if (item.asin !== undefined) expect(item.asin).toMatch(ASIN);
    if (item.price !== undefined) {
      expect(Number.isFinite(item.price.amount)).toBe(true);
      expect(item.price.currency).toBe("USD");
    }
    if (item.price_hint !== undefined) expect(Number.isFinite(item.price_hint)).toBe(true);
    if (item.added !== undefined) expect(item.added.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (item.rating !== undefined)
      expect(item.rating.value).toBeLessThanOrEqual(item.rating.out_of);
    expect(item.actions.length).toBeGreaterThan(0);
    ids.add(item.item_id);
  });
  expect(ids.size).toBe(page.items.length);
  expect(page.is_empty).toBe(page.items.length === 0 && !page.pagination.has_more);
  if (!page.pagination.has_more && page.pagination.items_rendered !== undefined) {
    expect(page.pagination.items_rendered).toBe(page.items.length);
  }
  if (page.filter !== undefined) expect(page.filter.options.length).toBeGreaterThan(0);
  if (page.sort !== undefined) expect(page.sort.options.length).toBeGreaterThan(0);
}
