import { describe, expect, it } from "vitest";
import {
  Consumption,
  DEFAULT_BLOCK_SELECTOR,
  DEFAULT_CHROME_SELECTORS,
  losslessReport,
  otherSections,
  parseDocument,
  q,
  unparsedTextChars,
  visibleTextChars,
} from "../src/index.ts";

const page = (body: string): string =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

const PRODUCT = page(`
  <header id=hdr>Header chrome text</header>
  <div id=navbar>Nav chrome</div>
  <div id=dp>
    <div id=titleSection data-feature-name="title"><h1 id=productTitle>Fake Widget Deluxe</h1></div>
    <div id=priceBlock data-feature-name="price"><span class=a-price>$12.34</span></div>
    <div id=bullets data-feature-name="featurebullets">
      <h2>About this item</h2>
      <ul><li>Invented bullet one</li><li>Invented bullet two</li></ul>
    </div>
    <div id=details>
      <h3>Product details</h3>
      <table id=specs><tr><th>Weight</th><td>1 fake pound</td></tr></table>
      <a href="/help">Report an issue</a>
    </div>
    <div id=ghost data-rf-hidden="1">Hidden block never emitted</div>
    loose text outside blocks
  </div>
  <footer>Footer chrome</footer>
`);

describe("lossless defaults", () => {
  it("chrome selectors are a short explicit list", () => {
    expect([...DEFAULT_CHROME_SELECTORS]).toEqual([
      "header",
      "footer",
      "nav",
      "[role=navigation]",
      "[role=banner]",
      "[role=contentinfo]",
      "#navbar",
      "#nav-main",
      "#nav-subnav",
      "#navFooter",
      "#skiplink",
    ]);
    expect(DEFAULT_BLOCK_SELECTOR).toContain("[data-feature-name]");
  });
});

describe("Consumption", () => {
  it("tracks taken elements and covers descendants", () => {
    const doc = parseDocument(PRODUCT);
    const c = new Consumption();
    const title = c.take(q(doc, "#titleSection"));
    expect(title?.id).toBe("titleSection");
    expect(c.take(null)).toBeNull();
    c.takeAll([q(doc, "#priceBlock"), undefined]);
    expect(c.size).toBe(2);
    expect(c.has(q(doc, "#priceBlock") as never)).toBe(true);
    expect(c.covers(q(doc, "#productTitle") as never)).toBe(true);
    expect(c.has(q(doc, "#productTitle") as never)).toBe(false);
    expect(c.covers(q(doc, "#bullets") as never)).toBe(false);
    expect(c.elements().map((e) => e.id)).toEqual(["titleSection", "priceBlock"]);
  });
});

describe("losslessReport", () => {
  it("emits unconsumed blocks, skips chrome and hidden, and adds up", () => {
    const doc = parseDocument(PRODUCT);
    const c = new Consumption();
    c.take(q(doc, "#titleSection"));
    c.take(q(doc, "#priceBlock"));
    const r = losslessReport(doc, c, { base: "https://www.example.com/dp/B0FAKE0001" });

    expect(r.sections.map((s) => s.key)).toEqual(["dp:rest", "bullets", "details"]);
    const bullets = r.sections.find((s) => s.key === "bullets");
    expect(bullets).toEqual({
      key: "bullets",
      heading: "About this item",
      text: "About this item Invented bullet one Invented bullet two",
    });
    const details = r.sections.find((s) => s.key === "details");
    expect(details?.heading).toBe("Product details");
    expect(details?.tables).toEqual([[["Weight", "1 fake pound"]]]);
    expect(details?.links).toEqual([
      { text: "Report an issue", href: "https://www.example.com/help" },
    ]);
    const rest = r.sections.find((s) => s.key === "dp:rest");
    expect(rest?.text).toBe("loose text outside blocks");

    const all = JSON.stringify(r.sections);
    expect(all).not.toContain("chrome");
    expect(all).not.toContain("Hidden block");
    expect(all).not.toContain("Fake Widget Deluxe");

    const { total, consumed, emitted, unparsed } = r.counts;
    expect(consumed).toBe("Fake Widget Deluxe".length + "$12.34".length);
    expect(unparsed).toBe(0);
    expect(consumed + emitted + unparsed).toBe(total);
    expect(total).toBe(visibleTextChars(doc));
    expect(unparsedTextChars(doc, c)).toBe(0);
  });

  it("does not emit a parent and its child", () => {
    const doc = parseDocument(
      page(
        `<div id=outer data-feature-name=o><div id=inner data-feature-name=i>Inner text</div> outer text</div>`,
      ),
    );
    const sections = otherSections(doc, new Consumption());
    expect(sections.map((s) => s.key)).toEqual(["outer"]);
    expect(sections[0]?.text).toBe("Inner text outer text");
  });

  it("splits oversized blocks into child blocks plus a rest section", () => {
    const doc = parseDocument(
      page(
        `<div id=big><section id=s1><h2>One</h2>aaaa aaaa</section><section id=s2>bbbb bbbb</section> tail</div>`,
      ),
    );
    const r = losslessReport(doc, new Consumption(), { maxBlockChars: 10 });
    expect(r.sections.map((s) => [s.key, s.text])).toEqual([
      ["big:rest", "tail"],
      ["s1", "One aaaa aaaa"],
      ["s2", "bbbb bbbb"],
    ]);
    expect(r.counts.emitted).toBe(r.counts.total);
    // An oversized block with no child blocks stays whole.
    const leaf = parseDocument(page(`<div id=leaf>${"x".repeat(50)}</div>`));
    expect(otherSections(leaf, new Consumption(), { maxBlockChars: 10 }).map((s) => s.key)).toEqual(
      ["leaf"],
    );
  });

  it("counts loose root text and unmatched containers as unparsed", () => {
    const doc = parseDocument(
      page(`root loose <div class=plain>plain div text <span id=sp>in block</span></div>`),
    );
    const r = losslessReport(doc, new Consumption());
    expect(r.sections.map((s) => s.key)).toEqual(["sp"]);
    expect(r.counts.unparsed).toBe("root loose".length + "plain div text".length);
    expect(r.counts.consumed + r.counts.emitted + r.counts.unparsed).toBe(r.counts.total);
  });

  it("uses positional keys, dedupes repeated keys and skips empty blocks", () => {
    const doc = parseDocument(
      page(
        `<main><section>first</section><section>second</section><section> </section><div data-component-type="s-result">r1</div><div data-component-type="s-result">r2</div></main>`,
      ),
    );
    const keys = otherSections(doc, new Consumption()).map((s) => s.key);
    expect(keys).toEqual(["section@0.0", "section@0.1", "s-result", "s-result~2"]);
  });

  it("emits nested tables once through the outer table", () => {
    const doc = parseDocument(
      page(
        `<div id=box><table id=outer><tr><td>Cell<table id=inner><tr><td>deep</td></tr></table></td></tr></table><table><tr><td>second table</td></tr></table></div>`,
      ),
    );
    const [s] = otherSections(doc, new Consumption());
    expect(s?.tables).toEqual([[["Cell deep"]], [["second table"]]]);
    // A bare table is itself a block.
    const t = parseDocument(page(`<table><tr><td>solo</td></tr></table>`));
    expect(otherSections(t, new Consumption())[0]?.tables).toEqual([[["solo"]]]);
  });

  it("excludes consumed content from sections inside a split container", () => {
    const doc = parseDocument(
      page(
        `<div id=wrap><h2>Wrap heading</h2><div id=taken><h2>Taken heading</h2><a href="/x">taken link</a><table><tr><td>taken</td></tr></table></div><p>leftover</p></div>`,
      ),
    );
    const c = new Consumption();
    c.take(q(doc, "#taken"));
    const r = losslessReport(doc, c);
    expect(r.sections).toEqual([
      { key: "wrap:rest", heading: "Wrap heading", text: "Wrap heading leftover" },
    ]);
    expect(r.counts.consumed).toBe("Taken heading".length + "taken link".length + "taken".length);
    expect(r.counts.consumed + r.counts.emitted + r.counts.unparsed).toBe(r.counts.total);
  });

  it("honors root, blockSelector and chromeSelectors overrides", () => {
    const doc = parseDocument(PRODUCT);
    const root = q(doc, "#details");
    const r = losslessReport(doc, new Consumption(), { root, blockSelector: "table" });
    expect(r.sections.map((s) => s.key)).toEqual(["specs"]);
    expect(r.counts.unparsed).toBe("Product details".length + "Report an issue".length);
    // With no chrome list the header becomes a block.
    const all = otherSections(doc, new Consumption(), { chromeSelectors: [] }).map((s) => s.key);
    expect(all).toContain("hdr");
    // A bad selector never throws.
    expect(
      otherSections(doc, new Consumption(), { blockSelector: "[[[", chromeSelectors: ["[[["] }),
    ).toEqual([]);
  });

  it("handles a consumed root, a hidden root and an element as the document", () => {
    const doc = parseDocument(
      page(`<div id=all>everything</div><div id=h data-rf-hidden="1">x</div>`),
    );
    const c = new Consumption();
    c.take(doc.body);
    const r = losslessReport(doc, c);
    expect(r.sections).toEqual([]);
    expect(r.counts).toEqual({ total: 10, consumed: 10, emitted: 0, unparsed: 0 });
    const hidden = losslessReport(doc, new Consumption(), { root: q(doc, "#all") ?? undefined });
    expect(hidden.counts.total).toBe(10);
    const h = doc.querySelector("#h");
    expect(losslessReport(doc, new Consumption(), { root: h ?? undefined }).counts.total).toBe(0);
    expect(visibleTextChars(h as never)).toBe(0);
    expect(visibleTextChars(q(doc, "#all") as never)).toBe(10);
    expect(otherSections(q(doc, "#all") as never, new Consumption())).toEqual([]);
  });
});
