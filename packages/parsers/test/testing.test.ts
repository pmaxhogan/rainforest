import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Capture, ParseResult } from "@rainforest/core";
import { FAKE } from "@rainforest/core";
import {
  Consumption,
  PARSERS,
  losslessReport,
  newMeta,
  parseDocument,
  qa,
  text,
} from "../src/index.ts";
import {
  DEFAULT_FIXTURES_ROOT,
  expectLosslessCoverage,
  listFixtureCases,
  loadExpected,
  loadFixture,
} from "../src/testing.ts";

const ROOT = resolve(import.meta.dirname, "fixtures");

/** A toy parser in the shape real per-page parsers will take. */
function toySearch(capture: Capture): ParseResult<{ titles: string[] }> {
  const doc = parseDocument(capture.html);
  const consumed = new Consumption();
  const titles = qa(doc, "[data-component-type=s-search-result]").map((el) =>
    text(consumed.take(el).querySelector("h2")),
  );
  const meta = newMeta();
  const report = losslessReport(doc, consumed);
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data: { titles }, other_sections: report.sections, meta };
}

describe("fixture loading", () => {
  it("lists cases sorted and skips directories without capture.json", () => {
    const cases = listFixtureCases("search", ROOT);
    expect(cases.map((c) => c.slice(ROOT.length + 1))).toEqual([
      join("search", "case-a"),
      join("search", "case-b"),
    ]);
    expect(listFixtureCases("cart", ROOT)).toEqual([]);
    expect(DEFAULT_FIXTURES_ROOT.endsWith("fixtures")).toBe(true);
    expect(Array.isArray(listFixtureCases("search"))).toBe(true);
  });

  it("loads a case with fragments and expected output", () => {
    const dir = join(ROOT, "search", "case-a");
    const capture = loadFixture(dir);
    expect(capture.kind).toBe("search");
    expect(capture.final_url.startsWith(FAKE.host)).toBe(true);
    expect(capture.html).toContain("B0FAKE0001");
    expect(capture.fragments).toEqual({ more: '<div id="more">Invented extra results</div>\n' });
    expect(loadExpected(dir)?.data).toEqual({ count: 2 });
    const plain = loadFixture(join(ROOT, "search", "case-b"));
    expect(plain.fragments).toBeUndefined();
    expect(loadExpected(join(ROOT, "search", "case-b"))).toBeUndefined();
  });

  describe("malformed cases", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rf-parsers-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const write = (name: string, manifest: unknown): string => {
      const dir = join(tmp, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "capture.json"), JSON.stringify(manifest));
      writeFileSync(join(dir, "page.html"), "<p>x</p>");
      return dir;
    };
    const base = {
      kind: "product",
      url: `${FAKE.host}/dp/B0FAKE0001`,
      final_url: `${FAKE.host}/dp/B0FAKE0001`,
      captured_at: "2000-01-01T00:00:00.000Z",
    };

    it("rejects an unknown kind, a missing field and an unsafe fragment name", () => {
      expect(() => loadFixture(write("kind", { ...base, kind: "nope" }))).toThrow(/unknown kind/);
      expect(() => loadFixture(write("url", { ...base, url: undefined }))).toThrow(/missing url/);
      expect(() =>
        loadFixture(write("frag", { ...base, fragments: { aod: "../escape.html" } })),
      ).toThrow(/bad fragment file name/);
    });
  });
});

describe("expectLosslessCoverage", () => {
  const capture = loadFixture(join(ROOT, "search", "case-a"));

  it("passes for a parser that accounts for everything", () => {
    const result = toySearch(capture);
    expect(result.data.titles).toEqual(["Invented Widget One", "Invented Widget Two"]);
    expect(result.other_sections.map((s) => s.key)).toEqual(["footer-note"]);
    expect(expectLosslessCoverage(result, capture, 1)).toBe(1);
  });

  it("fails below the ratio and on inconsistent results", () => {
    const result = toySearch(capture);
    const lossy = { ...result, meta: { ...result.meta, unparsed_text_chars: 20 } };
    expect(() => expectLosslessCoverage(lossy, capture, 0.9)).toThrow(/below 0.9/);
    expect(expectLosslessCoverage(lossy, capture, 0.1)).toBeLessThan(1);
    const negative = { ...result, meta: { ...result.meta, unparsed_text_chars: -1 } };
    expect(() => expectLosslessCoverage(negative, capture, 0)).toThrow(/not within/);
    const empty = { ...result, other_sections: [{ key: "x", heading: null, text: " " }] };
    expect(() => expectLosslessCoverage(empty, capture, 0)).toThrow(/empty text/);
    const dup = {
      ...result,
      other_sections: [
        { key: "x", heading: null, text: "a" },
        { key: "x", heading: null, text: "b" },
      ],
    };
    expect(() => expectLosslessCoverage(dup, capture, 0)).toThrow(/duplicated/);
  });

  it("treats an empty page as fully covered", () => {
    const blank: Capture = { ...capture, html: "" };
    expect(expectLosslessCoverage({ ...toySearch(blank) }, blank, 1)).toBe(1);
  });
});

describe("registry", () => {
  it("starts empty", () => {
    expect(PARSERS).toEqual({});
  });
});
