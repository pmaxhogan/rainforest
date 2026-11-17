import { FAKE } from "@rainforest/core";
import { describe, expect, test } from "vitest";
import {
  ALLOWED_HOSTS,
  FAKE_RANGES,
  SCRIPT_TYPES,
  SYNTHETIC,
  auditText,
  describeFinding,
  isOpaque,
} from "../src/rules.mjs";

// Hardcoded on purpose: adding or removing an entry must fail this test.
const EXPECTED_SCRIPT_TYPES = ["application/json", "a-state"];
const EXPECTED_HOSTS = ["www.example.com", "images.example.com", "www.w3.org"];

function rules(text: string, html = false): string[] {
  return auditText(text, { html }).map((f) => f.rule);
}

describe("shared rules", () => {
  test("FAKE_RANGES mirrors core FAKE exactly", () => {
    expect(FAKE_RANGES.asinPattern.source).toBe(FAKE.asinPattern.source);
    expect(FAKE_RANGES.asinPattern.flags).toBe(FAKE.asinPattern.flags);
    expect(FAKE_RANGES.orderIdPattern.source).toBe(FAKE.orderIdPattern.source);
    expect(FAKE_RANGES.phonePattern.source).toBe(FAKE.phonePattern.source);
    expect(FAKE_RANGES.emailDomain).toBe(FAKE.emailDomain);
    expect([...FAKE_RANGES.zips]).toEqual([...FAKE.zips]);
    expect(FAKE_RANGES.imageUrl).toBe(FAKE.imageUrl);
    expect(FAKE_RANGES.host).toBe(FAKE.host);
  });

  test("script type allowlist is exactly the expected list", () => {
    expect([...SCRIPT_TYPES].sort()).toEqual([...EXPECTED_SCRIPT_TYPES].sort());
    for (const t of EXPECTED_SCRIPT_TYPES) expect(SCRIPT_TYPES).toContain(t);
  });

  test("host allowlist is exactly the expected list", () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual([...EXPECTED_HOSTS].sort());
    for (const h of EXPECTED_HOSTS) expect(ALLOWED_HOSTS).toContain(h);
  });

  test("every synthetic value the scrubber emits passes the audit", () => {
    const text = [
      SYNTHETIC.city,
      `${SYNTHETIC.city}, ${SYNTHETIC.state} 00001`,
      `Deliver to ${SYNTHETIC.names[0]} - ${SYNTHETIC.city} 00002`,
      SYNTHETIC.street,
      `ending in ${SYNTHETIC.cardLast4}`,
      `${SYNTHETIC.idPrefix}0001 ${SYNTHETIC.tokenPrefix}0001 ${SYNTHETIC.uuidPrefix}000000000001`,
      "B0FAKE0000 X0FAKE00AB 000-0000000-0000001 user1@example.com 555-555-0100 (555) 555-0199",
      FAKE_RANGES.imageUrl,
      `${FAKE_RANGES.host}/dp/B0FAKE0001?k=lorem`,
    ].join("\n");
    expect(auditText(text, { html: true })).toEqual([]);
  });
});

describe("auditText catches each leak class", () => {
  const cases: [string, string, string][] = [
    ["asin", "see B0ABCD1234 here", "asin"],
    ["lowercase asin", "/dp/b0abcd1234/", "asin"],
    ["isbn asin in a product path", "/dp/0123456789/ref", "isbn-asin"],
    ["isbn asin in a key", '"asin":"0123456789"', "isbn-asin"],
    ["order id", "Order 123-1234567-1234567", "order-id"],
    ["digital order id", "D01-7654321-7654321", "order-id"],
    ["email", "zed.placeholder@mail.invalid", "email"],
    ["phone", "call (999) 555-1234", "phone"],
    ["dashed phone", "999-555-1234", "phone"],
    ["zip plus four", "99999-1234", "zip"],
    ["zip after state", "Nowhere Falls, ZZ 99999", "zip"],
    ["zip in a key", '"postalCode":"99999"', "zip"],
    ["zip after deliver to", "Deliver to Zed 99999", "zip"],
    ["zip in glow widget", '<span id="glow-ingress-line2">Lorem 99999</span>', "zip"],
    ["card last four", "Visa ending in 4321", "card-last4"],
    ["masked card", "****4321", "card-last4"],
    ["uuid", "4a2b6c8d-1234-4abc-9def-0123456789ab", "uuid"],
    ["opaque blob", 'value="hGxM3Y8cH8Z5aBcDeFgHiJkL0mNoPq12345="', "opaque-blob"],
    ["hex blob", "a3f9c0d2e4b6a8c0d2e4f6a8b0c2d4e6", "opaque-blob"],
    ["upper id", "seller=A2QQQQ9QQQQ8QQ", "opaque-id"],
    ["foreign url host", "https://shop.invalid/dp/B0FAKE0000", "url-host"],
    ["protocol-relative host", '<img src="//img.invalid/x.jpg">', "url-host"],
    ["percent-encoded email", "u=zed%40mail.invalid", "email"],
    ["entity-encoded email", "zed&#64;mail.invalid", "email"],
    ["js-escaped url", '"https:\\/\\/shop.invalid\\/x"', "url-host"],
  ];
  for (const [label, text, rule] of cases) {
    test(label, () => expect(rules(text)).toContain(rule));
  }

  test("markup checks: scripts, styles, comments, handlers, iframes, meta", () => {
    expect(rules("<script>var a=1;</script>", true)).toContain("script");
    expect(rules('<script type="text/template">{}</script>', true)).toContain("script");
    expect(rules('<script type="a-state">{}</script>', true)).toContain("script");
    expect(rules('<script type="application/json" src="/x.js">{}</script>', true)).toContain(
      "script",
    );
    expect(rules('<script type="application/json">not json</script>', true)).toContain(
      "script-json",
    );
    expect(rules('<script type="application/json">{"a":1}', true)).toContain("script");
    expect(rules("<style>.a{}</style>", true)).toContain("element");
    expect(rules('<link rel="x" href="/y">', true)).toContain("element");
    expect(rules('<meta name="x" content="y">', true)).toContain("element");
    expect(rules("<!-- note -->", true)).toContain("comment");
    expect(rules('<a onclick="x()">', true)).toContain("event-handler");
    expect(rules('<p style="color:red">', true)).toContain("style-attr");
    expect(rules('<iframe src="/x"></iframe>', true)).toContain("iframe-src");
  });

  test("allowlisted data blobs and charset meta pass", () => {
    const ok =
      '<meta charset="utf-8"><script type="application/json">{"a":"b"}</script>' +
      '<script type="a-state" data-a-state="{&quot;key&quot;:&quot;k&quot;}">{"x":1}</script>';
    expect(auditText(ok, { html: true })).toEqual([]);
  });

  test("structural shapes are not opaque", () => {
    for (const s of [
      "s-result-item s-asin sg-col-0-of-12 s-widget-spacing-small",
      "_cDEzb_p13n-sc-css-line-clamp-3_g3dy1",
      "displayAddressAddressLine1",
      "displayAddressCityStateOrRegionPostalCode",
      "com/Posuere-Lacus-Pulvinar-Augue/dp/B0FAKE0000",
      "a-autoid-12-announce",
      "search_result_12",
      "9400111899223456789012",
    ]) {
      expect(isOpaque(s), s).toBe(false);
      expect(rules(s), s).not.toContain("opaque-blob");
    }
  });

  test("describeFinding never contains the matched value", () => {
    const [f] = auditText("zed.placeholder@mail.invalid");
    expect(f).toBeDefined();
    if (f === undefined) return;
    expect(describeFinding(f)).not.toContain("zed");
    expect(describeFinding(f)).not.toContain("invalid");
  });
});
