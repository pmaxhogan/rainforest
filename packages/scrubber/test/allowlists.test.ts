import { describe, expect, test } from "vitest";
import {
  DROPPED_ATTRS,
  DROPPED_ELEMENTS,
  IMAGE_URL_ATTRS,
  KEPT_VALUE_ATTRS,
  LABELS,
  SAFE_LITERALS,
  URL_ATTRS,
  parseLabels,
} from "../src/index.ts";

// Hardcoded on purpose: these lists decide what survives scrubbing. Adding or removing an
// entry must fail this test so the change is deliberate and reviewed.
const EXPECTED_KEPT_VALUE_ATTRS = [
  "id",
  "class",
  "role",
  "type",
  "name",
  "for",
  "data-rf-hidden",
  "data-component-type",
  "data-cel-widget",
  "data-feature-name",
  "data-csa-c-type",
  "data-csa-c-slot-id",
  "data-hook",
  "data-action",
  "data-a-expander-name",
  "data-cy",
  "method",
  "target",
  "rel",
  "dir",
  "lang",
  "tabindex",
  "colspan",
  "rowspan",
  "scope",
  "headers",
  "width",
  "height",
  "autocomplete",
  "hidden",
  "disabled",
  "checked",
  "selected",
  "readonly",
  "multiple",
  "required",
  "maxlength",
  "size",
  "charset",
  "aria-hidden",
  "aria-expanded",
  "aria-haspopup",
  "aria-live",
  "aria-modal",
  "aria-checked",
  "aria-selected",
  "aria-disabled",
  "aria-level",
  "aria-current",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "aria-owns",
  "aria-pressed",
  "aria-atomic",
  "aria-relevant",
  "aria-posinset",
  "aria-setsize",
  "aria-orientation",
  "xmlns",
  "xmlns:xlink",
  "viewbox",
  "focusable",
  "preserveaspectratio",
  "d",
  "fill",
  "stroke",
  "points",
  "transform",
];

const EXPECTED_IMAGE_URL_ATTRS = [
  "src",
  "srcset",
  "poster",
  "background",
  "data-src",
  "data-srcset",
  "data-old-hires",
  "data-a-hires",
];

const EXPECTED_DROPPED_ATTRS = [
  "style",
  "nonce",
  "integrity",
  "srcdoc",
  "ping",
  "crossorigin",
  "referrerpolicy",
];

const EXPECTED_DROPPED_ELEMENTS = [
  "style",
  "link",
  "noscript",
  "object",
  "embed",
  "applet",
  "param",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "frameset",
];

const EXPECTED_SAFE_LITERALS = [
  "",
  "true",
  "false",
  "on",
  "off",
  "yes",
  "no",
  "none",
  "null",
  "auto",
  "_blank",
  "_self",
  "_top",
  "_parent",
  "0",
  "1",
  "-1",
];

function exactly(live: readonly string[], expected: readonly string[]) {
  expect([...live].sort()).toEqual([...expected].sort());
  for (const e of expected) expect(live).toContain(e);
}

describe("security-relevant allowlists", () => {
  test("kept attribute values", () => exactly(KEPT_VALUE_ATTRS, EXPECTED_KEPT_VALUE_ATTRS));
  test("image URL attributes", () => exactly(IMAGE_URL_ATTRS, EXPECTED_IMAGE_URL_ATTRS));
  test("dropped attributes", () => exactly(DROPPED_ATTRS, EXPECTED_DROPPED_ATTRS));
  test("dropped elements", () => exactly(DROPPED_ELEMENTS, EXPECTED_DROPPED_ELEMENTS));
  test("safe literal values", () => exactly(SAFE_LITERALS, EXPECTED_SAFE_LITERALS));

  test("no attribute is both kept and rewritten or dropped", () => {
    for (const a of KEPT_VALUE_ATTRS) {
      expect(URL_ATTRS).not.toContain(a);
      expect(DROPPED_ATTRS).not.toContain(a);
    }
    for (const a of IMAGE_URL_ATTRS) expect(URL_ATTRS).toContain(a);
  });

  test("text-bearing attributes are never kept verbatim", () => {
    for (const a of ["alt", "title", "aria-label", "placeholder", "value", "content", "label"]) {
      expect(KEPT_VALUE_ATTRS).not.toContain(a);
    }
  });
});

describe("label allowlist", () => {
  const texts = LABELS.map((l) => l.text);
  test("carries the structural labels parsers anchor on", () => {
    for (const label of [
      "Sponsored",
      "Add to Cart",
      "In Stock",
      "Currently unavailable",
      "Ships from",
      "Sold by",
      "Order placed",
      "Total",
      "Subscribe & Save",
      "Deliver to",
      "Returns",
      "out of 5 stars",
      "ratings",
      "bought in past month",
      "Typical price",
      "List Price",
      "Limited time deal",
      "Coupon",
      "FREE delivery",
      "Prime",
      "Qty:",
      "Save for later",
      "Delete",
      "Verified Purchase",
      "Reviewed in the United States on",
      "Helpful",
      "Monday",
      "Sunday",
      "January",
      "December",
    ]) {
      expect(texts).toContain(label);
    }
  });

  test("parser understands kinds and rejects bad lines", () => {
    expect(parseLabels("# c\n\nSold by\nDeliver to | name-or-place\n")).toEqual([
      { text: "Sold by", kind: null },
      { text: "Deliver to", kind: "name-or-place" },
    ]);
    expect(() => parseLabels("Ship to | address\n")).toThrow(/unknown kind/);
    expect(() => parseLabels("Deliver to 99999\n")).toThrow(/numbers/);
  });
});
