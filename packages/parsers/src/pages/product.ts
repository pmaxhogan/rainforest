/**
 * Product detail page parser (`get_product`).
 *
 * Layout notes (desktop amazon.com, observed on real captures):
 * - The buy box is `#buybox`. Most pages render purchase options as an accordion
 *   (`#buyBoxAccordion > .a-box`, the selected row carries `.a-accordion-active`); ids such as
 *   `#corePrice_feature_div`, `#addToCart` and `#merchantID` repeat once per row, so every
 *   buy-box field is read inside the selected row first. Grocery uses `#desktop_almBuyBox`.
 * - The center column repeats the featured price in `#apex_desktop` together with list /
 *   typical price, savings, coupons and promotions.
 * - The seller / ships-from / returns rows ("offer display features") sit in a collapsed
 *   expander and arrive with the hidden marker; they are real content, not templates, so they
 *   are read through raw DOM access (strategy names say "collapsed"). The same holds for the
 *   collapsed "Product information" tables and the options of a visible quantity select.
 *   Prices are never read from hidden elements, except for sponsored-carousel items, which
 *   a content blocker hides wholesale.
 * - Variants and media belong to sibling parsers; this one only emits summaries.
 */
import { RfError } from "@rainforest/core";
import type { Capture, ParseMeta, Parser, ParseResult } from "@rainforest/core";
import {
  type DomElement,
  type DomRoot,
  type Money,
  INVISIBLE_TAGS,
  attr,
  collapse,
  findMoney,
  hiddenSelf,
  isElement,
  moneyFromPriceElement,
  parseCapture,
  parseCount,
  parseCountDetail,
  parseMoney,
  parseRating,
  q,
  qa,
  ratingFromClass,
  tableToRows,
  text,
  visible,
} from "../dom.ts";
import { extractBalanced, tryJson } from "../blobs.ts";
import { Consumption, losslessReport } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";

// ---- exported types

export const BUY_BOX_STATES = [
  "featured_offer",
  "no_featured_offer",
  "see_all_buying_options",
  "unavailable",
  "out_of_stock_orderable",
  "preorder",
  "used_only",
  "renewed",
  "unknown",
] as const;
export type BuyBoxState = (typeof BUY_BOX_STATES)[number];

export type Fulfillment = "amazon" | "fba" | "merchant";
export type ConditionKind = "new" | "used" | "renewed" | "collectible";

export interface PathLink {
  text: string;
  /** Site-relative path without query string. */
  path?: string;
}

export interface Byline {
  /** Visible byline text, for example "Visit the Example Store" or "Brand: Example". */
  text: string;
  /** Brand or store name derived from the text. */
  name?: string;
  kind: "store" | "brand" | "contributors" | "other";
  store_path?: string;
  contributors?: { name: string; role?: string; path?: string }[];
}

export interface BestSellerRank {
  rank: number;
  category: string;
  path?: string;
  raw: string;
}

export interface ProductType {
  /** Lower-case product group from the page root (for example "book", "grocery", "wireless"). */
  product_group?: string;
  /** Structural markers such as "book", "grocery", "renewed", "variations", "subscribe_and_save". */
  markers: string[];
}

export interface UnitPrice {
  price: Money;
  /** Unit text such as "count", "Fl Oz", "lb". */
  unit?: string;
  raw: string;
}

export interface Savings {
  percent?: number;
  amount?: Money;
  raw: string;
}

export interface LabeledMoney extends Money {
  /** Label shown next to the strikethrough, for example "List Price:" or "Typical price:". */
  label?: string;
}

export interface Coupon {
  text: string;
  /** True when the page offers a clip / apply control for it. */
  clippable: boolean;
  /** Condition text, for example "when you select Subscribe & Save". */
  condition?: string;
}

export interface Promotion {
  badge?: string;
  text: string;
}

export interface Deal {
  /** Deal label as shown: "Limited time deal", "Lightning Deal", ... */
  type: string;
  countdown?: string;
  claimed?: string;
  raw: string;
}

export interface SellerRef {
  name: string;
  /** Merchant id when the page exposes one (link or form field). */
  id?: string;
  path?: string;
}

export interface Condition {
  kind: ConditionKind;
  text: string;
  note?: string;
}

export interface Prime {
  eligible: boolean;
  text?: string;
  /** Every distinct badge text when the buy box and center column differ. */
  badges?: string[];
}

export interface DeliveryPromise {
  /** "primary", "secondary", "fastest" or "other". */
  kind: string;
  text: string;
  /** The emphasized date / window part, raw. */
  date?: string;
  /** ISO date when the raw date names a year. */
  date_iso?: string;
  free: boolean;
  /** "Order within ..." cutoff, raw. */
  cutoff?: string;
}

export interface QuantityOptions {
  min?: number;
  max?: number;
  count: number;
  selected?: string;
}

export interface SubscribeAndSave {
  available: boolean;
  /** True when Subscribe & Save is the purchase option selected by default. */
  default_selected: boolean;
  price?: Money;
  unit_price?: UnitPrice;
  /** Discount percentages mentioned by the offer (base and tiered), ascending. */
  discount_percents: number[];
  /** Discount-related sentences, raw. */
  discount_text: string[];
  frequency_options: string[];
  default_frequency?: { value: string; unit: string };
  first_delivery?: string;
}

export interface PurchaseOption {
  /** "one_time", "new", "subscribe_and_save", "used", "renewed", "collectible", "other". */
  kind: string;
  caption: string;
  selected: boolean;
  price?: Money;
  unit_price?: UnitPrice;
  /** Delivery lines of the row header, joined with " | ". */
  delivery?: string;
  /** Prime / speed badge text of the row header. */
  badge?: string;
  ships_from?: string;
  sold_by?: string;
  row_id?: string;
}

export interface AddOn {
  /** "protection_plan", "trade_in", "accessory" or "other". */
  kind: string;
  title: string;
  price?: Money;
  price_text?: string;
}

export interface OtherSellers {
  text: string;
  count?: number;
  from_price?: Money;
  path?: string;
}

export interface FeaturedOffer {
  price?: Money;
  /** "est." pricing (sold by weight). */
  price_is_estimate?: boolean;
  /** Unit an estimated price is quoted per ("each"). */
  price_per?: string;
  list_price?: LabeledMoney;
  typical_price?: LabeledMoney;
  savings?: Savings;
  unit_price?: UnitPrice;
  coupon?: Coupon;
  promotions: Promotion[];
  deal?: Deal;
  seller?: SellerRef;
  ships_from?: string;
  fulfillment?: Fulfillment;
  condition?: Condition;
  prime?: Prime;
  delivery: DeliveryPromise[];
  /** "Deliver to ..." line (the owner's location: private, but part of the page). */
  delivery_location?: string;
  returns?: string;
  stock_text?: string;
  quantity_options?: QuantityOptions;
  limits_text: string[];
  subscribe_and_save?: SubscribeAndSave;
  add_to_cart_present: boolean;
  buy_now_present: boolean;
  add_ons: AddOn[];
  gift?: string[];
  /** Other offer-display rows (payment, packaging, customer service, ...): label -> value. */
  offer_features: { label: string; value: string }[];
  installments?: string;
  rewards_text?: string;
  points?: string;
}

export interface BuyBox {
  state: BuyBoxState;
  /** Which structural evidence decided the state. */
  evidence: string;
  selected_option?: string;
  /** Other buy-box buttons, for example "Add to List". */
  secondary_actions?: string[];
}

export interface VariantSummary {
  parent_asin?: string;
  dimensions: { name: string; label?: string; selected?: string; option_count?: number }[];
}

export interface MediaCounts {
  images?: number;
  videos?: number;
}

export interface Histogram {
  star: number;
  percent: number;
}

export interface ReviewAspect {
  name: string;
  sentiment: "positive" | "negative" | "mixed" | "unknown";
  mentions?: number;
}

export interface RatingSummary {
  value?: number;
  out_of?: number;
  count?: number;
  histogram: Histogram[];
  review_summary_ai?: { text: string; aspects: ReviewAspect[]; note?: string };
  /** Third-party ratings shown next to the stars (for example Goodreads on books). */
  external?: { source: string; text: string }[];
}

export interface TextSection {
  heading: string | null;
  text: string;
}

export interface KeyValue {
  label: string;
  value: string;
}

export interface SpecTable {
  heading: string | null;
  rows: KeyValue[];
  /** True when the table sat in a collapsed expander (read through raw DOM access). */
  collapsed: boolean;
  source: string;
}

export interface Notice {
  type: string;
  text: string;
  asin?: string;
  path?: string;
}

export interface CarouselItem {
  asin?: string;
  title?: string;
  price?: Money;
  rating?: number;
  rating_count?: number;
  /** Remaining visible card text (badges, strikethrough, delivery), raw. */
  details?: string;
}

export interface SponsoredBlock {
  key: string;
  heading: string | null;
  is_sponsored: true;
  /** True when the owner's browser did not render the block (content blocker). */
  hidden_in_browser: boolean;
  items: CarouselItem[];
  /** Visible text outside the items (totals, buttons), raw. */
  footer?: string;
}

export interface RelatedWidget {
  key: string;
  heading: string | null;
  kind: "carousel" | "bundle";
  items: CarouselItem[];
  /** Visible text outside the items (totals, buttons), raw. */
  footer?: string;
}

export interface NutritionFact {
  name: string;
  amount?: string;
  daily_value?: string;
}

export interface Nutrition {
  diet_types: string[];
  serving?: string;
  /** The at-a-glance row (Calories, Sodium, ...). */
  summary: KeyValue[];
  /** The full facts panel (usually in a collapsed expander). */
  facts: NutritionFact[];
  ingredients?: string;
  /** True when the facts panel was collapsed (read through raw DOM access). */
  collapsed: boolean;
}

export interface GroceryInfo {
  /** Store marker: "whole_foods", "amazon_fresh" or "other". */
  store?: string;
  /** Buy-box tabs such as Delivery / Pickup, with the selected one. */
  tabs: { label: string; selected: boolean }[];
  weight_text?: string;
  snap_ebt?: boolean;
  delivery_window?: string;
}

export interface PriceHistoryIngress {
  /** Positions of the native "Price history" control: "buybox", "central". */
  positions: string[];
  query_text?: string;
}

export interface ProductPage {
  asin?: string;
  parent_asin?: string;
  title?: string;
  /** Secondary line under the title ("For ..." compatibility differentiators). */
  title_differentiators?: string;
  byline?: Byline;
  breadcrumbs: PathLink[];
  department?: string;
  best_seller_ranks: BestSellerRank[];
  product_type: ProductType;
  buy_box: BuyBox;
  featured_offer?: FeaturedOffer;
  purchase_options: PurchaseOption[];
  other_sellers: OtherSellers[];
  variant_summary?: VariantSummary;
  media_counts?: MediaCounts;
  rating?: RatingSummary;
  highlights: string[];
  bullets: string[];
  description?: string;
  aplus_text: TextSection[];
  overview: KeyValue[];
  spec_tables: SpecTable[];
  important_information: TextSection[];
  whats_in_the_box: string[];
  documents: { text: string; path: string }[];
  notices: Notice[];
  sponsored_blocks: SponsoredBlock[];
  related: RelatedWidget[];
  grocery?: GroceryInfo;
  nutrition?: Nutrition;
  price_history_ingress?: PriceHistoryIngress;
}

// ---- small helpers

const ASIN_RE = /^[0-9A-Z]{10}$/;
const ASIN_IN_PATH =
  /\/(?:dp|gp\/product|product-reviews|gp\/offer-listing)\/([0-9A-Z]{10})(?=[/?#]|$)/;
/** Amazon's own US merchant id (a fixed public constant, not personal data). */
const AMAZON_MERCHANT_ID = "ATVPDKIKX0DER";
const OFFSCREEN = ".a-offscreen, .aok-offscreen";
const POPOVER = ".a-popover-preload, .a-popover-content";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function matchesSafe(el: DomElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** Remove bidi / zero-width marks Amazon puts around labels, collapse whitespace. */
export function cleanText(s: string | null | undefined): string {
  return collapse((s ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, ""));
}

function stripColon(s: string): string {
  return cleanText(s).replace(/\s*:\s*$/, "");
}

/** Visible text without screen-reader-only duplicates. */
function vtext(el: DomElement | null | undefined, extra?: (e: DomElement) => boolean): string {
  return cleanText(
    text(el, {
      exclude: (e) => matchesSafe(e, OFFSCREEN) || (extra !== undefined && extra(e)),
    }),
  );
}

/**
 * Text of an element regardless of the hidden marker (for collapsed expanders, hidden inputs
 * and blocked carousels). Skips scripts, styles, templates and popover copies.
 */
function rawText(
  el: DomElement | null | undefined,
  skipOffscreen = true,
  honorHidden = false,
): string {
  if (el == null || (honorHidden && !visible(el))) return "";
  const parts: string[] = [];
  const walk = (node: DomElement): void => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child === undefined) continue;
      if (child.nodeType === 3) parts.push(child.textContent ?? "");
      else if (isElement(child)) {
        if (INVISIBLE_TAGS.has(child.localName)) continue;
        if (honorHidden && hiddenSelf(child)) continue;
        if (matchesSafe(child, POPOVER)) continue;
        if (skipOffscreen && matchesSafe(child, OFFSCREEN)) continue;
        parts.push(" ");
        walk(child);
        parts.push(" ");
      }
    }
  };
  walk(el);
  return cleanText(parts.join(""));
}

/** Visible text with a space at every element boundary (for runs of adjacent inline spans). */
function spacedText(el: DomElement | null | undefined): string {
  return rawText(el, true, true);
}

/** querySelectorAll without the visibility filter. */
function rawAll(root: DomRoot | null | undefined, selector: string): DomElement[] {
  if (root == null) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function rawOne(root: DomRoot | null | undefined, selector: string): DomElement | undefined {
  return rawAll(root, selector)[0];
}

/** Site-relative path (no query) of an href, or undefined. */
function pathOf(href: string | undefined): string | undefined {
  if (href === undefined || href === "" || href.startsWith("#") || /^javascript:/i.test(href)) {
    return undefined;
  }
  try {
    const u = new URL(href, "https://host.invalid");
    return u.pathname;
  } catch {
    return undefined;
  }
}

function asinOfHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  return ASIN_IN_PATH.exec(href)?.[1];
}

function sellerIdOfHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  return /[?&](?:seller|merchantId|me)=([A-Z0-9]{8,20})(?:&|$)/.exec(href)?.[1];
}

/** "Jan 31, 2027" / "January 31, 2027" -> "2027-01-31"; undefined without a year. */
export function isoDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = /\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(raw);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined)
    return undefined;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Drop trailing separators and spaces before punctuation left by inline links. */
function tidy(s: string): string {
  return cleanText(s.replace(/(\s*\|)+\s*$/, "").replace(/\s+([.,;:!?])/g, "$1"));
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Money from a `.a-price` element. The framework prefers the offscreen text, but carousels
 * occasionally ship an offscreen value without its decimal point ("$1005" next to a
 * visible "$10.05"); when the split whole / fraction markup disagrees that way, trust it.
 */
function priceFrom(el: DomElement | null | undefined): Money | undefined {
  const m = moneyFromPriceElement(el);
  if (m === undefined || el == null || /[.,]\d{1,2}$/.test(m.raw)) return m;
  const whole = (q(el, ".a-price-whole")?.textContent ?? "").replace(/[^0-9]/g, "");
  const fraction = (q(el, ".a-price-fraction")?.textContent ?? "").replace(/[^0-9]/g, "");
  if (whole === "" || fraction === "") return m;
  const amount = Number(`${whole}.${fraction.slice(0, 2)}`);
  if (Math.abs(amount * 100 - m.amount) > 0.001) return m;
  const symbol = collapse(q(el, ".a-price-symbol")?.textContent ?? "") || "$";
  return { amount, currency: m.currency, raw: `${symbol}${whole}.${fraction.slice(0, 2)}` };
}

/** Same as priceFrom for an element the browser did not render (blocked sponsored cards). */
function rawPriceFrom(el: DomElement | undefined): Money | undefined {
  if (el === undefined) return undefined;
  const off = parseMoney(cleanText(rawOne(el, ".a-offscreen")?.textContent ?? ""));
  const whole = (rawOne(el, ".a-price-whole")?.textContent ?? "").replace(/[^0-9]/g, "");
  const fraction = (rawOne(el, ".a-price-fraction")?.textContent ?? "").replace(/[^0-9]/g, "");
  if (whole !== "" && fraction !== "" && (off === undefined || !/[.,]\d{1,2}$/.test(off.raw))) {
    const symbol = cleanText(rawOne(el, ".a-price-symbol")?.textContent ?? "") || "$";
    const frac = fraction.slice(0, 2);
    return {
      amount: Number(`${whole}.${frac}`),
      currency: off?.currency ?? "USD",
      raw: `${symbol}${whole}.${frac}`,
    };
  }
  return off ?? parseMoney(cleanText(el.textContent ?? ""));
}

function present(root: DomRoot | null | undefined, selector: string): boolean {
  return q(root, selector) !== undefined;
}

/** First visible element (in the given roots, in order) whose own text matches. */
function findByText(
  roots: (DomElement | undefined)[],
  selector: string,
  re: RegExp,
): DomElement | undefined {
  for (const root of roots) {
    if (root === undefined) continue;
    for (const el of qa(root, selector)) {
      if (re.test(vtext(el))) return el;
    }
  }
  return undefined;
}

// ---- context

interface Ctx {
  doc: DomRoot;
  root: DomElement;
  meta: ParseMeta;
  used: Consumption;
  capture: Capture;
  buybox?: DomElement;
  rows: DomElement[];
  row?: DomElement;
  /** Selected offer scope: the active accordion row, else the qualified buy box. */
  offer?: DomElement;
  apex?: DomElement;
  asin?: string;
}

function scopes(ctx: Ctx): (DomElement | undefined)[] {
  return [ctx.offer, ctx.apex, ctx.buybox];
}

function setupScopes(ctx: Ctx): void {
  const doc = ctx.doc;
  ctx.buybox =
    q(doc, "#buybox") ??
    q(doc, "#desktop_buybox") ??
    q(doc, "#buyBoxInner") ??
    q(doc, "#Books-Buybox") ??
    q(doc, "#rightCol");
  const accordion = q(ctx.buybox, "#buyBoxAccordion");
  ctx.rows =
    accordion === undefined
      ? []
      : Array.from(accordion.children).filter(
          (r) =>
            !hiddenSelf(r) && matchesSafe(r, ".a-box, [id$=AccordionRow], [id*=AccordionRow_]"),
        );
  ctx.row =
    ctx.rows.find((r) => matchesSafe(r, ".a-accordion-active")) ??
    ctx.rows.find((r) => visible(rawOne(r, ".accordion-row-content") ?? null));
  ctx.offer =
    ctx.row ??
    q(ctx.buybox, "#desktop_qualifiedBuyBox") ??
    q(ctx.buybox, "#desktop_almBuyBox") ??
    q(ctx.buybox, "#qualifiedBuybox") ??
    ctx.buybox;
  ctx.apex = q(doc, "#apex_desktop") ?? q(doc, "#corePriceDisplay_desktop_feature_div");
  if (ctx.rows.length > 0) ctx.meta.strategies["buy_box.scope"] = "accordion-row";
  else if (ctx.offer !== ctx.buybox) ctx.meta.strategies["buy_box.scope"] = "qualified-buybox";
  else if (ctx.buybox !== undefined) ctx.meta.strategies["buy_box.scope"] = "buybox";
}

// ---- identity

function parseAsin(ctx: Ctx): string | undefined {
  const { doc, capture } = ctx;
  const ok = (s: string | undefined): string | undefined =>
    s !== undefined && ASIN_RE.test(s) ? s : undefined;
  return firstOf(
    "asin",
    [
      ["id", () => ok(attr(rawOne(ctx.offer, "input#ASIN, input[name=ASIN]"), "value"))],
      ["id", () => ok(attr(rawOne(doc, "input#ASIN, input[name=ASIN]"), "value"))],
      ["data-attr", () => ok(attr(rawOne(doc, "#averageCustomerReviews[data-asin]"), "data-asin"))],
      [
        "data-attr",
        () => ok(attr(rawOne(doc, "#title_feature_div[data-csa-c-asin]"), "data-csa-c-asin")),
      ],
      ["label", () => ok(asinOfHref(attr(rawOne(doc, "link[rel=canonical]"), "href")))],
      ["text-anchor", () => ok(asinOfHref(capture.final_url) ?? asinOfHref(capture.url))],
    ],
    ctx.meta,
  );
}

function parseParentAsin(ctx: Ctx): string | undefined {
  return firstOf(
    "parent_asin",
    [
      [
        "blob",
        () => {
          for (const s of rawAll(ctx.doc, "script")) {
            const m = /"parentAsin"\s*:\s*"([0-9A-Z]{10})"/.exec(s.textContent ?? "");
            if (m?.[1] !== undefined) return m[1];
          }
          return undefined;
        },
      ],
      [
        "data-attr",
        () => attr(rawOne(ctx.doc, "input[name=parentASIN], input#parentASIN"), "value"),
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function parseTitle(ctx: Ctx): string | undefined {
  const { doc } = ctx;
  return firstOf(
    "title",
    [
      ["id", () => vtext(ctx.used.take(q(doc, "#productTitle")))],
      ["id", () => vtext(ctx.used.take(q(doc, "#title")))],
      ["id", () => vtext(ctx.used.take(q(doc, "#ebooksProductTitle")))],
      ["label", () => cleanText(attr(rawOne(doc, "meta[name=title]"), "content"))],
      ["text-anchor", () => cleanText(doc.querySelector("title")?.textContent ?? "")],
    ],
    ctx.meta,
  );
}

function parseByline(ctx: Ctx): Byline | undefined {
  const { doc, used } = ctx;
  return firstOf<Byline>(
    "byline",
    [
      [
        "id",
        () => {
          const container = q(doc, "#bylineInfo");
          if (container === undefined) return undefined;
          const authors = qa(container, ".author");
          if (authors.length > 0) {
            const contributors = authors.map((a) => {
              const link = q(a, "a.a-link-normal") ?? q(a, "a");
              const role = vtext(q(a, ".contribution"))
                .replace(/^\(|\)$/g, "")
                .replace(/,\s*$/, "");
              const name = vtext(link) || vtext(a, (e) => matchesSafe(e, ".contribution"));
              const out: { name: string; role?: string; path?: string } = { name };
              if (role !== "") out.role = role.replace(/[()]/g, "").trim();
              const path = pathOf(attr(link, "href"));
              if (path !== undefined) out.path = path;
              return out;
            });
            used.take(container);
            return {
              text: vtext(container),
              kind: "contributors",
              contributors: contributors.filter((c) => c.name !== ""),
            };
          }
          const t = vtext(container);
          if (t === "") return undefined;
          used.take(container);
          return bylineFromText(t, attr(container, "href") ?? attr(q(container, "a"), "href"));
        },
      ],
      [
        "text-anchor",
        () => {
          const el = findByText(
            [q(doc, "#centerCol"), q(doc, "#ppd")],
            "a, span, div",
            /^(Visit the .+ Store|Brand: .+)$/,
          );
          if (el === undefined) return undefined;
          used.take(el);
          return bylineFromText(vtext(el), attr(el, "href"));
        },
      ],
    ],
    ctx.meta,
    // Some listings render an empty byline slot; absence is not drift.
    { optional: rawOne(doc, "#bylineInfo") === undefined },
  );
}

function bylineFromText(t: string, href: string | undefined): Byline {
  const store = /^Visit the (.+?) Store$/.exec(t);
  const brand = /^Brand:\s*(.+)$/.exec(t);
  const out: Byline = { text: t, kind: store ? "store" : brand ? "brand" : "other" };
  const name = store?.[1] ?? brand?.[1];
  if (name !== undefined) out.name = name;
  const path = pathOf(href);
  if (path !== undefined) out.store_path = path;
  return out;
}

function parseBreadcrumbs(ctx: Ctx): PathLink[] {
  const { doc, used } = ctx;
  return (
    firstOf<PathLink[]>(
      "breadcrumbs",
      [
        [
          "id",
          () => {
            const box = q(doc, "#wayfinding-breadcrumbs_feature_div");
            const out = qa(box, "a").map((a) => linkOf(a));
            if (out.length > 0) used.take(box);
            return out;
          },
        ],
        [
          "label",
          () => {
            const box = q(doc, ".a-breadcrumb") ?? q(doc, "[aria-label=Breadcrumb]");
            const out = qa(box, "a").map((a) => linkOf(a));
            if (out.length > 0) used.take(box);
            return out;
          },
        ],
      ],
      ctx.meta,
      { optional: true },
    ) ?? []
  );
}

function linkOf(a: DomElement): PathLink {
  const out: PathLink = { text: vtext(a) };
  const path = pathOf(attr(a, "href"));
  if (path !== undefined) out.path = path;
  return out;
}

function parseDepartment(ctx: Ctx, crumbs: PathLink[]): string | undefined {
  return firstOf(
    "department",
    [
      ["label", () => crumbs[0]?.text],
      ["data-attr", () => attr(rawOne(ctx.doc, "#nav-subnav[data-category]"), "data-category")],
      [
        "id",
        () => cleanText(rawOne(ctx.doc, "#searchDropdownBox option[selected]")?.textContent ?? ""),
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

// ---- best sellers rank

/** Parse "#2 in Category (See Top 100 in Category) #1 in Sub" style text. */
export function parseRanks(raw: string, anchors: DomElement[] = []): BestSellerRank[] {
  const t = cleanText(raw)
    .replace(/^Best Sellers Rank\s*:?\s*/i, "")
    .replace(/\([^)]*\)/g, " ");
  const out: BestSellerRank[] = [];
  const re = /#\s?([\d,]+)\s+in\s+(.+?)(?=\s*#\s?[\d,]+\s+in\s|$)/g;
  for (const m of t.matchAll(re)) {
    if (m[1] === undefined || m[2] === undefined) continue;
    const category = cleanText(m[2]);
    const rank: BestSellerRank = {
      rank: Number(m[1].replace(/,/g, "")),
      category,
      raw: cleanText(m[0]),
    };
    const link = anchors.find((a) => cleanText(a.textContent ?? "") === category);
    const path = pathOf(attr(link, "href"));
    if (path !== undefined) rank.path = path;
    out.push(rank);
  }
  return out;
}

// ---- buy box: prices

/** Price elements that are never the featured price. */
const NOT_FEATURED_PRICE = [
  ".basisPrice",
  ".apex-basisprice-value",
  ".apex-basis-price-value",
  ".apex-priceperunit-value",
  "[data-a-strike=true]",
  "#mapleAdvertisement_feature_div",
  "#paymentOptions_PriceblockMessaging_feature_div",
  ".apex_on_twister_price",
  "#twister_feature_div",
  "#twister-plus-inline-twister",
  "#olpLinkWidget_feature_div",
  "#newerVersion_feature_div",
  "#mbb_feature_div",
  "#promoPriceBlockMessage_feature_div",
].join(", ");

function insideAny(el: DomElement, stop: DomElement | undefined, selector: string): boolean {
  for (let cur: DomElement | null = el; cur != null && cur !== stop; cur = cur.parentElement) {
    if (matchesSafe(cur, selector)) return true;
  }
  return false;
}

/** The featured "price to pay" inside a scope, by class priority. */
function priceIn(scope: DomElement | undefined): { money: Money; el: DomElement } | undefined {
  if (scope === undefined) return undefined;
  const ok = (el: DomElement): boolean => !insideAny(el, scope, NOT_FEATURED_PRICE);
  const tiers = [
    ".priceToPay",
    ".apex-pricetopay-value",
    ".reinventPriceAccordionT2",
    "#corePrice_feature_div .a-price",
    "#corePriceDisplay_desktop_feature_div .a-price",
    ".a-price",
  ];
  for (const sel of tiers) {
    for (const el of qa(scope, sel)) {
      if (!ok(el)) continue;
      if (matchesSafe(el, ".a-text-price") && sel === ".a-price") continue;
      const money = priceFrom(el);
      if (money !== undefined) return { money, el };
    }
  }
  return undefined;
}

const LEGACY_PRICE_IDS = [
  "#priceblock_dealprice",
  "#priceblock_ourprice",
  "#priceblock_saleprice",
  "#price_inside_buybox",
  "#newBuyBoxPrice",
  "#kindle-price",
  "#price",
];

interface PriceHit {
  money: Money;
  el: DomElement;
}

function parsePrice(ctx: Ctx): PriceHit | undefined {
  return firstOf<PriceHit>(
    "featured_offer.price",
    [
      ["selected-row", () => (ctx.row === undefined ? undefined : priceIn(ctx.row))],
      ["qualified-buybox", () => (ctx.row === undefined ? priceIn(ctx.offer) : undefined)],
      ["apex-center", () => priceIn(ctx.apex)],
      [
        "grocery-alm",
        () => {
          const el = q(ctx.doc, "#almDesktopSingleOfferPriceWrapper .a-price");
          const money = priceFrom(el);
          return el !== undefined && money !== undefined ? { money, el } : undefined;
        },
      ],
      [
        "legacy-id",
        () => {
          for (const id of LEGACY_PRICE_IDS) {
            const el = q(ctx.doc, id);
            const money = priceFrom(el);
            if (el !== undefined && money !== undefined) return { money, el };
          }
          return undefined;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function basisPrices(
  ctx: Ctx,
  priceEl: DomElement | undefined,
): {
  list?: LabeledMoney;
  typical?: LabeledMoney;
} {
  const out: { list?: LabeledMoney; typical?: LabeledMoney } = {};
  const priceBlock =
    priceEl?.closest("#corePriceDisplay_desktop_feature_div") ??
    priceEl?.closest("#corePrice_feature_div") ??
    priceEl?.closest("#apex_desktop") ??
    undefined;
  const containers = uniq(
    [priceBlock ?? undefined, ctx.row, ctx.apex, ctx.offer].filter(
      (x): x is DomElement => x !== undefined,
    ),
  );
  const found = firstOf<{ label: string; money: Money; el: DomElement }[]>(
    "featured_offer.list_price",
    [
      [
        "id",
        () => {
          for (const c of containers) {
            const hits = qa(c, ".basisPrice")
              .filter((b) => !insideAny(b, c, "#twister_feature_div, .apex_on_twister_price"))
              .map((b) => {
                const money = priceFrom(q(b, ".a-price"));
                const label = vtext(b, (e) => matchesSafe(e, ".a-price"));
                return money === undefined ? undefined : { label, money, el: b };
              })
              .filter((x): x is { label: string; money: Money; el: DomElement } => x !== undefined);
            if (hits.length > 0) return hits;
          }
          return undefined;
        },
      ],
      [
        "data-attr",
        () => {
          for (const c of containers) {
            const el = qa(c, ".a-text-price[data-a-strike=true]").find(
              (e) => !insideAny(e, c, "#twister_feature_div"),
            );
            const money = priceFrom(el);
            if (el !== undefined && money !== undefined) {
              const label = vtext(el.parentElement).replace(money.raw, "").trim();
              return [{ label, money, el }];
            }
          }
          return undefined;
        },
      ],
      [
        "legacy-id",
        () => {
          const el = q(ctx.doc, "#listPrice") ?? q(ctx.doc, "#priceblock_listprice");
          const money = priceFrom(el);
          return el !== undefined && money !== undefined
            ? [{ label: "List Price:", money, el }]
            : undefined;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  for (const hit of found ?? []) {
    ctx.used.take(hit.el);
    const lm: LabeledMoney = { ...hit.money };
    if (hit.label !== "") lm.label = hit.label;
    if (/typical/i.test(hit.label)) out.typical ??= lm;
    else out.list ??= lm;
  }
  return out;
}

function parseSavings(ctx: Ctx, priceEl: DomElement | undefined): Savings | undefined {
  const block = priceEl?.closest("#corePriceDisplay_desktop_feature_div") ?? undefined;
  const containers = [block, ctx.row, ctx.apex].filter((x): x is DomElement => x !== undefined);
  return firstOf<Savings>(
    "featured_offer.savings",
    [
      [
        "id",
        () => {
          for (const c of containers) {
            const el = qa(c, ".savingsPercentage").find(
              (e) => !insideAny(e, c, "#twister_feature_div"),
            );
            const t = vtext(el);
            const m = /(\d+)\s*%/.exec(t);
            if (el !== undefined && m?.[1] !== undefined) {
              ctx.used.take(el);
              return { percent: Number(m[1]), raw: t };
            }
          }
          return undefined;
        },
      ],
      [
        "label",
        () => {
          for (const c of containers) {
            const el = rawOne(c, "#apex-pricetopay-accessibility-label");
            const t = cleanText(el?.textContent ?? "");
            const m = /with (\d+) percent savings/i.exec(t);
            if (m?.[1] !== undefined) return { percent: Number(m[1]), raw: m[0] };
          }
          return undefined;
        },
      ],
      [
        "text-anchor",
        () => {
          const el = findByText(scopes(ctx), "span, td, div", /^You Save:?\s/i);
          if (el === undefined) return undefined;
          const t = vtext(el);
          const pct = /\((\d+)\s*%\)/.exec(t)?.[1];
          const out: Savings = { raw: t };
          const amount = parseMoney(t);
          if (amount !== undefined) out.amount = amount;
          if (pct !== undefined) out.percent = Number(pct);
          ctx.used.take(el);
          return out;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

/** Unit price from an accessibility label ("$0.40 per count") or the "(... / unit)" stack. */
function unitPriceIn(scope: DomElement | undefined): UnitPrice | undefined {
  if (scope === undefined) return undefined;
  const ok = (e: DomElement): boolean =>
    !insideAny(e, scope, "#twister_feature_div, .apex_on_twister_price, #sns-base-price");
  for (const label of rawAll(scope, ".apex-priceperunit-accessibility-label")) {
    if (!ok(label) || (label.parentElement !== null && !visible(label.parentElement))) continue;
    const t = cleanText(label.textContent ?? "");
    const m = /^(.+?)\s+per\s+(.+)$/.exec(t);
    const price = parseMoney(t);
    if (price !== undefined) {
      const out: UnitPrice = { price, raw: t };
      if (m?.[2] !== undefined) out.unit = m[2];
      return out;
    }
  }
  for (const el of qa(scope, ".apex-priceperunit-value, .pricePerUnit")) {
    if (!ok(el)) continue;
    const price = priceFrom(el);
    if (price === undefined) continue;
    const wrap = el.parentElement;
    const t = vtext(wrap);
    const unit = /\/\s*([^)]+)\)?\s*$/.exec(t)?.[1];
    const out: UnitPrice = { price, raw: t };
    if (unit !== undefined) out.unit = cleanText(unit);
    return out;
  }
  return undefined;
}

// ---- buy box: rows, seller, delivery

interface OfferFeatures {
  map: Map<string, { value: string; el: DomElement }>;
  sellerLink?: DomElement;
}

/** Offer-display rows (collapsed expander): label -> first value text. */
function offerFeatures(scope: DomElement | undefined): OfferFeatures {
  const map = new Map<string, { value: string; el: DomElement }>();
  const out: OfferFeatures = { map };
  if (scope === undefined) return out;
  const containers = rawAll(scope, "#offer-display-features, .offer-display-features");
  for (const box of containers) {
    for (const label of rawAll(box, ".offer-display-feature-label")) {
      if (insideAny(label, box, POPOVER)) continue;
      const feature = label.parentElement;
      if (feature === null) continue;
      const name = stripColon(rawText(label));
      if (name === "" || map.has(name)) continue;
      const msg =
        rawAll(feature, ".offer-display-feature-text-message").find(
          (e) => !insideAny(e, feature, POPOVER),
        ) ??
        rawAll(feature, ".offer-display-feature-text").find((e) => !insideAny(e, feature, POPOVER));
      const value = rawText(msg);
      if (value === "") continue;
      map.set(name, { value, el: feature });
      const link = rawAll(feature, "a#sellerProfileTriggerId, a[href*='seller=']").find(
        (e) => !insideAny(e, feature, POPOVER),
      );
      if (link !== undefined && /sold by|seller/i.test(name)) out.sellerLink = link;
    }
  }
  return out;
}

function featureValue(f: OfferFeatures, ...names: RegExp[]): string | undefined {
  for (const re of names) {
    for (const [label, v] of f.map) if (re.test(label)) return v.value;
  }
  return undefined;
}

/** "Ships from: X Sold by: Y" or "Ships from and sold by X." text. */
export function parseShipsSold(t: string): { ships_from?: string; sold_by?: string } {
  const s = cleanText(t);
  const both = /Ships from and sold by\s+(.+?)\.?$/i.exec(s);
  if (both?.[1] !== undefined) return { ships_from: both[1], sold_by: both[1] };
  const out: { ships_from?: string; sold_by?: string } = {};
  const ships = /Ships from:?\s+(.+?)(?=\s+Sold by\b|\s+Fulfilled by\b|$)/i.exec(s)?.[1];
  const sold =
    /Sold by:?\s+(.+?)(?=\s+and Fulfilled by\b|\s+Ships from\b|\s+Fulfilled by\b|\.?$)/i.exec(
      s,
    )?.[1];
  const fulfilled = /Fulfilled by\s+(Amazon)/i.exec(s)?.[1];
  if (ships !== undefined) out.ships_from = ships.replace(/\.$/, "");
  else if (fulfilled !== undefined) out.ships_from = fulfilled;
  if (sold !== undefined) out.sold_by = sold.replace(/\.$/, "");
  return out;
}

function isAmazonName(s: string | undefined): boolean {
  return s !== undefined && /^amazon(\.com)?(\s+services.*)?$/i.test(s.trim());
}

export function deriveFulfillment(
  shipsFrom: string | undefined,
  soldBy: string | undefined,
  merchantId?: string,
): Fulfillment | undefined {
  if (isAmazonName(soldBy) || (soldBy === undefined && merchantId === AMAZON_MERCHANT_ID)) {
    return isAmazonName(shipsFrom) || shipsFrom === undefined ? "amazon" : "merchant";
  }
  if (isAmazonName(shipsFrom)) return "fba";
  if (shipsFrom !== undefined || soldBy !== undefined) return "merchant";
  return undefined;
}

function conditionOf(caption: string): ConditionKind | undefined {
  if (/renewed|refurbished/i.test(caption)) return "renewed";
  if (/collectible/i.test(caption)) return "collectible";
  if (/\bused\b/i.test(caption)) return "used";
  if (/\bnew\b|one-time|subscribe/i.test(caption)) return "new";
  return undefined;
}

function rowKind(row: DomElement, caption: string): string {
  const id = row.id;
  if (/^sns/i.test(id) || /subscribe/i.test(caption)) return "subscribe_and_save";
  if (/one-time/i.test(caption)) return "one_time";
  const cond = conditionOf(caption);
  if (cond === "used" || /^used/i.test(id)) return "used";
  if (cond === "renewed") return "renewed";
  if (cond === "collectible") return "collectible";
  if (cond === "new" || /^new/i.test(id)) return "new";
  return "other";
}

function rowCaption(row: DomElement): string {
  const cap =
    q(row, ".accordion-caption") ??
    q(row, "[id$=AccordionCaption_feature_div]") ??
    q(row, "#sns-caption-and-icon") ??
    q(row, "h5");
  return vtext(cap ?? undefined, (e) => matchesSafe(e, ".a-price, #corePrice_feature_div"));
}

function parsePurchaseOptions(ctx: Ctx): PurchaseOption[] {
  const out: PurchaseOption[] = [];
  for (const row of ctx.rows) {
    const caption = rowCaption(row);
    if (caption === "") continue;
    const header = q(row, ".a-accordion-row") ?? row;
    const opt: PurchaseOption = {
      kind: rowKind(row, caption),
      caption,
      selected: row === ctx.row,
    };
    if (row.id !== "") opt.row_id = row.id;
    const price = priceIn(q(header, "#apex_offerDisplay_desktop") ?? header);
    if (price !== undefined) opt.price = price.money;
    const unit = unitPriceIn(q(header, "#apex_offerDisplay_desktop") ?? header);
    if (unit !== undefined) opt.unit_price = unit;
    const slots = qa(header, "[id^=mir-layout-DELIVERY_BLOCK-slot-]");
    const delivery = slots.length > 0 ? slots : qa(header, "#deliveryDateLabel_feature_div");
    const dt = delivery
      .map((d) => vtext(d))
      .filter((t) => t !== "")
      .join(" | ");
    if (dt !== "") opt.delivery = dt;
    const badge = vtext(q(header, "#priceBadging_feature_div"));
    if (badge !== "") opt.badge = badge;
    const sfsb = q(header, "#sfsb_accordion_head");
    if (sfsb !== undefined) {
      const ss = parseShipsSold(vtext(sfsb));
      if (ss.ships_from !== undefined) opt.ships_from = ss.ships_from;
      if (ss.sold_by !== undefined) opt.sold_by = ss.sold_by;
    }
    if (row !== ctx.row) {
      // Non-selected rows are summarized here completely; the selected one feeds featured_offer.
      ctx.used.takeAll([
        q(row, "[id$=AccordionCaption_feature_div]") ?? q(row, ".accordion-caption"),
        q(row, "#snsCaptionAndDiscountPillAbbreviated_feature_div"),
        q(row, "#apex_offerDisplay_desktop"),
        q(row, "#apex_accordion_header_below_price_desktop"),
        q(row, "#deliveryDateLabel_feature_div"),
        sfsb,
      ]);
    } else {
      ctx.used.takeAll([
        q(row, "[id$=AccordionCaption_feature_div]") ?? q(row, ".accordion-caption"),
        q(row, "#snsCaptionAndDiscountPillAbbreviated_feature_div"),
      ]);
    }
    out.push(opt);
  }
  return out;
}

function slotKind(id: string): string {
  if (/PRIMARY/.test(id)) return "primary";
  if (/SECONDARY/.test(id)) return "secondary";
  if (/FASTEST/.test(id)) return "fastest";
  return "other";
}

function deliveryFrom(el: DomElement, kind: string): DeliveryPromise {
  const t = vtext(el);
  const out: DeliveryPromise = { kind, text: t, free: /\bFREE\b/.test(t) };
  const date = vtext(q(el, ".a-text-bold"));
  if (date !== "") {
    out.date = date;
    const iso = isoDate(date);
    if (iso !== undefined) out.date_iso = iso;
  }
  const cutoff = vtext(q(el, "#ftCountdown, .ftCountdownClass"));
  if (cutoff !== "") out.cutoff = cutoff;
  else {
    const m = /Order within (.+?)(?:\.|$)/.exec(t)?.[1];
    if (m !== undefined) out.cutoff = m.trim();
  }
  return out;
}

function parseDelivery(ctx: Ctx): DeliveryPromise[] {
  const scope = ctx.offer;
  const header = ctx.row !== undefined ? (q(ctx.row, ".a-accordion-row") ?? undefined) : undefined;
  return (
    firstOf<DeliveryPromise[]>(
      "featured_offer.delivery",
      [
        [
          "id",
          () => {
            const slots = qa(scope, "[id^=mir-layout-DELIVERY_BLOCK-slot-]").filter(
              (s) =>
                header === undefined ||
                !insideAny(s, header, "#deliveryBlockAbbreviated_feature_div") ||
                qa(scope, "#deliveryBlockMessage").length === 0,
            );
            const inBlock = slots.filter((s) => s.closest("#deliveryBlockMessage") !== null);
            const chosen = inBlock.length > 0 ? inBlock : slots;
            ctx.used.takeAll(chosen);
            return chosen.map((s) => deliveryFrom(s, slotKind(s.id)));
          },
        ],
        [
          "grocery-alm",
          () => {
            const el =
              q(scope, "#alm-delivery-message") ??
              q(ctx.doc, "#almLogoAndDeliveryMessage_feature_div #alm-delivery-message");
            const msg = q(el, "span") ?? el;
            if (msg === undefined || vtext(msg) === "") return undefined;
            ctx.used.take(msg);
            return [deliveryFrom(msg, "primary")];
          },
        ],
        [
          "text-anchor",
          () => {
            const el = findByText(
              [scope],
              "span, div",
              /^(FREE )?(delivery|Delivery)\b|^Arrives\b|^Get it\b/,
            );
            if (el === undefined) return undefined;
            ctx.used.take(el);
            return [deliveryFrom(el, "primary")];
          },
        ],
      ],
      ctx.meta,
      { optional: true },
    ) ?? []
  );
}

function parseDeliveryLocation(ctx: Ctx): string | undefined {
  return firstOf(
    "featured_offer.delivery_location",
    [
      [
        "id",
        () => {
          const el =
            q(ctx.offer, "#contextualIngressPtLabel_deliveryShortLine") ??
            q(ctx.buybox, "#contextualIngressPtLabel_deliveryShortLine") ??
            q(ctx.doc, "#contextualIngressPtLabel_deliveryShortLine");
          ctx.used.take(el?.closest("#contextualIngressPt") ?? el);
          return spacedText(el);
        },
      ],
      [
        "label",
        () =>
          cleanText(attr(rawOne(ctx.offer ?? ctx.doc, "#contextualIngressPtLink"), "aria-label")),
      ],
      ["text-anchor", () => vtext(q(ctx.doc, "#glow-ingress-line2"))],
    ],
    ctx.meta,
    { optional: true },
  );
}

function parseStock(ctx: Ctx): string | undefined {
  return firstOf(
    "featured_offer.stock_text",
    [
      ["id", () => vtext(ctx.used.take(q(ctx.offer, "#availability")))],
      ["id", () => vtext(ctx.used.take(q(ctx.offer, "#availability-string")))],
      ["id", () => vtext(ctx.used.take(q(ctx.buybox, "#availability")))],
      ["id", () => vtext(ctx.used.take(q(ctx.buybox, "#outOfStock")))],
      [
        "text-anchor",
        () =>
          vtext(
            ctx.used.take(
              findByText(
                [ctx.offer],
                "span, div",
                /^(In Stock|Only \d+ left|Currently unavailable|Temporarily out of stock)/i,
              ),
            ),
          ),
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function parseQuantity(ctx: Ctx): QuantityOptions | undefined {
  return firstOf<QuantityOptions>(
    "featured_offer.quantity_options",
    [
      [
        "id",
        () => {
          const select =
            q(ctx.offer, "select#quantity") ??
            q(ctx.offer, "select[name=quantity]") ??
            (ctx.row === undefined ? q(ctx.buybox, "select#quantity") : undefined);
          if (select === undefined) return undefined;
          const values = rawAll(select, "option")
            .map((o) => cleanText(attr(o, "value") ?? o.textContent ?? ""))
            .filter((v) => v !== "");
          const nums = values.map(Number).filter((n) => Number.isFinite(n));
          const out: QuantityOptions = { count: values.length };
          if (nums.length > 0) {
            out.min = Math.min(...nums);
            out.max = Math.max(...nums);
          }
          const sel = rawOne(select, "option[selected]");
          const prompt = select.parentElement?.querySelector(".a-dropdown-prompt");
          const selected = cleanText(attr(sel, "value") ?? prompt?.textContent ?? "");
          if (selected !== "") out.selected = selected;
          ctx.used.take(select.closest("#selectQuantity") ?? select.parentElement ?? select);
          return out;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

const LIMIT_RE =
  /(limit(ed to)? \d+ per (customer|order)|maximum (order|purchase) quantity|minimum (order|purchase) quantity|max(imum)? \d+ per|min(imum)? (order )?(of )?\d+|this item has a (maximum|minimum)|purchase limit)/i;

function parseLimits(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const scope of [ctx.offer, ctx.buybox]) {
    for (const el of qa(scope, "span, div, p")) {
      if (ctx.used.covers(el)) continue;
      const t = vtext(el);
      if (t.length > 200 || !LIMIT_RE.test(t)) continue;
      // Prefer the innermost element carrying the text.
      if (Array.from(el.children).some((c) => LIMIT_RE.test(vtext(c)))) continue;
      out.push(t);
      ctx.used.take(el);
    }
    if (out.length > 0) break;
  }
  if (out.length > 0) ctx.meta.strategies["featured_offer.limits_text"] = "text-anchor";
  return uniq(out);
}

function parseAddOns(ctx: Ctx): AddOn[] {
  const out: AddOn[] = [];
  const mbb = q(ctx.offer, "#mbb_feature_div") ?? q(ctx.buybox, "#mbb_feature_div");
  for (const box of qa(mbb, "input[type=checkbox]")) {
    const item = box.closest(".a-checkbox") ?? box.parentElement;
    if (item == null) continue;
    const link = q(item, "a") ?? q(item.parentElement, "a");
    const title = vtext(link);
    if (title === "") continue;
    const priceEl = q(item, ".a-color-price") ?? q(item.parentElement, ".a-color-price");
    const priceText = vtext(priceEl);
    const addOn: AddOn = { kind: "protection_plan", title };
    const price = parseMoney(priceText);
    if (price !== undefined) addOn.price = price;
    if (priceText !== "") addOn.price_text = priceText;
    out.push(addOn);
  }
  if (out.length > 0) {
    ctx.meta.strategies["featured_offer.add_ons"] = "id";
    ctx.used.take(mbb);
  }
  const tradeIn = q(ctx.doc, "#tradeInButton") ?? q(ctx.doc, "#twisterPlusWWDesktopWrapper");
  const tt = vtext(tradeIn);
  if (/trade-in/i.test(tt)) {
    const addOn: AddOn = { kind: "trade_in", title: tt };
    const price = parseMoney(tt);
    if (price !== undefined) addOn.price = price;
    out.push(addOn);
    ctx.used.take(tradeIn);
  }
  return out;
}

function parseCoupon(ctx: Ctx): { coupon?: Coupon; promotions: Promotion[] } {
  const roots = uniq(
    [
      q(ctx.apex, "#promoPriceBlockMessage_feature_div"),
      q(ctx.offer, "#promoPriceBlockMessage_feature_div"),
      q(ctx.doc, "#promoPriceBlockMessage_feature_div"),
      q(ctx.doc, "#couponFeature"),
      q(ctx.doc, "#vpcButton"),
    ].filter((x): x is DomElement => x !== undefined),
  );
  const result: { coupon?: Coupon; promotions: Promotion[] } = { promotions: [] };
  const coupon = firstOf<Coupon>(
    "featured_offer.coupon",
    [
      [
        "id",
        () => {
          for (const r of roots) {
            const label = q(r, ".couponLabelText") ?? q(r, "[id^=couponText]");
            if (label === undefined) continue;
            const badge = q(r, ".newCouponBadge") ?? q(r, "[id^=couponBadge]");
            const t = tidy(vtext(label, (e) => matchesSafe(e, "a")));
            const line = label.parentElement ?? label;
            const cond = /\b(when you (select|buy|purchase) .+)$/i.exec(t)?.[1];
            const clippable =
              cond === undefined &&
              (rawAll(line, "input[type=checkbox], [id*=clip], [id*=Clip]").length > 0 ||
                /^(apply|clip)\b/i.test(t));
            const out: Coupon = {
              text: [vtext(badge), t].filter((s) => s !== "").join(" "),
              clippable,
            };
            if (cond !== undefined) out.condition = cond;
            ctx.used.takeAll([label, badge]);
            for (const a of qa(label.parentElement, "a")) ctx.used.take(a);
            return out;
          }
          return undefined;
        },
      ],
      [
        "text-anchor",
        () => {
          const el = findByText(
            scopes(ctx),
            "span, label, div",
            /^(Apply|Clip)\s.*coupon|^Coupon:/i,
          );
          if (el === undefined) return undefined;
          const t = vtext(el);
          ctx.used.take(el);
          return { text: t, clippable: /^(apply|clip)/i.test(t) };
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  if (coupon !== undefined) result.coupon = coupon;
  for (const r of roots) {
    for (const badge of qa(r, "label[id^=greenBadge]")) {
      const id = badge.id.replace(/^greenBadge/, "");
      const msg = rawOne(r, `[id="promoMessage${id}"]`);
      const promo: Promotion = { text: vtext(msg, (e) => matchesSafe(e, "a")) };
      const b = vtext(badge);
      if (b !== "") promo.badge = b;
      if (promo.text === "" && promo.badge === undefined) continue;
      if (promo.text === "") promo.text = b;
      result.promotions.push(promo);
      ctx.used.takeAll([badge, msg]);
      for (const a of qa(msg?.parentElement, "a")) ctx.used.take(a);
    }
  }
  return result;
}

function parseDeal(ctx: Ctx): Deal | undefined {
  return firstOf<Deal>(
    "featured_offer.deal",
    [
      [
        "id",
        () => {
          const box = q(ctx.doc, "#dealBadge_feature_div") ?? q(ctx.doc, "#dealBadge");
          const t = spacedText(box);
          if (t === "") return undefined;
          ctx.used.take(box);
          return dealFromText(t, box);
        },
      ],
      [
        "text-anchor",
        () => {
          const el = findByText(
            scopes(ctx),
            "span, div",
            /^(Limited time deal|Lightning Deal|Deal of the Day|Prime (Big|Exclusive) Deal|Today's Big Deal)/i,
          );
          if (el === undefined) return undefined;
          ctx.used.take(el);
          return dealFromText(vtext(el), el);
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function dealFromText(t: string, box: DomElement | undefined): Deal {
  const type =
    /(Limited time deal|Lightning Deal|Deal of the Day|Prime Big Deal|Prime Exclusive Deal|Today's Big Deal|Black Friday Deal|Cyber Monday Deal|Deal)/i.exec(
      t,
    )?.[1] ?? t;
  const out: Deal = { type, raw: t };
  const timer = q(
    box,
    "[id*=countdown], [id*=Countdown], [id^=deal_expiry_timer], [id*=dealTimer]",
  );
  const cd = vtext(timer) || /\b(Ends in .+?)(?=\s*\d+% claimed|$)/i.exec(t)?.[1] || "";
  if (cd !== "") out.countdown = cd.trim();
  const claimed = /(\d+%\s*claimed)/i.exec(t)?.[1];
  if (claimed !== undefined) out.claimed = claimed;
  return out;
}

function parsePrime(ctx: Ctx, delivery: DeliveryPromise[]): Prime | undefined {
  return firstOf<Prime>(
    "featured_offer.prime",
    [
      [
        "id",
        () => {
          const badge =
            q(ctx.offer, "#priceBadging_feature_div") ??
            q(ctx.apex, "#priceBadging_feature_div") ??
            q(ctx.offer, "[class*=a-icon-prime]");
          if (badge === undefined) return undefined;
          const icon = matchesSafe(badge, "[class*=a-icon-prime]")
            ? badge
            : q(badge, "[class*=a-icon-prime]");
          if (icon === undefined) return undefined;
          const t = vtext(badge);
          const all = [
            ...qa(ctx.offer, "#priceBadging_feature_div"),
            ...qa(ctx.apex, "#priceBadging_feature_div"),
          ];
          ctx.used.takeAll(all);
          const out: Prime = t === "" ? { eligible: true } : { eligible: true, text: t };
          const badges = uniq(all.map((b) => vtext(b)).filter((x) => x !== ""));
          if (badges.length > 1) out.badges = badges;
          return out;
        },
      ],
      [
        "text-anchor",
        () =>
          delivery.some((d) => /Prime members/i.test(d.text))
            ? { eligible: true, text: "for Prime members" }
            : undefined,
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function parseReturns(ctx: Ctx, features: OfferFeatures): string | undefined {
  return firstOf(
    "featured_offer.returns",
    [
      ["odf-collapsed", () => featureValue(features, /^returns?$/i)],
      [
        "id",
        () => {
          const el =
            q(ctx.offer, "#creturns-policy-anchor-text") ??
            q(ctx.apex, "#creturns-policy-anchor-text");
          return vtext(el);
        },
      ],
      ["text-anchor", () => vtext(findByText(scopes(ctx), "a, span", /returns?\b/i))],
    ],
    ctx.meta,
    { optional: true },
  );
}

function takeReturnsBadges(ctx: Ctx): void {
  for (const scope of [ctx.offer, ctx.apex]) {
    for (const el of qa(scope, "#freeReturns_feature_div, #creturns-return-policy-content")) {
      ctx.used.take(el);
    }
  }
}

interface SellerInfo {
  seller?: SellerRef;
  ships_from?: string;
  fulfillment?: Fulfillment;
}

function parseSeller(ctx: Ctx, features: OfferFeatures): SellerInfo {
  const out: SellerInfo = {};
  const merchantId =
    attr(rawOne(ctx.offer, "input#merchantID, input[name=merchantID]"), "value") ||
    (ctx.row === undefined ? attr(rawOne(ctx.buybox, "input#merchantID"), "value") : undefined) ||
    undefined;
  const ss = firstOf<{ ships_from?: string; sold_by?: string }>(
    "featured_offer.seller",
    [
      [
        "odf-collapsed",
        () => {
          const both = featureValue(features, /^shipper\s*\/\s*seller$/i);
          if (both !== undefined) return { ships_from: both, sold_by: both };
          const ships = featureValue(features, /^ships from$/i);
          const sold = featureValue(features, /^sold by$/i);
          if (ships === undefined && sold === undefined) return undefined;
          const r: { ships_from?: string; sold_by?: string } = {};
          if (ships !== undefined) r.ships_from = ships;
          if (sold !== undefined) r.sold_by = sold;
          return r;
        },
      ],
      [
        "sfsb-accordion",
        () => {
          const el = q(ctx.row, "#sfsb_accordion_head");
          const r = parseShipsSold(vtext(el));
          return r.ships_from === undefined && r.sold_by === undefined ? undefined : r;
        },
      ],
      [
        "grocery-table",
        () => {
          const table =
            q(ctx.offer, "#fresh-merchant-info table") ?? q(ctx.doc, "#fresh-merchant-info table");
          const rows = tableToRows(table);
          if (rows.length === 0) return undefined;
          ctx.used.take(table?.closest("#almShipsFromSoldBy_feature_div") ?? table);
          const r: { ships_from?: string; sold_by?: string } = {};
          for (const [k, v] of rows) {
            if (k === undefined || v === undefined) continue;
            if (/ships from/i.test(k)) r.ships_from = v;
            if (/sold by/i.test(k)) r.sold_by = v;
          }
          return r;
        },
      ],
      [
        "text-anchor",
        () => {
          const el =
            q(ctx.offer, "#merchant-info") ??
            q(ctx.buybox, "#merchant-info") ??
            q(ctx.offer, "#tabular-buybox") ??
            findByText([ctx.offer], "div, span", /^(Ships from|Sold by)\b/);
          const r = parseShipsSold(vtext(el));
          if (r.ships_from === undefined && r.sold_by === undefined) return undefined;
          ctx.used.take(el);
          return r;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  if (ss?.sold_by !== undefined) {
    const seller: SellerRef = { name: ss.sold_by };
    const href = attr(features.sellerLink, "href");
    const id = sellerIdOfHref(href) ?? merchantId;
    if (id !== undefined && id !== "") seller.id = id;
    const path = pathOf(href);
    if (path !== undefined) seller.path = path;
    out.seller = seller;
  } else if (merchantId !== undefined && merchantId !== "") {
    out.seller = {
      name: merchantId === AMAZON_MERCHANT_ID ? "Amazon.com" : merchantId,
      id: merchantId,
    };
    ctx.meta.strategies["featured_offer.seller"] = "raw-input";
  }
  if (ss?.ships_from !== undefined) out.ships_from = ss.ships_from;
  const f = deriveFulfillment(ss?.ships_from, ss?.sold_by ?? out.seller?.name, merchantId);
  if (f !== undefined) out.fulfillment = f;
  return out;
}

function parseCondition(ctx: Ctx, features: OfferFeatures): Condition | undefined {
  return firstOf<Condition>(
    "featured_offer.condition",
    [
      [
        "odf-collapsed",
        () => {
          const t = featureValue(features, /^condition$/i);
          const kind = t === undefined ? undefined : conditionOf(t);
          return t === undefined || kind === undefined ? undefined : { kind, text: t };
        },
      ],
      [
        "selected-row",
        () => {
          if (ctx.row === undefined) return undefined;
          const t = rowCaption(ctx.row);
          const kind = conditionOf(t);
          return kind === undefined ? undefined : { kind, text: t };
        },
      ],
      [
        "id",
        () => {
          const el =
            q(ctx.offer, "#usedItemConditionInfo") ??
            q(ctx.offer, "#offerDisplayFeatures_condition");
          const t = vtext(el);
          const kind = conditionOf(t);
          return kind === undefined ? undefined : { kind, text: t };
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function parseSubscribeAndSave(ctx: Ctx): SubscribeAndSave | undefined {
  const row =
    ctx.rows.find((r) => /^sns/i.test(r.id) || /subscribe/i.test(rowCaption(r))) ??
    q(ctx.buybox, "#snsAccordionRowMiddle") ??
    q(ctx.buybox, "#sns-base-price")?.closest(".a-box") ??
    undefined;
  if (row === undefined) return undefined;
  ctx.meta.strategies["featured_offer.subscribe_and_save"] = "accordion-row";
  const header = q(row, ".a-accordion-row") ?? row;
  const out: SubscribeAndSave = {
    available: true,
    default_selected: row === ctx.row,
    discount_percents: [],
    discount_text: [],
    frequency_options: [],
  };
  const price = priceIn(
    q(header, "#sns-tiered-price") ?? q(header, "#subscriptionPrice") ?? header,
  );
  if (price !== undefined) out.price = price.money;
  const unit = unitPriceIn(q(header, "#sns-tiered-price") ?? header);
  if (unit !== undefined) out.unit_price = unit;
  const first = vtext(q(header, "#accordion-header-sns-delivery-link"));
  if (first !== "") out.first_delivery = first;
  // Discount wording lives in collapsed popovers; percentages are not prices.
  const pcts = new Set<number>();
  const sentences = new Set<string>();
  const PCT = /(\d{1,2})\s*(?:%|percent)/i;
  for (const el of rawAll(row, "span, div, p, li, label")) {
    if (!PCT.test(el.textContent ?? "")) continue;
    if (Array.from(el.children).some((c) => PCT.test(rawText(c, false)))) continue;
    const t = rawText(el, false);
    if (!PCT.test(t)) continue;
    for (const m of t.matchAll(/(\d{1,2})\s*(?:%|percent)/gi)) {
      if (m[1] !== undefined) pcts.add(Number(m[1]));
    }
    if (t.length < 220 && /sav|off|discount/i.test(t) && !/\$\s?\d/.test(t)) sentences.add(t);
  }
  out.discount_percents = [...pcts].sort((a, b) => a - b);
  out.discount_text = [...sentences].slice(0, 8);
  for (const sel of rawAll(row, "select")) {
    if (!/freq|interval|deliver/i.test(`${attr(sel, "name") ?? ""} ${sel.id}`)) continue;
    for (const o of rawAll(sel, "option")) {
      const t = cleanText(o.textContent ?? "");
      if (t !== "") out.frequency_options.push(t);
    }
  }
  const fv = attr(
    rawAll(row, "input[name*='recurringDelivery'][name*='frequency'][name*='value']")[0],
    "value",
  );
  const fu = attr(
    rawAll(row, "input[name*='recurringDelivery'][name*='frequency'][name*='unit']")[0],
    "value",
  );
  if (fv !== undefined && fu !== undefined) out.default_frequency = { value: fv, unit: fu };
  ctx.used.takeAll([
    q(header, "#apex_offerDisplay_desktop"),
    q(header, "#deliveryDateLabel_feature_div"),
    q(header, "#snsOfferDisplayFeatureCollapsed_desktop"),
  ]);
  return out;
}

function parseOtherSellers(ctx: Ctx): OtherSellers[] {
  const out: OtherSellers[] = [];
  const els = uniq(
    [
      ...qa(ctx.doc, "#olpLinkWidget_feature_div #dynamic-aod-ingress-box"),
      ...qa(ctx.doc, "#mediaMatrixGridAODPopover"),
      ...qa(ctx.doc, "[id^=refreshable_ppd-right] #dynamic-aod-ingress-box"),
      ...qa(ctx.doc, "#buybox-see-all-buying-choices"),
    ].filter((e) => !ctx.used.covers(e)),
  );
  for (const el of els) {
    const t = vtext(el);
    if (t === "") continue;
    const link = q(el, "#aod-ingress-link") ?? (matchesSafe(el, "a") ? el : q(el, "a"));
    const o: OtherSellers = { text: t };
    const count = /\((\d[\d,]*)\)/.exec(t)?.[1] ?? /\b(\d+) options?\b/.exec(t)?.[1];
    if (count !== undefined) o.count = Number(count.replace(/,/g, ""));
    const from = parseMoney(/from\s+(.+)$/i.exec(t)?.[1]);
    if (from !== undefined) o.from_price = from;
    const path = pathOf(attr(link, "href"));
    if (path !== undefined) o.path = path;
    out.push(o);
    ctx.used.take(el);
  }
  if (out.length > 0) ctx.meta.strategies.other_sellers = "id";
  return out;
}

// ---- buy box state

function hasButton(scope: DomElement | undefined, kind: "atc" | "buy_now"): boolean {
  const sel =
    kind === "atc"
      ? "#add-to-cart-button, #add-to-cart-button-grocery, input[name='submit.add-to-cart'], #freshAddToCartButton"
      : "#buy-now-button, input[name='submit.buy-now']";
  return qa(scope, sel).length > 0;
}

function decideState(
  ctx: Ctx,
  price: Money | undefined,
  stock: string | undefined,
  condition: Condition | undefined,
  options: PurchaseOption[],
): { state: BuyBoxState; evidence: string } {
  const bb = ctx.buybox;
  const atc = hasButton(ctx.offer, "atc") || (ctx.row === undefined && hasButton(bb, "atc"));
  const buyNow = hasButton(ctx.offer, "buy_now");
  const stockT = stock ?? "";
  const bbText = vtext(bb);
  const seeAll =
    present(bb, "#buybox-see-all-buying-choices") ||
    present(bb, "#buybox-see-all-buying-choices-announce") ||
    findByText([bb], "a, span, input", /^See All Buying Options$/i) !== undefined;
  const buttonsText = [
    attr(q(ctx.offer, "#add-to-cart-button"), "value"),
    attr(q(ctx.offer, "#buy-now-button"), "value"),
    vtext(q(ctx.offer, "#submit\\.add-to-cart-announce")),
    vtext(q(ctx.offer, "#submit\\.buy-now-announce")),
    vtext(q(ctx.offer, "#buy-now-button")?.parentElement ?? undefined),
  ].join(" ");
  if (/currently unavailable/i.test(stockT) || present(bb, "#outOfStock")) {
    return { state: "unavailable", evidence: "availability: currently unavailable" };
  }
  if (/temporarily out of stock/i.test(stockT)) {
    return atc || buyNow
      ? {
          state: "out_of_stock_orderable",
          evidence: "availability: temporarily out of stock + buy button",
        }
      : { state: "unavailable", evidence: "availability: temporarily out of stock, no buy button" };
  }
  if (
    /pre-?order/i.test(buttonsText) ||
    /\b(will be released on|pre-?order price guarantee|available for pre-?order)\b/i.test(
      `${stockT} ${bbText}`,
    )
  ) {
    return { state: "preorder", evidence: "pre-order button or release-date text" };
  }
  if (/no featured offers available/i.test(bbText)) {
    return { state: "no_featured_offer", evidence: "text: no featured offers available" };
  }
  if (price === undefined && seeAll) {
    return { state: "no_featured_offer", evidence: "see-all-buying-options without a price" };
  }
  if (seeAll && !atc && !buyNow) {
    return { state: "see_all_buying_options", evidence: "see-all-buying-options, no buy button" };
  }
  const hasNewRow = options.some(
    (o) => o.kind === "new" || o.kind === "one_time" || o.kind === "subscribe_and_save",
  );
  if (condition?.kind === "used" && !hasNewRow) {
    return { state: "used_only", evidence: "selected offer condition used, no new offer" };
  }
  if (condition?.kind === "renewed") {
    return { state: "renewed", evidence: "selected offer condition renewed" };
  }
  if (price !== undefined && (atc || buyNow)) {
    return { state: "featured_offer", evidence: "price + buy button" };
  }
  if (price !== undefined) {
    ctx.meta.warnings.push("buy_box: price without an add-to-cart or buy-now button");
    return { state: "featured_offer", evidence: "price without buy button" };
  }
  return { state: "unknown", evidence: "no decisive structure" };
}

/** Buy-box buttons besides add-to-cart / buy-now (list, registry, auto-buy, ...). */
const SECONDARY_ACTIONS = [
  "#addToWishlistAccordion_feature_div",
  "#wishlistButtonStack",
  "#digitalDashHighProminenceAccordion_feature_div",
  "#add-to-registry-baby-button",
  "#addToRegistry_feature_div",
];

// ---- featured offer assembly

function parseFeaturedOffer(ctx: Ctx): {
  offer?: FeaturedOffer;
  buyBox: BuyBox;
  options: PurchaseOption[];
} {
  const options = parsePurchaseOptions(ctx);
  const priceHit = parsePrice(ctx);
  const features = offerFeatures(ctx.offer);
  const stock = parseStock(ctx);
  const condition = parseCondition(ctx, features);
  const { state, evidence } = decideState(ctx, priceHit?.money, stock, condition, options);
  ctx.meta.strategies["buy_box.state"] = evidence;
  const buyBox: BuyBox = { state, evidence };
  if (ctx.row !== undefined) {
    const cap = rowCaption(ctx.row);
    if (cap !== "") buyBox.selected_option = cap;
  }
  const actions: string[] = [];
  for (const sel of SECONDARY_ACTIONS) {
    for (const el of qa(ctx.buybox, sel)) {
      if (ctx.used.covers(el)) continue;
      const t = vtext(el);
      if (t === "") continue;
      actions.push(t);
      ctx.used.take(el);
    }
  }
  if (actions.length > 0) buyBox.secondary_actions = uniq(actions);
  const delivery = parseDelivery(ctx);
  const offer: FeaturedOffer = {
    delivery,
    promotions: [],
    limits_text: [],
    add_to_cart_present:
      hasButton(ctx.offer, "atc") || (ctx.row === undefined && hasButton(ctx.buybox, "atc")),
    buy_now_present: hasButton(ctx.offer, "buy_now"),
    add_ons: [],
    offer_features: [],
  };
  if (priceHit !== undefined) {
    offer.price = priceHit.money;
    ctx.used.take(priceHit.el);
    const container = priceHit.el.parentElement;
    const around = vtext(container ?? undefined);
    if (/^est\.?/i.test(around)) offer.price_is_estimate = true;
    // "est. $0.30 /each": the unit the price is quoted per.
    const per = /\$[\d.,]+\s*\/\s*([A-Za-z]+)/.exec(around)?.[1];
    if (per !== undefined && offer.price_is_estimate === true) offer.price_per = per;
  }
  // Center column repeats of the same price.
  if (ctx.apex !== undefined && ctx.apex !== priceHit?.el.closest("#apex_desktop")) {
    const centre = priceIn(ctx.apex);
    if (
      centre !== undefined &&
      priceHit !== undefined &&
      centre.money.amount === priceHit.money.amount
    ) {
      ctx.used.take(centre.el);
    }
  }
  const basis = basisPrices(ctx, priceHit?.el);
  if (basis.list !== undefined) offer.list_price = basis.list;
  if (basis.typical !== undefined) offer.typical_price = basis.typical;
  const savings = parseSavings(ctx, priceHit?.el);
  if (savings !== undefined) offer.savings = savings;
  const unit =
    firstOf<UnitPrice>(
      "featured_offer.unit_price",
      [
        ["selected-row", () => unitPriceIn(ctx.row)],
        ["qualified-buybox", () => (ctx.row === undefined ? unitPriceIn(ctx.offer) : undefined)],
        ["apex-center", () => unitPriceIn(ctx.apex)],
        ["grocery-alm", () => groceryUnitPrice(ctx)],
      ],
      ctx.meta,
      { optional: true },
    ) ?? undefined;
  if (unit !== undefined) offer.unit_price = unit;
  for (const scope of [ctx.row ?? ctx.offer, ctx.apex]) {
    const sel = ".right-of-price-stack, .pricePerUnit, #apex-pricetopay-accessibility-label";
    for (const el of qa(scope, sel)) {
      if (!insideAny(el, scope, "#twister_feature_div, #sns-base-price")) ctx.used.take(el);
    }
    for (const el of qa(scope, ".apex-priceperunit-value")) {
      if (insideAny(el, scope, "#twister_feature_div, #sns-base-price")) continue;
      ctx.used.take(el.closest(".aok-relative") ?? el.parentElement ?? el);
    }
  }
  const { coupon, promotions } = parseCoupon(ctx);
  if (coupon !== undefined) offer.coupon = coupon;
  offer.promotions = promotions;
  const deal = parseDeal(ctx);
  if (deal !== undefined) offer.deal = deal;
  const seller = parseSeller(ctx, features);
  if (seller.seller !== undefined) offer.seller = seller.seller;
  if (seller.ships_from !== undefined) offer.ships_from = seller.ships_from;
  if (seller.fulfillment !== undefined) offer.fulfillment = seller.fulfillment;
  if (condition !== undefined) {
    offer.condition = condition;
  } else if (priceHit !== undefined) {
    offer.condition = { kind: "new", text: "New" };
    ctx.meta.strategies["featured_offer.condition"] = "default-new";
  }
  const prime = parsePrime(ctx, delivery);
  if (prime !== undefined) offer.prime = prime;
  const loc = parseDeliveryLocation(ctx);
  if (loc !== undefined) offer.delivery_location = loc.replace(/\s*-\s*$/, "");
  const returns = parseReturns(ctx, features);
  if (returns !== undefined) offer.returns = returns;
  takeReturnsBadges(ctx);
  if (stock !== undefined) offer.stock_text = stock;
  const qty = parseQuantity(ctx);
  if (qty !== undefined) offer.quantity_options = qty;
  offer.limits_text = parseLimits(ctx);
  const sns = parseSubscribeAndSave(ctx);
  if (sns !== undefined) offer.subscribe_and_save = sns;
  offer.add_ons = parseAddOns(ctx);
  const gift = featureValue(features, /^gift/i);
  const giftBoxes = qa(ctx.offer, "#gift-wrap, #giftwrap, [id^=gift-option]")
    .map((e) => vtext(e))
    .filter((t) => t !== "");
  if (gift !== undefined || giftBoxes.length > 0) {
    offer.gift = uniq([...(gift === undefined ? [] : [gift]), ...giftBoxes]);
  }
  for (const [label, v] of features.map) {
    if (/^(ships from|sold by|shipper \/ seller|returns?|condition|gift.*)$/i.test(label)) continue;
    offer.offer_features.push({ label, value: v.value });
  }
  // The expander itself: its only visible text is the "See more" toggle.
  for (const odf of qa(ctx.offer, "#offer-display-features")) ctx.used.take(odf);
  const inst =
    q(ctx.apex, "#paymentOptions_PriceblockMessaging_feature_div") ??
    q(ctx.offer, "#paymentOptions_PriceblockMessaging_feature_div");
  const instText = vtext(inst);
  if (instText !== "") {
    offer.installments = instText;
    ctx.used.take(inst);
  }
  const maple =
    q(ctx.apex, "#mapleAdvertisement_feature_div") ??
    q(ctx.offer, "#mapleAdvertisement_feature_div");
  const mapleText = vtext(maple);
  if (mapleText !== "") {
    offer.rewards_text = mapleText;
    ctx.used.take(maple);
  }
  const points =
    q(ctx.offer, "#pointsInsideBuyBox_feature_div") ?? q(ctx.offer, "#points_feature_div");
  const pointsText = vtext(points);
  if (pointsText !== "") {
    offer.points = pointsText;
    ctx.used.take(points);
  }
  ctx.used.takeAll([
    ...qa(ctx.offer, "#addToCart_feature_div"),
    ...qa(ctx.offer, "#buyNow_feature_div"),
    ...qa(ctx.offer, "#almAddToCart_feature_div .atc-faceout-container"),
  ]);
  takePriceBlocks(ctx, offer);
  const hasOffer = priceHit !== undefined || offer.add_to_cart_present || offer.buy_now_present;
  const result: { offer?: FeaturedOffer; buyBox: BuyBox; options: PurchaseOption[] } = {
    buyBox,
    options,
  };
  if (hasOffer) result.offer = offer;
  return result;
}

/**
 * Price containers whose every amount is already typed (price, list / typical, unit, savings)
 * are consumed whole, so their labels ("est.", "/each", screen-reader copies) do not leak into
 * other_sections. A container showing any other amount is left alone.
 */
function takePriceBlocks(ctx: Ctx, offer: FeaturedOffer): void {
  const known = new Set<number>();
  for (const m of [
    offer.price,
    offer.list_price,
    offer.typical_price,
    offer.unit_price?.price,
    offer.savings?.amount,
  ]) {
    if (m !== undefined) known.add(Math.round(m.amount * 100));
  }
  if (known.size === 0) return;
  const sel =
    "#corePriceDisplay_desktop_feature_div, #corePrice_feature_div, #almDesktopSingleOfferPriceWrapper";
  const scope = ctx.row ?? ctx.offer;
  const blocks = [
    ...qa(scope, sel),
    ...qa(ctx.apex, sel),
    ...(ctx.apex !== undefined && matchesSafe(ctx.apex, sel) ? [ctx.apex] : []),
  ];
  for (const b of blocks) {
    if (
      ctx.used.covers(b) ||
      insideAny(b, ctx.root, "#twister_feature_div, #sns-base-price, #snsAccordionRowMiddle")
    )
      continue;
    if (ctx.row !== undefined && b.closest("#buyBoxAccordion") !== null && !within(ctx.row, b))
      continue;
    const amounts = findMoney(text(b));
    if (amounts.length === 0) continue;
    if (amounts.every((m) => known.has(Math.round(m.amount * 100)))) ctx.used.take(b);
  }
}

function groceryUnitPrice(ctx: Ctx): UnitPrice | undefined {
  const wrap = q(ctx.doc, "#almDesktopSingleOfferPriceWrapper");
  const t = vtext(wrap);
  const m = /\(\s*(\$[\d.,]+)\s*\/\s*([^)]+)\)/.exec(t);
  if (m?.[1] === undefined) return undefined;
  const price = parseMoney(m[1]);
  if (price === undefined) return undefined;
  const out: UnitPrice = { price, raw: cleanText(m[0]) };
  if (m[2] !== undefined) out.unit = cleanText(m[2]);
  for (const el of qa(wrap, "span.a-size-small")) ctx.used.take(el);
  return out;
}

// ---- variants and media summaries

function parseVariantSummary(ctx: Ctx, parentAsin: string | undefined): VariantSummary | undefined {
  const dims = firstOf<VariantSummary["dimensions"]>(
    "variant_summary",
    [
      [
        "id",
        () => [
          ...qa(ctx.doc, "[id^=inline-twister-row-]").map((row) => {
            const name = row.id.replace(/^inline-twister-row-/, "");
            const header = q(row, `[id^=inline-twister-expander-header-]`);
            const title = q(row, `[id^=inline-twister-dim-title-]`);
            const selectedEl = q(row, `[id^=inline-twister-expanded-dimension-text-]`);
            const selected = vtext(selectedEl);
            const label = stripColon(vtext(title, (e) => e === selectedEl));
            const content = rawOne(row, `[id^=inline-twister-expander-content-]`);
            const aria = attr(content, "aria-label");
            const countText = /There (?:are|is) (\d+) options?/i.exec(aria ?? "")?.[1];
            const items = rawAll(row, "li[data-asin]");
            const swatches =
              items.length > 0
                ? items
                : rawAll(row, `[id^=${name}_]`).filter((e) => matchesSafe(e, ".a-button-toggle"));
            const d: VariantSummary["dimensions"][number] = { name };
            if (label !== "") d.label = label;
            if (selected !== "") d.selected = selected;
            const count = countText !== undefined ? Number(countText) : swatches.length;
            if (count > 0) d.option_count = count;
            ctx.used.take(header ?? title);
            return d;
          }),
          // Dimensions with a single value render as a plain "Label: Value" header.
          ...qa(ctx.doc, "[id^=inline-twister-singleton-header-]")
            .filter((h) => h.closest("[id^=inline-twister-row-]") === null)
            .map((h) => {
              const name = h.id.replace(/^inline-twister-singleton-header-/, "");
              const t = vtext(h);
              const m = /^([^:]+):\s*(.*)$/.exec(t);
              const d: VariantSummary["dimensions"][number] = { name, option_count: 1 };
              if (m?.[1] !== undefined) d.label = cleanText(m[1]);
              const sel = m?.[2] ?? t;
              if (sel !== "") d.selected = sel;
              ctx.used.take(h);
              return d;
            }),
        ],
      ],
      [
        "label",
        () =>
          qa(ctx.doc, "#twister [id^=variation_]").map((v) => {
            const name = v.id.replace(/^variation_/, "");
            const label = q(v, "label");
            const sel = q(v, ".selection");
            const d: VariantSummary["dimensions"][number] = { name };
            const lt = stripColon(vtext(label));
            if (lt !== "") d.label = lt;
            const st = vtext(sel);
            if (st !== "") d.selected = st;
            const n = rawAll(v, "li").length || rawAll(v, "option").length;
            if (n > 0) d.option_count = n;
            ctx.used.takeAll([label, sel]);
            return d;
          }),
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  if (dims === undefined && parentAsin === undefined) return undefined;
  const out: VariantSummary = { dimensions: dims ?? [] };
  if (parentAsin !== undefined) out.parent_asin = parentAsin;
  return out;
}

function parseMediaCounts(ctx: Ctx): MediaCounts | undefined {
  const scripts = rawAll(ctx.doc, "script").map((s) => s.textContent ?? "");
  const images = firstOf<number>(
    "media_counts.images",
    [
      [
        "blob",
        () => {
          for (const s of scripts) {
            const at = s.search(/'colorImages'\s*:\s*\{\s*'initial'\s*:/);
            if (at < 0) continue;
            const open = s.indexOf("[", at);
            const literal = open < 0 ? undefined : extractBalanced(s, open);
            if (literal === undefined) continue;
            // The payload is JSON inside a single-quoted JS string: undo the \' escapes.
            const arr = tryJson(literal.replace(/\\'/g, "'"));
            if (Array.isArray(arr)) return arr.length;
            // Every image entry carries exactly one "large" url.
            const n = (literal.match(/"large"\s*:/g) ?? []).length;
            if (n > 0) return n;
          }
          return undefined;
        },
      ],
      ["id", () => rawAll(ctx.doc, "#altImages li.imageThumbnail").length || undefined],
      [
        "id",
        () => (rawOne(ctx.doc, "#landingImage, #imgBlkFront, #ebooksImgBlkFront") ? 1 : undefined),
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  const videos = firstOf<number>(
    "media_counts.videos",
    [
      [
        "blob",
        () => {
          for (const s of scripts) {
            const m = /"totalVideoCount"\s*:\s*(\d+)/.exec(s);
            if (m?.[1] !== undefined) return Number(m[1]);
          }
          return undefined;
        },
      ],
      [
        "id",
        () => {
          const el = q(ctx.doc, "#videoCount");
          const n = parseCount(vtext(el));
          return n;
        },
      ],
      ["id", () => rawAll(ctx.doc, "#altImages li.videoThumbnail").length || undefined],
    ],
    ctx.meta,
    { optional: true },
  );
  const vc = q(ctx.doc, "#videoCount");
  if (vc !== undefined) ctx.used.take(vc);
  if (images === undefined && videos === undefined) return undefined;
  const out: MediaCounts = {};
  if (images !== undefined) out.images = images;
  if (videos !== undefined) out.videos = videos;
  return out;
}

// ---- rating

function parseRatingSummary(ctx: Ctx): RatingSummary | undefined {
  const { doc, used } = ctx;
  const out: RatingSummary = { histogram: [] };
  const acr = q(doc, "#averageCustomerReviews");
  const value = firstOf<{ value: number; out_of: number }>(
    "rating.value",
    [
      [
        "id",
        () => {
          const alt =
            vtext(q(acr, ".a-icon-alt")) || cleanText(attr(q(acr, "#acrPopover"), "title"));
          return parseRating(alt);
        },
      ],
      [
        "label",
        () => {
          const el = qa(doc, "#customer-reviews_feature_div [role=img][aria-label*='out of']")[0];
          return parseRating(attr(el, "aria-label"));
        },
      ],
      [
        "data-attr",
        () => {
          const icon = q(acr, "i[class*=a-star]") ?? q(doc, "[data-hook=rating-out-of-text]");
          const v = ratingFromClass(attr(icon, "class"));
          return v === undefined ? undefined : { value: v, out_of: 5 };
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  if (value !== undefined) {
    out.value = value.value;
    out.out_of = value.out_of;
  }
  const count = firstOf<number>(
    "rating.count",
    [
      [
        "id",
        () =>
          parseCount(
            attr(q(acr, "#acrCustomerReviewText"), "aria-label") ??
              vtext(q(acr, "#acrCustomerReviewText")),
          ),
      ],
      [
        "label",
        () => {
          const el = qa(doc, "#customer-reviews_feature_div [role=img][aria-label*='ratings']")[0];
          const m = /,\s*([\d,]+)\s+ratings?/i.exec(attr(el, "aria-label") ?? "");
          return m?.[1] === undefined ? undefined : Number(m[1].replace(/,/g, ""));
        },
      ],
      ["data-hook", () => parseCount(vtext(q(doc, "[data-hook=total-review-count]")))],
    ],
    ctx.meta,
    { optional: true },
  );
  if (count !== undefined) out.count = count;
  if (acr !== undefined) used.take(acr.closest("#averageCustomerReviews_feature_div") ?? acr);
  const hist = firstOf<Histogram[]>(
    "rating.histogram",
    [
      [
        "label",
        () => {
          const seen = new Map<number, number>();
          const els = qa(
            doc,
            "#customer-reviews_feature_div [aria-label*='of ratings'], #reviewsMedley [aria-label*='of ratings']",
          );
          for (const el of els) {
            const m = /(\d)\s+stars?\s+represents?\s+(\d+)%/i.exec(attr(el, "aria-label") ?? "");
            if (m?.[1] === undefined || m[2] === undefined) continue;
            if (!seen.has(Number(m[1]))) seen.set(Number(m[1]), Number(m[2]));
            used.take(el);
          }
          return [...seen]
            .map(([star, percent]) => ({ star, percent }))
            .sort((a, b) => b.star - a.star);
        },
      ],
      [
        "id",
        () => {
          const out2: Histogram[] = [];
          for (const tr of qa(doc, "#histogramTable tr, #histogramTable li")) {
            const t = vtext(tr);
            const m = /(\d)\s*star.*?(\d+)%/i.exec(t);
            if (m?.[1] !== undefined && m[2] !== undefined)
              out2.push({ star: Number(m[1]), percent: Number(m[2]) });
          }
          if (out2.length > 0) used.take(q(doc, "#histogramTable"));
          return out2;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
  if (hist !== undefined) out.histogram = hist;
  const goodreads = q(doc, "#goodreadsRatingsWidget_feature_div");
  const gt = vtext(goodreads);
  if (gt !== "") {
    out.external = [{ source: "Goodreads", text: gt }];
    used.take(goodreads);
  }
  // Heading + average block of the reviews widget.
  const anchor = q(doc, "#averageCustomerReviewsAnchor");
  if (anchor !== undefined && hist !== undefined) used.take(anchor);
  const ai = parseReviewSummary(ctx);
  if (ai !== undefined) out.review_summary_ai = ai;
  if (
    out.value === undefined &&
    out.count === undefined &&
    out.histogram.length === 0 &&
    ai === undefined &&
    out.external === undefined
  ) {
    return undefined;
  }
  return out;
}

function parseReviewSummary(ctx: Ctx): RatingSummary["review_summary_ai"] {
  const { doc, used } = ctx;
  return firstOf(
    "rating.review_summary_ai",
    [
      [
        "text-anchor",
        () => {
          const h = findByText(
            [q(doc, "#customer-reviews_feature_div") ?? q(doc, "#reviewsMedley")],
            "h2, h3, h4, span",
            /^Customers say$/,
          );
          const box = h?.parentElement;
          if (h === undefined || box == null) return undefined;
          const tablist = q(box, "[role=tablist]");
          const aspects: ReviewAspect[] = [];
          for (const tab of qa(box, "[role=tab][aria-label]")) {
            const a = parseAspect(attr(tab, "aria-label") ?? "");
            if (a !== undefined) aspects.push(a);
          }
          let summary = "";
          let note: string | undefined;
          for (const child of Array.from(box.children)) {
            if (child === h || (tablist !== undefined && within(tablist, child))) continue;
            const t = vtext(child, (e) => e === tablist || matchesSafe(e, "[role=tablist], h4"));
            if (t === "") continue;
            if (/generated from the text of customer reviews/i.test(t) && note === undefined) {
              note = t;
              continue;
            }
            if (summary === "") summary = t;
          }
          if (summary === "" && aspects.length === 0) return undefined;
          used.take(box);
          const out: { text: string; aspects: ReviewAspect[]; note?: string } = {
            text: summary,
            aspects,
          };
          if (note !== undefined) out.note = note;
          return out;
        },
      ],
      [
        "id",
        () => {
          const box = q(doc, "#product-summary") ?? q(doc, "[data-hook=cr-product-insights]");
          const t = vtext(q(box, "p") ?? box);
          if (t === "") return undefined;
          used.take(box);
          const aspects = qa(
            doc,
            "[data-hook=cr-insights-widget-aspects] button, #cr-product-insights-cards button",
          )
            .map((b) => parseAspect(attr(b, "aria-label") ?? vtext(b)))
            .filter((a): a is ReviewAspect => a !== undefined);
          return { text: t, aspects };
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function within(ancestor: DomElement, el: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement)
    if (cur === ancestor) return true;
  return false;
}

export function parseAspect(label: string): ReviewAspect | undefined {
  const m = /^(Positive|Negative|Mixed)\s+aspect,\s*(.+?)(?:,\s*([\d,]+)\s+mentions?)?$/i.exec(
    cleanText(label),
  );
  if (m?.[2] === undefined) return undefined;
  const sentiment = (m[1]?.toLowerCase() ?? "unknown") as ReviewAspect["sentiment"];
  const out: ReviewAspect = { name: m[2], sentiment };
  if (m[3] !== undefined) out.mentions = Number(m[3].replace(/,/g, ""));
  return out;
}

// ---- content

function listItems(root: DomElement | undefined, used: Consumption): string[] {
  const items = qa(root, "li").filter((li) => q(li, "li") === undefined);
  const out = items.map((li) => vtext(li)).filter((t) => t !== "");
  if (out.length > 0) used.takeAll(items);
  return out;
}

function parseBullets(ctx: Ctx): string[] {
  const { doc, used } = ctx;
  return (
    firstOf<string[]>(
      "bullets",
      [
        [
          "id",
          () => {
            const box = q(doc, "#feature-bullets");
            const out = listItems(q(box, "ul") ?? box, used);
            if (out.length > 0) {
              used.takeAll(qa(box, "h1, h2, h3"));
              // Heading, items and the "See more" expander toggle: nothing else lives here.
              used.take(box);
            }
            return out;
          },
        ],
        ["id", () => listItems(q(doc, "#featurebullets_feature_div"), used)],
        [
          "text-anchor",
          () => {
            const h = findByText(
              [q(doc, "#centerCol") ?? q(doc, "#ppd")],
              "h1, h2, h3",
              /^About this item$/i,
            );
            const box = h?.parentElement ?? undefined;
            const out = listItems(box, used);
            if (out.length > 0) used.take(h);
            return out;
          },
        ],
        // Accordion layouts (grocery "voyager") keep the bullets in a collapsed expander.
        ["collapsed", () => rawListItems(rawOne(doc, "#feature-bullets"))],
      ],
      ctx.meta,
      { optional: true },
    ) ?? []
  );
}

/** Consume the visible toggle of the collapsed expander holding `el`. */
function takeExpanderHeader(ctx: Ctx, el: DomElement | undefined): void {
  const exp = el?.closest(".a-expander-container");
  if (exp == null) return;
  const header = rawOne(exp, ".a-expander-header");
  if (header !== undefined && visible(header)) ctx.used.take(header);
}

/** List items of a collapsed (hidden-marked) list. */
function rawListItems(root: DomElement | undefined): string[] {
  return rawAll(root, "li")
    .filter((li) => rawOne(li, "li") === undefined)
    .map((li) => rawText(li))
    .filter((t) => t !== "");
}

function parseHighlights(ctx: Ctx): string[] {
  const filter = (xs: string[]): string[] =>
    uniq(xs.filter((t) => t !== "" && !/^Summarized from\b/i.test(t)));
  return (
    firstOf<string[]>(
      "highlights",
      [
        [
          "id",
          () => {
            const box = q(ctx.doc, "#nile-inline-insights_feature_div");
            const items = filter(
              qa(box, "li, [class*=insight-item], [class*=bullet], .afs-insights-pill")
                .filter((e) => q(e, "li") === undefined)
                .map((e) => vtext(e)),
            );
            if (items.length > 0) ctx.used.take(box);
            return items;
          },
        ],
        [
          "collapsed",
          () => {
            const box = rawOne(ctx.doc, "#afs-insights");
            const pills = rawAll(box, ".afs-insights-pill").map((e) => rawText(e));
            const items = filter(pills.length > 0 ? pills : rawListItems(box));
            if (items.length > 0) takeExpanderHeader(ctx, box);
            return items;
          },
        ],
      ],
      ctx.meta,
      { optional: true },
    ) ?? []
  );
}

function parseDescription(ctx: Ctx): string | undefined {
  const { doc, used } = ctx;
  return firstOf(
    "description",
    [
      [
        "id",
        () => {
          const el = q(doc, "#productDescription");
          const t = vtext(el);
          if (t === "") return undefined;
          used.take(el);
          const h = qa(el?.parentElement, "h2, h3")[0];
          if (h !== undefined && /description/i.test(vtext(h))) used.take(h);
          return t;
        },
      ],
      [
        "id",
        () => {
          const el = q(doc, "#bookDescription_feature_div");
          const t = vtext(el, (e) => matchesSafe(e, ".a-expander-prompt, .a-expander-header"));
          if (t === "") return undefined;
          used.take(el);
          return t;
        },
      ],
      [
        "id",
        () => {
          const el = q(doc, "#productDescription_feature_div");
          const t = vtext(el, (e) => matchesSafe(e, "h2"));
          if (t === "") return undefined;
          used.take(el);
          return t;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

const APLUS_ROOTS = [
  "#aplus_feature_div",
  "#aplusBrandStory_feature_div",
  "#aplus3p_feature_div",
  "#aplusSustainabilityStory_feature_div",
  "#aplusProductDescription_feature_div",
];

function parseAplus(ctx: Ctx): TextSection[] {
  const out: TextSection[] = [];
  for (const sel of APLUS_ROOTS) {
    for (const root of qa(ctx.doc, sel)) {
      if (ctx.used.covers(root)) continue;
      const rootHeading = qa(root, "h2")[0];
      const modules = qa(
        root,
        ".aplus-module, [class*=aplus-module], .apm-brand-story-card, [class*=apm-brand-story], .a-carousel-card",
      ).filter((m) => {
        for (let p = m.parentElement; p != null && p !== root; p = p.parentElement) {
          if (
            matchesSafe(
              p,
              ".aplus-module, [class*=aplus-module], .apm-brand-story-card, [class*=apm-brand-story], .a-carousel-card",
            )
          )
            return false;
        }
        return true;
      });
      const parts = modules.length > 0 ? modules : [root];
      let any = false;
      for (const m of parts) {
        const exclude = (e: DomElement): boolean => e === rootHeading;
        const t = vtext(m, exclude);
        if (t === "") continue;
        const h = qa(m, "h1, h2, h3, h4, h5, h6, [class*=heading], [role=heading]").find(
          (x) => x !== rootHeading,
        );
        out.push({
          heading: h === undefined ? vtext(rootHeading) || null : vtext(h) || null,
          text: t,
        });
        ctx.used.take(m);
        any = true;
      }
      if (any) {
        ctx.used.take(rootHeading);
        ctx.meta.strategies.aplus_text = modules.length > 0 ? "id" : "label";
      }
    }
  }
  return out;
}

function parseOverview(ctx: Ctx): KeyValue[] {
  const box = q(ctx.doc, "#productOverview_feature_div") ?? q(ctx.doc, "#poExpander");
  const rows = tableToRows(q(box, "table"));
  const out: KeyValue[] = [];
  for (const r of rows) {
    if (r.length < 2 || r[0] === undefined || r[1] === undefined) continue;
    out.push({ label: stripColon(r[0]), value: cleanText(r.slice(1).join(" ")) });
  }
  if (out.length > 0) {
    ctx.meta.strategies.overview = "id";
    ctx.used.take(box);
  }
  return out;
}

function rowsOfTable(table: DomElement): KeyValue[] {
  const out: KeyValue[] = [];
  for (const tr of rawAll(table, "tr")) {
    if (tr.closest("table") !== table) continue;
    const cells = Array.from(tr.children).filter(
      (c) => c.localName === "th" || c.localName === "td",
    );
    if (cells.length < 2) continue;
    const label = stripColon(rawText(cells[0]));
    const value = cleanText(
      cells
        .slice(1)
        .map((c) => valueText(c))
        .join(" "),
    );
    if (label === "" && value === "") continue;
    out.push({ label, value });
  }
  return out;
}

/** Cell text with the nested review-stars widget reduced to its alt text. */
function valueText(cell: DomElement): string {
  const acr = rawOne(cell, "#averageCustomerReviews");
  if (acr !== undefined) {
    const alt = cleanText(rawOne(acr, ".a-icon-alt")?.textContent ?? "");
    const count = cleanText(rawOne(acr, "#acrCustomerReviewText")?.textContent ?? "");
    return cleanText(`${alt} ${count}`);
  }
  return rawText(cell);
}

const SPEC_TABLE_SELECTOR = [
  "#prodDetails table",
  "#productDetails_feature_div table",
  "#voyagerNorthstarATF table",
  "#productDetails_techSpec_section_1",
  "#productDetails_techSpec_section_2",
  "#productDetails_detailBullets_sections1",
  "#technicalSpecifications_section_1",
  "table.prodDetTable",
].join(", ");

const NOT_SPEC_TABLE = [
  "#aplus_feature_div",
  "#aplusBrandStory_feature_div",
  "#customer-reviews_feature_div",
  "#rightCol",
  "#nutritionalInfoAndIngredients_feature_div",
  "#productOverview_feature_div",
  ".a-popover-preload",
].join(", ");

/** Nearest heading before `el` (its earlier siblings, then its ancestors' earlier siblings). */
function precedingHeading(el: DomElement): DomElement | undefined {
  let cur: DomElement | null = el;
  for (let depth = 0; cur != null && depth < 4; depth++, cur = cur.parentElement) {
    const parent: DomElement | null = cur.parentElement;
    if (parent === null) break;
    const kids = Array.from(parent.children);
    for (let i = kids.indexOf(cur) - 1; i >= 0; i--) {
      const sib = kids[i];
      if (sib === undefined) continue;
      if (matchesSafe(sib, "h1, h2, h3, h4, h5")) return sib;
      if (matchesSafe(sib, "table")) return undefined;
    }
  }
  return undefined;
}

function parseSpecTables(ctx: Ctx, ranks: BestSellerRank[]): SpecTable[] {
  const out: SpecTable[] = [];
  const doc = ctx.doc;
  const seen = new Set<DomElement>();
  /** The same table is often repeated (accordion + "see all" side sheet): keep the first. */
  const seenRows = new Set<string>();
  // Key/value tables: the expander layout ("header + collapsed table", product information
  // and the voyager accordion) and classic tables with their own headings.
  for (const table of rawAll(ctx.root, SPEC_TABLE_SELECTOR)) {
    if (seen.has(table) || insideAny(table, ctx.root, NOT_SPEC_TABLE)) continue;
    if (table.parentElement?.closest("table") != null) continue;
    seen.add(table);
    const rows = rowsOfTable(table);
    if (rows.length === 0) continue;
    const exp = table.closest(".a-expander-container");
    const prompt = exp === null ? undefined : rawOne(exp, ".a-expander-prompt");
    let heading = rawText(prompt);
    let h: DomElement | undefined;
    if (heading === "") {
      h = precedingHeading(table);
      heading = rawText(h);
    }
    const sig = JSON.stringify(rows);
    if (seenRows.has(sig)) continue;
    seenRows.add(sig);
    const source =
      exp === null
        ? "prodDetails-table"
        : table.closest("#voyagerNorthstarATF") !== null
          ? "voyager-expander"
          : "prodDetails-expander";
    out.push({
      heading: heading === "" ? null : heading,
      rows,
      collapsed: !visible(table),
      source,
    });
    if (visible(table)) ctx.used.take(table);
    if (h !== undefined && visible(h)) ctx.used.take(h);
    if (prompt !== undefined && visible(prompt))
      ctx.used.take(prompt.closest(".a-expander-header") ?? prompt);
  }
  // Detail bullets (books, grocery, many media items).
  for (const box of qa(doc, "#detailBullets_feature_div, #detailBulletsWrapper_feature_div")) {
    if (seen.has(box) || ctx.used.covers(box)) continue;
    seen.add(box);
    const rows: KeyValue[] = [];
    for (const li of qa(box, "li")) {
      if (q(li, "li") !== undefined && q(li, ".a-text-bold") === undefined) continue;
      if (li.parentElement?.closest("li") != null) continue;
      const bold = q(li, ".a-text-bold");
      const label = stripColon(vtext(bold));
      if (label === "") continue;
      const value = vtext(li, (e) => e === bold);
      rows.push({ label, value });
    }
    if (rows.length === 0) continue;
    const container = box.closest("#detailBulletsWrapper_feature_div") ?? box;
    const h = qa(container, "h2, h3")[0];
    out.push({
      heading: vtext(h) || "Product details",
      rows,
      collapsed: false,
      source: "detail-bullets",
    });
    ctx.used.take(container);
    seen.add(container);
  }
  if (out.length > 0) {
    ctx.meta.strategies.spec_tables = uniq(out.map((t) => t.source)).join("+");
    for (const box of qa(doc, "#prodDetails, #productDetails_feature_div")) {
      for (const h of qa(box, "h1, h2")) if (!ctx.used.covers(h)) ctx.used.take(h);
    }
  }
  // Best sellers rank lives in one of those tables.
  for (const t of out) {
    for (const r of t.rows) {
      if (!/best ?sellers? rank/i.test(r.label)) continue;
      const anchors = rawAll(doc, "a[href*='/gp/bestsellers/']");
      for (const rank of parseRanks(r.value, anchors)) {
        if (!ranks.some((x) => x.rank === rank.rank && x.category === rank.category))
          ranks.push(rank);
      }
    }
  }
  if (ranks.length > 0) ctx.meta.strategies.best_seller_ranks = "spec-table";
  return out;
}

const DISCLAIMER_SELECTORS = [
  "#storeDisclaimer_feature_div",
  "#safetyWarning_feature_div",
  "#productSafetyWarning_feature_div",
  "#prop65Warning_feature_div",
];

function parseImportantInformation(ctx: Ctx): TextSection[] {
  const box =
    q(ctx.doc, "#important-information") ?? q(ctx.doc, "#importantInformation_feature_div");
  const out: TextSection[] = [];
  // Store / safety disclaimers rendered as their own cards.
  for (const sel of DISCLAIMER_SELECTORS) {
    for (const el of qa(ctx.doc, sel)) {
      if (ctx.used.covers(el)) continue;
      const t = vtext(el);
      if (t === "") continue;
      const h = /^([A-Z][A-Za-z ]{2,40}):\s/.exec(t)?.[1];
      out.push({ heading: h ?? null, text: t });
      ctx.used.take(el);
      ctx.meta.strategies.important_information = "id";
    }
  }
  if (box === undefined) return out;
  for (const content of qa(box, ".content")) {
    let heading: string | null = null;
    let buf: string[] = [];
    const flush = (): void => {
      const t = cleanText(buf.join(" "));
      if (t !== "" || heading !== null) out.push({ heading, text: t });
      buf = [];
    };
    for (const child of Array.from(content.children)) {
      if (hiddenSelf(child)) continue;
      if (matchesSafe(child, "h4, h5, .a-text-bold")) {
        if (heading !== null || buf.length > 0) flush();
        heading = vtext(child) || null;
      } else {
        const t = vtext(child);
        if (t !== "") buf.push(t);
      }
    }
    flush();
  }
  if (out.length > 0) {
    ctx.meta.strategies.important_information = "id";
    ctx.used.take(box);
  }
  return out;
}

function parseWhatsInTheBox(ctx: Ctx): string[] {
  return (
    firstOf<string[]>(
      "whats_in_the_box",
      [
        [
          "id",
          () => takeList(ctx, q(ctx.doc, "#witb-content-list"), q(ctx.doc, "#whatsInTheBoxDeck")),
        ],
        [
          "id",
          () =>
            takeList(
              ctx,
              q(ctx.doc, "#postPurchaseWhatsInTheBox_MP_feature_div"),
              q(ctx.doc, "#postPurchaseWhatsInTheBox_MP_feature_div"),
            ),
        ],
      ],
      ctx.meta,
      { optional: true },
    ) ?? []
  );
}

function takeList(
  ctx: Ctx,
  list: DomElement | undefined,
  container: DomElement | undefined,
): string[] | undefined {
  const items = qa(list, "li")
    .filter((li) => q(li, "li") === undefined)
    .map((li) => vtext(li))
    .filter((t) => t !== "");
  if (items.length === 0) return undefined;
  ctx.used.take(container ?? list);
  return items;
}

function parseDocuments(ctx: Ctx): { text: string; path: string }[] {
  const out: { text: string; path: string }[] = [];
  for (const sel of ["#productDocuments_feature_div", "#buffetServiceCard_feature_div"]) {
    const box = q(ctx.doc, sel);
    for (const a of qa(box, "a[href]")) {
      const t = vtext(a);
      const path = pathOf(attr(a, "href"));
      if (t === "" || path === undefined) continue;
      if (!/\.pdf$|manual|guide|warranty|document|safety/i.test(`${path} ${t}`)) continue;
      out.push({ text: t, path });
    }
    if (out.length > 0 && sel === "#productDocuments_feature_div") ctx.used.take(box);
  }
  if (out.length > 0) ctx.meta.strategies.documents = "id";
  const seenPaths = new Set<string>();
  return out.filter((d) => {
    const k = `${d.text}|${d.path}`;
    if (seenPaths.has(k)) return false;
    seenPaths.add(k);
    return true;
  });
}

// ---- notices

interface NoticeRule {
  type: string;
  selectors: string[];
  /** Only emit when the text matches (when given). */
  match?: RegExp;
}

const NOTICE_RULES: NoticeRule[] = [
  { type: "amazons_choice", selectors: ["#acBadge_feature_div"], match: /choice/i },
  { type: "best_seller", selectors: ["#zeitgeistBadge_feature_div"], match: /best seller/i },
  {
    type: "climate_pledge_friendly",
    selectors: ["#climatePledgeFriendlyATF_feature_div", "#climatePledgeFriendlyBadge"],
  },
  { type: "renewed_badge", selectors: ["#refurbishedBadge_feature_div"] },
  {
    type: "bought_in_past_month",
    selectors: ["#socialProofingAsinFaceout_feature_div"],
    match: /bought/i,
  },
  { type: "small_business", selectors: ["#smallBusinessBadge_feature_div", "[id^=smallBusiness]"] },
  {
    type: "frequently_returned",
    selectors: ["#buyingOptionRipersInlineBadge_feature_div", "[id*=ripers]"],
    match: /frequently returned/i,
  },
  {
    type: "usually_kept",
    selectors: ["#buyingOptionRipersInlineBadge_feature_div", "[id*=ripers]"],
    match: /usually keep/i,
  },
  {
    type: "lowest_price_30_days",
    selectors: ["#delightPricingBadge_feature_div", "#dealBadge_feature_div"],
    match: /lowest price in 30 days/i,
  },
  {
    type: "lower_price_other_sellers",
    selectors: ["#alternativeOfferEligibilityMessaging_feature_div"],
  },
  { type: "prime_exclusive_price", selectors: ["#pep_feature_div"] },
  {
    type: "last_purchased",
    selectors: [
      "#instantOrderUpdate_feature_div",
      "#instantOrderUpdate",
      "#ourPurchasedBox_feature_div",
      "#purchaseHistoryMessage_feature_div",
    ],
  },
  {
    type: "compatibility",
    selectors: ["#compatibilityContainerDesktop", "#compatibilityFinder_feature_div"],
  },
  { type: "sustainability", selectors: ["#sustZoneATF_feature_div"] },
  { type: "age_restriction", selectors: ["#ageRestriction_feature_div", "[id*=ageVerification]"] },
  { type: "prop65_warning", selectors: ["#prop65_feature_div", "[id*=prop65]", "[id*=Prop65]"] },
  { type: "snap_ebt", selectors: ["#oasisLabel_feature_div"], match: /SNAP|EBT/i },
];

/** Text anchors for notices whose container id is not known. */
const NOTICE_TEXT: { type: string; re: RegExp }[] = [
  { type: "last_purchased", re: /\b(you )?(last )?(purchased|bought|ordered) this( item)? on\b/i },
  { type: "frequently_returned", re: /^frequently returned item\b/i },
  { type: "lowest_price_30_days", re: /^lowest price in 30 days$/i },
  { type: "prop65_warning", re: /\b(proposition 65|p65warnings)\b/i },
  {
    type: "age_restriction",
    re: /\b(you must be (18|21)|age verification required|age restricted)\b/i,
  },
];

function parseNotices(ctx: Ctx): Notice[] {
  const out: Notice[] = [];
  const push = (n: Notice, el: DomElement | undefined): void => {
    if (n.text === "") return;
    if (out.some((o) => o.type === n.type && o.text === n.text)) return;
    out.push(n);
    ctx.used.take(el);
  };
  for (const rule of NOTICE_RULES) {
    for (const sel of rule.selectors) {
      const el = q(ctx.doc, sel);
      if (el === undefined || ctx.used.covers(el)) continue;
      const t = vtext(el);
      if (t === "" || (rule.match !== undefined && !rule.match.test(t))) continue;
      const n: Notice = { type: rule.type, text: t };
      const link = q(el, "a[href]");
      const path = pathOf(attr(link, "href"));
      if (path !== undefined) n.path = path;
      push(n, el);
      break;
    }
  }
  // Newer model.
  const newer = q(ctx.doc, "#newerVersion_feature_div") ?? q(ctx.doc, "#newer-version");
  if (newer !== undefined) {
    const link = qa(newer, "a[href]").find((a) => asinOfHref(attr(a, "href")) !== undefined);
    const n: Notice = { type: "newer_model", text: vtext(newer) };
    const asin = asinOfHref(attr(link, "href"));
    if (asin !== undefined) n.asin = asin;
    const path = pathOf(attr(link, "href"));
    if (path !== undefined) n.path = path;
    push(n, newer);
  }
  // Text-anchored notices anywhere in the center column or buy box.
  const roots = [
    q(ctx.doc, "#centerCol"),
    ctx.buybox,
    q(ctx.doc, "#ppd"),
    q(ctx.doc, "#above-dp-container"),
  ];
  for (const { type, re } of NOTICE_TEXT) {
    if (out.some((o) => o.type === type)) continue;
    for (const root of roots) {
      const el = qa(root, "div, span, p").find((e) => {
        if (ctx.used.covers(e)) return false;
        const t = vtext(e);
        return (
          t.length < 300 && re.test(t) && !Array.from(e.children).some((c) => re.test(vtext(c)))
        );
      });
      if (el !== undefined) {
        push({ type, text: vtext(el) }, el);
        break;
      }
    }
  }
  if (out.length > 0) ctx.meta.strategies.notices = "id+text-anchor";
  return out;
}

// ---- carousels: sponsored and related

const SPONSORED_SIGNAL =
  "[class*=sponsored_label], [class*=sponsored-label], [id^=ad-feedback-text], [class*=ad-feedback-text], [id^=sp_detail], [data-ad-feedback], [data-adfeedbackdetails], .sp-sponsored-label-text";
const SPONSORED_NAME = /sponsored|^sp[-_]|dramabot|^ape_|ad-endcap|^ams|adplaceholder|-ads-/i;
const BLOCK_ROOT = "[data-feature-name], [cel_widget_id], .a-carousel-container, #cr-ADPlaceholder";
const CARD = "li.a-carousel-card, [data-asin]";

function nameOf(el: DomElement): string {
  return [el.id, attr(el, "data-feature-name") ?? "", attr(el, "cel_widget_id") ?? ""].join(" ");
}

function isSponsoredName(el: DomElement): boolean {
  return nameOf(el)
    .split(" ")
    .some((n) => n !== "" && SPONSORED_NAME.test(n));
}

function cardsOf(root: DomElement, includeHidden: boolean): DomElement[] {
  const all = includeHidden ? rawAll(root, CARD) : qa(root, CARD);
  const cards = all.filter((c) => {
    if (matchesSafe(c, "[data-asin]") && (attr(c, "data-asin") ?? "") === "") return false;
    for (let p = c.parentElement; p != null && p !== root; p = p.parentElement) {
      if (all.includes(p)) return false;
    }
    return true;
  });
  return cards;
}

function itemOf(card: DomElement, raw: boolean): CarouselItem {
  const read = (el: DomElement | undefined): string => (raw ? rawText(el) : vtext(el));
  const out: CarouselItem = {};
  const links = rawAll(card, "a[href]");
  const asin =
    (ASIN_RE.test(attr(card, "data-asin") ?? "") ? attr(card, "data-asin") : undefined) ??
    attr(
      rawAll(card, "[data-asin]").find((e) => ASIN_RE.test(attr(e, "data-asin") ?? "")),
      "data-asin",
    ) ??
    links.map((a) => asinOfHref(attr(a, "href"))).find((x) => x !== undefined);
  if (asin !== undefined) out.asin = asin;
  const titleEl =
    rawOne(card, ".a-truncate-full") ??
    rawOne(card, "[class*=title] a, [class*=Title] a") ??
    rawOne(card, "[class*=title], [class*=Title]") ??
    links.find((a) => rawText(a).length > 15);
  let title = read(titleEl);
  if (title === "") title = cleanText(attr(rawOne(card, "img[alt]"), "alt"));
  if (title !== "") out.title = title;
  const priceEl = raw ? rawOne(card, ".a-price") : q(card, ".a-price");
  const price = raw ? rawPriceFrom(priceEl) : priceFrom(priceEl);
  if (price !== undefined) out.price = price;
  const ratingLabel =
    attr(rawOne(card, "[aria-label*='out of 5 stars']"), "aria-label") ??
    cleanText(rawOne(card, ".a-icon-alt")?.textContent ?? "");
  const rating = parseRating(ratingLabel);
  if (rating !== undefined) out.rating = rating.value;
  const rc = /([\d,]+)\s+ratings?/i.exec(ratingLabel ?? "")?.[1];
  if (rc !== undefined) out.rating_count = Number(rc.replace(/,/g, ""));
  else {
    const countEl =
      rawOne(card, "a[href*='customerReviews'] span, .a-size-small[aria-hidden]") ??
      rawOne(card, "a[href*='product-reviews'] + span");
    const n = parseCountDetail(rawText(countEl));
    if (n !== undefined && !n.approximate) out.rating_count = n.value;
  }
  if (!raw) {
    // Whatever else the card shows (discount, strikethrough, delivery, badges).
    const rest = vtext(card, (e) => e === titleEl || matchesSafe(e, ".a-icon-alt"));
    const details = cleanText(
      rest.replace(price?.raw ?? "\u0000", " ").replace(/^\s*\.\.\.\s*/, ""),
    );
    if (details !== "") out.details = details;
  }
  return out;
}

/** Visible text of a widget outside its items and heading (bundle totals, buttons). */
function footerOf(root: DomElement, itemSelector: string): string {
  return vtext(root, (e) =>
    matchesSafe(e, `${itemSelector}, h1, h2, h3, .a-carousel-heading, ${SPONSORED_SIGNAL}`),
  );
}

function headingOf(root: DomElement, raw: boolean): string | null {
  const h =
    rawOne(root, ".a-carousel-heading") ??
    rawAll(root, "h2, h3, [role=heading]").find(
      (e) => rawText(e) !== "" && !/^sponsored$/i.test(rawText(e)),
    );
  const t = raw ? rawText(h) : vtext(h);
  return t === "" ? null : t;
}

function parseSponsored(ctx: Ctx): SponsoredBlock[] {
  const roots = new Set<DomElement>();
  const content = ctx.root;
  for (const sig of rawAll(content, SPONSORED_SIGNAL)) {
    const r = sig.closest(BLOCK_ROOT);
    if (r !== null) roots.add(r);
  }
  for (const el of rawAll(content, "[data-feature-name], [cel_widget_id]")) {
    if (isSponsoredName(el)) roots.add(el);
  }
  // Document order, then outermost wins, but never the reviews widget or the buy box as a whole.
  const ordered = rawAll(content, `${BLOCK_ROOT}, [data-feature-name], [cel_widget_id]`).filter(
    (e) => roots.has(e),
  );
  const candidates = ordered.filter((r) => {
    if (matchesSafe(r, "#customer-reviews_feature_div, #desktop_buybox, #ppd, #dp-container"))
      return false;
    for (let p = r.parentElement; p != null; p = p.parentElement)
      if (roots.has(p) && !matchesSafe(p, "#customer-reviews_feature_div")) return false;
    return true;
  });
  const out: SponsoredBlock[] = [];
  for (const r of candidates) {
    const cards = cardsOf(r, true);
    const visText = vtext(
      r,
      (e) =>
        matchesSafe(e, SPONSORED_SIGNAL) ||
        /^Sponsored( Ad)?$/.test(cleanText(e.textContent ?? "")),
    );
    // Hidden means: the browser rendered none of the block's items or text (blocked).
    const hidden = !cards.some((c) => visible(c)) && visText === "";
    const rawAllText = rawText(r);
    const sponsoredNamed =
      isSponsoredName(r) || rawAll(r, "[data-feature-name], [cel_widget_id]").some(isSponsoredName);
    const signal = rawAll(r, SPONSORED_SIGNAL).length > 0 || sponsoredNamed;
    if (!signal) continue;
    if (cards.length === 0 && rawAllText === "") continue;
    const items =
      cards.length > 0
        ? cards
            .map((c) => itemOf(c, !visible(c)))
            .filter((i) => i.asin !== undefined || i.title !== undefined)
        : bundleItems(ctx, r, hidden);
    if (items.length === 0 && rawAllText === "") continue;
    // A rendered block we could not itemize stays in other_sections rather than vanish.
    if (!hidden && items.length === 0) continue;
    const feature = r.closest("[data-feature-name]");
    const block: SponsoredBlock = {
      key:
        r.id ||
        attr(r, "cel_widget_id") ||
        feature?.id ||
        attr(feature, "data-feature-name") ||
        "sponsored",
      heading: headingOf(r, hidden),
      is_sponsored: true,
      hidden_in_browser: hidden,
      items,
    };
    if (!hidden) {
      const footer = footerOf(r, `${CARD}, [id^=ProductTitle-], [id^=ProductSpecs-]`);
      if (footer !== "") block.footer = footer;
    }
    out.push(block);
    ctx.used.take(r);
  }
  if (out.length > 0) ctx.meta.strategies.sponsored_blocks = "sponsored-signal";
  return out;
}

/** "Frequently bought together" style widgets: numbered title / specs pairs. */
function bundleItems(ctx: Ctx, el: DomElement, raw: boolean): CarouselItem[] {
  const titles = raw ? rawAll(el, "[id^=ProductTitle-]") : qa(el, "[id^=ProductTitle-]");
  return titles.map((t) => {
    const n = t.id.replace(/^ProductTitle-/, "");
    const specs = rawOne(el, `[id="ProductSpecs-${n}"]`);
    const link = rawOne(t, "a[href]");
    const read = raw || !visible(t) ? rawText(t) : vtext(t);
    const item: CarouselItem = {};
    const asin = asinOfHref(attr(link, "href"));
    if (asin !== undefined) item.asin = asin;
    else if (/^This item/i.test(read) && ctx.asin !== undefined) item.asin = ctx.asin;
    const title = read.replace(/^This item:\s*/i, "");
    if (title !== "") item.title = title;
    const priceEl = rawOne(specs, ".a-price");
    const price =
      priceEl !== undefined && visible(priceEl)
        ? priceFrom(priceEl)
        : raw
          ? rawPriceFrom(priceEl)
          : undefined;
    if (price !== undefined) item.price = price;
    const details = cleanText(vtext(specs).replace(price?.raw ?? "\u0000", " "));
    if (details !== "" && details !== "+") item.details = details.replace(/\s*\+$/, "");
    return item;
  });
}

function parseRelated(ctx: Ctx): RelatedWidget[] {
  const out: RelatedWidget[] = [];
  const roots: { el: DomElement; kind: RelatedWidget["kind"] }[] = [];
  for (const c of qa(ctx.root, ".a-carousel-container")) {
    if (ctx.used.covers(c)) continue;
    if (
      insideAny(
        c,
        ctx.root,
        "#aplus_feature_div, #aplusBrandStory_feature_div, #twister_feature_div, #customer-reviews_feature_div, #imageBlock_feature_div",
      )
    )
      continue;
    roots.push({ el: c, kind: "carousel" });
  }
  for (const t of qa(ctx.root, "[id^=ProductTitle-]")) {
    const r = t.closest("[data-feature-name]") ?? t.closest("[id^=CardInstance]");
    if (r === null || ctx.used.covers(r) || roots.some((x) => x.el === r)) continue;
    roots.push({ el: r, kind: "bundle" });
  }
  for (const { el, kind } of roots) {
    let items: CarouselItem[];
    if (kind === "bundle") {
      items = bundleItems(ctx, el, false);
    } else {
      items = cardsOf(el, false)
        .map((c) => itemOf(c, false))
        .filter((i) => i.asin !== undefined || i.title !== undefined);
    }
    if (items.length === 0) continue;
    const container =
      kind === "carousel"
        ? (el.closest("[id^=CardInstance]") ?? el.closest("[data-feature-name]") ?? el)
        : el;
    const outer = ctx.used.covers(container) ? el : container;
    const widget: RelatedWidget = {
      key:
        outer.id ||
        attr(outer, "data-feature-name") ||
        attr(outer, "cel_widget_id") ||
        `related-${out.length + 1}`,
      heading: headingOf(outer, false) ?? headingOf(el, false),
      kind,
      items,
    };
    const taken = kind === "carousel" ? el : outer;
    const footer = footerOf(taken, `${CARD}, [id^=ProductTitle-], [id^=ProductSpecs-]`);
    if (footer !== "") widget.footer = footer;
    out.push(widget);
    ctx.used.take(taken);
    const h = rawOne(outer, ".a-carousel-heading") ?? qa(outer, "h2")[0];
    if (h !== undefined) ctx.used.take(h);
  }
  if (out.length > 0) ctx.meta.strategies.related = "carousel+bundle";
  return out;
}

// ---- grocery, product type, price history

function parseNutrition(ctx: Ctx): Nutrition | undefined {
  const box =
    q(ctx.doc, "#nutritionalInfoAndIngredients_feature_div") ??
    rawOne(ctx.doc, "#nic-nutrition-facts, #nic-nutrition-summary-nutrient-content")?.closest(
      "[data-feature-name]",
    ) ??
    undefined;
  if (box === undefined) return undefined;
  const out: Nutrition = { diet_types: [], summary: [], facts: [], collapsed: false };
  out.diet_types = uniq(
    rawAll(box, "#nic-diet-type-logos-wrapper .nic-diet-type-logo")
      .map((e) => rawText(e))
      .filter((t) => t !== ""),
  );
  const serving = rawText(rawOne(box, "#nic-nutrition-summary-serving"));
  if (serving !== "") out.serving = serving;
  const summaryRows = rawAll(rawOne(box, "#nic-nutrition-summary-nutrient-content"), "tr").map(
    (tr) => Array.from(tr.children).map((td) => rawText(td)),
  );
  const values = summaryRows[0] ?? [];
  const names = summaryRows[1] ?? [];
  names.forEach((name, i) => {
    const value = values[i];
    if (name !== "" && value !== undefined) out.summary.push({ label: name, value });
  });
  for (const tr of rawAll(
    box,
    "#nic-nutrition-facts-energy, #nic-nutrition-facts tr, #nic-nutrition-facts-serving-size",
  )) {
    if (rawOne(tr, "table") !== undefined) continue;
    const tds = Array.from(tr.children).filter((c) => c.localName === "td");
    if (tds.length === 0) continue;
    const amountEl = rawOne(tr, "[class*=nutrientAmountText]");
    const left = tds.find((td) => matchesSafe(td, ".a-text-left")) ?? tds[0];
    const name = rawText(left).replace(rawText(amountEl), "").trim();
    if (name === "") continue;
    const fact: NutritionFact = { name };
    const amount =
      rawText(amountEl) || rawText(tds.find((td) => td !== left && !/%$/.test(rawText(td))));
    if (amount !== "") fact.amount = amount;
    const dv = tds.map((td) => rawText(td)).find((t) => /^[\d.]+%$/.test(t));
    if (dv !== undefined) fact.daily_value = dv;
    out.facts.push(fact);
  }
  const facts = rawOne(box, "#nic-nutrition-facts, #nic-nutrition-facts-nutrients-content");
  out.collapsed = facts !== undefined && !visible(facts);
  const ingredients = rawText(rawOne(box, "#nic-ingredients-content"));
  if (ingredients !== "") out.ingredients = ingredients;
  if (
    out.diet_types.length === 0 &&
    out.summary.length === 0 &&
    out.facts.length === 0 &&
    out.ingredients === undefined
  ) {
    return undefined;
  }
  ctx.meta.strategies.nutrition = "id";
  ctx.used.take(box);
  return out;
}

function parseGrocery(ctx: Ctx): GroceryInfo | undefined {
  const alm = q(ctx.doc, "#desktop_almBuyBox") ?? q(ctx.doc, "#gsod_singleOfferDisplay_Desktop");
  const isGrocery =
    alm !== undefined || matchesSafe(rawOne(ctx.doc, "#dp") ?? ctx.root, ".grocery");
  if (!isGrocery) return undefined;
  const out: GroceryInfo = { tabs: [] };
  const logo = rawOne(ctx.doc, "#almLogo");
  const soldBy = rawText(rawOne(ctx.doc, "#fresh-merchant-info"));
  const marker = `${attr(logo, "alt") ?? ""} ${attr(logo, "src") ?? ""} ${soldBy}`;
  if (/whole ?foods|WFM/i.test(marker)) out.store = "whole_foods";
  else if (/fresh/i.test(marker)) out.store = "amazon_fresh";
  else if (logo !== undefined) out.store = "other";
  for (const tab of qa(ctx.doc, "#offerDisplayGroupTabSet li")) {
    const label = vtext(tab);
    if (label === "") continue;
    out.tabs.push({ label, selected: matchesSafe(tab, ".a-active") });
  }
  ctx.used.take(q(ctx.doc, "#offerDisplayGroupTabSet"));
  const weight =
    q(ctx.doc, "#almAddToCart_feature_div .pvw-replace") ??
    findByText([alm], "div, span", /final cost by weight|^About [\d.]+ ?(lb|oz|kg)/i);
  const wt = vtext(weight);
  if (wt !== "") {
    out.weight_text = wt;
    ctx.used.take(weight);
  }
  const snap = vtext(q(ctx.doc, "#oasisLabel_feature_div"));
  if (/SNAP|EBT/i.test(snap)) out.snap_ebt = true;
  const window = vtext(q(ctx.doc, "#alm-delivery-message .a-text-bold"));
  if (window !== "") out.delivery_window = window;
  ctx.meta.strategies.grocery = alm !== undefined ? "id" : "data-attr";
  return out;
}

function parseProductType(
  ctx: Ctx,
  extra: { renewed: boolean; variations: boolean; sns: boolean; grocery: boolean },
): ProductType {
  const dp = rawOne(ctx.doc, "#dp");
  const cls = (attr(dp, "class") ?? "")
    .split(/\s+/)
    .filter((c) => c !== "" && !/^[a-z]{2}_[A-Z]{2}$/.test(c));
  const out: ProductType = { markers: [] };
  if (cls[0] !== undefined) out.product_group = cls[0].toLowerCase();
  const m = out.markers;
  if (
    out.product_group === "book" ||
    rawOne(ctx.doc, "#Books-Buybox, #booksTitle, #inline-twister-row-media_format") !== undefined
  )
    m.push("book");
  if (extra.grocery) m.push("grocery");
  if (extra.renewed) m.push("renewed");
  if (extra.variations) m.push("variations");
  if (extra.sns) m.push("subscribe_and_save");
  if (rawOne(ctx.doc, "#ebooksProductTitle, #ebooksImgBlkFront, #kindle-price") !== undefined)
    m.push("digital");
  return out;
}

function parsePriceHistoryIngress(ctx: Ctx): PriceHistoryIngress | undefined {
  const els = rawAll(ctx.doc, "[id^=rufus-price-ingress]");
  if (els.length === 0) return undefined;
  const positions = uniq(
    els
      .map((e) => attr(e, "data-ingress-position") ?? e.id.replace(/^rufus-price-ingress-?/, ""))
      .filter((p) => p !== ""),
  );
  const out: PriceHistoryIngress = { positions };
  const qt = attr(els[0], "data-query-text");
  if (qt !== undefined && qt !== "") out.query_text = qt;
  for (const e of els) ctx.used.take(e);
  ctx.meta.strategies.price_history_ingress = "id";
  return out;
}

// ---- entry point

/** Content root for lossless accounting: the detail page container. */
function contentRoot(doc: DomRoot): DomElement {
  return (
    q(doc, "#dp") ??
    q(doc, "#dp-container") ??
    q(doc, "#a-page") ??
    ("body" in doc ? doc.body : (doc as DomElement))
  );
}

export const parseProduct: Parser<ProductPage> = (capture: Capture): ParseResult<ProductPage> => {
  const { doc } = parseCapture(capture);
  const meta = newMeta();
  const used = new Consumption();
  const ctx: Ctx = { doc, root: contentRoot(doc), meta, used, capture, rows: [] };
  setupScopes(ctx);

  const asin = parseAsin(ctx);
  if (asin !== undefined) ctx.asin = asin;
  const title = parseTitle(ctx);
  const byline = parseByline(ctx);
  const breadcrumbs = parseBreadcrumbs(ctx);
  const department = parseDepartment(ctx, breadcrumbs);
  const parentAsin = parseParentAsin(ctx);

  const sponsored = parseSponsored(ctx);
  const { offer, buyBox, options } = parseFeaturedOffer(ctx);
  const otherSellers = parseOtherSellers(ctx);
  const variantSummary = parseVariantSummary(ctx, parentAsin);
  const mediaCounts = parseMediaCounts(ctx);
  const rating = parseRatingSummary(ctx);
  const highlights = parseHighlights(ctx);
  const bullets = parseBullets(ctx);
  const description = parseDescription(ctx);
  const aplus = parseAplus(ctx);
  const overview = parseOverview(ctx);
  const ranks: BestSellerRank[] = [];
  const specTables = parseSpecTables(ctx, ranks);
  const important = parseImportantInformation(ctx);
  const witb = parseWhatsInTheBox(ctx);
  const documents = parseDocuments(ctx);
  const notices = parseNotices(ctx);
  const related = parseRelated(ctx);
  const grocery = parseGrocery(ctx);
  const nutrition = parseNutrition(ctx);
  const ingress = parsePriceHistoryIngress(ctx);

  const renewed =
    buyBox.state === "renewed" ||
    offer?.condition?.kind === "renewed" ||
    notices.some((n) => n.type === "renewed_badge") ||
    /\(Renewed\)/.test(title ?? "");
  const productType = parseProductType(ctx, {
    renewed,
    variations: (variantSummary?.dimensions.length ?? 0) > 0,
    sns: offer?.subscribe_and_save !== undefined,
    grocery: grocery !== undefined,
  });

  // A document title alone does not make a product page.
  const pageTitle = title !== undefined && meta.strategies.title !== "text-anchor";
  if (asin === undefined && !pageTitle && offer === undefined && buyBox.state === "unknown") {
    throw new RfError("layout_unrecognized", "product page: no title, ASIN or buy box found");
  }

  const data: ProductPage = {
    breadcrumbs,
    best_seller_ranks: ranks,
    product_type: productType,
    buy_box: buyBox,
    purchase_options: options,
    other_sellers: otherSellers,
    highlights,
    bullets,
    aplus_text: aplus,
    overview,
    spec_tables: specTables,
    important_information: important,
    whats_in_the_box: witb,
    documents,
    notices,
    sponsored_blocks: sponsored,
    related,
  };
  if (asin !== undefined) data.asin = asin;
  if (parentAsin !== undefined) data.parent_asin = parentAsin;
  if (title !== undefined) data.title = title;
  const differentiators = q(doc, "#titleSection .dp-title-differentiators");
  const diff = vtext(used.take(differentiators));
  if (diff !== "") data.title_differentiators = diff;
  if (byline !== undefined) data.byline = byline;
  if (department !== undefined) data.department = department;
  if (offer !== undefined) data.featured_offer = offer;
  if (variantSummary !== undefined) data.variant_summary = variantSummary;
  if (mediaCounts !== undefined) data.media_counts = mediaCounts;
  if (rating !== undefined) data.rating = rating;
  if (description !== undefined) data.description = description;
  if (grocery !== undefined) data.grocery = grocery;
  if (nutrition !== undefined) data.nutrition = nutrition;
  if (ingress !== undefined) data.price_history_ingress = ingress;

  const report = losslessReport(doc, used, {
    root: ctx.root,
    base: capture.final_url || capture.url,
  });
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data, other_sections: report.sections, meta };
};
