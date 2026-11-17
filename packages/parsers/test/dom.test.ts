import { describe, expect, it } from "vitest";
import {
  INVISIBLE_TAGS,
  attr,
  collapse,
  findMoney,
  links,
  moneyFromPriceElement,
  parseCapture,
  parseCount,
  parseCountDetail,
  parseDocument,
  parseMoney,
  parseMoneyRange,
  parseRating,
  q,
  qa,
  ratingFromClass,
  tableToRows,
  text,
  visible,
} from "../src/index.ts";

const page = (body: string): string =>
  `<!DOCTYPE html><html><head><title>Fake page</title></head><body>${body}</body></html>`;

describe("parseDocument", () => {
  it("parses a full document", () => {
    const doc = parseDocument(page("<p id=a>hello</p>"));
    expect(doc.body.localName).toBe("body");
    expect(doc.title).toBe("Fake page");
    expect(text(doc.querySelector("#a"))).toBe("hello");
  });

  it("wraps a fragment so body works", () => {
    const doc = parseDocument("<div id=x>frag</div><p>two</p>");
    expect(doc.documentElement.localName).toBe("html");
    expect(doc.body.children.length).toBe(2);
    expect(text(doc.body)).toBe("frag two");
  });

  it("handles empty input", () => {
    const doc = parseDocument("");
    expect(doc.body.localName).toBe("body");
    expect(text(doc.body)).toBe("");
  });

  it("tolerates a comment before the doctype and html without body", () => {
    const a = parseDocument("  <!-- c --> <!DOCTYPE html><html><body><p>q</p></body></html>");
    expect(text(a.body)).toBe("q");
    const b = parseDocument("<html><p>nobody</p></html>");
    expect(text(b.body)).toBe("nobody");
    const s = parseDocument('<script>var t = "<html>";</script><p>fragment with html text</p>');
    expect(s.documentElement.localName).toBe("html");
    expect(text(s.body)).toBe("fragment with html text");
    const c = parseDocument("<html lang=en><head><title>T</title></head><p>after head</p>");
    expect(c.title).toBe("T");
    expect(text(c.body)).toBe("after head");
  });

  it("parses capture fragments", () => {
    const parsed = parseCapture({
      kind: "product",
      url: "https://www.example.com/dp/B0FAKE0001",
      final_url: "https://www.example.com/dp/B0FAKE0001",
      captured_at: "2000-01-01T00:00:00.000Z",
      html: page("<p>main</p>"),
      fragments: { aod: "<div id=offers>offer list</div>" },
    });
    expect(text(parsed.doc.body)).toBe("main");
    expect(text(parsed.fragments.aod?.querySelector("#offers"))).toBe("offer list");
    const none = parseCapture({
      kind: "product",
      url: "u",
      final_url: "u",
      captured_at: "t",
      html: "",
    });
    expect(none.fragments).toEqual({});
  });
});

describe("visibility", () => {
  const doc = parseDocument(
    page(`
    <div id=shown>Shown <span data-rf-hidden="1">secret</span> text</div>
    <div id=hid data-rf-hidden="1"><p id=inner>inner</p></div>
    <div id=zero data-rf-hidden="0">zero marker is visible</div>
    <script id=s>var x = 1;</script>
    <style>.a{}</style>
    <noscript><p id=ns>enable js</p></noscript>
    <template id=t><p>tpl</p></template>
    <ul><li class=i>one</li><li class=i data-rf-hidden="1">two</li><li class=i>three</li></ul>
  `),
  );

  it("lists the invisible tags", () => {
    expect([...INVISIBLE_TAGS].sort()).toEqual(
      ["head", "link", "meta", "noscript", "script", "style", "template", "title"].sort(),
    );
  });

  it("is false for hidden elements, their descendants and non-rendering tags", () => {
    expect(visible(doc.querySelector("#shown"))).toBe(true);
    expect(visible(doc.querySelector("#hid"))).toBe(false);
    expect(visible(doc.querySelector("#inner"))).toBe(false);
    expect(visible(doc.querySelector("#zero"))).toBe(true);
    expect(visible(doc.querySelector("#s"))).toBe(false);
    expect(visible(doc.querySelector("#ns"))).toBe(false);
    expect(visible(null)).toBe(false);
    expect(visible(undefined)).toBe(false);
  });

  it("q and qa skip hidden matches", () => {
    expect(qa(doc, "li.i").map((li) => text(li))).toEqual(["one", "three"]);
    expect(q(doc, "#inner")).toBeUndefined();
    expect(q(doc, "#shown")?.id).toBe("shown");
    expect(qa(null, "p")).toEqual([]);
    expect(qa(doc, "[[[invalid")).toEqual([]);
  });

  it("text skips hidden descendants and collapses whitespace", () => {
    expect(text(doc.querySelector("#shown"))).toBe("Shown text");
    expect(text(doc.querySelector("#hid"))).toBe("");
    expect(text(null)).toBe("");
    expect(text(doc.body)).not.toContain("secret");
    expect(text(doc.body)).not.toContain("var x");
    expect(text(doc.body)).not.toContain("enable js");
    expect(text(doc.body)).not.toContain("tpl");
  });

  it("separates block elements and keeps inline runs together", () => {
    const d = parseDocument(
      page(
        "<div id=r><div>a</div><div>b</div><span>c</span><b>d</b><br>e&nbsp;&nbsp;f\n\t g</div>",
      ),
    );
    expect(text(d.querySelector("#r"))).toBe("a b cd e f g");
    expect(collapse("  x \u00a0 y\n")).toBe("x y");
  });

  it("text honors an exclude predicate", () => {
    const d = parseDocument(page("<div id=r>keep <i class=x>drop</i> this</div>"));
    expect(text(d.querySelector("#r"), { exclude: (e) => e.localName === "i" })).toBe("keep this");
  });
});

describe("attr, tables and links", () => {
  it("attr trims and tolerates missing", () => {
    const d = parseDocument(page("<a id=l href='  /x  ' data-n=''>x</a>"));
    expect(attr(d.querySelector("#l"), "href")).toBe("/x");
    expect(attr(d.querySelector("#l"), "data-n")).toBe("");
    expect(attr(d.querySelector("#l"), "nope")).toBeUndefined();
    expect(attr(null, "href")).toBeUndefined();
  });

  it("tableToRows reads visible rows, th and td, and leaves nested tables out", () => {
    const d = parseDocument(
      page(`<table id=t>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Color</td><td>Fake blue</td></tr>
          <tr data-rf-hidden="1"><td>Hidden</td><td>row</td></tr>
          <tr><td>Size</td><td>Big <span data-rf-hidden="1">x</span></td></tr>
          <tr><td></td><td> </td></tr>
          <tr><td>Nest</td><td><table><tr><td>inner</td></tr></table></td></tr>
        </tbody></table>`),
    );
    expect(tableToRows(d.querySelector("#t"))).toEqual([
      ["Name", "Value"],
      ["Color", "Fake blue"],
      ["Size", "Big"],
      ["Nest", "inner"],
    ]);
    expect(tableToRows(null)).toEqual([]);
  });

  it("links resolves, filters and labels", () => {
    const d = parseDocument(
      page(`<div id=box>
        <a href="/dp/B0FAKE0001">Fake widget</a>
        <a href="#top">skip</a>
        <a href="javascript:void(0)">js</a>
        <a href="">empty</a>
        <a href="/hidden" data-rf-hidden="1">hidden</a>
        <a href="/img"><img alt="Pic label" src="https://images.example.com/placeholder.png"></a>
        <a href="/aria" aria-label="Aria label"></a>
        <a href="http://[bad">bad</a>
      </div><a id=self href="/self">Self</a>`),
    );
    expect(links(d.querySelector("#box"), { base: "https://www.example.com/s?k=x" })).toEqual([
      { text: "Fake widget", href: "https://www.example.com/dp/B0FAKE0001" },
      { text: "Pic label", href: "https://www.example.com/img" },
      { text: "Aria label", href: "https://www.example.com/aria" },
      { text: "bad", href: "http://[bad" },
    ]);
    expect(links(d.querySelector("#self"))).toEqual([{ text: "Self", href: "/self" }]);
    expect(links(null)).toEqual([]);
  });
});

describe("money", () => {
  it("parses symbols, separators, signs and codes", () => {
    expect(parseMoney("$1,234.56")).toEqual({ amount: 1234.56, currency: "USD", raw: "$1,234.56" });
    expect(parseMoney("Price: $ 7")).toMatchObject({ amount: 7, currency: "USD" });
    expect(parseMoney("Save -$5.00 today")).toMatchObject({ amount: -5, raw: "-$5.00" });
    expect(parseMoney("US$12.5")).toMatchObject({ amount: 12.5, currency: "USD" });
    expect(parseMoney("CDN$ 3.99")).toMatchObject({ amount: 3.99, currency: "CAD" });
    expect(parseMoney("\u00a310.00")).toMatchObject({ amount: 10, currency: "GBP" });
    expect(parseMoney("19.99 USD")).toMatchObject({ amount: 19.99, currency: "USD" });
    expect(parseMoney("USD 4")).toMatchObject({ amount: 4, currency: "USD" });
    expect(parseMoney("$1,000,000")).toMatchObject({ amount: 1000000 });
  });

  it("returns undefined without a currency unless a default is given", () => {
    expect(parseMoney("12.99")).toBeUndefined();
    expect(parseMoney("12.99", { defaultCurrency: "USD" })).toMatchObject({ amount: 12.99 });
    expect(parseMoney("")).toBeUndefined();
    expect(parseMoney(null)).toBeUndefined();
    expect(parseMoney("free")).toBeUndefined();
    expect(findMoney("free", { defaultCurrency: "USD" })).toEqual([]);
  });

  it("finds every amount", () => {
    expect(findMoney("was $20.00 now $15.00").map((m) => m.amount)).toEqual([20, 15]);
    expect(findMoney("$10.99 - $24.99").map((m) => m.amount)).toEqual([10.99, 24.99]);
    expect(findMoney("$10-$20").map((m) => m.amount)).toEqual([10, 20]);
    expect(parseMoney("Fake widget - $12.34")?.amount).toBe(12.34);
    expect(parseMoney("Fake widget -$12.34")?.amount).toBe(-12.34);
    expect(parseMoney("x-$1")?.amount).toBe(1);
    expect(findMoney("total -3.50 or 2", { defaultCurrency: "USD" }).map((m) => m.amount)).toEqual([
      -3.5, 2,
    ]);
  });

  it("parses ranges", () => {
    expect(parseMoneyRange("$10.99 - $24.99")).toEqual({
      low: { amount: 10.99, currency: "USD", raw: "$10.99" },
      high: { amount: 24.99, currency: "USD", raw: "$24.99" },
      raw: "$10.99 - $24.99",
    });
    expect(parseMoneyRange("from $10-$20")?.raw).toBe("$10-$20");
    expect(parseMoneyRange("$10 to 20")?.high).toMatchObject({ amount: 20, currency: "USD" });
    expect(parseMoneyRange("$5.00 \u2013 $9.00")?.high.amount).toBe(9);
    expect(parseMoneyRange("$10.99")).toBeUndefined();
    expect(parseMoneyRange("$10.99 - free")).toBeUndefined();
    expect(parseMoneyRange("no price")).toBeUndefined();
    expect(parseMoneyRange(null)).toBeUndefined();
  });

  it("reads Amazon-style price markup", () => {
    const d = parseDocument(
      page(`
      <span id=p1 class="a-price"><span class="a-offscreen">$19.99</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">19<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span>
      <span id=p2 class="a-price"><span class="a-offscreen" data-rf-hidden="1">$5.49</span></span>
      <span id=p3 class="a-price"><span class="a-price-symbol">$</span><span class="a-price-whole">1,299<span class="a-price-decimal">.</span></span><span class="a-price-fraction">5</span></span>
      <span id=p4 class="a-price"><span class="a-price-whole">42</span></span>
      <span id=p5 class="a-price" data-rf-hidden="1"><span class="a-offscreen">$1.00</span></span>
      <span id=p6>$3.25 each</span>
      <span id=p7 class="a-price"><span class="a-offscreen"></span><span class="a-price-whole"></span>n/a</span>
    `),
    );
    expect(moneyFromPriceElement(d.querySelector("#p1"))).toEqual({
      amount: 19.99,
      currency: "USD",
      raw: "$19.99",
    });
    expect(moneyFromPriceElement(d.querySelector("#p2"))?.amount).toBe(5.49);
    expect(moneyFromPriceElement(d.querySelector("#p3"))).toEqual({
      amount: 1299.5,
      currency: "USD",
      raw: "$1299.5",
    });
    expect(moneyFromPriceElement(d.querySelector("#p4"))).toMatchObject({
      amount: 42,
      raw: "$42.00",
    });
    expect(moneyFromPriceElement(d.querySelector("#p5"))).toBeUndefined();
    expect(moneyFromPriceElement(d.querySelector("#p6"))?.amount).toBe(3.25);
    expect(moneyFromPriceElement(d.querySelector("#p7"))).toBeUndefined();
    expect(moneyFromPriceElement(null)).toBeUndefined();
  });

  it("picks the visible price inside a container", () => {
    const d = parseDocument(
      page(`
      <div id=c1>
        <span class="a-price" data-rf-hidden="1"><span class="a-offscreen">$1.11</span></span>
        <span class="a-price"><span class="a-offscreen">$2.22</span></span>
      </div>
      <div id=c2>
        <span class="a-price" data-rf-hidden="1"><span class="a-price-symbol">$</span><span class="a-price-whole">3</span><span class="a-price-fraction">33</span></span>
        <span class="a-price"><span class="a-price-symbol">&pound;</span><span class="a-price-whole">4</span><span class="a-price-fraction">44</span></span>
      </div>
    `),
    );
    expect(moneyFromPriceElement(d.querySelector("#c1"))?.amount).toBe(2.22);
    expect(moneyFromPriceElement(d.querySelector("#c2"))).toEqual({
      amount: 4.44,
      currency: "GBP",
      raw: "\u00a34.44",
    });
  });
});

describe("counts and ratings", () => {
  it("parses counts", () => {
    expect(parseCount("1,234 ratings")).toBe(1234);
    expect(parseCount("(87)")).toBe(87);
    expect(parseCount("No ratings")).toBeUndefined();
    expect(parseCount(null)).toBeUndefined();
    expect(parseCountDetail("2K+ bought in past month")).toEqual({
      value: 2000,
      approximate: true,
      raw: "2K+",
    });
    expect(parseCountDetail("1.5M views")).toMatchObject({ value: 1500000, approximate: true });
    expect(parseCountDetail("over 10,000 sold")).toMatchObject({ value: 10000, approximate: true });
    expect(parseCountDetail("50+ bought")).toMatchObject({ value: 50, approximate: true });
    expect(parseCountDetail("12 reviews")).toMatchObject({ value: 12, approximate: false });
    expect(parseCount("12 months")).toBe(12);
    expect(parseCount("3 more offers")).toBe(3);
    expect(parseCount("1,234 members")).toBe(1234);
    expect(parseCount("5 kits")).toBe(5);
    expect(parseCount("4Kids pack")).toBe(4);
  });

  it("parses ratings", () => {
    expect(parseRating("4.5 out of 5 stars")).toEqual({ value: 4.5, out_of: 5 });
    expect(parseRating("Rated 3 out of 5")).toEqual({ value: 3, out_of: 5 });
    expect(parseRating("6 out of 5")).toBeUndefined();
    expect(parseRating("1 out of 0")).toBeUndefined();
    expect(parseRating("great")).toBeUndefined();
    expect(parseRating(undefined)).toBeUndefined();
  });

  it("reads star classes", () => {
    expect(ratingFromClass("a-icon a-star-4-5 review-rating")).toBe(4.5);
    expect(ratingFromClass("a-icon a-star-mini-4")).toBe(4);
    expect(ratingFromClass("a-star-small-3-5")).toBe(3.5);
    expect(ratingFromClass("a-star-7")).toBeUndefined();
    expect(ratingFromClass("a-icon")).toBeUndefined();
    expect(ratingFromClass(null)).toBeUndefined();
  });
});
