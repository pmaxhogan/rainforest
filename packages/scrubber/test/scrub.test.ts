import type { Capture } from "@rainforest/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { auditScrubbed, scrubCapture, type ScrubResult } from "../src/index.ts";
import { SYNTHETIC_CAPTURED_AT } from "../src/context.ts";
import { AOD_HTML, PAGE_HTML, PLANTED, sampleCapture } from "./samples.ts";

const DAY_MS = 86_400_000;

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

function everything(r: ScrubResult): string {
  return (
    JSON.stringify(r.capture) + r.capture.html + Object.values(r.capture.fragments ?? {}).join("")
  );
}

function one(html: string, extra: Partial<Capture> = {}, seed?: string): ScrubResult {
  return scrubCapture(
    {
      kind: "product",
      url: "https://shop.invalid/dp/B0ABCD1234",
      final_url: "https://shop.invalid/dp/B0ABCD1234",
      captured_at: "2025-01-08T15:30:00.000Z",
      html,
      ...extra,
    },
    seed === undefined ? {} : { seed },
  );
}

/** Body text of a scrubbed fragment, for terse assertions. */
function body(html: string, seed?: string): string {
  return one(html, {}, seed).capture.html;
}

function doc(html: string) {
  return (parseHTML(html) as unknown as { document: QueryRoot }).document;
}
interface QueryRoot {
  querySelectorAll(sel: string): ArrayLike<{
    getAttribute(n: string): string | null;
    textContent: string | null;
  }>;
  querySelector(
    sel: string,
  ): { getAttribute(n: string): string | null; textContent: string | null } | null;
}

const result = scrubCapture(sampleCapture());
const out = result.capture;
const all = everything(result);

describe("planted values never survive", () => {
  for (const [cls, values] of Object.entries(PLANTED)) {
    test(cls, () => {
      for (const v of values) expect(all, `${cls}: ${v}`).not.toContain(v);
    });
  }

  test("no planted word survives in any case", () => {
    const lower = all.toLowerCase();
    for (const w of [
      "zed",
      "nowhere",
      "maple",
      "quill",
      "imaginary",
      "tangerine",
      "frobnicator",
      "zippy",
      "gizmo",
      "grocer",
      "emporium",
      "secret",
      ".invalid",
    ]) {
      expect(lower, w).not.toContain(w);
    }
    expect(all).not.toContain("Organic");
    expect(all).not.toContain("Widget");
  });

  test("the manifest fields are scrubbed", () => {
    expect(out.url.startsWith("https://www.example.com/")).toBe(true);
    expect(out.url).not.toContain("tag=");
    expect(out.final_url).toBe("https://www.example.com/dp/B0FAKE0000?th=1");
    expect(out.captured_at).toBe("2020-07-01T12:00:00.000Z");
    expect(SYNTHETIC_CAPTURED_AT).toBe("2020-07-01T12:00:00.000Z");
    expect(scrubCapture(sampleCapture(), { seed: "x" }).capture.captured_at).toBe(out.captured_at);
  });

  test("output is ASCII only", () => {
    expect(isAscii(all)).toBe(true);
    const r = body("<p>Caf\u00e9 \u203a\u00a0Zed \u2013 x</p>");
    expect(isAscii(r)).toBe(true);
    expect(r).toContain("&#x203a;");
  });
});

describe("structure is preserved", () => {
  const before = doc(PAGE_HTML);
  const after = doc(out.html);

  test("ids, classes and data attribute names survive", () => {
    for (const id of [
      "nav-belt",
      "glow-ingress-block",
      "glow-ingress-line1",
      "glow-ingress-line2",
      "nav-search-bar-form",
      "twotabsearchtextbox",
      "orderDetails",
      "od-subtotals",
      "twister-data",
    ]) {
      expect(after.querySelector(`#${id}`), id).not.toBeNull();
    }
    for (const cls of [
      ".s-result-item.s-asin.sg-col-0-of-12.s-widget-spacing-small",
      ".a-price .a-offscreen",
      ".a-price-whole",
      ".a-icon-alt",
      ".displayAddressFullName",
      ".displayAddressAddressLine1",
      ".displayAddressCityStateOrRegionPostalCode",
      ".a-profile-name",
    ]) {
      expect(after.querySelector(cls), cls).not.toBeNull();
    }
    const item = after.querySelector('[data-component-type="s-search-result"]');
    expect(item).not.toBeNull();
    for (const a of [
      "data-asin",
      "data-index",
      "data-uuid",
      "data-cel-widget",
      "data-csa-c-item-id",
    ]) {
      expect(item?.getAttribute(a), a).not.toBeNull();
    }
    expect(item?.getAttribute("data-cel-widget")).toBe("search_result_3");
    expect(item?.getAttribute("data-csa-c-type")).toBe("item");
    expect(after.querySelectorAll('[data-hook="review-body"]').length).toBe(1);
  });

  test("hidden markers survive", () => {
    const n = before.querySelectorAll('[data-rf-hidden="1"]').length;
    expect(n).toBeGreaterThan(0);
    expect(after.querySelectorAll('[data-rf-hidden="1"]').length).toBe(n);
  });

  test("element counts match for structural tags", () => {
    for (const sel of [
      "div",
      "span",
      "li",
      "ul",
      "form",
      "input",
      "a",
      "h2",
      "label",
      "time",
      "bdi",
    ]) {
      expect(after.querySelectorAll(sel).length, sel).toBe(before.querySelectorAll(sel).length);
    }
  });

  test("form structure is kept", () => {
    const input = after.querySelector("#twotabsearchtextbox");
    expect(input?.getAttribute("name")).toBe("field-keywords");
    expect(input?.getAttribute("type")).toBe("text");
    expect(after.querySelector("form")?.getAttribute("method")).toBe("GET");
    expect(after.querySelector("form")?.getAttribute("role")).toBe("search");
  });
});

describe("labels survive and values are synthesized", () => {
  test("allowlisted labels are kept", () => {
    for (const label of [
      ">Sponsored<",
      ">Verified Purchase<",
      ">Subscribe &amp; Save<",
      ">Add to Cart<",
      ">Ships from Amazon.com<",
      ">Order placed ",
      ">Deliver to ",
      ">Hello, ",
      ">Reviewed in the United States on ",
      " out of 5 stars<",
      " ratings<",
      " bought in past month<",
      ">List Price: $",
      ">FREE delivery ",
      ">Helpful<",
      ">Item(s) Subtotal:<",
      ">Estimated tax to be collected:<",
      ">Grand Total:<",
      ">Sold by ",
      ">Last purchased ",
    ]) {
      expect(out.html, label).toContain(label);
    }
  });

  test("shapes are kept: prices, counts, ratings, dates", () => {
    const h = out.html;
    expect(h).toMatch(/class="a-offscreen">\$\d{2}\.\d{2}</);
    expect(h).toMatch(/>\d,\d{3} ratings</);
    const rating = /aria-label="(\d\.\d) out of 5 stars"/.exec(h);
    expect(rating).not.toBeNull();
    expect(Number(rating?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(rating?.[1])).toBeLessThanOrEqual(5);
    expect(h).toMatch(/>Order placed [A-Z][a-z]+ \d{1,2}, \d{4}</);
    expect(h).toMatch(/>Reviewed in the United States on [A-Z][a-z]+ \d{1,2}, \d{4}</);
    expect(h).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(h).toMatch(/>Order # 000-0000000-\d{7}</);
  });

  test("dates move by one shift, weekdays follow the shifted date", () => {
    const dayOf = (s: string) => Date.parse(`${s} UTC`) / DAY_MS;
    const placed = /Order placed ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(out.html)?.[1] ?? "";
    const reviewed = /United States on ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(out.html)?.[1] ?? "";
    // Real order and review are the same day; the real delivery promise is 2 days later.
    expect(dayOf(reviewed) - dayOf(placed)).toBe(0);
    const free = /FREE delivery ([A-Z][a-z]+), ([A-Z][a-z]+ \d{1,2})</.exec(out.html);
    expect(free).not.toBeNull();
    const y = new Date(placed).getUTCFullYear();
    const promised = dayOf(`${free?.[2]}, ${y}`);
    const gap = promised - dayOf(placed);
    expect(gap === 2 || gap === 2 - 365 || gap === 2 - 366).toBe(true);
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    expect(free?.[1]).toBe(names[new Date(promised * DAY_MS).getUTCDay()]);
  });
});

describe("identifier mapping is consistent within a fixture", () => {
  const after = doc(out.html);
  test("one real ASIN maps to one fake ASIN everywhere", () => {
    const asin = after.querySelector("[data-asin]")?.getAttribute("data-asin") ?? "";
    expect(asin).toMatch(/^B0FAKE[0-9A-Z]{4}$/);
    expect(out.url).toContain(`/dp/${asin}`);
    expect(out.html).toContain(`/dp/${asin}/`);
    expect(out.html).toContain(`"${asin}":{`);
    expect(
      after.querySelector("[data-csa-c-item-id]")?.getAttribute("data-csa-c-item-id"),
    ).toContain(asin);
    expect(out.fragments?.aod).toBeDefined();
  });

  test("distinct real ASINs get distinct fakes", () => {
    const blob = JSON.parse(after.querySelector("#twister-data")?.textContent ?? "{}") as {
      asin: string;
      isbn: { asin: string };
    };
    const main = after.querySelector("[data-asin]")?.getAttribute("data-asin");
    expect(new Set([main, blob.asin, blob.isbn.asin]).size).toBe(3);
  });

  test("order ids, ids and labels referencing them stay in sync", () => {
    const order = /Order # (000-0000000-\d{7})/.exec(out.html)?.[1] ?? "";
    expect(out.html).toContain(`orderID=${order}`);
    const reviewId = after.querySelector('[data-hook="review"]')?.getAttribute("id") ?? "";
    expect(reviewId).toMatch(/^FAKEID\d{4}$/);
    expect(after.querySelector("label")?.getAttribute("for")).toBe(reviewId);
  });

  test("a price scrubs the same way in every place it appears", () => {
    const off = /class="a-offscreen">\$(\d+)\.(\d+)</.exec(out.html);
    const whole = /class="a-price-whole">(\d+)</.exec(out.html)?.[1];
    const frac = /class="a-price-fraction">(\d+)</.exec(out.html)?.[1];
    expect(whole).toBe(off?.[1]);
    expect(frac).toBe(off?.[2]);
    expect(out.fragments?.aod).toContain(`$${off?.[1]}.${off?.[2]}`);
    const blob = /"price":([\d.]+)/.exec(out.html)?.[1];
    expect(blob).toBe(`${off?.[1]}.${off?.[2]}`);
  });

  test("the seller id maps the same in page and fragment", () => {
    const fragSeller = /seller=(FAKEID\d{4})/.exec(out.fragments?.aod ?? "")?.[1];
    expect(fragSeller).toMatch(/^FAKEID\d{4}$/);
    expect(out.html).toContain(fragSeller);
  });
});

describe("location leaks", () => {
  test("Deliver-to header widget", () => {
    const after = doc(out.html);
    expect(after.querySelector("#glow-ingress-line1")?.textContent).toMatch(
      /^Deliver to [A-Z][a-z]+$/,
    );
    expect(after.querySelector("#glow-ingress-line2")?.textContent).toMatch(
      /^Exampleville 0000[0-3]$/,
    );
    expect(
      body('<span id="glow-ingress-line1">Deliver to Zed - Nowhere Falls 99999</span>'),
    ).toMatch(/Deliver to [A-Z][a-z]+ - Exampleville 0000[0-3]/);
    expect(body('<span id="x">Delivering to Nowhere Falls 99999 - Update location</span>')).toMatch(
      /Delivering to Exampleville 0000[0-3]/,
    );
  });

  test("full address block", () => {
    const after = doc(out.html);
    expect(after.querySelector(".displayAddressFullName")?.textContent).toMatch(
      /^[A-Z][a-z]+ [A-Z][a-z]+$/,
    );
    expect(after.querySelector(".displayAddressAddressLine1")?.textContent).toBe("100 Example St");
    expect(after.querySelector(".displayAddressCityStateOrRegionPostalCode")?.textContent).toMatch(
      /^Exampleville, ZZ 0000[0-3]-0000$/,
    );
    expect(after.querySelector(".displayAddressPhoneNumber")?.textContent).toMatch(
      /\(555\) 555-01\d\d$/,
    );
  });

  test("delivery promises are shifted", () => {
    expect(out.html).not.toContain("January 7");
    expect(out.html).toMatch(/Arriving [A-Z][a-z]+, [A-Z][a-z]+ \d{1,2} /);
  });

  test("tax lines are synthesized", () => {
    expect(out.html).toMatch(/Estimated tax to be collected:<\/span><span>\$\d\.\d{2}</);
    expect(out.html).not.toContain("$3.21");
    expect(out.html).not.toContain("$48.88");
  });

  test("grocery store names and delivery windows", () => {
    const after = doc(out.html);
    const w = after.querySelector(".fresh-window")?.textContent ?? "";
    expect(w).not.toMatch(/Imaginary|Grocer|Nowhere|Falls/);
    expect(w).toMatch(/\d{1,2}:\d{2} [AP]M - \d{1,2}:\d{2} [AP]M$/);
    expect(w).not.toContain("10:00 AM - 12:00 PM");
  });

  test("last purchased banners", () => {
    expect(out.html).toMatch(/>Last purchased [A-Z][a-z]{2} \d{1,2}</);
    expect(out.html).not.toContain("Last purchased Jan 5<");
  });

  test("time zones are normalized to UTC", () => {
    for (const z of ["CST", "-06:00", "GMT-0600", "GMT"]) expect(out.html).not.toContain(z);
    const isos = out.html.match(/\d{4}-\d{2}-\d{2}T[\d:]+[^"<\s)]*/g) ?? [];
    expect(isos.length).toBeGreaterThan(0);
    for (const iso of isos) expect(iso.endsWith("Z"), iso).toBe(true);
    expect(body("<p>Window 2 PM - 4 PM PDT, updated 10:00 EST</p>")).not.toMatch(/PDT|EST/);
    expect(body("<p>Window 2 PM - 4 PM PDT</p>")).toContain("UTC");
  });

  test("zip-like numbers never survive in address contexts", () => {
    const r = body(
      '<div class="shipping-address">Zed<br>Nowhere, ZZ 99999</div><p>"zip": 99999</p>',
    );
    expect(r).not.toContain("99999");
    expect(auditScrubbed(r)).toEqual([]);
  });
});

describe("labels never protect names or places", () => {
  test("a surname or city word that is also a label is still replaced", () => {
    const r = body(
      '<span class="a-profile-name">Zed Price</span>' +
        '<ul class="displayAddressUL"><li class="displayAddressFullName">Page Zed</li>' +
        "<li>New Zedtown, ZZ 99999</li><li>Total Zedtown</li></ul>" +
        "<p>Sold by Price Zed</p><p>Ships from Amazon.com</p>",
    );
    for (const w of ["Zed", "Price", "Page", "New Zedtown", "Total"]) expect(r, w).not.toContain(w);
    expect(r).toContain("Sold by ");
    expect(r).toContain(">Ships from Amazon.com<");
  });

  test("trailing labels only for the suffix kinds", () => {
    expect(body("<p>Zed Sponsored</p>")).not.toContain("Sponsored");
    expect(body('<span aria-label="4.5 out of 5 stars, rating details">x</span>')).toMatch(
      /aria-label="\d\.\d out of 5 stars, rating details"/,
    );
    expect(body("<p>1-16 of over 3,000 results for</p>")).toMatch(
      /^<p>\d-\d{2} [a-z]+ [a-z]+ \d,\d{3} results for<\/p>$/,
    );
  });

  test("attributes on the root html element are scrubbed", () => {
    const r = one(
      '<!DOCTYPE html><html lang="en" class="a-js" style="x" data-zed="Zed Placeholder 2025-01-05" ' +
        'onload="x()"><body><p>x</p></body></html>',
    ).capture.html;
    expect(r).toMatch(/^<!DOCTYPE html><html lang="en" class="a-js" data-zed="[^"]+">/);
    expect(r).not.toContain("Zed");
    expect(r).not.toContain("2025-01-05");
    expect(r).not.toContain("style=");
    expect(r).not.toContain("onload");
  });
});

describe("scripts, styles and attributes", () => {
  const after = doc(out.html);
  test("only allowlisted JSON blobs survive, scrubbed recursively", () => {
    const scripts = Array.from(after.querySelectorAll("script"));
    expect(scripts.map((s) => s.getAttribute("type")).sort()).toEqual([
      "a-state",
      "application/json",
    ]);
    const state = scripts.find((s) => s.getAttribute("type") === "a-state");
    expect(JSON.parse(state?.getAttribute("data-a-state") ?? "")).toEqual({
      key: "turbo-checkout-page-state",
    });
    const data = JSON.parse(state?.textContent ?? "") as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([
      "customerId",
      "title",
      "price",
      "zip",
      "postalCode",
      "when",
      expect.stringMatching(/^B0FAKE/) as unknown as string,
      "email",
    ]);
    expect(data.customerId).toMatch(/^FAKEID\d{4}$/);
    expect(data.zip).toMatch(/^0000[0-3]$/);
    expect(data.postalCode).toMatch(/^0000[0-3]$/);
    expect(data.email).toMatch(/^user\d+@example\.com$/);
    expect(String(data.when)).toMatch(/Z$/);
    expect(String(data.price)).toMatch(/^\d{2}\.\d{2}$/);
  });

  test("no handlers, styles, comments, pixels, iframe sources, meta or links", () => {
    expect(out.html).not.toMatch(/\son[a-z]+=/i);
    expect(out.html).not.toMatch(/\sstyle=/i);
    expect(out.html).not.toContain("<!--");
    expect(out.html).not.toMatch(/<(style|link|noscript)\b/i);
    expect(out.html).not.toContain('name="description"');
    expect(out.html).toContain('<meta charset="utf-8">');
    expect(out.html).toContain("<iframe></iframe>");
    expect(after.querySelectorAll("img").length).toBe(1);
    expect(after.querySelector("img")?.getAttribute("src")).toBe(
      "https://images.example.com/placeholder.png",
    );
    expect(after.querySelector("img")?.getAttribute("srcset")).toBe(
      "https://images.example.com/placeholder.png 1x, https://images.example.com/placeholder.png 2x",
    );
  });

  test("special URL schemes", () => {
    expect(out.html).toMatch(/href="mailto:user\d+@example\.com"/);
    expect(out.html).toMatch(/href="tel:555-555-01\d\d"/);
    expect(out.html).toContain('href="#"');
  });

  test("query strings keep only allowlisted parameter names", () => {
    expect(out.html).toMatch(
      /href="\/[A-Za-z-]+\/dp\/B0FAKE0000\/ref=rf\?keywords=[a-z]+\+[a-z]+&amp;th=1"/,
    );
    expect(out.html).not.toContain("qid=");
    expect(out.html).not.toContain("sr=");
  });

  test("text in title and textarea cannot break out of RCDATA", () => {
    const r = body(
      "<title>a &lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title><textarea>&lt;/textarea&gt;</textarea>",
    );
    expect(r).not.toMatch(/<script/i);
    expect(r).toContain("&lt;/");
  });

  test("kept values still get the token pass", () => {
    const r = body(
      '<div id="sc-item-B0ABCD1234" class="row A1B2C3D4E5F6G7" data-cel-widget="w_123-1234567-1234567">x</div>' +
        '<label for="sc-item-B0ABCD1234">q</label>',
    );
    expect(r).not.toContain("B0ABCD1234");
    expect(r).not.toContain("A1B2C3D4E5F6G7");
    expect(r).not.toContain("123-1234567-1234567");
    expect(r).toContain('id="sc-item-B0FAKE0000"');
    expect(r).toContain('for="sc-item-B0FAKE0000"');
  });

  test("unknown attributes are scrubbed, not kept", () => {
    const r = body(
      '<div data-seller-name="Zed Placeholder" data-zip="99999" data-flag="true">x</div>',
    );
    expect(r).not.toContain("Zed");
    expect(r).not.toContain("99999");
    expect(r).toContain('data-flag="true"');
  });

  test("other node types and dangerous elements are removed", () => {
    const r = body(
      '<p>a</p><![CDATA[ Zed ]]><xmp><b>Zed</b></xmp><object data="/x"><p>Zed</p></object>' +
        '<embed src="/x"><svg><text>Zed</text><use xlink:href="#icon"></use></svg>',
    );
    expect(r).not.toContain("Zed");
    expect(r).not.toMatch(/<(xmp|object|embed)\b/);
    expect(r).toContain('xlink:href="#icon"');
  });
});

describe("determinism", () => {
  test("same input and seed give byte-identical output", () => {
    const again = scrubCapture(sampleCapture());
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });

  test("a different seed changes the synthetic choices", () => {
    const other = scrubCapture(sampleCapture(), { seed: "another" });
    expect(other.capture.html).not.toBe(out.html);
    expect(other.report.findings).toEqual([]);
  });

  test("fake ids are first-appearance order, not derived from the real value", () => {
    const plain = { url: "https://shop.invalid/", final_url: "https://shop.invalid/" };
    const a = one("<p>B0ABCD1234 B0WXYZ9876</p>", plain).capture.html;
    const b = one("<p>B0WXYZ9876 B0ABCD1234</p>", plain).capture.html;
    expect(a).toContain("B0FAKE0000 B0FAKE0001");
    expect(b).toContain("B0FAKE0000 B0FAKE0001");
  });
});

describe("closed under the audit", () => {
  test("many seeds: output and re-scrubbed output have no findings", () => {
    for (let i = 0; i < 40; i++) {
      const r = scrubCapture(sampleCapture(), { seed: `seed-${i}` });
      expect(r.report.findings, `seed ${i}`).toEqual([]);
      const again = scrubCapture(r.capture, { seed: `again-${i}` });
      expect(again.report.findings, `rescrub ${i}`).toEqual([]);
      const text = everything(r);
      for (const v of [
        ...PLANTED.asins,
        ...PLANTED.orderIds,
        ...PLANTED.emails,
        ...PLANTED.tokens,
      ]) {
        expect(text.includes(v), `seed ${i}: ${v}`).toBe(false);
      }
    }
  });

  test("shapes the generator might mint stay clean", () => {
    const tricky =
      "<p>Model ab12cd34ef56gh78ij90 x0abcdefgh q0abcd1234 4K60HZ1080P ABCDEFGHIJ12</p>" +
      "<p>Ref ghijklmn-1234-5678-9abc-def012345678 tel 999 555 1234 code 12345.67</p>" +
      "<p>US 12345 and ZZ 54321, zip:12345, 12345-6789 Deliver to x 13579</p>" +
      "<p>abcd+1234+abcd+5678+efgh lorem_ipsum_dolor_sit_amet_123 1234567890</p>";
    for (let i = 0; i < 25; i++) {
      const r = one(tricky, {}, `t-${i}`);
      expect(r.report.findings, `seed ${i}`).toEqual([]);
    }
  });
});

describe("audit catches each planted leak class in raw input", () => {
  test("raw sample page", () => {
    const rules = new Set(auditScrubbed(PAGE_HTML).map((f) => f.rule));
    for (const r of [
      "asin",
      "order-id",
      "email",
      "phone",
      "zip",
      "card-last4",
      "uuid",
      "opaque-blob",
      "opaque-id",
      "url-host",
      "script",
      "comment",
      "event-handler",
      "style-attr",
      "iframe-src",
      "element",
    ]) {
      expect(rules.has(r), r).toBe(true);
    }
    expect(auditScrubbed(AOD_HTML).map((f) => f.rule)).toContain("zip");
  });
});

describe("input validation fails closed", () => {
  test("an unparseable captured_at throws", () => {
    expect(() => one("<p>x</p>", { captured_at: "yesterday" })).toThrow(/captured_at/);
  });
  test("bad fragment names throw", () => {
    expect(() => one("<p>x</p>", { fragments: { "../x": "<p>y</p>" } })).toThrow(/fragment/);
  });
});
