import { describe, expect, it } from "vitest";
import { STRATEGY_NAMES, firstOf, isMiss, newMeta, parseDocument, q, text } from "../src/index.ts";

describe("firstOf", () => {
  it("lists the conventional strategy names", () => {
    expect([...STRATEGY_NAMES]).toEqual(["id", "data-attr", "label", "text-anchor", "blob"]);
  });

  it("returns the first hit and records the strategy", () => {
    const meta = newMeta();
    const calls: string[] = [];
    const value = firstOf(
      "title",
      [
        ["id", () => (calls.push("id"), undefined)],
        ["data-attr", () => (calls.push("data-attr"), "Fake title")],
        ["label", () => (calls.push("label"), "never")],
      ],
      meta,
    );
    expect(value).toBe("Fake title");
    expect(meta.strategies).toEqual({ title: "data-attr" });
    expect(calls).toEqual(["id", "data-attr"]);
    expect(meta.warnings).toEqual([]);
  });

  it("falls through misses: null, blank, NaN, empty array", () => {
    const meta = newMeta();
    const v = firstOf<unknown>(
      "f",
      [
        ["a", () => null],
        ["b", () => "  "],
        ["c", () => Number.NaN],
        ["d", () => []],
        ["e", () => 0],
      ],
      meta,
    );
    expect(v).toBe(0);
    expect(meta.strategies.f).toBe("e");
  });

  it("turns a throw into a warning and keeps going", () => {
    const meta = newMeta();
    const v = firstOf(
      "price",
      [
        [
          "id",
          () => {
            throw new Error("boom");
          },
        ],
        [
          "label",
          () => {
            throw "plain";
          },
        ],
        ["text-anchor", () => 5],
      ],
      meta,
    );
    expect(v).toBe(5);
    expect(meta.warnings).toEqual([
      'price: strategy "id" threw: boom',
      'price: strategy "label" threw: plain',
    ]);
  });

  it("warns when nothing hits, unless optional", () => {
    const meta = newMeta();
    expect(firstOf("rating", [["id", () => undefined]], meta)).toBeUndefined();
    expect(firstOf("coupon", [["id", () => undefined]], meta, { optional: true })).toBeUndefined();
    expect(firstOf("empty", [], meta)).toBeUndefined();
    expect(meta.warnings).toEqual([
      "rating: no strategy matched (tried id)",
      "empty: no strategy matched (tried none)",
    ]);
    expect(meta.strategies).toEqual({});
  });

  it("works against a document", () => {
    const doc = parseDocument(
      "<div data-rf-hidden='1'><span id=productTitle>Hidden title</span></div><h1 data-title='x'>Visible fake title</h1>",
    );
    const meta = newMeta();
    const title = firstOf(
      "title",
      [
        ["id", () => text(q(doc, "#productTitle"))],
        ["data-attr", () => text(q(doc, "h1[data-title]"))],
      ],
      meta,
    );
    expect(title).toBe("Visible fake title");
    expect(meta.strategies.title).toBe("data-attr");
  });

  it("isMiss treats objects and false as hits", () => {
    expect(isMiss({})).toBe(false);
    expect(isMiss(false)).toBe(false);
    expect(isMiss(undefined)).toBe(true);
  });
});
