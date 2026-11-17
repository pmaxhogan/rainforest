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
  "data-component",
  "data-browsing-history-status",
  "data-csa-c-item-type",
  "data-csa-c-owner",
  "data-listtype",
  "data-itemtype",
  "data-csa-c-content-id",
  "data-testid",
  "data-id",
  "data-hub-section",
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

/**
 * Kept attributes whose value is a list of element ids (IDREFS). The value is kept only
 * when every token names an id in the same document; otherwise it is text (Amazon puts
 * whole sentences, product titles included, into aria-labelledby).
 */
export const IDREF_ATTRS: readonly string[] = [
  "for",
  "headers",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "aria-owns",
];

/**
 * Query parameters whose values are account-scoped ids. Every such value seen anywhere in
 * the capture is replaced wherever else it appears verbatim (a JSON key, a kept value),
 * not only inside the URL that carried it.
 */
export const ID_PARAMS: readonly string[] = [
  "shipId",
  "subscriptionId",
  "deliveryBundleId",
  "rmaId",
  "orderId",
  "orderID",
  "itemId",
  "lid",
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
  "data-edit-url",
  "data-manageurl",
  "data-next-url",
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

export interface TrimRule {
  /** Name used in reports. */
  name: string;
  /** Page kinds the rule applies to ("*" for all). */
  kinds: readonly string[];
  /** One repeated item; its outermost wrapper holding no other item is what is removed. */
  item: string;
  /** The site's fixed page size: a group of exactly this size is left alone. */
  standardSize?: number;
  /** JSON-valued attributes holding the full id list of the collection (cut with it). */
  idListAttrs?: readonly string[];
  /** A removed unit may never contain (or be) one of these: the enclosing item's boundary. */
  stopAt?: string;
}

/**
 * Repeated item collections whose size is a fact about the account. Each group of 3 or
 * more keeps a seeded random 2..min(6, n-1) of its items (see trim.ts).
 */
export const TRIM_RULES: readonly TrimRule[] = [
  { name: "cart items", kinds: ["cart"], item: ".sc-list-item[data-itemid]" },
  { name: "subscriptions", kinds: ["subscriptions"], item: "[data-edit-url]" },
  {
    name: "history cards",
    kinds: ["browsing_history"],
    item: "[id^='p13n-asin-index-']",
    idListAttrs: ["data-client-recs-list"],
  },
  { name: "list items", kinds: ["list", "lists_index"], item: "li[data-itemid]" },
  { name: "orders per page", kinds: ["order_list"], item: ".order-card", standardSize: 10 },
  {
    name: "shipments per order",
    kinds: ["order_list"],
    item: ".delivery-box",
    stopAt: ".order-header",
  },
  { name: "items per order", kinds: ["order_list"], item: ".item-box", stopAt: ".delivery-box" },
  {
    name: "shipments per order",
    kinds: ["order_details", "invoice"],
    item: "[data-component='shipmentStatus']",
  },
  {
    name: "items per shipment",
    kinds: ["order_details", "invoice"],
    item: "[data-component='purchasedItemsRightGrid']",
    stopAt: "[data-component='shipmentStatus']",
  },
  { name: "carousel cards", kinds: ["*"], item: "li.a-carousel-card" },
];

/**
 * Size reduction (ScrubOptions.reduce, off by default). Subtrees removed before scrubbing:
 * site chrome no parser reads and recommendation rails. Removing more is always safe for
 * privacy; whether parsers survive is checked per fixture by the staging comparison.
 */
export const REDUCE_DROP_SELECTORS: readonly string[] = [
  "#navFooter",
  "footer",
  "#skiplink",
  "#rhf",
  "#nav-flyout-anchor",
  "#nav-flyout-accountList",
  "#nav-flyout-prime",
  "[id^='ape_']",
];

/**
 * With reduce on, a subtree the capture marked hidden is removed only when it matches one
 * of these (large recommendation rails) AND holds nothing parsers read on purpose (see
 * REDUCE_KEEP_HIDDEN_SELECTORS). Parsers read many hidden elements deliberately (form
 * inputs, select options, popover preloads, state attributes), so hidden alone is not enough.
 */
export const REDUCE_DROP_HIDDEN_SELECTORS: readonly string[] = [".right-rail", "#rhf"];

/** Hidden content parsers read on purpose; a hidden subtree holding any of it is kept. */
export const REDUCE_KEEP_HIDDEN_SELECTORS: readonly string[] = [
  "input",
  "select",
  "option",
  "textarea",
  "form",
  "script",
  "[data-a-state]",
  "[class*='popover']",
  "[id*='popover']",
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
  "progress-tracker",
  "package",
  "ship-track",
  "shiptrack",
  "spr",
  "prep",
  "aag",
  "main",
  "buyagain",
  "intro",
  "rufus",
  "cl",
  "render",
  "ajax",
  "subscription",
  "subscriptions",
  "edit",
  "api",
  "marketplaces",
  "replenishment",
  "fulfillment",
  "deliveries",
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
  ["orderFilter", "keep"],
  ["timeFilter", "scrub"],
  ["rmaId", "scrub"],
  ["subscriptionId", "scrub"],
  ["subAsin", "scrub"],
  ["shipId", "scrub"],
  ["deliveryBundleId", "scrub"],
  ["deliveryDate", "scrub"],
]);

/**
 * Structural prefixes of generated element ids ("CardInstance" + an opaque instance id).
 * An id that starts with one keeps the prefix; the rest is always replaced by a token.
 */
export const ID_PREFIXES: readonly string[] = ["CardInstance"];

/**
 * Class names parsers query that would otherwise match the experiment-token rule (a hex run
 * with a digit, or 4+ digits). Regenerate by grepping packages/parsers/src for class
 * selectors when parsers change; today none of them matches the rule.
 */
export const PARSER_CLASS_TOKENS: readonly string[] = [];

/** JSON keys whose string values are structural (token pass only, no word synthesis). */
export const JSON_KEPT_KEYS: readonly string[] = [
  "action",
  "itemType",
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

/**
 * Element context hints (matched against id, class and feature names). "city" must start a
 * word: "sc-product-scarcity" is not an address block.
 */
export const NAME_HINT =
  /(profile-name|full-?name|recipient|addressee|buyer-?name|customer-?name|displayaddressfullname|nav-line-1)/i;
export const ADDRESS_HINT =
  /(address|glow-ingress|ship-?to|shipping-?addr|deliver-?to|delivery-?location|location-?(?:widget|label|name)|zip|postal|(?<![a-z])city|street|store-?(?:name|address)|pickup)/i;

export type LabelKind =
  "name" | "place" | "name-or-place" | "rating" | "asin" | "suffix" | "whole" | "word";

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
  "word",
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
