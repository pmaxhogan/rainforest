import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { auditScrubbed, scrubCapture, writeFixtureCase } from "../src/index.ts";
import { AOD_HTML, PAGE_HTML, sampleCapture } from "./samples.ts";

function scrub(html: string): string {
  return scrubCapture({
    kind: "search",
    url: "https://shop.invalid/",
    final_url: "https://shop.invalid/",
    captured_at: "2025-01-08T15:30:00.000Z",
    html,
  }).capture.html;
}

/** Scrub one text node and return its scrubbed text. */
function text(s: string): string {
  const out = scrub(`<p>${s}</p>`);
  return out
    .replace(/^<p>|<\/p>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const MONTH =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const WD = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const WDA = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";

describe("date formats keep their style", () => {
  const cases: [string, RegExp][] = [
    ["January 5, 2025", new RegExp(`^${MONTH} \\d{1,2}, \\d{4}$`)],
    ["Jan. 5, 2025", new RegExp(`^${MON}\\. \\d{1,2}, \\d{4}$`)],
    ["January 5th", new RegExp(`^${MONTH} \\d{1,2}(st|nd|rd|th)$`)],
    ["Mon, Jan 5", new RegExp(`^${WDA}, ${MON} \\d{1,2}$`)],
    ["Monday, January 5, 2025", new RegExp(`^${WD}, ${MONTH} \\d{1,2}, \\d{4}$`)],
    ["5 January 2025", new RegExp(`^\\d{1,2} ${MONTH} \\d{4}$`)],
    ["Tue, 7 Jan", new RegExp(`^${WDA}, \\d{1,2} ${MON}$`)],
    ["January 2025", new RegExp(`^${MONTH} \\d{4}$`)],
    ["01/05/2025", /^\d{2}\/\d{2}\/\d{4}$/],
    ["1/5/25", /^\d{1,2}\/\d{1,2}\/\d{2}$/],
    ["2025-01-05", /^\d{4}-\d{2}-\d{2}$/],
    ["2025-01-05T10:00:00.123+05:30", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/],
    ["JANUARY 5", new RegExp(`^${MONTH.toUpperCase()} \\d{1,2}$`)],
  ];
  for (const [input, shape] of cases) {
    test(input, () => {
      const out = text(input);
      expect(out).toMatch(shape);
      expect(out).not.toBe(input);
    });
  }

  test("ranges", () => {
    expect(text("January 5 - 8")).toMatch(new RegExp(`^${MONTH} \\d{1,2} - (${MONTH} )?\\d{1,2}$`));
    expect(text("Jan 30 - Feb 2")).toMatch(new RegExp(`^${MON} \\d{1,2} - ${MON} \\d{1,2}$`));
  });

  test("standalone years, weekdays and months inside text shift too", () => {
    // Free words around a date are re-synthesized (count and lengths random).
    expect(text("Orders in 2024 only")).toMatch(
      /^[A-Za-z]+(?: [a-z]+)* (19|20)\d{2} [a-z]+(?: [a-z]+)*$/,
    );
    expect(text("Orders in 2024 only")).not.toContain("2024");
    expect(text("arrives Saturday or so")).toMatch(
      new RegExp(`^[A-Za-z]+(?: [a-z]+)* ${WD} [a-z]+(?: [a-z]+)*$`),
    );
    expect(text("sale ends March for real")).toMatch(
      new RegExp(`^[A-Za-z]+(?: [a-z]+)* ${MONTH} [a-z]+(?: [a-z]+)*$`),
    );
  });

  test("impossible dates fall through to digit synthesis", () => {
    expect(text("13/45/2025")).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(text("2025-13-40")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("times keep a valid shape", () => {
    expect(text("10:00:59")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(text("9:30 a.m.")).toMatch(/^\d{1,2}:\d{2} [ap]\.m\.$/);
    expect(text("4PM")).toMatch(/^\d{1,2}[AP]M$/);
  });

  test("whole-node weekday and month labels are kept", () => {
    expect(text("Tuesday")).toBe("Tuesday");
    expect(text("May")).toBe("May");
  });
});

describe("tokens and numbers", () => {
  test("ordinals, phones, ASIN keys and mixed tokens", () => {
    // An ordinal inside free text goes with it.
    expect(text("the 21st time")).toMatch(/^[A-Za-z]+(?: [a-z]+)*$/);
    expect(text("the 21st time")).not.toMatch(/\d/);
    expect(text("+1 999-555-1234")).toBe("+1 555-555-0100");
    expect(text("ASIN: 0123456789")).toBe("ASIN: B0FAKE0000");
    const mixed = text("Model Ab12cD34");
    // A one-word label before a free token is not a label lead: the node is free text, and
    // a mixed token keeps neither its length nor its shape.
    expect(mixed).toMatch(/^[A-Za-z]+(?: [a-z]+)*$/);
    expect(text("Model: Ab12cD34")).toMatch(/^Model: [A-Za-z]+(?: [a-z]+)*$/);
    expect(mixed).not.toContain("Ab12cD34");
  });

  test("non-ASCII letters and digits become ASCII", () => {
    const out = scrub("<p>\u00c9t\u00e9 \u0661\u0662\u0663</p>");
    expect(out).toMatch(/^<p>[A-Za-z]+ 000<\/p>$/);
  });

  test("URLs in text, protocol-relative and with trailing punctuation", () => {
    expect(text("see https://shop.invalid/dp/B0ABCD1234.")).toMatch(
      /^[A-Za-z]+(?: [a-z]+)* https:\/\/www\.example\.com\/dp\/B0FAKE0000\.$/,
    );
    expect(text("cdn //img.invalid/a/b.jpg here")).toMatch(
      /^[A-Za-z]+(?: [a-z]+)* https:\/\/images\.example\.com\/placeholder\.png [a-z]+(?: [a-z]+)*$/,
    );
  });

  test("an ISBN-shaped ASIN next to an inline asin key is mapped", () => {
    expect(text("the asin: 0123456789 here")).toMatch(
      /^[A-Za-z]+(?: [a-z]+)* asin: B0FAKE0000 [a-z]+(?: [a-z]+)*$/,
    );
  });

  test("lone digits are permuted (0 and 1 kept), amounts move in magnitude", () => {
    expect(text("Qty 3")).toMatch(/^Qty [2-9]$/);
    expect(text("Qty 1")).toBe("Qty 1");
    expect(text("$5")).toMatch(/^\$\d+$/);
    expect(text("Save 20%")).toMatch(/^Save \d{2}%$/);
  });
});

describe("urls", () => {
  function href(h: string, tag = "a", attr = "href"): string {
    const out = scrub(`<${tag} ${attr}="${h}">x</${tag}>`);
    return /="([^"]*)"/.exec(out)?.[1]?.replace(/&amp;/g, "&") ?? "";
  }
  test("schemes and relative forms", () => {
    expect(href("data:image/png;base64,AAAA")).toBe("https://images.example.com/placeholder.png");
    expect(href("data:text/html,x", "form", "action")).toBe(
      "https://images.example.com/placeholder.png",
    );
    expect(href("data:image/png;base64,AAAA", "img", "src")).toBe(
      "https://images.example.com/placeholder.png",
    );
    expect(href("vbscript:x")).toBe("#");
    expect(href("?k=zippy&tag=x")).toMatch(/^\?k=[A-Za-z]+(?:\+[a-z]+)*$/);
    expect(href("gp/your-orders")).toBe("gp/your-orders");
    expect(href("#customerReviews")).toBe("#customerReviews");
    expect(href("#a b")).toBe("#");
    expect(href("")).toBe("");
    expect(href("https://shop.invalid/your-orders/123-1234567-1234567")).toBe(
      "https://www.example.com/your-orders/000-0000000-0000001",
    );
    expect(href("/gp/product/0123456789?asin=0123456789")).toBe(
      "/gp/product/B0FAKE0000?asin=B0FAKE0000",
    );
    expect(href("https://[bad")).toBe("#");
    expect(href("https://[bad", "img", "src")).toBe("https://images.example.com/placeholder.png");
    expect(href("/x%E0%A4%A.html")).toMatch(/^\/[A-Za-z%0-9.-]+$/);
  });

  test("srcset tolerates empty entries and odd descriptors", () => {
    const out = scrub('<img srcset="a.jpg 1x, , b.jpg zz">');
    expect(out).toContain(
      'srcset="https://images.example.com/placeholder.png 1x, , https://images.example.com/placeholder.png"',
    );
  });
});

describe("json corner cases", () => {
  test("numbers, nested arrays, URL keys and non-identifier keys", () => {
    const out = scrub(
      '<div data-x=\'{"n":-1234,"big":1e30,"one":7,"asin":123456789,"zip":99999,' +
        '"https://img.invalid/a.jpg":[500,500],"Zed Placeholder":"x","imgs":["/a.jpg"],"key":"k-1"}\'>y</div>',
    );
    const json = JSON.parse(
      (/data-x="([^"]*)"/.exec(out)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
    ) as Record<string, unknown>;
    expect(String(json.n)).toMatch(/^-\d{4}$/);
    expect(json.n).not.toBe(-1234);
    expect(json.big).toBe(1e30);
    expect(json.one).toBe(7);
    expect(json.asin).toBe("B0FAKE0000");
    expect(json.zip).toMatch(/^0000[0-3]$/);
    expect(json.key).toBe("k-1");
    expect(json["https://images.example.com/placeholder.png"]).toBeDefined();
    expect(Object.keys(json).join(" ")).not.toContain("Zed");
    expect(json.imgs).toEqual(["https://images.example.com/placeholder.png"]);
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("booleans and nulls pass, script-breaking and non-ASCII text is escaped", () => {
    const out = scrub(
      '<script type="application/json">{"a":true,"b":null,"c":"$5 <\\/script><b>\\u00e9"}</script>',
    );
    expect(out).toContain('"a":true,"b":null');
    expect(out).not.toContain("</script><b>");
    expect(out).toContain("\\u003c");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("a broken JSON-looking attribute is scrubbed as text", () => {
    expect(scrub('<div data-x="{not json Zed}">y</div>')).not.toContain("Zed");
  });
});

describe("html corner cases", () => {
  test("meta without charset is dropped, attributes with odd names are dropped", () => {
    const out = scrub('<meta http-equiv="refresh" content="0"><p data-\u00e9="1">x</p>');
    expect(out).not.toContain("meta");
    expect(out).not.toContain("data-");
  });

  test("a-state blobs with a bad key or bad JSON are dropped", () => {
    const out = scrub(
      '<script type="a-state" data-a-state=\'{"key":"bad key!"}\'>{}</script>' +
        '<script type="application/json">{oops</script><p>x</p>',
    );
    expect(out).not.toContain("<script");
  });

  test("names in address blocks and name contexts", () => {
    const out = scrub(
      '<div class="shipping-address"><span class="a-profile-name">Zed Placeholder</span><span>Nowhere Falls</span><span>Shipping address</span></div>',
    );
    expect(out).toMatch(/<span class="a-profile-name">[A-Z][a-z]+(?: [A-Z][a-z]+)?<\/span>/);
    expect(out).toContain("<span>Exampleville</span>");
    expect(out).toContain("<span>Shipping address</span>");
  });

  test("Deliver to with an empty value part", () => {
    expect(text("Deliver to  -  Nowhere 99999")).toMatch(
      /^Deliver to\s+-\s+Exampleville 0000[0-3]$/,
    );
  });
});

describe("cli main and fixture writing in-process", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "rf-fmt-"));
    dirs.push(d);
    return d;
  }

  test("main writes the case and returns 0", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const raw = tmp();
    const { html: _h, fragments: _f, ...meta } = sampleCapture();
    writeFileSync(
      join(raw, "capture.json"),
      JSON.stringify({ ...meta, fragments: { aod: "aod.html" } }),
    );
    writeFileSync(join(raw, "page.html"), PAGE_HTML);
    writeFileSync(join(raw, "aod.html"), AOD_HTML);
    const dest = join(tmp(), "case");
    expect(main([raw, dest, "--seed", "s1", "--note", "basic"])).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dest, "capture.json"), "utf8")) as {
      note: string;
    };
    expect(manifest.note).toBe("basic");
  });

  test("main stops with status 4 on usage errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`status ${String(code)}`);
    });
    expect(() => main([])).toThrow("status 4");
    expect(() => main(["a", "b", "--bogus"])).toThrow("status 4");
    expect(() => main(["a", "b", "--seed"])).toThrow("status 4");
  });

  test("main refuses findings and same-dir output", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = tmp();
    writeFileSync(
      join(raw, "capture.json"),
      JSON.stringify({
        ...sampleCapture(),
        html: '<p id="ZZ 12345">x</p>',
        fragments: undefined,
      }),
    );
    const dest = join(tmp(), "case");
    expect(main([raw, dest])).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(main([raw, raw])).toBe(4);
    const clean = tmp();
    writeFileSync(join(clean, "capture.json"), JSON.stringify(sampleCapture()));
    expect(main([clean, dest, "--note", "from zed@mail.invalid order 123-1234567-1234567"])).toBe(
      1,
    );
    expect(existsSync(dest)).toBe(false);
  });

  test("writeFixtureCase adds a trailing newline and writes fragments", () => {
    const { capture } = scrubCapture(sampleCapture());
    const dest = join(tmp(), "c");
    const files = writeFixtureCase(dest, capture);
    expect(files).toEqual(["capture.json", "page.html", "aod.html"]);
    expect(readFileSync(join(dest, "page.html"), "utf8").endsWith("\n")).toBe(true);
  });

  test("readRawCapture rejects malformed manifests", async () => {
    const { readRawCapture } = await import("../src/index.ts");
    const raw = tmp();
    writeFileSync(join(raw, "capture.json"), "[]");
    expect(() => readRawCapture(raw)).toThrow(/object/);
    writeFileSync(join(raw, "capture.json"), JSON.stringify({ kind: "product" }));
    expect(() => readRawCapture(raw)).toThrow(/url/);
    writeFileSync(join(raw, "capture.json"), JSON.stringify({ ...sampleCapture(), fragments: [] }));
    expect(() => readRawCapture(raw)).toThrow(/fragments/);
    writeFileSync(
      join(raw, "capture.json"),
      JSON.stringify({ ...sampleCapture(), fragments: { a: 1 } }),
    );
    expect(() => readRawCapture(raw)).toThrow(/fragment a/);
  });
});
