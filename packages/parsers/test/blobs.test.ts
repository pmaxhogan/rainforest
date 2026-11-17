import { describe, expect, it } from "vitest";
import {
  DEFAULT_JSON_ATTRIBUTES,
  collectBlobs,
  extractBalanced,
  extractJsonAfter,
  harvestBlobs,
  parseDocument,
  tryJson,
} from "../src/index.ts";

const DOC = parseDocument(`<!DOCTYPE html><html><head>
<script type="application/json" id="fakeConfig">{"asin":"B0FAKE0001","n":2}</script>
<script type="application/ld+json">{"@type":"Product","name":"Invented gadget"}</script>
<script type="application/json">{broken json</script>
</head><body>
<script type="a-state" data-a-state='{"key":"fake-twister"}'>{"dims":["size","color"]}</script>
<script type="a-state" data-a-state='{"key":"fake-twister"}'>{"dims":["style"]}</script>
<script type="a-state" data-a-state='{"key":"fake-bad"}'>{"oops":</script>
<script type="a-state" data-a-state='not json'>{"x":1}</script>
<script data-a-state='{"key":"no-type"}'>[1,2]</script>
<img id="landing" data-a-dynamic-image='{"https://images.example.com/placeholder.png":[500,500]}' src="https://images.example.com/placeholder.png">
<img data-a-dynamic-image='nope'>
<div data-custom-json='{"k":true}'></div>
<script>
  var unrelated = 1;
  P.register("fake", function () { var obj = { "price": "$1.00 }", "list": [1, [2, 3]], "s": "a \\"quoted\\" {brace}" }; });
</script>
<script type="text/javascript">window.fakeData = {"colors": ["red", "blue"], "note": "it's // not a comment"};</script>
<script>window.badLiteral = {unquoted: 'single'};</script>
<script src="/external.js">window.ignored = {"a":1};</script>
</body></html>`);

describe("tryJson", () => {
  it("parses or returns undefined", () => {
    expect(tryJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryJson("  [1] ")).toEqual([1]);
    expect(tryJson("{bad")).toBeUndefined();
    expect(tryJson("")).toBeUndefined();
    expect(tryJson(null)).toBeUndefined();
  });
});

describe("extractBalanced", () => {
  it("extracts objects and arrays, honoring strings, escapes and comments", () => {
    expect(extractBalanced('x = {"a": "}", "b": [1, {"c": 2}]}; rest', 3)).toBe(
      '{"a": "}", "b": [1, {"c": 2}]}',
    );
    expect(extractBalanced('  [1, \']\', "\\"]"] tail')).toBe('[1, \']\', "\\"]"]');
    expect(extractBalanced("{a: `t}`, /* } */ b: 1 // }\n}")).toBe(
      "{a: `t}`, /* } */ b: 1 // }\n}",
    );
  });

  it("returns undefined when nothing balanced starts there", () => {
    expect(extractBalanced("no literal")).toBeUndefined();
    expect(extractBalanced("{never closed")).toBeUndefined();
    expect(extractBalanced("{ ]")).toBeUndefined();
    expect(extractBalanced("{ // open comment")).toBeUndefined();
    expect(extractBalanced("{ /* open comment")).toBeUndefined();
    expect(extractBalanced("")).toBeUndefined();
  });
});

describe("extractJsonAfter", () => {
  it("parses the literal after an anchor", () => {
    expect(extractJsonAfter('var obj = {"a": [1]};', /var obj\s*=\s*/g)).toEqual({ a: [1] });
    expect(extractJsonAfter("var obj = {a: 1};", /var obj\s*=\s*/)).toBeUndefined();
    expect(extractJsonAfter("nothing here", /var obj\s*=/)).toBeUndefined();
    expect(extractJsonAfter("var obj = 5;", /var obj\s*=/)).toBeUndefined();
  });
});

describe("collectBlobs", () => {
  it("finds every kind of blob with unique keys", () => {
    const entries = collectBlobs(DOC, {
      attributes: [...DEFAULT_JSON_ATTRIBUTES, "data-custom-json"],
      anchors: {
        fakeObj: /var obj\s*=\s*/,
        fakeData: /window\.fakeData\s*=\s*/,
        badLiteral: /window\.badLiteral\s*=\s*/,
        absent: /window\.absent\s*=/,
        ignored: /window\.ignored\s*=\s*/,
      },
    });
    expect(entries.map((e) => [e.key, e.source, e.ok])).toEqual([
      ["fakeConfig", "json-script", true],
      ["ld-json:1", "json-script", true],
      ["json:2", "json-script", false],
      ["fake-twister", "a-state", true],
      ["fake-twister#2", "a-state", true],
      ["fake-bad", "a-state", false],
      ["a-state:6", "a-state", true],
      ["no-type", "a-state", true],
      ["data-a-dynamic-image#landing", "attribute", true],
      ["data-a-dynamic-image:1", "attribute", false],
      ["data-custom-json:0", "attribute", true],
      ["fakeObj", "inline-script", true],
      ["fakeData", "inline-script", true],
      ["badLiteral", "inline-script", false],
    ]);
    expect(entries.find((e) => e.key === "fakeObj")?.value).toEqual({
      price: "$1.00 }",
      list: [1, [2, 3]],
      s: 'a "quoted" {brace}',
    });
    expect(entries.find((e) => e.key === "fake-twister#2")?.baseKey).toBe("fake-twister");
  });

  it("skips an invalid attribute selector", () => {
    expect(collectBlobs(parseDocument("<p>x</p>"), { attributes: ["[[["] })).toEqual([]);
  });
});

describe("harvestBlobs", () => {
  it("splits known values from unknown keys and lists malformed ones", () => {
    const h = harvestBlobs(DOC, {
      known: ["fakeConfig", /^fake-/],
      anchors: { fakeData: /window\.fakeData\s*=\s*/ },
    });
    expect(h.known).toEqual({
      fakeConfig: { asin: "B0FAKE0001", n: 2 },
      "fake-twister": { dims: ["size", "color"] },
      "fake-twister#2": { dims: ["style"] },
      fakeData: { colors: ["red", "blue"], note: "it's // not a comment" },
    });
    expect(h.unknownKeys).toEqual([
      "ld-json:1",
      "json:2",
      "a-state:6",
      "no-type",
      "data-a-dynamic-image#landing",
      "data-a-dynamic-image:1",
    ]);
    expect(h.malformed).toEqual(["json:2", "fake-bad", "data-a-dynamic-image:1"]);
  });

  it("treats everything as unknown by default and never throws on an empty page", () => {
    expect(harvestBlobs(parseDocument("")).unknownKeys).toEqual([]);
    expect(harvestBlobs(DOC).known).toEqual({});
  });
});
