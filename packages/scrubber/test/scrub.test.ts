import type { Capture } from "@rainforest/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { auditScrubbed, scrubCapture, type ScrubResult } from "../src/index.ts";
import {
  MAX_SHIFT_DAYS,
  MIN_SHIFT_DAYS,
  MIN_YEAR_GAP_DAYS,
  SYNTHETIC_CAPTURED_AT,
  createContext,
  yearGap,
} from "../src/context.ts";
import { AOD_HTML, PAGE_HTML, PLANTED, sampleCapture } from "./samples.ts";
import { shift } from "../src/dates.ts";

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
    // Punctuation inside free text goes with the words it separated.
    expect(r).toMatch(/^<p>[A-Za-z ]+<\/p>$/);
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
    expect(h).toMatch(/class="a-offscreen">\$[\d,]+\.\d{2}</);
    expect(h).toMatch(/>[\d,]+ ratings</);
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
    // Real order and review are the same day (one date, one jitter); the real delivery
    // promise is 2 days later, which survives only to within the per-date jitter.
    expect(dayOf(reviewed) - dayOf(placed)).toBe(0);
    const free = /FREE delivery ([A-Z][a-z]+), ([A-Z][a-z]+ \d{1,2})</.exec(out.html);
    expect(free).not.toBeNull();
    const y = new Date(placed).getUTCFullYear();
    const promised = dayOf(`${free?.[2]}, ${y}`);
    const gap = promised - dayOf(placed);
    const near = (g: number) => Math.abs(g - 2) <= 2 * 3;
    expect(near(gap) || near(gap + 365) || near(gap + 366)).toBe(true);
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
      /^Deliver to [A-Z][a-z]+(?: [A-Z][a-z]+)?$/,
    );
    expect(after.querySelector("#glow-ingress-line2")?.textContent).toMatch(
      /^Exampleville 0000[0-3]$/,
    );
    expect(
      body('<span id="glow-ingress-line1">Deliver to Zed - Nowhere Falls 99999</span>'),
    ).toMatch(/Deliver to [A-Z][a-z]+(?: [A-Z][a-z]+)? - Exampleville 0000[0-3]/);
    expect(body('<span id="x">Delivering to Nowhere Falls 99999 - Update location</span>')).toMatch(
      /Delivering to Exampleville 0000[0-3]/,
    );
  });

  test("full address block", () => {
    const after = doc(out.html);
    // One word or two at random: the real name's word count is not kept.
    expect(after.querySelector(".displayAddressFullName")?.textContent).toMatch(
      /^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/,
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
      /^<p>\d-\d{2} of over [\d,]+ results for<\/p>$/,
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
    expect(String(data.price)).toMatch(/^\d+(?:\.\d{1,2})?$/);
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
      /href="\/[A-Za-z-]+\/dp\/B0FAKE0000\/ref=rf\?keywords=[A-Za-z]+(?:\+[a-z]+)*&amp;th=1"/,
    );
    expect(out.html).not.toContain("qid=");
    expect(out.html).not.toContain("sr=");
  });

  test("text in title and textarea cannot break out of RCDATA", () => {
    const r = body(
      "<title>a &lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title><textarea>&lt;/textarea&gt;</textarea>",
    );
    expect(r).not.toMatch(/<script/i);
    expect(r).toMatch(/^<title>[^<]*<\/title><textarea>[^<]*<\/textarea>$/);
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
      "<p>abcd+1234+abcd+5678+efgh lorem_ipsum_dolor_sit_amet_123 1234567890</p>" +
      // Shapes first seen on real pages (all values invented here):
      "<p>Item - ET4M8N2K6R1W5Q9 and 7PT3W8M2Q6Z4N1J ratio 2.7182818284590452E-4</p>" +
      '<p data-x="a=b%7CQ42W7NZ8KD&amp;c=GhQ3%2Bk9Lm2Pq8%2FzW4xYt7Rv%3D&amp;rh=n%3A5550001234">x</p>' +
      '<p>t 2019-03-04T05:06:07.000000000Z</p><label for="checkbox1f2e3d4c-5b6a-4789-8abc-0123456789ab">u</label>' +
      "<p>\u30c6\u30b9\u30c8123\u30c7\u30fc\u30bf \uff21\uff22\uff23\uff24 1234</p>" +
      '<p data-q="wxyzq9f8e7d6c-5555-6666-7777-888899990000 13.1a2b3c4d-1111-2222-3333-444455556666">v</p>';
    for (let i = 0; i < 25; i++) {
      const r = one(tricky, {}, `t-${i}`);
      expect(r.report.findings, `seed ${i}`).toEqual([]);
    }
  });
});

describe("leak classes found on real captures (invented values)", () => {
  test("a kept attribute holding JSON, a URL or markup is scrubbed as data", () => {
    const blob = JSON.stringify({
      pixelUrl: "https://ads.shop.invalid/x/px?t=1",
      html: "<div>Pat Realname at 42 Main Street</div>",
    });
    const out = body(
      `<iframe name='${blob}' id="ad_1"></iframe>` +
        '<div class="https://tracker.invalid/q">x</div>',
    );
    expect(out).not.toContain("shop.invalid");
    expect(out).not.toContain("tracker.invalid");
    expect(out).not.toContain("Realname");
    expect(out).toContain('id="ad_1"');
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("a URL under a kept JSON key is scrubbed as data", () => {
    const out = body(
      '<script type="application/json">{"type":"https://tracker.invalid/p","key":"ok"}</script>',
    );
    expect(out).not.toContain("tracker.invalid");
    expect(out).toContain('"key":"ok"');
  });

  test("a time-zone word at the start of an id stays an id", () => {
    const out = body("<p>Pack - ET4M8N2K6R1W5Q9</p><p>9PT3W8M2Q6Z4N1</p>");
    expect(out).not.toContain("UTC");
    expect(out).not.toContain("ET4M8N2K6R1W5Q9");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("scientific notation keeps a lower-case exponent and fresh digits", () => {
    const out = body("<p>2.7182818284590452E-4</p>");
    // 16 decimals: a full-precision value, so the run becomes a placeholder.
    expect(out).toMatch(/^<p>\d\.9\d{15}e-\d<\/p>$/);
    expect(out).not.toContain("7182818284590452");
  });

  test("percent-encoded tokens and ids are judged decoded", () => {
    const out = body(
      '<p data-x="a=b%7CQ42W7NZ8KD&amp;t=GhQ3%2Bk9Lm2Pq8%2FzW4xYt7Rv%3D&amp;s=x%2FB0WXYZ9876">x</p>',
    );
    expect(out).not.toContain("Q42W7NZ8KD");
    expect(out).not.toContain("k9Lm2Pq8");
    expect(out).not.toContain("B0WXYZ9876");
    expect(out).toContain("%7CFAKEID");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("a UUID or order id right after a hyphen is still mapped (and still audited)", () => {
    const raw =
      '<div class="w pd_rd_r-abcdef01-2345-4678-9abc-def012345678 c-f">x</div>' +
      '<div class="order-112-1234567-7654321">y</div>';
    expect(auditScrubbed(raw).map((f) => f.rule)).toEqual(
      expect.arrayContaining(["uuid", "order-id"]),
    );
    const out = body(raw);
    expect(out).not.toContain("def012345678");
    expect(out).not.toContain("7654321");
    expect(out).toContain("pd_rd_r-00000000-0000-4000-8000-");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("an id-reference attribute holding text is scrubbed; real id lists are kept", () => {
    const out = body(
      '<div id="lbl-1">a</div><div id="lbl-2">b</div>' +
        '<ul aria-labelledby="lbl-1 lbl-2">x</ul>' +
        '<ul aria-labelledby="Customers Who Bought Zorbo Widget Also Bought">y</ul>',
    );
    expect(out).toContain('aria-labelledby="lbl-1 lbl-2"');
    expect(out).not.toContain("Zorbo");
  });

  test("an id seen in an id query parameter is replaced where it is echoed", () => {
    const out = body(
      '<a href="/auto-deliveries/?shipId=qwzrtplmnbvx">m</a>' +
        '<script type="application/json">{"qwzrtplmnbvx":"2 items","k":"qwzrtplmnbvx"}</script>' +
        '<div data-x="ship qwzrtplmnbvx">z</div>',
    );
    expect(out).not.toContain("qwzrtplmnbvx");
    expect(out).toMatch(/\{"FAKETOKEN\d{4}":/);
  });

  test("short media and instance ids in kept values become tokens; camelCase names stay", () => {
    const out = body(
      '<div data-csa-c-content-id="42Ab3dE+fGL">a</div><div data-csa-c-content-id="19qR-tUvwXL">b</div>' +
        '<div class="__xYz4kQ7mNp2W displayAddressLine1 acBadge_Desktop">c</div>',
    );
    expect(out).not.toContain("42Ab3dE");
    expect(out).not.toContain("19qR-tUvwXL");
    expect(out).not.toContain("xYz4kQ7mNp2W");
    expect(out).toContain("displayAddressLine1 acBadge_Desktop");
  });

  test("a token that is only opaque once decoded is replaced whole", () => {
    const out = body('<p data-x="t=k9Lm%41Pq8zW4xYt7Rv1a2b">x</p>');
    expect(out).toContain("FAKETOKEN");
    expect(out).not.toContain("zW4xYt7");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("a non-punctuation escape is data and an id after it is still mapped", () => {
    const out = body('<p data-x="q=%41Q42W7NZ8KD">x</p>');
    expect(out).toContain("%5FFAKEID");
    // The audit gives no exemption after an escape that decodes to a letter.
    expect(auditScrubbed("<p>%41Q42W7NZ8KD</p>").map((f) => f.rule)).toContain("opaque-id");
    expect(auditScrubbed("<p>%AB5550001234</p>").map((f) => f.rule)).toContain("opaque-id");
    // A punctuation escape before digits is not an id ("%3A" is ":").
    expect(auditScrubbed("<p>%3A5550001234</p>").map((f) => f.rule)).not.toContain("opaque-id");
  });

  test("a glued UUID is mapped and not re-randomized into a UUID shape", () => {
    const out = body(
      '<label for="checkbox1f2e3d4c-5b6a-4789-8abc-0123456789ab">u</label>' +
        "<p>wxyzq9f8e7d6c-5555-6666-7777-888899990000 13.1a2b3c4d-1111-2222-3333-444455556666</p>",
    );
    expect(out).toMatch(/[a-z]+00000000-0000-4000-8000-0000000000\d\d /);
    expect(out).not.toContain("1f2e3d4c");
    expect(out).not.toContain("1a2b3c4d");
    expect(auditScrubbed(out)).toEqual([]);
  });

  test("a long ISO fraction is cut to 3 digits", () => {
    expect(body("<p>2019-03-04T05:06:07.123456789Z</p>")).toMatch(/T\d\d:\d\d:\d\d\.000Z/);
  });

  test("caseless and full-width words become lower-case lorem", () => {
    const out = body("<p>123\u30c6\u30b9\u30c8\u30c7\u30fc\u30bf \uff21\uff22\uff23\uff24 x</p>");
    expect(out).toMatch(/^<p>[A-Za-z ]+<\/p>$/);
  });

  test("ISBN-shaped values in asin-named attributes become fake ASINs", () => {
    const out = body(
      '<div asin="0123456789" data-bookasin="0123456780" data-asins=\'["0123456781","B0ABCD1234"]\'>x</div>',
    );
    expect(out).toContain('asin="B0FAKE');
    expect(out).toContain('data-bookasin="B0FAKE');
    expect(out).not.toMatch(/012345678/);
    expect(auditScrubbed(out)).toEqual([]);
  });
});

describe("structure kept for parsers (invented values)", () => {
  test("unit and frequency words survive, but not in address blocks", () => {
    expect(body("<p>1 unit every 3 months</p>")).toMatch(/^<p>1 unit every [2-9] months<\/p>$/);
    expect(body("<p>Purchased 2 times</p>")).toMatch(/^<p>Purchased [2-9] times<\/p>$/);
    expect(body("<p>the 90-day median</p>")).toMatch(
      /^<p>[A-Za-z]+(?: [a-z]+)* \d\d-day [a-z]+(?: [a-z]+)*<\/p>$/,
    );
    const addr = body('<div class="shipping-address"><span>12 Every Day Rd</span></div>');
    expect(addr).not.toContain("Every Day");
  });

  test("a trailing label is kept after a leading one", () => {
    expect(body("<p>Only 3 left in stock - order soon.</p>")).toMatch(
      /^<p>Only [2-9] left in stock - order soon\.<\/p>$/,
    );
    expect(body("<p>Only 37 left in stock - order soon.</p>")).toMatch(
      /^<p>Only \d\d left in stock - order soon\.<\/p>$/,
    );
  });

  test("a label may lead a later ' - ' clause; a date range is not split", () => {
    expect(body("<p>1 month - view data going back to Mar 3, 2019</p>")).toMatch(
      /^<p>1 month - view data going back to [A-Z][a-z]{2} \d{1,2}, \d{4}<\/p>$/,
    );
    expect(body("<p>Feb 3 - 7</p>")).toMatch(
      /^<p>[A-Z][a-z]{2} \d{1,2} - (?:[A-Z][a-z]{2} )?\d{1,2}<\/p>$/,
    );
  });

  test("a card network next to card digits becomes one constant brand", () => {
    expect(body("<p>Mastercard ending in 4321</p>")).toBe("<p>Card ending in 0000</p>");
    // "Prime" before a free word is not a label lead: the word is free text too.
    expect(body("<p>Prime Amex \u2022\u2022\u2022\u2022 4321</p>")).toMatch(
      /^<p>[A-Z][a-z]+ Card &#x2022;&#x2022;&#x2022;&#x2022; 0000<\/p>$/,
    );
  });

  test("long digit runs in kept values are replaced, short ones kept", () => {
    const out = body('<div id="widget-123456789" class="a-col-12">x</div>');
    expect(out).toMatch(/id="widget-\d{9}"/);
    expect(out).not.toContain("123456789");
    expect(out).toContain('class="a-col-12"');
  });

  test("a kept value holding a relative URL or a query string is data", () => {
    const out = body('<div data-id="/Pat-Realname-Widget/dp/B0ABCD1234?ref=x">x</div>');
    expect(out).not.toContain("Realname");
    expect(out).not.toContain("B0ABCD1234");
  });

  test("HTML inside JSON is scrubbed as markup, structure kept", () => {
    const pop = JSON.stringify({
      inlineContent:
        '<div class="a-row"><span>Refund subtotal</span><span>Pat Realname</span></div>',
    });
    const out = body(`<span data-a-popover='${pop}'>x</span>`);
    const attr = /data-a-popover="([^"]*)"/.exec(out)?.[1] ?? "";
    const json = JSON.parse(
      attr
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    ) as { inlineContent: string };
    expect(json.inlineContent).toMatch(
      /^<div class="a-row"><span>[A-Za-z ]+<\/span><span>[A-Za-z ]+<\/span><\/div>$/,
    );
    expect(json.inlineContent).not.toContain("Realname");
  });

  test("structural id prefixes keep the prefix, the rest becomes a token", () => {
    const out = body('<div id="CardInstanceAbCdEfGhIjKlMnOpQr">x</div>');
    expect(out).toMatch(/id="CardInstanceFAKETOKEN\d{4}"/);
  });

  test("'city' inside a word is not an address hint", () => {
    expect(
      body('<span class="sc-product-scarcity">Only 3 left in stock - order soon.</span>'),
    ).toMatch(/>Only [2-9] left in stock - order soon\.</);
  });

  test("reduce drops chrome and hidden rails, keeps hidden form state, collapses whitespace", () => {
    const html =
      '<!DOCTYPE html><html><body><div id="navFooter"><a>About Lorem</a></div>' +
      '<div class="right-rail" data-rf-hidden="1"><p>Rail text</p></div>' +
      '<div class="right-rail" data-rf-hidden="1"><input type="hidden" name="k" value="1"></div>' +
      "<p>\n\n   Sold by    \n  </p></body></html>";
    const full = scrubCapture({ ...sampleCapture(), html, fragments: undefined }).capture.html;
    const small = scrubCapture({ ...sampleCapture(), html, fragments: undefined }, { reduce: true })
      .capture.html;
    expect(full).toContain('id="navFooter"');
    expect(small).not.toContain('id="navFooter"');
    expect(small.match(/right-rail/g)?.length).toBe(1);
    expect(small).toContain('name="k"');
    expect(small).toContain("<p>\nSold by\n</p>");
    expect(small.length).toBeLessThan(full.length);
  });
});

describe("no shape fingerprint survives (invented values)", () => {
  const words = (t: string) =>
    t
      .trim()
      .split(/\s+/)
      .filter((w) => w !== "");

  test("free text gets a random word count, random lengths and generic case", () => {
    const title = "ZORBLAX Quantum-Fluff Widget, 12-Pack (Teal) - XL 3000mAh";
    const counts = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const out = /^<p>(.*)<\/p>$/.exec(body(`<p>${title}</p>`, `shape-${i}`))?.[1] ?? "";
      expect(out).not.toMatch(/ZORBLAX|Fluff|Teal|3000/i);
      expect(out).not.toMatch(/[A-Z]{2}/);
      // Punctuation inside a run goes; separators next to a bracket may stay.
      expect(out).not.toMatch(/,|\w-\w/);
      counts.add(words(out.replace(/[()]/g, " ")).length);
    }
    expect(counts.size).toBeGreaterThan(2);
  });

  test("a one-word label before free words does not survive; label plus value does", () => {
    const out = body(
      "<p>Amazon Zorblax Fluff Widget</p><p>Brand: Zorblax</p><p>Only 4 left in stock - order soon.</p>",
    );
    expect(out).not.toContain("Amazon");
    expect(out).not.toContain("Zorblax");
    expect(out).toContain("<p>Brand: ");
    expect(out).toMatch(/<p>Only [2-9] left in stock - order soon\.<\/p>/);
  });

  test("an item count stays, so parsers can check it against the items present", () => {
    expect(body("<p>Saved for later (7 items)</p>")).toBe("<p>Saved for later (7 items)</p>");
    expect(body('<div data-saved-item-quantity="7">x</div>')).toContain(
      'data-saved-item-quantity="7"',
    );
  });
});

describe("dates, counts, amounts and ratings are re-drawn (invented values)", () => {
  test("the date offset is 3..6 years either way and never close to whole years", () => {
    for (let i = 0; i < 60; i++) {
      const ctx = createContext(`dates-${i}`, "2026-03-04T05:06:07Z");
      expect(Math.abs(ctx.shiftDays)).toBeGreaterThanOrEqual(MIN_SHIFT_DAYS);
      expect(Math.abs(ctx.shiftDays)).toBeLessThanOrEqual(MAX_SHIFT_DAYS);
      expect(yearGap(ctx.shiftDays)).toBeGreaterThanOrEqual(MIN_YEAR_GAP_DAYS);
    }
  });

  test("each distinct date gets its own jitter; one date maps one way", () => {
    let changed = 0;
    for (let i = 0; i < 20; i++) {
      const out = body("<p>March 3, 2019</p><p>March 10, 2019</p><p>March 3, 2019</p>", `j-${i}`);
      const ds = [...out.matchAll(/<p>([A-Z][a-z]+ \d{1,2}, \d{4})<\/p>/g)].map((m) =>
        Date.parse(`${m[1]} UTC`),
      );
      expect(ds).toHaveLength(3);
      expect(ds[0]).toBe(ds[2]);
      const gap = ((ds[1] ?? 0) - (ds[0] ?? 0)) / DAY_MS;
      expect(Math.abs(gap - 7)).toBeLessThanOrEqual(6);
      if (gap !== 7) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  test("a year select keeps 3 year options around the selected one", () => {
    const opts = [2014, 2015, 2016, 2017, 2018, 2019]
      .map((y) => `<option value="year-${y}"${y === 2017 ? " selected" : ""}>${y}</option>`)
      .join("");
    const out = body(
      `<select name="timeFilter"><option value="last30">last 30 days</option>${opts}</select>`,
    );
    expect(out.match(/<option/g)).toHaveLength(4);
    expect(out).toMatch(/<option value="year-\d{4}" selected="">\d{4}<\/option>/);
    expect(out).not.toMatch(/201[4-9]/);
  });

  test("amounts and counts move in magnitude, consistently per value", () => {
    const ratios: number[] = [];
    for (let i = 0; i < 30; i++) {
      const out = body("<p>$40.00</p><p>$40.00</p><p>1,500 ratings</p>", `amt-${i}`);
      const prices = [...out.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) =>
        Number((m[1] ?? "").replace(/,/g, "")),
      );
      expect(prices[0]).toBe(prices[1]);
      ratios.push((prices[0] ?? 0) / 40);
      const r = (prices[0] ?? 0) / 40;
      expect(r <= 0.8 || r >= 1.25).toBe(true);
      const n = Number(/<p>([\d,]+) ratings<\/p>/.exec(out)?.[1]?.replace(/,/g, ""));
      expect(n / 1500).toBeGreaterThanOrEqual(0.29);
      expect(n / 1500).toBeLessThanOrEqual(3.01);
    }
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.29);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(3.01);
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeGreaterThan(2);
  });

  test("split price spans agree with the offscreen price", () => {
    const out = body(
      '<span class="a-price"><span class="a-offscreen">$1,234.56</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">1,234<span class="a-price-decimal">.</span></span><span class="a-price-fraction">56</span></span></span>',
    );
    const off = /a-offscreen">\$([\d,]+)\.(\d{2})</.exec(out);
    expect(off).not.toBeNull();
    expect(out).toContain(`a-price-whole">${off?.[1]}<`);
    expect(out).toContain(`a-price-fraction">${off?.[2]}<`);
    expect(off?.[1]).not.toBe("1,234");
  });

  test("star classes follow the synthetic rating", () => {
    for (let i = 0; i < 10; i++) {
      const out = body(
        '<i class="a-icon a-icon-star a-star-4-5"><span class="a-icon-alt">4.5 out of 5 stars</span></i>',
        `star-${i}`,
      );
      const r = Number(/>(\d\.\d) out of 5 stars</.exec(out)?.[1]);
      const cls = /a-star-(\d)(-5)?/.exec(out);
      expect(Number(cls?.[1])).toBe(Math.floor(r));
      expect(cls?.[2] === "-5").toBe(r - Math.floor(r) >= 0.5);
    }
  });

  test("lone digits are permuted the same way in text and attributes", () => {
    const out = body(
      '<select><option value="3" selected>3</option></select><span data-quantity="3">Qty: 3</span>',
    );
    const d = /<option value="(\d)"/.exec(out)?.[1];
    expect(out).toContain(`>${d}</option>`);
    expect(out).toContain(`data-quantity="${d}"`);
    expect(out).toContain(`Qty: ${d}`);
  });

  test("experiment tokens in class names become a fixed placeholder; fake ids stay", () => {
    const out = body(
      '<div class="a-aui_31337-c r-4f1e2d0 a-spacing-mini asin-id-B0ABCD1234">x</div>',
    );
    expect(out).toContain("a-aui_0000-c");
    expect(out).toContain("r-0000");
    expect(out).toContain("a-spacing-mini");
    expect(out).toMatch(/asin-id-B0FAKE[0-9A-Z]{4}/);
  });
});

describe("blind review findings (invented values)", () => {
  test("F1: card last digits and expiry in embedded JSON are fixed fakes", () => {
    const json = JSON.stringify({
      paymentMethodNumber: { prefix: "**", lastDigits: "4321" },
      paymentMethodExpirationDate: { year: 2031, month: 7 },
      card: { last4: 9876, expMonth: 4, expYear: 2029 },
    });
    const out = body(`<script type="application/json">${json}</script>`);
    const data = JSON.parse(/<script[^>]*>(.*)<\/script>/.exec(out)?.[1] ?? "{}") as Record<
      string,
      Record<string, unknown>
    >;
    expect(data["paymentMethodNumber"]?.["lastDigits"]).toBe("0000");
    expect(data["paymentMethodExpirationDate"]).toEqual({ year: 2030, month: 1 });
    expect(data["card"]).toEqual({ last4: 0, expMonth: 1, expYear: 2030 });
  });

  test("F2: a year-less weekday fits the year the page implies (nearest captured_at)", () => {
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (let i = 0; i < 20; i++) {
      const out = body("<p>Arriving Thu, Mar 9</p><p>Thursday, March 9, 2027</p>", `wd-${i}`);
      const a = /Arriving ([A-Z][a-z]{2}), ([A-Z][a-z]{2}) (\d{1,2})/.exec(out);
      expect(a).not.toBeNull();
      const day = (y: number) => Date.parse(`${a?.[2]} ${a?.[3]}, ${y} UTC`);
      const epoch = Date.parse(SYNTHETIC_CAPTURED_AT);
      const y =
        [2019, 2020, 2021].sort((p, q) => Math.abs(day(p) - epoch) - Math.abs(day(q) - epoch))[0] ??
        2020;
      expect(names[new Date(day(y)).getUTCDay()]?.slice(0, 3)).toBe(a?.[1]);
      const full = /([A-Z][a-z]+day), ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(out);
      expect(names[new Date(Date.parse(`${full?.[2]} UTC`)).getUTCDay()]).toBe(full?.[1]);
    }
  });

  test("F3: per-render lower-case tokens after an underscore become a placeholder", () => {
    const out = body(
      '<div id="a-popover-feedback-popup_ab12cd34ef">x</div><div name="p13n-sc-shoveler_9zzq8wxv7u">y</div>' +
        '<div data-csa-c-content-id="nav_cs_bestsellers">z</div>',
    );
    expect(out).toContain('id="a-popover-feedback-popup_rftoken"');
    expect(out).toContain('name="p13n-sc-shoveler_rftoken"');
    expect(out).toContain("nav_cs_bestsellers");
    expect(out).not.toMatch(/ab12cd34ef|9zzq8wxv7u/);
  });

  test("F4: numeric path segments in links are replaced", () => {
    const out = body('<a href="/gp/bestsellers/zorbo-gear/12345678/ref=zg_x">a</a>');
    expect(out).toMatch(/href="\/gp\/bestsellers\/[A-Za-z-]+\/10000000\/ref=rf"/);
  });

  test("F5: long numeric ids under id-like JSON keys are obvious placeholders", () => {
    const out = body(
      '<script type="application/json">{"legacyId":1234567890123,"shipID":"7654321","count":5}</script>',
    );
    expect(out).toContain('"legacyId":9000000000001');
    expect(out).toContain('"shipID":"9000001"');
    expect(out).toContain('"count":5');
  });

  test("F6: pagination keeps 3 numbered pages, labelled in order, and no extent", () => {
    const li = (n: number, sel = false) =>
      `<li class="${sel ? "a-selected" : "a-normal"}"><a href="/your-orders/orders?page=${n - 1}">${n}</a></li>`;
    const pages = [1, 2, 3, 4, 5, 6, 7].map((n) => li(n, n === 1)).join("");
    const out = body(
      `<ul class="a-pagination"><li class="a-disabled">Previous</li>${pages}<li class="a-disabled">...</li>${li(42)}<li class="a-last"><a href="/your-orders/orders?page=1">Next</a></li></ul>`,
    );
    expect([...out.matchAll(/<a href="[^"]*">(\d+)<\/a>/g)].map((m) => m[1])).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(out).not.toContain("...");
    expect(out).not.toContain("42");
    expect(out).toContain(">Next<");
  });

  test("F7: a filter year agrees between URL and select and is 3+ years from the real one", () => {
    for (let i = 0; i < 20; i++) {
      const out = body(
        '<select name="timeFilter"><option value="year-2016" selected>2016</option></select>' +
          '<a href="/your-orders/orders?timeFilter=year-2016&page=1">n</a>',
        `fy-${i}`,
      );
      const opt = /<option value="year-(\d{4})"[^>]*>(\d{4})</.exec(out);
      const url = /timeFilter=year-(\d{4})/.exec(out);
      expect(opt?.[1]).toBe(opt?.[2]);
      expect(url?.[1]).toBe(opt?.[1]);
      expect(Math.abs(Number(url?.[1]) - 2016)).toBeGreaterThanOrEqual(2);
    }
  });

  test("F8: a code split over spans scrubs like the same code written whole", () => {
    const out = body("<p>: 012345678901</p><div><span>012345</span><span>678901</span></div>");
    const whole = /: (\d{12})</.exec(out)?.[1];
    const split = /<div><span>(\d{6})<\/span><span>(\d{6})<\/span><\/div>/.exec(out);
    expect(whole).toMatch(/^9\d{11}$/);
    expect(`${split?.[1]}${split?.[2]}`).toBe(whole);
  });
});

describe("blind review 2 findings (invented values)", () => {
  test("F5: extension-injected nodes are stripped, and the gate fails on any left", () => {
    const html =
      '<!DOCTYPE html><html><body><div id="main">x</div>' +
      '<div id="zorboClipperHighlightShadowHost"></div><span class="grammarly-btn">g</span>' +
      '<div data-src="chrome-extension://abcdefghijklmnop/x.png">e</div>' +
      "<next-route-announcer>n</next-route-announcer></body></html>";
    const out = scrubCapture({ ...sampleCapture(), html, fragments: undefined }).capture.html;
    expect(out).not.toMatch(/Clipper|grammarly|chrome-extension/i);
    expect(out).toContain('id="main"');
    expect(out).toContain("<next-route-announcer>");
    const rules = (h: string) => auditScrubbed(h).map((f) => f.rule);
    expect(rules('<div id="xRemnoteClipperShadowHost"></div>')).toContain("extension");
    expect(rules('<div class="lastpass-icon"></div>')).toContain("extension");
    expect(rules("<p>see moz-extension://x</p>")).toContain("extension");
    expect(rules('<div id="honey-jar-product">text about honey</div>')).toContain("extension");
    expect(rules("<p>honey and clippers in text are fine</p>")).not.toContain("extension");
  });

  test("F1: 9+ digit runs and 10+ decimal floats become placeholders everywhere", () => {
    const out = body(
      '<div data-ad-id="123412341234123" data-x="B0ABCD1234:432143214321432">a</div>' +
        '<script type="application/json">{"qualifier":"1357913579","rs":1.2345678901234567,"n":123456789012,"ok":12}</script>',
    );
    expect(out).not.toMatch(/123412341234123|432143214321432|1357913579|1234567890|123456789012/);
    expect(out).toMatch(/data-ad-id="9\d{14}"/);
    expect(out).toMatch(/B0FAKE[0-9A-Z]{4}:9\d{14}/);
    expect(out).toContain('"rs":1.5');
    expect(out).toMatch(/"n":9\d{11}/);
    expect(out).toMatch(/"ok":\d{2}[,}]/);
  });

  test("F2: digits glued to free words and slugs go with the words", () => {
    const out = body(
      '<p>Zorbo Widget (Gizmo-12321) 6.8"-9.9" 1/4" 74th</p><a href="/Zorbo-Widget-12x34-5678/dp/B0ABCD1234">x</a>',
    );
    expect(out).not.toMatch(/12321|6\.8|9\.9|1\/4|74th|12x34|5678/);
    expect(body("<p>Only 3 left in stock - order soon.</p>")).toMatch(/Only [2-9] left/);
    expect(body("<p>the 90-day median</p>")).toMatch(/\d\d-day/);
  });

  test("notes: widget id classes, account flags and body cohort classes", () => {
    const html =
      '<!DOCTYPE html><html class="a-js"><body class="a-m-us rufus-docked-only a-spacing-none"><div class="celwidget pd_rd_w-Ab3cD">x</div>' +
      '<script type="application/json">{"isPinnacleCustomer":true,"hasMultipleAddresses":true,"isRfySubscriptionsSwapEnabled":true,"isSelected":true}</script></body></html>';
    const out = scrubCapture({ ...sampleCapture(), html, fragments: undefined }).capture.html;
    expect(out).toContain("pd_rd_w-rfwid");
    expect(out).toContain('"isPinnacleCustomer":false');
    expect(out).toContain('"hasMultipleAddresses":false');
    expect(out).toContain('"isRfySubscriptionsSwapEnabled":false');
    expect(out).toContain('"isSelected":true');
    expect(out).toMatch(/<body class="a-m-us a-spacing-none">/);
  });

  test("notes: at most two synthetic names per fixture", () => {
    const people = ["Ann Zorbo", "Bea Quux", "Cid Plonk", "Dov Frob", "Eve Wibble"];
    const out = body(people.map((p) => `<span class="a-profile-name">${p}</span>`).join(""));
    const names = new Set(
      [...out.matchAll(/a-profile-name">([^<]+)</g)].map((m) => (m[1] ?? "").split(" ")[0]),
    );
    expect(names.size).toBeLessThanOrEqual(2);
  });

  test("the date offset never keeps a real month and day", () => {
    for (let i = 0; i < 200; i++) {
      const ctx = createContext(`md-${i}`, "2026-05-06T07:08:09Z");
      for (const [m, d] of [
        [0, 1],
        [1, 29],
        [5, 15],
        [11, 31],
      ] as const) {
        const real = { y: 2024, m, d };
        const fake = shift(ctx, real);
        expect(fake.m === real.m && fake.d === real.d, `seed ${i} ${m}/${d}`).toBe(false);
      }
    }
  });
});

describe("audit reads attributes, not escaped markup inside them", () => {
  test("escaped markup in a value is not an attribute of the tag", () => {
    const esc =
      '<iframe id="a" name="{&quot;h&quot;:&quot;&lt;img src=x style=y onclick=z&gt;&quot;}"></iframe>';
    const rules = auditScrubbed(esc).map((f) => f.rule);
    expect(rules).not.toContain("iframe-src");
    expect(rules).not.toContain("style-attr");
    expect(rules).not.toContain("event-handler");
  });

  test("real attributes are still caught, and an unbalanced quote is flagged", () => {
    const rules = (h: string) => auditScrubbed(h).map((f) => f.rule);
    expect(rules('<iframe title="x" src="/y"></iframe>')).toContain("iframe-src");
    expect(rules('<div title="x"style="c">x</div>')).toContain("style-attr");
    expect(rules('<a href="#" onclick="z">x</a>')).toContain("event-handler");
    expect(rules('<div title="x style=c>x</div>')).toContain("unbalanced-quote");
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
