/**
 * Data-driven allowlists for the scrubber. Everything NOT listed is scrubbed or dropped,
 * so extending a list is the only way to let more through. The security-relevant lists
 * (kept attribute values, script types) are pinned by hardcoded-list tests.
 */
import { readFileSync } from "node:fs";

/**
 * Attributes whose VALUES are structural and kept, after the token pass (ASINs, order
 * ids, opaque tokens and ids are still mapped inside them). Names are lowercase.
 */
export const KEPT_VALUE_ATTRS: readonly string[] = [
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

/** Attributes holding a URL. Rewritten to the placeholder host with the path shape kept. */
export const URL_ATTRS: readonly string[] = [
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "cite",
  "background",
  "longdesc",
  "xlink:href",
  "data-src",
  "data-srcset",
  "data-old-hires",
  "data-a-hires",
  "data-href",
  "data-url",
];

/** URL attributes that always point at media: replaced by the placeholder image. */
export const IMAGE_URL_ATTRS: readonly string[] = [
  "src",
  "srcset",
  "poster",
  "background",
  "data-src",
  "data-srcset",
  "data-old-hires",
  "data-a-hires",
];

/** Attributes removed outright (styling, integrity, tracking, inline documents). */
export const DROPPED_ATTRS: readonly string[] = [
  "style",
  "nonce",
  "integrity",
  "srcdoc",
  "ping",
  "crossorigin",
  "referrerpolicy",
];

/** Elements removed with everything inside them. */
export const DROPPED_ELEMENTS: readonly string[] = [
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

/** Generic attribute values kept verbatim because they are enumerated, not data. */
export const SAFE_LITERALS: readonly string[] = [
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

/** URL path segments kept verbatim (lowercase compare). Others become synthetic slugs. */
export const PATH_SEGMENTS: readonly string[] = [
  "dp",
  "gp",
  "d",
  "aw",
  "s",
  "b",
  "product",
  "product-reviews",
  "customer-reviews",
  "offer-listing",
  "your-account",
  "your-orders",
  "order-history",
  "order-details",
  "orders",
  "css",
  "summary",
  "print.html",
  "edit.html",
  "cart",
  "view.html",
  "hz",
  "wishlist",
  "ls",
  "registry",
  "history",
  "browsing-history",
  "search-history",
  "subscribe-and-save",
  "auto-deliveries",
  "subscriptionlist",
  "returns",
  "your-returns",
  "invoice",
  "invoice.html",
  "help",
  "customer",
  "display.html",
  "stores",
  "page",
  "ask",
  "questions",
  "buy",
  "cpe",
  "yourpayments",
  "vine",
  "fresh",
  "alm",
  "storefront",
  "deals",
  "goldbox",
  "bestsellers",
  "new-releases",
  "images",
  "i",
  "g",
  "en_us",
  "placeholder.png",
];

/** Query parameter names kept: "keep" values get the token pass, "scrub" values are text. */
export const QUERY_PARAMS: ReadonlyMap<string, "keep" | "scrub"> = new Map([
  ["ie", "keep"],
  ["i", "keep"],
  ["s", "keep"],
  ["sort", "keep"],
  ["sortBy", "keep"],
  ["filterByStar", "keep"],
  ["reviewerType", "keep"],
  ["formatType", "keep"],
  ["mediaType", "keep"],
  ["th", "keep"],
  ["psc", "keep"],
  ["language", "keep"],
  ["page", "keep"],
  ["pageNumber", "keep"],
  ["startIndex", "keep"],
  ["k", "scrub"],
  ["field-keywords", "scrub"],
  ["keywords", "scrub"],
  ["search", "scrub"],
  ["rh", "scrub"],
  ["orderID", "scrub"],
  ["orderId", "scrub"],
  ["asin", "scrub"],
  ["ASIN", "scrub"],
  ["m", "scrub"],
  ["smid", "scrub"],
  ["seller", "scrub"],
  ["me", "scrub"],
  ["orderFilter", "scrub"],
  ["timeFilter", "scrub"],
]);

/** JSON keys whose string values are structural (token pass only, no word synthesis). */
export const JSON_KEPT_KEYS: readonly string[] = [
  "key",
  "type",
  "@type",
  "@context",
  "pageType",
  "subPageType",
  "currencyCode",
  "currency",
  "locale",
];

/** Element context hints (matched against id, class and feature names). */
export const NAME_HINT =
  /(profile-name|full-?name|recipient|addressee|buyer-?name|customer-?name|displayaddressfullname|nav-line-1)/i;
export const ADDRESS_HINT =
  /(address|glow-ingress|ship-?to|shipping-?addr|deliver-?to|delivery-?location|location-?(?:widget|label|name)|zip|postal|city|street|store-?(?:name|address)|pickup)/i;

export type LabelKind = "name" | "place" | "name-or-place" | "rating" | "asin" | "suffix" | "whole";

export interface Label {
  text: string;
  kind: LabelKind | null;
}

const LABEL_KINDS: readonly string[] = [
  "name",
  "place",
  "name-or-place",
  "rating",
  "asin",
  "suffix",
  "whole",
];

/** Parse the labels.txt format (exported for tests). */
export function parseLabels(src: string): Label[] {
  const out: Label[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const bar = line.lastIndexOf(" | ");
    const text = (bar >= 0 ? line.slice(0, bar) : line).trim();
    const kind = bar >= 0 ? line.slice(bar + 3).trim() : null;
    if (kind !== null && !LABEL_KINDS.includes(kind)) {
      throw new Error(`labels.txt: unknown kind "${kind}"`);
    }
    // A run of two or more digits in a label is a value pasted by mistake (a ZIP, an id).
    if (/[0-9]{2}/.test(text)) throw new Error(`labels.txt: labels may not contain numbers`);
    out.push({ text, kind: kind as LabelKind | null });
  }
  return out;
}

/** The structural UI label allowlist, loaded from labels.txt next to this file. */
export const LABELS: readonly Label[] = parseLabels(
  readFileSync(new URL("./labels.txt", import.meta.url), "utf8"),
);
