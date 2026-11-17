/**
 * Buying-options parser (`get_buying_options`): the all-offers display ("AOD") panel plus the
 * product page's buy box.
 *
 * The AOD panel is a FRAGMENT (`capture.fragments.aod`) fetched in-page from the all-offers
 * endpoint. It is primary for every offer field: the pinned (featured) offer and the full
 * offer list, filters, the total count and the per-offer add-to-cart identifiers. The product
 * page (`capture.html`) is used only for what the panel lacks: purchase types (one-time
 * versus Subscribe & Save), clippable coupons, the typical / list price of the featured
 * offer, buy-box state hints and page-level upsell signals (protection plan, add-on). When the
 * fragment is missing the featured offer is read from the buy box instead (strategy
 * "page-buybox") and the offer list is empty.
 *
 * Visibility: a fetched fragment never went through the in-page hidden-marker pass, so it
 * carries no `data-rf-hidden` markers. Its hidden state is class based (`aok-hidden`,
 * `a-hidden`, `aod-hide`, `aod-visibility-hidden`). `normalizeAodVisibility` translates those
 * classes into markers before anything is read, except for the panel's COLLAPSED content
 * (the pinned offer's "See more" details and the "See N more options" list), which is real
 * data behind a toggle and is un-hidden on purpose. The sticky duplicate of the pinned offer
 * is always hidden.
 *
 * Verified against real captures for: the pinned offer, the offer list (including the
 * collapsed "more options" part), condition headings, apex price / savings / typical price /
 * unit price blocks, the delivery promise blocks and their data attributes, Prime icons,
 * ships-from / sold-by / customer-service / condition-note rows, seller ratings, the
 * add-to-cart form and its `data-aod-atc-action` JSON, quantity options, filters, total
 * offer count, the product page's buy-box accordion (one-time and Subscribe & Save rows),
 * Subscribe & Save prices, frequencies and the S&S-conditional coupon text, the protection
 * plan block and the basis price label. NOT verified (no capture showed them; strategies are
 * written from the surrounding markup conventions and marked "unverified"): a panel with no
 * pinned offer, a shipping fee row, collectible condition, new-seller badges, minimum
 * quantities above 1, per-customer limit text, stock text inside the panel, pre-order and
 * out-of-stock offers, a clippable coupon control and the next-page request.
 *
 * Never emitted: CSRF tokens, session ids, request ids. The offer listing id (the opaque
 * add-to-cart token) is emitted ONLY inside each offer's `internal` object, which the daemon
 * wraps into its own short-lived offer id and never shows to the model.
 */
import { OFFER_FLAGS, RfError } from "@rainforest/core";
import type {
  Capture,
  OfferFlag,
  OtherSection,
  ParseMeta,
  ParseResult,
  Parser,
} from "@rainforest/core";
import {
  Consumption,
  type DomDocument,
  type DomElement,
  type DomRoot,
  type Money,
  attr,
  collapse,
  firstOf,
  hiddenSelf,
  losslessReport,
  moneyFromPriceElement,
  newMeta,
  parseCapture,
  parseCount,
  parseMoney,
  parseRating,
  q,
  qa,
  ratingFromClass,
  text,
  tryJson,
} from "../index.ts";

// ---- types

export type OfferCondition = "new" | "used" | "renewed" | "collectible";
export type Fulfillment = "amazon" | "fba" | "merchant";

export interface OfferSeller {
  name: string | null;
  /** Merchant id from the seller profile link (`seller=` parameter), when the link exposes it. */
  seller_id: string | null;
  /** Seller star rating (out of 5). */
  rating_stars?: number;
  /** "70% positive over last 12 months" -> 70. */
  rating_percent?: number;
  rating_count?: number;
  /** The rating line as shown. */
  rating_raw?: string;
  /** "Just launched" / "New seller" badge. */
  new_seller: boolean;
  /** Sold by Amazon itself (Amazon.com, Amazon Warehouse, ...). */
  is_amazon: boolean;
}

export interface OfferShipping {
  free: boolean;
  /** Fee when not free (0 when free). */
  amount?: Money;
  /** Qualifier such as "for Prime members" or "on orders over $35". */
  condition?: string;
  raw: string;
}

export interface UnitPrice {
  price: Money;
  /** "count", "ounce", "Fl Oz", ... */
  unit: string;
  raw: string;
}

export interface DeliveryOption {
  /** Layout slot: "PRIMARY_DELIVERY_MESSAGE_LARGE", "SECONDARY_DELIVERY_MESSAGE_LARGE", ... */
  slot: string | null;
  raw: string;
  /** The bold date part ("Wednesday, November 18", "November 18 - 19"). */
  date_raw?: string;
  /** Calendar dates resolved against the capture date (the page shows no year). */
  earliest_iso?: string;
  latest_iso?: string;
  /** "today" / "tomorrow" / "overnight" when the promise is relative. */
  relative?: "today" | "tomorrow" | "overnight";
  /** "FREE", a fee, or null when the option does not state one. */
  price?: "FREE" | Money;
  /** Qualifier ("for Prime members"). */
  condition?: string;
  /** "Order within 2 hrs 56 mins". */
  cutoff?: string;
  /** Marked as the fastest option by the page. */
  fastest: boolean;
}

export interface DeliveryPromise {
  /** Each delivery line as shown. */
  lines: string[];
  options: DeliveryOption[];
  /** The option with the earliest latest-date (or the page's "fastest" option). */
  fastest?: DeliveryOption;
  /** Epoch seconds the page attaches to the Prime badge (end of the promised day). */
  promise_epoch_s?: number;
}

export interface OfferDetail {
  label: string;
  value: string;
}

/** Identifiers the add-to-cart flow needs. Never shown to the model: the daemon wraps them. */
export interface OfferInternal {
  asin: string | null;
  offer_listing_id: string | null;
  seller_id: string | null;
  condition: OfferCondition | null;
  price: Money | null;
}

export interface Offer {
  /** Position in the panel (0 = pinned); the panel's own `offerIndex` when present. */
  index: number;
  pinned: boolean;
  /** Inside the collapsed "See N more options" part of the list. */
  collapsed: boolean;
  /** Where the offer was read from. */
  source: "aod" | "buybox";
  price: Money | null;
  /** Strikethrough reference price with its label ("Typical price", "List Price"). */
  basis_price?: { price: Money; label: string };
  /** Set when the basis label is "Typical price". */
  typical_price?: Money;
  /** Set when the basis label is "List Price". */
  list_price?: Money;
  savings_percent?: number;
  savings?: Money;
  unit_price?: UnitPrice;
  shipping?: OfferShipping;
  /** price + shipping when both are known in one currency. */
  total?: Money;
  /** Set when the total assumes conditional free shipping ("for Prime members"). */
  total_condition?: string;
  condition: OfferCondition | null;
  /** Heading as shown ("Used - Very Good", "Refurbished - Excellent"). */
  condition_label?: string;
  /** "Very Good", "Excellent". */
  sub_condition?: string;
  /** Panel's buying-option code ("NEW", "USED", "RENEWED_TIER_2"). */
  condition_code?: string;
  /** Seller's condition comment. */
  condition_note?: string;
  seller: OfferSeller;
  ships_from?: string;
  fulfillment: Fulfillment | null;
  /** null when no Prime signal could be read either way. */
  prime: boolean | null;
  /** Words beside the Prime badge ("One-Day"). */
  prime_badge?: string;
  delivery?: DeliveryPromise;
  /** Largest quantity the offer's quantity control allows. */
  max_quantity?: number;
  min_quantity?: number;
  /** Explicit per-customer / per-order limit stated in text (unverified). */
  quantity_limit?: number;
  stock_text?: string;
  /** "Only 3 left in stock" -> 3. */
  stock_count?: number;
  returns?: string;
  customer_service?: string;
  payment?: string;
  /** Promotion lines ("5% cash back with ..."). */
  promotions: string[];
  /** Badges ("Exclusive Prime price"). */
  badges: string[];
  /** Deposit / fee rows. */
  fees: string[];
  /** Other label/value rows of the offer that have no typed field. */
  details: OfferDetail[];
  /** Time-independent D17 flags (slow_delivery and quantity_above_stock need computeOfferFlags). */
  flags: OfferFlag[];
  /** Cannot be added at all. Never acknowledgeable. */
  out_of_stock: boolean;
  internal: OfferInternal;
}

export interface OfferFilter {
  /** Checkbox id ("primeEligible", "freeShipping", "new", "usedLikeNew", ...). */
  id: string;
  /** Label as shown. May disagree with the id ("new" labelled "Renewed"): trust the label. */
  label: string;
  group: string | null;
  /** Parent checkbox id for sub-filters. */
  parent: string | null;
  checked: boolean;
  /** Count shown beside the label, when the panel shows one. */
  count?: number;
  /** How many loaded offers match (computed; only for filters this parser understands). */
  loaded_match_count?: number;
}

export interface OffersPagination {
  /** Offers loaded in this fragment (pinned excluded). */
  loaded: number;
  /** The panel's total of other options, when stated. */
  total?: number;
  has_more: boolean;
  /** Page number to request next (pages of PAGE_SIZE offers). */
  next_page?: number;
  page_size: number;
  /**
   * Next-page request with placeholders {asin} and {page}. UNVERIFIED: no capture showed a
   * next-page request; the lead should confirm it live.
   */
  url_template: string;
}

export interface SubscribeAndSaveTier {
  /** "base" (every delivery) or "tiered" (5+ items in one delivery). */
  kind: "base" | "tiered";
  price?: Money;
  percent?: number;
  raw?: string;
}

export interface PurchaseType {
  kind: "one_time" | "subscribe_and_save";
  label: string;
  /** Selected by default (the active buy-box row). */
  default: boolean;
  price?: Money;
  unit_price?: UnitPrice;
  /** Subscribe & Save discount tiers. */
  tiers?: SubscribeAndSaveTier[];
  /** Delivery frequencies offered (S&S). */
  frequencies?: string[];
  selected_frequency?: string;
  /** "First delivery on ..." (S&S). */
  first_delivery?: string;
}

export interface Coupon {
  text: string;
  badge?: string;
  /** Percent or amount off when stated. */
  percent?: number;
  amount?: Money;
  /** A clip control exists (checkbox / clip button). */
  clippable: boolean;
  /** Only applies with Subscribe & Save. */
  requires_subscribe_and_save: boolean;
  /** Where it was found: "price-block", "buybox", "subscribe-and-save". */
  location: string;
}

export interface BuyboxRow {
  /** `data-a-accordion-row-name` ("newAccordionRow", "snsAccordionRowMiddle", ...). */
  name: string;
  caption: string;
  /** The row header as shown (condition, price, delivery, ships-from / sold-by summary). */
  text: string;
  active: boolean;
  price?: Money;
}

export type BuyboxState = "featured" | "no_featured_offer" | "unavailable" | "unknown";

export interface BuyboxInfo {
  state: BuyboxState;
  availability_text?: string;
  rows: BuyboxRow[];
  add_to_cart_present: boolean;
  /** Delivery lines of the selected row. */
  delivery_lines?: string[];
  /** Ships-from / sold-by of the selected row (read from the collapsed details). */
  ships_from?: string;
  sold_by?: string;
  /** Shipping destination line ("Deliver to ..."): the owner's name and location. */
  deliver_to?: string;
  max_quantity?: number;
  /** Visible protection-plan offer text. */
  protection_plan_text?: string;
  /** Visible add-on item text. */
  addon_text?: string;
  /** "See All Buying Options" style text when there is no featured offer. */
  no_featured_offer_text?: string;
}

export interface OffersProduct {
  asin: string | null;
  title: string | null;
  rating?: number;
  rating_count?: number;
  image_url?: string;
}

export interface OffersData {
  product: OffersProduct;
  pinned_offer: Offer | null;
  /** Every listed offer below the pinned one, in panel order. */
  offers: Offer[];
  total_offer_count?: number;
  total_offer_count_text?: string;
  /** No pinned offer and no listed offer. */
  no_offers: boolean;
  /** The panel's "no other sellers" message, when shown. */
  no_offers_text?: string;
  /** No featured (buy box) offer: pinned offer missing or price suppressed. */
  no_featured_offer: boolean;
  heading?: string;
  sort_text?: string;
  filters: OfferFilter[];
  pagination: OffersPagination;
  purchase_types: PurchaseType[];
  coupons: Coupon[];
  /** Other promotion lines in the product page price block. */
  promotions: string[];
  /** Typical / list price of the featured offer from the product page. */
  typical_price?: Money;
  list_price?: Money;
  featured_price?: Money;
  buybox: BuyboxInfo;
}

// ---- constants

export const AOD_PAGE_SIZE = 10;
export const AOD_NEXT_PAGE_TEMPLATE =
  "/gp/product/ajax/aodAjaxMain/ref=aod_page_{page}?asin={asin}&pc=dp&isonlyrenderofferlist=true&pageno={page}&experienceId=aodAjaxMain";

/** Classes that hide an element in the fetched panel. */
export const AOD_HIDDEN_CLASSES: readonly string[] = [
  "aok-hidden",
  "a-hidden",
  "aod-hide",
  "aod-visibility-hidden",
  "a-popover-preload",
];

/** Collapsed-but-real panel content: shown again on purpose. */
export const AOD_REVEAL_SELECTORS: readonly string[] = [
  "#aod-pinned-offer-additional-content",
  "#aod-retail-other-offers-content",
  ".aod-oas-other-offers-hide",
];

/** Always hidden: the sticky header duplicates the pinned offer. */
export const AOD_FORCE_HIDDEN_SELECTORS: readonly string[] = ["#aod-sticky-pinned-container"];

const AMAZON_NAME_RE =
  /^amazon(?:\.com)?(?:\s+(?:resale|warehouse|services(?:,?\s*(?:llc|inc\.?))?|export sales(?:,?\s*llc)?))?$/i;

// ---- small helpers

interface Mutable {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function classList(el: DomElement): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Translate the fetched panel's class-based hidden state into `data-rf-hidden` markers so the
 * framework helpers skip it, and un-hide collapsed content that holds real data.
 */
export function normalizeAodVisibility(root: DomRoot): void {
  const hide = new Set(AOD_HIDDEN_CLASSES);
  const reveal = (el: DomElement): boolean =>
    AOD_REVEAL_SELECTORS.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  for (const el of Array.from(root.querySelectorAll("[class]"))) {
    if (reveal(el)) continue;
    if (classList(el).some((c) => hide.has(c))) {
      (el as unknown as Mutable).setAttribute("data-rf-hidden", "1");
    }
  }
  for (const sel of AOD_REVEAL_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      (el as unknown as Mutable).removeAttribute("data-rf-hidden");
    }
  }
  for (const sel of AOD_FORCE_HIDDEN_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      (el as unknown as Mutable).setAttribute("data-rf-hidden", "1");
    }
  }
}

/** Raw (visibility-ignoring) text, for data Amazon keeps in collapsed / hidden nodes. */
function rawText(el: DomElement | null | undefined): string {
  if (el == null) return "";
  const parts: string[] = [];
  const walk = (node: DomElement): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) parts.push(child.textContent ?? "");
      else if (child.nodeType === 1) {
        const e = child as DomElement;
        if (["script", "style", "noscript", "template"].includes(e.localName)) continue;
        parts.push(" ");
        walk(e);
        parts.push(" ");
      }
    }
  };
  walk(el);
  return collapse(parts.join(""));
}

/** First element matching, ignoring visibility. */
function rq(root: DomRoot | null | undefined, selector: string): DomElement | undefined {
  if (root == null) return undefined;
  try {
    return root.querySelector(selector) ?? undefined;
  } catch {
    return undefined;
  }
}

function rqa(root: DomRoot | null | undefined, selector: string): DomElement[] {
  if (root == null) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** Visible elements under `root` that belong to this offer card (not to a nested card). */
function within(root: DomElement, selector: string): DomElement[] {
  return qa(root, selector);
}

function percentOf(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /(\d+(?:\.\d+)?)\s*(?:%|percent)/i.exec(s);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function sellerIdFromHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  const m = /[?&](?:amp;)?seller=([A-Z0-9]{6,20})\b/i.exec(href);
  return m?.[1] ?? null;
}

export function isAmazonName(name: string | null | undefined): boolean {
  if (name == null) return false;
  return AMAZON_NAME_RE.test(collapse(name));
}

export function conditionFromText(s: string | null | undefined): OfferCondition | null {
  if (s == null) return null;
  const t = s.toLowerCase();
  if (/\b(renewed|refurbished)\b/.test(t)) return "renewed";
  if (/\bcollectible\b/.test(t)) return "collectible";
  if (/\bused\b/.test(t)) return "used";
  if (/\bnew\b/.test(t)) return "new";
  return null;
}

/** The panel's buying-option code ("NEW", "USED", "RENEWED_TIER_2", "COLLECTIBLE"). */
export function conditionFromCode(code: string | null | undefined): OfferCondition | null {
  if (code == null) return null;
  const c = code.toUpperCase();
  if (c.startsWith("RENEWED") || c.startsWith("REFURB")) return "renewed";
  if (c.startsWith("COLLECTIBLE")) return "collectible";
  if (c.startsWith("USED")) return "used";
  if (c.startsWith("NEW")) return "new";
  return null;
}

/** Condition infix of the add-to-cart form action ("ref=aod_dpdsk_used_1"). */
function conditionFromRef(action: string | undefined): OfferCondition | null {
  const m = /aod_[a-z]+_(new|used|ren|col)[a-z]*_\d/i.exec(action ?? "");
  if (m?.[1] === undefined) return null;
  return ({ new: "new", used: "used", ren: "renewed", col: "collectible" } as const)[
    m[1].toLowerCase() as "new" | "used" | "ren" | "col"
  ];
}

// ---- dates

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH_RE_SRC =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DATE_RANGE_RE = new RegExp(
  `${MONTH_RE_SRC}\\s+(\\d{1,2})(?:\\s*(?:-|\\u2013|to)\\s*(?:${MONTH_RE_SRC}\\s+)?(\\d{1,2}))?`,
  "i",
);

function monthIndex(name: string): number {
  return MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase());
}

interface YMD {
  y: number;
  m: number;
  d: number;
}

function ymdFromIso(iso: string | undefined): YMD | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (m === null) return undefined;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

function isoOf(t: YMD): string {
  return `${String(t.y).padStart(4, "0")}-${String(t.m + 1).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
}

/** Pick the year that puts month/day closest after the reference date (allowing a short look-back). */
function resolveYear(month: number, day: number, ref: YMD): YMD | undefined {
  if (month < 0 || day < 1 || day > 31) return undefined;
  const refMs = Date.UTC(ref.y, ref.m, ref.d);
  let y = ref.y;
  let ms = Date.UTC(y, month, day);
  if (ms < refMs - 60 * 86_400_000) y += 1;
  else if (ms > refMs + 305 * 86_400_000) y -= 1;
  ms = Date.UTC(y, month, day);
  const dt = new Date(ms);
  if (dt.getUTCMonth() !== month) return undefined;
  return { y, m: month, d: day };
}

export interface ParsedDeliveryDate {
  earliest_iso?: string;
  latest_iso?: string;
  relative?: "today" | "tomorrow" | "overnight";
}

/**
 * Dates in a delivery promise ("Wednesday, November 18", "November 18 - 19",
 * "Dec 30 - Jan 2", "Tomorrow, November 17", "Today"). The page shows no year: it is
 * resolved against `refIso` (the capture date), never against a clock.
 */
export function parseDeliveryDate(raw: string, refIso: string | undefined): ParsedDeliveryDate {
  const out: ParsedDeliveryDate = {};
  if (/\btoday\b/i.test(raw)) out.relative = "today";
  else if (/\btomorrow\b/i.test(raw)) out.relative = "tomorrow";
  else if (/\bovernight\b/i.test(raw)) out.relative = "overnight";
  const ref = ymdFromIso(refIso);
  const m = DATE_RANGE_RE.exec(raw);
  if (m === null || ref === undefined || m[1] === undefined || m[2] === undefined) return out;
  const m1 = monthIndex(m[1]);
  const start = resolveYear(m1, Number(m[2]), ref);
  if (start === undefined) return out;
  out.earliest_iso = isoOf(start);
  if (m[4] !== undefined) {
    const m2 = m[3] === undefined ? m1 : monthIndex(m[3]);
    let end = resolveYear(m2, Number(m[4]), start);
    if (end !== undefined && Date.UTC(end.y, end.m, end.d) < Date.UTC(start.y, start.m, start.d)) {
      end = { ...end, y: end.y + 1 };
    }
    out.latest_iso = end === undefined ? out.earliest_iso : isoOf(end);
  } else {
    out.latest_iso = out.earliest_iso;
  }
  return out;
}

// ---- offer card parsing

interface CardCtx {
  meta: ParseMeta;
  cons: Consumption;
  refIso: string | undefined;
  base: string;
}

interface AtcJson {
  oid?: string;
  asin?: string;
  maxQty?: number;
  minQty?: number;
  offerIndex?: number;
  isStickyPinnedOffer?: boolean;
}

function atcJsonOf(card: DomElement): AtcJson | undefined {
  const el = rq(card, "[data-aod-atc-action]");
  const v = tryJson(el?.getAttribute("data-aod-atc-action"));
  return v !== null && typeof v === "object" ? (v as AtcJson) : undefined;
}

/** Label/value rows of an offer ("Ships from", "Sold by", "Condition", ...). */
interface DetailRow {
  el: DomElement;
  label: string;
  valueEl: DomElement | undefined;
}

function isInside(el: DomElement, ancestor: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (cur === ancestor) return true;
  }
  return false;
}

function detailRows(scope: DomElement): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const el of qa(scope, "[role=listitem]")) {
    // An offer card is itself a listitem; its rows are what we want.
    if (el.id === "aod-offer") continue;
    // Nested listitems (rows inside rows) belong to the outer row.
    const outer = el.parentElement?.closest("[role=listitem]") ?? null;
    if (outer !== null && outer.id !== "aod-offer" && outer !== scope && isInside(outer, scope)) {
      continue;
    }
    const labelEl =
      q(el, "[role=heading]") ?? q(el, ".a-col-left .a-color-tertiary") ?? q(el, ".a-col-left");
    const valueEl = q(el, ".a-col-right") ?? undefined;
    const label = text(labelEl).replace(/:$/, "");
    rows.push({ el, label, valueEl });
  }
  return rows;
}

function parseSeller(row: DetailRow | undefined, card: DomElement, ctx: CardCtx): OfferSeller {
  const seller: OfferSeller = { name: null, seller_id: null, new_seller: false, is_amazon: false };
  const value = row?.valueEl;
  const ratingBlock = value === undefined ? undefined : q(value, "#aod-offer-seller-rating");
  const atcLabel = attr(rq(card, "input[name='submit.addToCart']"), "aria-label");
  seller.name =
    firstOf(
      "offer.seller.name",
      [
        ["id", () => text(q(value, "a")) || undefined],
        ["label", () => text(value, { exclude: (e) => e === ratingBlock }) || undefined],
        [
          "data-attr",
          () => /from seller (.+?) and price/i.exec(atcLabel ?? "")?.[1]?.trim() || undefined,
        ],
      ],
      ctx.meta,
    ) ?? null;
  const href = attr(value === undefined ? undefined : q(value, "a[href]"), "href");
  seller.seller_id = sellerIdFromHref(href);
  // Amazon's own sold-by carries no storefront link; an Amazon-looking name WITH a seller id
  // is treated as a third party (fails closed).
  seller.is_amazon = isAmazonName(seller.name) && seller.seller_id === null;
  if (ratingBlock !== undefined) {
    const icon = q(ratingBlock, "i.a-icon");
    seller.rating_stars =
      ratingFromClass(icon?.getAttribute("class")) ??
      parseRating(text(q(ratingBlock, ".a-icon-alt")))?.value;
    const line = text(ratingBlock, { exclude: (e) => e.matches(".a-icon-alt") });
    if (line !== "") seller.rating_raw = line;
    const count = /\(?\s*([\d,]+)\s+ratings?\s*\)?/i.exec(line)?.[1];
    if (count !== undefined) seller.rating_count = Number(count.replace(/,/g, ""));
    const pct = /(\d{1,3})%\s+positive/i.exec(line)?.[1];
    if (pct !== undefined) seller.rating_percent = Number(pct);
    if (/just launched|new seller|no ratings yet/i.test(line)) seller.new_seller = true;
  }
  if (value !== undefined && /just launched|new seller/i.test(text(value)))
    seller.new_seller = true;
  return seller;
}

function parseDeliveryBlock(card: DomElement, ctx: CardCtx): DeliveryPromise | undefined {
  const slots = within(card, "[id^=mir-layout-DELIVERY_BLOCK-slot-]");
  if (slots.length === 0) return undefined;
  const options: DeliveryOption[] = [];
  for (const slot of slots) {
    const span = q(slot, "[data-csa-c-delivery-time], [data-csa-c-delivery-price]") ?? slot;
    const raw = text(slot);
    if (raw === "") continue;
    const priceAttr = attr(span, "data-csa-c-delivery-price");
    const dateRaw =
      attr(span, "data-csa-c-delivery-time") || text(q(slot, ".a-text-bold")) || undefined;
    const cond = attr(span, "data-csa-c-delivery-condition") || undefined;
    const cutoff =
      attr(span, "data-csa-c-delivery-cutoff") ||
      (() => {
        const cd = text(q(slot, ".ftCountdownClass, #ftCountdown"));
        return cd === "" ? "" : `Order within ${cd}`;
      })() ||
      undefined;
    const fastest = /^fastest$/i.test(priceAttr ?? "") || /\bfastest\b/i.test(raw);
    const opt: DeliveryOption = {
      slot: slot.id.replace(/^mir-layout-DELIVERY_BLOCK-slot-/, "") || null,
      raw,
      fastest,
    };
    if (dateRaw !== undefined) opt.date_raw = dateRaw;
    const dates = parseDeliveryDate(dateRaw ?? raw, ctx.refIso);
    Object.assign(opt, dates);
    if (priceAttr !== undefined && /^free$/i.test(priceAttr)) opt.price = "FREE";
    else {
      const money =
        parseMoney(priceAttr) ??
        (/(\$[\d.,]+)\s+(?:delivery|shipping)/i.test(raw) ? parseMoney(raw) : undefined);
      if (money !== undefined) opt.price = money;
      else if (/\bFREE\b/.test(raw) && !fastest) opt.price = "FREE";
    }
    const condition = cond ?? /\b(for Prime members|on orders? over \$[\d.,]+)/i.exec(raw)?.[1];
    if (condition !== undefined && condition !== "") opt.condition = condition;
    if (cutoff !== undefined) opt.cutoff = cutoff;
    options.push(opt);
    ctx.cons.take(slot);
  }
  if (options.length === 0) return undefined;
  const promise: DeliveryPromise = { lines: options.map((o) => o.raw), options };
  let best: DeliveryOption | undefined = options.find((o) => o.fastest);
  for (const o of options) {
    if (o.latest_iso === undefined) continue;
    if (best?.latest_iso === undefined || o.latest_iso < best.latest_iso) best = o;
  }
  if (best !== undefined) promise.fastest = best;
  const epoch = Number(
    attr(rq(card, "[data-csa-c-delivery-promise-date]"), "data-csa-c-delivery-promise-date"),
  );
  if (Number.isFinite(epoch) && epoch > 0) promise.promise_epoch_s = epoch;
  return promise;
}

const STOCK_RE =
  /(only \d+ left in stock[^.]*\.?|in stock\.?|currently unavailable\.?|temporarily out of stock[^.]*\.?|out of stock\.?|available to ship in [^.]*\.?|usually ships within [^.]*\.?|pre-?order[^.]*\.?|this item will be released on [^.]*\.?|not yet released\.?)/i;

function stockCountOf(s: string | undefined): number | undefined {
  const m = /only (\d+) left in stock/i.exec(s ?? "");
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function limitOf(s: string): number | undefined {
  const m =
    /\blimit(?:ed to)?\s+(\d+)\s+per\s+(?:customer|order|household)/i.exec(s) ??
    /\bmax(?:imum)?\s+(?:order\s+)?(?:quantity\s+)?(?:of\s+)?(\d+)\s+per\s+(?:customer|order)/i.exec(
      s,
    );
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function minOf(s: string): number | undefined {
  const m = /\bminimum (?:order )?(?:quantity|purchase)(?: of| is|:)?\s+(\d+)/i.exec(s);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function parseOfferCard(
  card: DomElement,
  details: DomElement,
  opts: { pinned: boolean; collapsed: boolean; position: number },
  ctx: CardCtx,
): Offer {
  const { meta, cons } = ctx;
  const atc = atcJsonOf(card);
  const form = rq(card, "form.AodAddToCart") ?? rq(card, "form[action*='add-to-cart']");

  // condition
  const headingEl = q(card, "#aod-offer-heading");
  const conditionLabel = text(headingEl) || undefined;
  cons.take(headingEl);
  const codeEl = rq(card, "[data-csa-c-buying-option-type]");
  const conditionCode = attr(codeEl, "data-csa-c-buying-option-type") || undefined;
  const condition =
    firstOf<OfferCondition>(
      "offer.condition",
      [
        ["id", () => conditionFromText(conditionLabel)],
        ["data-attr", () => conditionFromCode(conditionCode)],
        ["text-anchor", () => conditionFromRef(attr(form, "action"))],
      ],
      meta,
    ) ?? null;
  const sub =
    conditionLabel !== undefined ? /\s-\s(.+)$/.exec(conditionLabel)?.[1]?.trim() : undefined;

  // price block
  const priceRoot = q(card, "[id^=aod-price-]") ?? q(card, "#aod-offer-price") ?? card;
  const ptp = q(priceRoot, ".apex-pricetopay-value");
  const atcLabel = attr(rq(card, "input[name='submit.addToCart']"), "aria-label");
  const price =
    firstOf<Money>(
      "offer.price",
      [
        ["id", () => moneyFromPriceElement(ptp)],
        [
          "data-attr",
          () => {
            const v = attr(rq(priceRoot, "[data-csa-c-price-to-pay]"), "data-csa-c-price-to-pay");
            const n = Number(v);
            return v !== undefined && v !== "" && Number.isFinite(n)
              ? { amount: n, currency: "USD", raw: v }
              : undefined;
          },
        ],
        ["label", () => parseMoney(/and price (\S+)/i.exec(atcLabel ?? "")?.[1])],
        [
          "text-anchor",
          () => parseMoney(text(q(priceRoot, ".apex-pricetopay-accessibility-label"))),
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  if (price === null)
    meta.warnings.push(`offer ${opts.position}: no price (price may be suppressed)`);

  const offer: Offer = {
    index: typeof atc?.offerIndex === "number" ? atc.offerIndex : opts.position,
    pinned: opts.pinned,
    collapsed: opts.collapsed,
    source: "aod",
    price,
    condition,
    seller: { name: null, seller_id: null, new_seller: false, is_amazon: false },
    fulfillment: null,
    prime: null,
    promotions: [],
    badges: [],
    fees: [],
    details: [],
    flags: [],
    out_of_stock: false,
    internal: { asin: null, offer_listing_id: null, seller_id: null, condition: null, price: null },
  };
  if (conditionLabel !== undefined) offer.condition_label = conditionLabel;
  if (sub !== undefined) offer.sub_condition = sub;
  if (conditionCode !== undefined) offer.condition_code = conditionCode;

  const basisEl = q(priceRoot, ".apex-basisprice-value");
  const basis = moneyFromPriceElement(basisEl);
  if (basis !== undefined) {
    const label = (
      text(q(priceRoot, ".apex-basisprice-label")) ||
      /^([^$]+):/.exec(text(q(priceRoot, ".apex-basisprice-offscreen-label")))?.[1] ||
      "Reference price"
    ).replace(/:$/, "");
    offer.basis_price = { price: basis, label };
    if (/typical/i.test(label)) offer.typical_price = basis;
    else if (/list/i.test(label)) offer.list_price = basis;
  }
  const savingsPct = percentOf(text(q(priceRoot, ".apex-savings-percentage")));
  if (savingsPct !== undefined) offer.savings_percent = savingsPct;
  if (
    basis !== undefined &&
    price !== null &&
    basis.currency === price.currency &&
    basis.amount > price.amount
  ) {
    const amount = Math.round((basis.amount - price.amount) * 100) / 100;
    offer.savings = { amount, currency: price.currency, raw: `$${amount.toFixed(2)}` };
  }
  const unitMoney = moneyFromPriceElement(q(priceRoot, ".apex-priceperunit-value"));
  if (unitMoney !== undefined) {
    const label = text(q(priceRoot, ".apex-priceperunit-accessibility-label"));
    const unit =
      /per\s+(.+)$/i.exec(label)?.[1]?.trim() ??
      /\/\s*([^)]+)\)/.exec(text(q(priceRoot, ".centralizedApexPricePerUnitCSS")))?.[1]?.trim() ??
      "unit";
    offer.unit_price = { price: unitMoney, unit, raw: label || `${unitMoney.raw} / ${unit}` };
  }
  cons.take(q(card, "[id^=aod-price-]"));

  // promotions, badges, fees
  for (const p of qa(card, "[id^=aod-offer-promotion-]")) {
    const t = text(p, { exclude: (e) => e.localName === "a" && /^terms$/i.test(text(e)) });
    if (t !== "") offer.promotions.push(t);
    cons.take(p);
  }
  for (const b of qa(card, "[id^=aod-offer-mario-]")) {
    const t = text(b);
    if (t !== "") offer.badges.push(t);
    cons.take(b);
  }
  for (const f of qa(card, "[id^=aod-bottlingDepositFee-]")) {
    const t = text(f);
    if (t !== "") offer.fees.push(t);
    cons.take(f);
  }
  if (/\badd-on item\b/i.test(text(card))) offer.badges.push("Add-on Item");

  // shipping and delivery
  const delivery = parseDeliveryBlock(card, ctx);
  if (delivery !== undefined) offer.delivery = delivery;
  const shipRow = q(card, "#aod_ship_charge_row, .aod-ship-charge");
  const shipText = text(shipRow);
  cons.take(shipRow);
  const primary = delivery?.options.find((o) => !o.fastest) ?? delivery?.options[0];
  const shipping = firstOf<OfferShipping>(
    "offer.shipping",
    [
      [
        "id",
        () => {
          if (shipText === "") return undefined;
          if (/\bfree\b/i.test(shipText)) return { free: true, raw: shipText };
          const fee = parseMoney(shipText);
          return fee === undefined
            ? undefined
            : { free: fee.amount === 0, amount: fee, raw: shipText };
        },
      ],
      [
        "data-attr",
        () => {
          if (primary?.price === undefined) return undefined;
          const s: OfferShipping =
            primary.price === "FREE"
              ? { free: true, raw: primary.raw }
              : { free: primary.price.amount === 0, amount: primary.price, raw: primary.raw };
          if (primary.condition !== undefined) s.condition = primary.condition;
          return s;
        },
      ],
      [
        "text-anchor",
        () => {
          const v = attr(rq(card, "[data-csa-c-shipping-charge]"), "data-csa-c-shipping-charge");
          const n = Number(v);
          if (v === undefined || v === "" || !Number.isFinite(n)) return undefined;
          return n === 0
            ? { free: true, raw: v }
            : {
                free: false,
                amount: { amount: n, currency: price?.currency ?? "USD", raw: v },
                raw: v,
              };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (shipping !== undefined) offer.shipping = shipping;
  if (price !== null && shipping !== undefined) {
    const fee = shipping.free
      ? 0
      : shipping.amount?.currency === price.currency
        ? shipping.amount.amount
        : undefined;
    if (fee !== undefined) {
      const amount = Math.round((price.amount + fee) * 100) / 100;
      offer.total = { amount, currency: price.currency, raw: `$${amount.toFixed(2)}` };
      // Conditional free shipping: the total holds only when the condition is met.
      if (shipping.free && shipping.condition !== undefined) {
        offer.total_condition = shipping.condition;
      }
    }
  }
  cons.takeAll(qa(card, ".aod-delivery-promise"));

  // prime
  const primeIcon = qa(card, "i.a-icon-prime").find((i) => i.closest("#aod-filter") === null);
  const program = rqa(card, "[data-csa-c-delivery-benefit-program-id]")
    .map((e) => attr(e, "data-csa-c-delivery-benefit-program-id") ?? "")
    .filter((v) => v !== "");
  offer.prime =
    firstOf<boolean>(
      "offer.prime",
      [
        ["id", () => (primeIcon !== undefined ? true : undefined)],
        [
          "data-attr",
          () => (program.length === 0 ? undefined : program.some((p) => /^prime/i.test(p))),
        ],
        [
          "text-anchor",
          () => (delivery !== undefined ? /\bprime\b/i.test(delivery.lines.join(" ")) : undefined),
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  // The Prime badge's own words ("One-Day", "Two-Day") sit next to the icon.
  const badgeHolder = primeIcon?.parentElement ?? undefined;
  const badgeText = badgeHolder === undefined ? "" : text(badgeHolder);
  if (badgeHolder !== undefined && badgeText.length <= 40) {
    if (badgeText !== "") offer.prime_badge = badgeText;
    cons.take(badgeHolder);
  }

  // detail rows: ships from, sold by, condition note, customer service, returns, payment
  const rows = detailRows(details);
  const byLabel = (re: RegExp): DetailRow | undefined => rows.find((r) => re.test(r.label));
  const soldRow = byLabel(/^sold by$/i) ?? rows.find((r) => r.el.id === "aod-offer-soldBy");
  const shipsRow = byLabel(/^ships from$/i) ?? rows.find((r) => r.el.id === "aod-offer-shipsFrom");
  offer.seller = parseSeller(soldRow, card, ctx);
  const shipsFrom = text(shipsRow?.valueEl) || undefined;
  if (shipsFrom !== undefined) offer.ships_from = shipsFrom;
  for (const r of rows) {
    cons.take(r.el);
    if (r === soldRow || r === shipsRow) continue;
    const value = text(r.valueEl) || text(r.el, { exclude: (e) => e.matches("[role=heading]") });
    if (/^condition$/i.test(r.label) || r.el.id === "aod-condition-container") {
      const note = text(q(r.el, ".expandable-expanded-text")) || value;
      if (note !== "") offer.condition_note = note;
    } else if (/customer service/i.test(r.label)) offer.customer_service = value;
    else if (/^returns?/i.test(r.label)) offer.returns = value;
    else if (/^payment/i.test(r.label)) offer.payment = value;
    else if (value !== "" || r.label !== "") offer.details.push({ label: r.label, value });
  }
  if (offer.condition_note === undefined) {
    const note = text(q(card, ".expandable-expanded-text"));
    if (note !== "") offer.condition_note = note;
  }

  // fulfillment
  const shipsAmazon = isAmazonName(offer.ships_from);
  offer.fulfillment = fulfillmentOf(shipsAmazon, offer.ships_from, offer.seller);

  // quantity, stock
  const optionMax = Math.max(
    0,
    ...rqa(card, "[data-select-aod-qty-option]").map((e) => {
      const j = tryJson(e.getAttribute("data-select-aod-qty-option")) as
        { qty?: unknown } | undefined;
      return typeof j?.qty === "number" ? j.qty : 0;
    }),
  );
  const maxQ = firstOf<number>(
    "offer.max_quantity",
    [
      ["data-attr", () => (typeof atc?.maxQty === "number" ? atc.maxQty : undefined)],
      ["id", () => (optionMax > 0 ? optionMax : undefined)],
    ],
    meta,
    { optional: true },
  );
  if (maxQ !== undefined) offer.max_quantity = maxQ;
  const cardText = text(card);
  const minQ = typeof atc?.minQty === "number" ? atc.minQty : minOf(cardText);
  if (minQ !== undefined) offer.min_quantity = minQ;
  const limit = limitOf(cardText);
  if (limit !== undefined) offer.quantity_limit = limit;
  const stockEl = q(card, "[id^=aod-offer-availability], .aod-offer-availability");
  const stock =
    text(stockEl) ||
    STOCK_RE.exec(
      text(card, {
        exclude: (e) =>
          e.matches("[id^=mir-layout-DELIVERY_BLOCK], [role=listitem], #aod-offer-heading"),
      }),
    )?.[1];
  if (stock !== undefined && stock !== "") {
    offer.stock_text = stock;
    const n = stockCountOf(stock);
    if (n !== undefined) offer.stock_count = n;
  }
  cons.take(stockEl);

  // add-to-cart identifiers and controls
  const olid =
    firstOf<string>(
      "offer.offer_listing_id",
      [
        ["id", () => attr(rq(form, "input[name='items[0.base][offerListingId]']"), "value")],
        ["data-attr", () => atc?.oid],
        ["label", () => attr(rq(card, "input[name=offerListingID]"), "value")],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const asin = attr(rq(form, "input[name='items[0.base][asin]']"), "value") || atc?.asin || null;
  offer.internal = {
    asin,
    offer_listing_id: olid,
    seller_id: offer.seller.seller_id,
    condition: offer.condition,
    price: offer.price,
  };
  const atcCol = q(card, ".aod-atc-column");
  cons.take(atcCol ?? form ?? undefined);
  cons.takeAll(qa(card, ".aod-atc-inline-msg-column"));
  cons.takeAll(qa(card, ".aod-offer-divider"));
  cons.takeAll(qa(card, "#aod-see-more-options-link"));
  if (olid === null && price !== null)
    meta.warnings.push(`offer ${opts.position}: no add-to-cart identifier`);
  return offer;
}

function fulfillmentOf(
  shipsAmazon: boolean,
  shipsFrom: string | undefined,
  seller: OfferSeller,
): Fulfillment | null {
  if (shipsFrom === undefined) return seller.is_amazon ? "amazon" : null;
  if (shipsAmazon) return seller.is_amazon ? "amazon" : seller.name === null ? null : "fba";
  return "merchant";
}

// ---- flags

/** Flags that need the request (clock, requested quantity): finished by the daemon. */
export const REQUEST_TIME_FLAGS: readonly OfferFlag[] = ["slow_delivery", "quantity_above_stock"];

export const DEFAULT_SLOW_DELIVERY_DAYS = 5;
export const DEFAULT_PRICE_ABOVE_TYPICAL = 0.25;
/** Amazon's usual quantity-dropdown cap; a lower cap with no stock explanation is a limit. */
export const DEFAULT_MAX_QUANTITY = 30;
/**
 * Page-local UTC offset used when the caller gives none: the westernmost US zone. A later
 * "now" date can only make deliveries look sooner, so the earliest plausible local date is
 * used and an unknown zone fails toward flagging.
 */
export const DEFAULT_UTC_OFFSET_MINUTES = -600;

export interface OfferFlagContext {
  /** Injected clock. Required: a missing clock must never silently pass slow_delivery. */
  now: Date | string;
  /** Page-local offset from UTC in minutes (US Central standard time = -360). */
  utc_offset_minutes?: number;
  slow_delivery_days?: number;
  /** Fraction over the typical price that flags (default 0.25). */
  price_above_typical_threshold?: number;
  /** Overrides the offer's own typical price. */
  typical_price?: Money;
  requested_quantity?: number;
  /** Product title, for the multipack heuristic. */
  title?: string | null;
  /** Page-level signals (see offerFlagContext). */
  no_featured_offer?: boolean;
  subscribe_and_save_default?: boolean;
  protection_plan_prompt?: boolean;
  addon_or_bundle_upsell?: boolean;
  /**
   * The account has Prime, so "FREE delivery for Prime members" is free. Unknown (undefined)
   * fails closed: conditional free shipping then counts as a fee.
   */
  prime_member?: boolean;
}

export type StaticFlagContext = Omit<
  OfferFlagContext,
  "now" | "requested_quantity" | "utc_offset_minutes"
>;

/** Build the flag context for one offer from a parse result. */
export function offerFlagContext(
  data: OffersData,
  offer: Offer,
  request: {
    now: Date | string;
    requested_quantity?: number;
    utc_offset_minutes?: number;
    prime_member?: boolean;
  },
): OfferFlagContext {
  const ctx: OfferFlagContext = {
    ...staticContext(data, offer),
    now: request.now,
  };
  if (request.requested_quantity !== undefined) ctx.requested_quantity = request.requested_quantity;
  if (request.utc_offset_minutes !== undefined) ctx.utc_offset_minutes = request.utc_offset_minutes;
  if (request.prime_member !== undefined) ctx.prime_member = request.prime_member;
  return ctx;
}

function staticContext(data: OffersData, offer: Offer): StaticFlagContext {
  const ctx: StaticFlagContext = {
    title: data.product.title,
    no_featured_offer: data.no_featured_offer,
    subscribe_and_save_default:
      offer.pinned && data.purchase_types.some((p) => p.kind === "subscribe_and_save" && p.default),
    protection_plan_prompt: data.buybox.protection_plan_text !== undefined,
    addon_or_bundle_upsell: data.buybox.addon_text !== undefined,
  };
  // The product page's typical price is product level: it applies to every offer.
  const typical = offer.typical_price ?? data.typical_price;
  if (typical !== undefined) ctx.typical_price = typical;
  return ctx;
}

/**
 * Multipack markers in a title: "Pack of 6", "6-Pack", "6 Pack", "24 Count", "24 Ct",
 * "Set of 3", "3 Pcs", "12 Pieces", "(2 x ...)". Returns the counts found (each > 1).
 */
export function multipackCounts(title: string | null | undefined): number[] {
  if (title == null) return [];
  const out = new Set<number>();
  const res = [
    /\bpack of (\d+)\b/gi,
    /\bset of (\d+)\b/gi,
    /\b(\d+)[- ]?(?:pack|pk)\b/gi,
    /\b(\d+)\s*(?:count|ct)\b/gi,
    /\b(\d+)\s*(?:pcs|pieces|piece)\b/gi,
    /\((\d+)\s*x\b/gi,
  ];
  for (const re of res) {
    for (const m of title.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 1) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const COUNT_UNIT_RE = /^(count|ct|each|ea|piece|pieces|item|items|unit|units)$/i;

/**
 * Multipack / unit ambiguity heuristic, deliberately conservative (it fires only on a concrete
 * contradiction or a missing cross-check):
 * - no multipack marker in the title (or no title at all): no flag;
 * - two different pack counts in the title ("Pack of 2" and "24 Count"): flag;
 * - one count and a per-count unit price: flag only when price / unit price disagrees with
 *   the count by more than 10%;
 * - one count and no unit price: flag (nothing tells whether the price is per pack or per unit);
 * - one count and a non-count unit price (per ounce): no flag, the unit price is explicit.
 */
export function isMultipackAmbiguous(offer: Offer, title: string | null | undefined): boolean {
  const counts = multipackCounts(title);
  if (counts.length === 0) return false;
  if (counts.length > 1) return true;
  const n = counts[0] as number;
  const unit = offer.unit_price;
  if (unit === undefined || offer.price === null) return true;
  if (!COUNT_UNIT_RE.test(unit.unit)) return false;
  if (unit.price.amount <= 0) return true;
  const implied = offer.price.amount / unit.price.amount;
  return Math.abs(implied - n) / n > 0.1;
}

const PREORDER_RE =
  /\b(pre-?order|backorder|back-ordered|temporarily out of stock|usually ships within|available to ship in|will be released on|not yet released|release date)\b/i;
const OUT_OF_STOCK_RE = /\b(currently unavailable|no longer available)\b|^\s*out of stock\.?\s*$/i;

/** Cannot be added: stated unavailable, or no add-to-cart identifier at all (fails closed). */
export function isOfferOutOfStock(offer: Offer): boolean {
  if (offer.stock_text !== undefined && OUT_OF_STOCK_RE.test(offer.stock_text)) return true;
  return offer.internal.offer_listing_id === null;
}

function staticFlags(offer: Offer, ctx: StaticFlagContext): Set<OfferFlag> {
  const f = new Set<OfferFlag>();
  if (offer.condition !== "new") f.add("used_or_renewed");
  if (ctx.no_featured_offer === true || (offer.pinned && offer.price === null))
    f.add("no_featured_offer");
  const typical = ctx.typical_price ?? offer.typical_price;
  if (typical !== undefined && offer.price !== null) {
    const threshold = ctx.price_above_typical_threshold ?? DEFAULT_PRICE_ABOVE_TYPICAL;
    if (typical.currency !== offer.price.currency) f.add("price_above_typical");
    else if (offer.price.amount * 100 > Math.round(typical.amount * 100) * (1 + threshold) + 1e-6) {
      f.add("price_above_typical");
    }
  }
  if (offer.prime !== true) f.add("not_prime");
  if (
    offer.shipping === undefined ||
    (!offer.shipping.free && (offer.shipping.amount?.amount ?? 1) > 0) ||
    !shippingConditionMet(offer.shipping.condition, ctx)
  ) {
    f.add("shipping_fee");
  }
  if (offer.min_quantity !== undefined && offer.min_quantity > 1) f.add("minimum_quantity");
  if (
    offer.quantity_limit !== undefined ||
    (offer.max_quantity !== undefined &&
      offer.max_quantity < DEFAULT_MAX_QUANTITY &&
      offer.stock_count === undefined)
  ) {
    f.add("quantity_limit");
  }
  if (isMultipackAmbiguous(offer, ctx.title)) f.add("multipack_ambiguity");
  if (ctx.subscribe_and_save_default === true) f.add("subscribe_and_save_default");
  const stockAndDelivery = `${offer.stock_text ?? ""} ${(offer.delivery?.lines ?? []).join(" ")}`;
  if (PREORDER_RE.test(stockAndDelivery)) f.add("preorder_or_backorder");
  if (ctx.addon_or_bundle_upsell === true || offer.badges.some((b) => /add-on|bundle/i.test(b))) {
    f.add("addon_or_bundle_upsell");
  }
  if (ctx.protection_plan_prompt === true) f.add("protection_plan_prompt");
  if (!offer.seller.is_amazon) f.add("third_party_seller");
  if (offer.fulfillment !== "amazon" && offer.fulfillment !== "fba") f.add("merchant_fulfilled");
  return f;
}

/**
 * Free shipping with a qualifier ("for Prime members", "on orders over $35") is free only
 * when the qualifier is provably met. Only Prime membership can be proven (by the caller,
 * through `prime_member`); an order-total threshold depends on the cart and never is.
 */
function shippingConditionMet(condition: string | undefined, ctx: StaticFlagContext): boolean {
  if (condition === undefined || condition.trim() === "") return true;
  if (/^for prime members$/i.test(condition.trim())) return ctx.prime_member === true;
  return false;
}

/**
 * The delivery options that count for slow_delivery: the primary option (the one shipping
 * and total were read from) plus any other option whose price is known to be FREE. A faster
 * option of unknown or non-zero price does not make a slow free offer fast.
 */
function countedDeliveryOptions(offer: Offer): DeliveryOption[] {
  const options = offer.delivery?.options ?? [];
  const primary = options.find((o) => !o.fastest) ?? options[0];
  return options.filter((o) => o === primary || o.price === "FREE");
}

function localDayNumber(instant: number, offsetMinutes: number): number {
  return Math.floor((instant + offsetMinutes * 60_000) / 86_400_000);
}

function isoDayNumber(iso: string): number | undefined {
  const t = ymdFromIso(iso);
  return t === undefined ? undefined : Date.UTC(t.y, t.m, t.d) / 86_400_000;
}

/**
 * Calendar days from `now` (page-local) to the offer's soonest counted delivery (see
 * countedDeliveryOptions), or undefined when no counted option has a usable date.
 */
export function deliveryDaysFrom(
  offer: Offer,
  now: Date | string,
  utcOffsetMinutes: number = DEFAULT_UTC_OFFSET_MINUTES,
): number | undefined {
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(nowMs)) return undefined;
  const today = localDayNumber(nowMs, utcOffsetMinutes);
  let best: number | undefined;
  for (const o of countedDeliveryOptions(offer)) {
    let days: number | undefined;
    if (o.latest_iso !== undefined) {
      const d = isoDayNumber(o.latest_iso);
      if (d !== undefined) days = d - today;
    } else if (o.relative === "today") days = 0;
    else if (o.relative === "tomorrow" || o.relative === "overnight") days = 1;
    if (days !== undefined && (best === undefined || days < best)) best = days;
  }
  const epoch = offer.delivery?.promise_epoch_s;
  if (best === undefined && epoch !== undefined) {
    best = localDayNumber(epoch * 1000, utcOffsetMinutes) - today;
  }
  return best;
}

/**
 * Every D17 flag for one offer, in OFFER_FLAGS order. Pure: `now` is injected. A missing or
 * unreadable input fails closed (the flag fires): unknown condition, Prime, shipping,
 * seller, fulfillment or delivery date. Only price_above_typical needs a known typical price.
 */
export function computeOfferFlags(offer: Offer, context: OfferFlagContext): OfferFlag[] {
  const f = staticFlags(offer, context);
  const limitDays = context.slow_delivery_days ?? DEFAULT_SLOW_DELIVERY_DAYS;
  const days = deliveryDaysFrom(offer, context.now, context.utc_offset_minutes);
  if (days === undefined || days > limitDays) f.add("slow_delivery");
  const want = context.requested_quantity ?? 1;
  const caps = [offer.stock_count, offer.max_quantity, offer.quantity_limit].filter(
    (n): n is number => n !== undefined,
  );
  if (caps.some((c) => want > c)) f.add("quantity_above_stock");
  return OFFER_FLAGS.filter((name) => f.has(name));
}

/** The time- and request-independent subset (what parseOffers stores on each offer). */
export function computeStaticOfferFlags(offer: Offer, context: StaticFlagContext): OfferFlag[] {
  const f = staticFlags(offer, context);
  return OFFER_FLAGS.filter((name) => f.has(name));
}

// ---- panel-level parsing

function parseFilters(root: DomElement): OfferFilter[] {
  const list = q(root, "#aod-filter-list") ?? q(root, "#aod-filter");
  if (list === undefined) return [];
  const out: OfferFilter[] = [];
  const seen = new Set<string>();
  for (const el of rqa(list, "[data-aod-toggle-filter-checkbox]")) {
    if (el.closest("[id^=aod-filter-swatch]") !== null) continue;
    const j = tryJson(el.getAttribute("data-aod-toggle-filter-checkbox")) as
      { checkboxID?: unknown; parentID?: unknown } | undefined;
    const box = rq(el, "[role=checkbox]");
    const id =
      typeof j?.checkboxID === "string" ? j.checkboxID : (rq(el, ".aod-filter-checkbox")?.id ?? "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const shown = rawText(box ?? el);
    const label = attr(box, "aria-label") || shown.replace(/\(\s*\d+\s*\)\s*$/, "").trim() || id;
    const groupEl = el.closest("[role=group]");
    const groupLabelId = attr(groupEl, "aria-labelledby");
    const group =
      (groupLabelId !== undefined ? rawText(rq(root, `[id="${groupLabelId}"]`)) : "") ||
      rawText(groupEl === null ? undefined : rq(groupEl, "h5")) ||
      null;
    const f: OfferFilter = {
      id,
      label,
      group,
      parent: typeof j?.parentID === "string" && j.parentID !== "" ? j.parentID : null,
      checked: attr(box, "aria-checked") === "true",
    };
    const count = /\((\d[\d,]*)\)\s*$/.exec(shown)?.[1];
    if (count !== undefined) f.count = Number(count.replace(/,/g, ""));
    out.push(f);
  }
  return out;
}

function filterMatches(f: OfferFilter, o: Offer): boolean | undefined {
  const label = f.label.toLowerCase();
  if (f.id === "primeEligible" || label === "prime") return o.prime === true;
  if (f.id === "freeShipping" || /free (delivery|shipping)/.test(label))
    return o.shipping?.free === true;
  if (f.parent !== null) {
    const parent = conditionFromText(f.parent);
    if (parent !== null && o.condition !== parent) return false;
    return (o.sub_condition ?? "").toLowerCase() === label.replace(/^used\s*-\s*/, "");
  }
  const cond = conditionFromText(f.label);
  if (cond !== null) return o.condition === cond;
  return undefined;
}

// ---- product page

interface PageInfo {
  purchase_types: PurchaseType[];
  coupons: Coupon[];
  promotions: string[];
  typical_price?: Money;
  list_price?: Money;
  featured_price?: Money;
  buybox: BuyboxInfo;
  title?: string;
  asin?: string;
  fallback_offer?: Offer;
}

function rowKind(name: string, caption: string): PurchaseType["kind"] {
  if (/sns|subscri/i.test(name) || /subscribe/i.test(caption)) return "subscribe_and_save";
  // Every other buy-box row (new, used, renewed) is bought once.
  return "one_time";
}

function unitPriceIn(scope: DomElement | undefined): UnitPrice | undefined {
  const label =
    scope === undefined ? undefined : rq(scope, ".apex-priceperunit-accessibility-label");
  const t = rawText(label);
  const money = parseMoney(t);
  if (money === undefined) return undefined;
  const unit = /per\s+(.+)$/i.exec(t)?.[1]?.trim() ?? "unit";
  return { price: money, unit, raw: t };
}

function parseSnsTiers(row: DomElement, oneTime: Money | undefined): SubscribeAndSaveTier[] {
  const tiers: SubscribeAndSaveTier[] = [];
  const base = rq(row, "#sns-base-price");
  if (base !== undefined) {
    const label = rawText(rq(base, ".apex-pricetopay-accessibility-label"));
    const price = parseMoney(label) ?? moneyFromRaw(base);
    const t: SubscribeAndSaveTier = { kind: "base" };
    if (price !== undefined) t.price = price;
    const pct = percentOf(label) ?? pctOff(price, oneTime);
    if (pct !== undefined) t.percent = pct;
    if (label !== "") t.raw = label;
    tiers.push(t);
  }
  const tiered = rq(row, "#sns-tiered-price");
  if (tiered !== undefined) {
    const price = moneyFromRaw(tiered);
    const t: SubscribeAndSaveTier = { kind: "tiered" };
    if (price !== undefined) t.price = price;
    const unlocked = percentOf(/unlocked (\d+%) savings/i.exec(rawText(row))?.[1]);
    const pct = unlocked ?? pctOff(price, oneTime);
    if (pct !== undefined) t.percent = pct;
    tiers.push(t);
  }
  return tiers;
}

function moneyFromRaw(el: DomElement | undefined): Money | undefined {
  if (el === undefined) return undefined;
  const off = rqa(el, ".a-offscreen")
    .map((o) => parseMoney(collapse(o.textContent ?? "")))
    .find((m) => m !== undefined);
  if (off !== undefined) return off;
  const whole = rq(el, ".a-price-whole");
  if (whole !== undefined) {
    const w = (whole.textContent ?? "").replace(/[^0-9]/g, "");
    const fr = (rq(el, ".a-price-fraction")?.textContent ?? "").replace(/[^0-9]/g, "");
    if (w !== "")
      return {
        amount: Number(`${w}.${fr === "" ? "00" : fr.slice(0, 2)}`),
        currency: "USD",
        raw: `$${w}.${fr || "00"}`,
      };
  }
  return parseMoney(rawText(el));
}

function pctOff(price: Money | undefined, ref: Money | undefined): number | undefined {
  if (
    price === undefined ||
    ref === undefined ||
    ref.amount <= 0 ||
    price.currency !== ref.currency
  )
    return undefined;
  return Math.round((1 - price.amount / ref.amount) * 100);
}

function parsePurchaseTypes(
  rowsEls: DomElement[],
  buybox: DomElement | undefined,
  meta: ParseMeta,
): { types: PurchaseType[]; rows: BuyboxRow[] } {
  const rows: BuyboxRow[] = [];
  const types: PurchaseType[] = [];
  const oneTimeRow = rowsEls.find((r) => /^new/i.test(attr(r, "data-a-accordion-row-name") ?? ""));
  const oneTimePrice = oneTimeRow === undefined ? undefined : rowPrice(oneTimeRow);
  for (const row of rowsEls) {
    const name = attr(row, "data-a-accordion-row-name") ?? row.id;
    const header = rq(row, ".accordion-header") ?? row;
    const caption =
      rawText(rq(header, ".accordion-caption")) ||
      rawText(rq(header, "#sns-caption-and-icon")) ||
      rawText(rq(header, ".a-text-bold"));
    const active = classList(row).includes("a-accordion-active");
    const price = rowPrice(row);
    const r: BuyboxRow = {
      name,
      caption,
      active,
      text: text(header, { exclude: (e) => e.matches(".a-offscreen") }),
    };
    if (price !== undefined) r.price = price;
    rows.push(r);
    const kind = rowKind(name, caption);
    if (kind === "one_time") {
      // Condition rows ("Buy New", "Refurbished - Excellent", "Used - Good") are all one-time
      // purchases: one entry, from the active row when it is one of them.
      const existing = types.find((x) => x.kind === "one_time");
      if (existing !== undefined) {
        if (active) {
          existing.default = true;
          if (price !== undefined) existing.price = price;
          else delete existing.price;
        }
        continue;
      }
    }
    const label =
      kind === "one_time" && !/one-time|one time/i.test(caption)
        ? "One-time purchase"
        : caption || kind;
    const t: PurchaseType = { kind, label, default: active };
    if (price !== undefined) t.price = price;
    const unit = unitPriceIn(rq(row, "#corePrice_feature_div") ?? row);
    if (unit !== undefined) t.unit_price = unit;
    if (kind === "subscribe_and_save") {
      const tiers = parseSnsTiers(row, oneTimePrice);
      if (tiers.length > 0) t.tiers = tiers;
      const freqs = rqa(row, "[id^=snsFrequencyAccordionRow-] .a-heading-text")
        .map(rawText)
        .filter(Boolean);
      if (freqs.length > 0) t.frequencies = freqs;
      const sel = rawText(rq(row, "#replenishment-sns-frequency-trigger"));
      if (sel !== "") t.selected_frequency = sel;
      const first =
        rawText(rq(row, "#accordion-header-sns-delivery-link")) ||
        rawText(rq(row, ".sns-delivery-link"));
      if (first !== "") t.first_delivery = first;
    }
    types.push(t);
  }
  if (
    types.length === 0 &&
    buybox !== undefined &&
    q(buybox, "#add-to-cart-button") !== undefined
  ) {
    // Single-offer buy box (no accordion): one-time purchase only.
    types.push({ kind: "one_time", label: "One-time purchase", default: true });
    meta.strategies["purchase_types"] = "single-buybox";
  } else if (types.length > 0) {
    meta.strategies["purchase_types"] = "data-attr";
  }
  return { types, rows };
}

function rowPrice(row: DomElement): Money | undefined {
  const core = rq(row, "#corePrice_feature_div") ?? rq(row, ".accordion-header") ?? row;
  const tiered = rq(core, "#sns-tiered-price");
  if (tiered !== undefined) return moneyFromRaw(tiered);
  for (const p of rqa(core, ".a-price")) {
    if (p.closest("#sns-base-price") !== null || p.matches(".a-text-price")) continue;
    const m = moneyFromRaw(p);
    if (m !== undefined) return m;
  }
  return undefined;
}

function parseCoupons(
  doc: DomDocument,
  cons: Consumption,
): { coupons: Coupon[]; promotions: string[] } {
  const coupons: Coupon[] = [];
  const promotions: string[] = [];
  const seen = new Set<string>();
  const scopes: [string, string][] = [
    ["#promoPriceBlockMessage_feature_div", "price-block"],
    ["#couponsInBuybox_feature_div", "buybox"],
    ["#coupons_feature_div", "buybox"],
    ["#snsCoupon_feature_div", "subscribe-and-save"],
    ["#vpcButton", "buybox"],
  ];
  for (const [sel, location] of scopes) {
    for (const scope of qa(doc, sel)) {
      for (const el of qa(scope, "[id^=couponText], .couponLabelText")) {
        if (el.parentElement?.closest("[id^=couponText], .couponLabelText") != null) continue;
        // The coupon row: the text span's parent holds the badge and the clip control.
        const container = el.parentElement ?? el;
        const t = text(el, {
          exclude: (e) => e.localName === "a" && /^(terms|shop items|details)$/i.test(text(e)),
        }).replace(/\s*\|\s*$/, "");
        if (t === "" || seen.has(t)) continue;
        seen.add(t);
        const badge =
          text(q(container, "[id^=badge], .newCouponBadge, [id^=couponBadge]")) || undefined;
        const clip =
          q(
            container,
            "input[type=checkbox], [data-action*=clip], [id*=clip], .clip-coupon, [id^=vpcButton]",
          ) !== undefined || /\bclip\b|\bapply \$?[\d.,]+%? coupon\b/i.test(text(container));
        const c: Coupon = {
          text: t,
          clippable: clip,
          requires_subscribe_and_save: /subscribe\s*&\s*save/i.test(t),
          location,
        };
        if (badge !== undefined) c.badge = badge;
        const pct = percentOf(t);
        if (pct !== undefined) c.percent = pct;
        else {
          const m = parseMoney(t);
          if (m !== undefined) c.amount = m;
        }
        coupons.push(c);
        cons.take(container);
      }
      for (const el of qa(scope, "[id^=promoMessage]")) {
        const badgeEl =
          el.parentElement === null ? undefined : q(el.parentElement, "[id^=greenBadge]");
        const t = collapse(
          `${text(badgeEl)} ${text(el, { exclude: (e) => e.localName === "a" && /^(terms|shop items)$/i.test(text(e)) })}`,
        );
        if (t !== "" && !promotions.includes(t)) promotions.push(t);
        cons.take(el.parentElement ?? el);
      }
    }
  }
  return { coupons, promotions };
}

function parseProductPage(
  doc: DomDocument,
  cons: Consumption,
  meta: ParseMeta,
  refIso: string | undefined,
): PageInfo {
  const buybox = q(doc, "#desktop_buybox") ?? q(doc, "#buybox") ?? undefined;
  const accordion = q(doc, "#buyBoxAccordion");
  const rowEls =
    accordion === undefined
      ? []
      : Array.from(accordion.children).filter(
          (c) => c.hasAttribute("data-a-accordion-row-name") && !hiddenSelf(c),
        );
  const { types, rows } = parsePurchaseTypes(rowEls, buybox, meta);
  const activeRow = rowEls.find((r) => classList(r).includes("a-accordion-active")) ?? rowEls[0];
  const scope = activeRow ?? buybox;

  // featured price, typical / list price (center column apex block)
  const core =
    q(doc, "#corePriceDisplay_desktop_feature_div") ??
    q(doc, "#corePrice_feature_div") ??
    undefined;
  const info: PageInfo = {
    purchase_types: types,
    coupons: [],
    promotions: [],
    buybox: { state: "unknown", rows, add_to_cart_present: false },
  };
  const featured = firstOf<Money>(
    "featured_price",
    [
      [
        "id",
        () => moneyFromPriceElement(q(core, ".apex-pricetopay-value") ?? q(core, ".priceToPay")),
      ],
      ["label", () => parseMoney(text(q(doc, "#apex-pricetopay-accessibility-label")))],
      ["data-attr", () => (activeRow === undefined ? undefined : rowPrice(activeRow))],
    ],
    meta,
    { optional: true },
  );
  if (featured !== undefined) info.featured_price = featured;
  for (const scopeEl of [core, q(doc, "#corePrice_feature_div")]) {
    for (const v of qa(scopeEl, ".apex-basisprice-value, .basisPrice .a-price")) {
      const m = moneyFromPriceElement(v);
      if (m === undefined) continue;
      const holder =
        v.closest(".apex-basisprice-feature") ?? v.closest(".basisPrice") ?? v.parentElement ?? v;
      const label = rawText(holder);
      if (/typical/i.test(label) && info.typical_price === undefined) {
        info.typical_price = m;
        meta.strategies["typical_price"] = "label";
      } else if (/list price/i.test(label) && info.list_price === undefined) {
        info.list_price = m;
        meta.strategies["list_price"] = "label";
      }
    }
  }

  const { coupons, promotions } = parseCoupons(doc, cons);
  info.coupons = coupons;
  info.promotions = promotions;

  // buy-box state
  const availEl = q(scope, "#availability") ?? q(doc, "#availability") ?? q(doc, "#outOfStock");
  const avail = text(availEl);
  if (avail !== "") info.buybox.availability_text = avail;
  cons.take(availEl);
  const atcBtn = q(scope, "#add-to-cart-button") ?? q(buybox, "#add-to-cart-button");
  info.buybox.add_to_cart_present = atcBtn !== undefined;
  const seeAll =
    q(doc, "#buybox-see-all-buying-choices") ?? q(doc, "#buybox-see-all-buying-choices-announce");
  const seeAllText = text(seeAll);
  if (/currently unavailable/i.test(avail) || q(doc, "#outOfStock") !== undefined)
    info.buybox.state = "unavailable";
  else if (seeAll !== undefined && atcBtn === undefined) {
    info.buybox.state = "no_featured_offer";
    if (seeAllText !== "") info.buybox.no_featured_offer_text = seeAllText;
  } else if (atcBtn !== undefined) info.buybox.state = "featured";
  meta.strategies["buybox.state"] = "id";
  const deliverTo = q(buybox, "#contextualIngressPtLabel") ?? q(buybox, "#glow-ingress-block");
  const dt = text(deliverTo);
  if (dt !== "") info.buybox.deliver_to = dt;
  cons.take(deliverTo);
  const deliveryLines = qa(scope, "[id^=mir-layout-DELIVERY_BLOCK-slot-]")
    .map((s) => text(s))
    .filter((t) => t !== "");
  if (deliveryLines.length > 0) info.buybox.delivery_lines = deliveryLines;
  const odfText = (sel: string): string =>
    rawText(rq(scope, `${sel} .offer-display-feature-text-message`)) ||
    rawText(rq(scope, `${sel} .offer-display-feature-text`));
  const soldBy = odfText("#merchantInfoFeature_feature_div");
  if (soldBy !== "") info.buybox.sold_by = soldBy;
  const shipsFrom = odfText("#fulfillerInfoFeature_feature_div");
  if (shipsFrom !== "") info.buybox.ships_from = shipsFrom;
  const qtyMax = Math.max(
    0,
    ...rqa(scope, "select#quantity option, select[name=quantity] option")
      .map((o) => Number(attr(o, "value")))
      .filter(Number.isFinite),
  );
  if (qtyMax > 0) info.buybox.max_quantity = qtyMax;
  const protect = [
    "#mbb_feature_div",
    "#abbWrapper",
    "#attach-warranty-display",
    "#warranty_feature_div",
  ]
    .map((s) => q(doc, s))
    .find((e) => e !== undefined && /protection|warranty|protect/i.test(text(e)));
  if (protect !== undefined) {
    info.buybox.protection_plan_text = text(protect);
    cons.take(protect);
  }
  const addon = q(doc, "#addOnItem_feature_div");
  if (addon !== undefined && text(addon) !== "") {
    info.buybox.addon_text = text(addon);
    cons.take(addon);
  }
  const title = text(q(doc, "#productTitle"));
  if (title !== "") info.title = title;
  const asin =
    attr(rq(scope, "input#ASIN, input[name=ASIN]"), "value") ||
    attr(rq(scope, "input[name='items[0.base][asin]']"), "value");
  if (asin !== undefined && asin !== "") info.asin = asin;

  // consume what the purchase-type and state parsing read
  for (const row of rowEls) cons.take(rq(row, ".accordion-header") ?? undefined);
  cons.takeAll(
    qa(
      scope,
      "#addToCart_feature_div, #buyNow_feature_div, #quantityRelocate_feature_div, #selectQuantity",
    ),
  );
  cons.takeAll(
    qa(
      scope,
      "#deliveryBlock_feature_div, #mir-layout-DELIVERY_BLOCK, #offerDisplayFeatures_desktop",
    ),
  );

  // featured offer from the buy box (fallback when the panel has no pinned offer)
  if (scope !== undefined && atcBtn !== undefined)
    info.fallback_offer = buyboxOffer(scope, activeRow, featured, info, refIso, meta);
  return info;
}

function buyboxOffer(
  scope: DomElement,
  row: DomElement | undefined,
  price: Money | undefined,
  info: PageInfo,
  refIso: string | undefined,
  meta: ParseMeta,
): Offer {
  const odf = (sel: string): string =>
    rawText(rq(scope, `${sel} .offer-display-feature-text-message`)) ||
    rawText(rq(scope, `${sel} .offer-display-feature-text`));
  const sold =
    odf("#merchantInfoFeature_feature_div") || rawText(rq(scope, "#sellerProfileTriggerId"));
  const ships =
    odf("#fulfillerInfoFeature_feature_div") ||
    (/shipper \/ seller/i.test(rawText(rq(scope, "#merchantInfoFeature_feature_div"))) ? sold : "");
  const sellerHref = attr(
    rq(scope, "#sellerProfileTriggerId, #merchantInfoFeature_feature_div a[href*='seller=']"),
    "href",
  );
  const rowName = attr(row, "data-a-accordion-row-name") ?? "";
  const condition = /used/i.test(rowName)
    ? "used"
    : /renew|refurb/i.test(rowName)
      ? "renewed"
      : "new";
  const slots = qa(scope, "[id^=mir-layout-DELIVERY_BLOCK-slot-]");
  const options: DeliveryOption[] = slots
    .map((s) => {
      const raw = text(s);
      const o: DeliveryOption = {
        slot: s.id.replace(/^mir-layout-DELIVERY_BLOCK-slot-/, ""),
        raw,
        fastest: /fastest/i.test(raw),
      };
      const bold = text(q(s, ".a-text-bold"));
      if (bold !== "") o.date_raw = bold;
      Object.assign(o, parseDeliveryDate(bold || raw, refIso));
      if (/\bFREE\b/.test(raw) && !o.fastest) o.price = "FREE";
      const cond = /\b(for Prime members|on orders? over \$[\d.,]+)/i.exec(raw)?.[1];
      if (cond !== undefined) o.condition = cond;
      return o;
    })
    .filter((o) => o.raw !== "");
  const seller: OfferSeller = {
    name: sold || null,
    seller_id: sellerIdFromHref(sellerHref),
    new_seller: false,
    is_amazon: isAmazonName(sold) && sellerIdFromHref(sellerHref) === null,
  };
  const olid =
    attr(rq(scope, "input[name='items[0.base][offerListingId]']"), "value") ||
    attr(rq(scope, "input#offerListingID, input[name=offerListingID]"), "value") ||
    null;
  const offer: Offer = {
    index: 0,
    pinned: true,
    collapsed: false,
    source: "buybox",
    price: price ?? null,
    condition,
    seller,
    fulfillment: fulfillmentOf(isAmazonName(ships), ships || undefined, seller),
    prime:
      q(scope, "i.a-icon-prime") !== undefined ||
      /prime members/i.test(options.map((o) => o.raw).join(" "))
        ? true
        : options.length > 0
          ? false
          : null,
    promotions: [...info.promotions],
    badges: [],
    fees: [],
    details: [],
    flags: [],
    out_of_stock: false,
    internal: {
      asin: info.asin ?? null,
      offer_listing_id: olid,
      seller_id: seller.seller_id,
      condition,
      price: price ?? null,
    },
  };
  if (ships !== "") offer.ships_from = ships;
  if (info.typical_price !== undefined) offer.typical_price = info.typical_price;
  if (info.list_price !== undefined) offer.list_price = info.list_price;
  const free = options.find((o) => o.price === "FREE");
  if (free !== undefined) {
    offer.shipping = { free: true, raw: free.raw };
    if (free.condition !== undefined) offer.shipping.condition = free.condition;
    if (price !== undefined) offer.total = price;
  }
  if (options.length > 0) {
    const d: DeliveryPromise = { lines: options.map((o) => o.raw), options };
    let best: DeliveryOption | undefined;
    for (const o of options)
      if (
        o.latest_iso !== undefined &&
        (best?.latest_iso === undefined || o.latest_iso < best.latest_iso)
      )
        best = o;
    if (best !== undefined) d.fastest = best;
    offer.delivery = d;
  }
  if (info.buybox.availability_text !== undefined) {
    offer.stock_text = info.buybox.availability_text;
    const n = stockCountOf(offer.stock_text);
    if (n !== undefined) offer.stock_count = n;
  }
  if (info.buybox.max_quantity !== undefined) offer.max_quantity = info.buybox.max_quantity;
  meta.strategies["pinned_offer"] = "page-buybox";
  return offer;
}

// ---- entry point

function aodRootOf(doc: DomDocument | undefined): DomElement | undefined {
  if (doc === undefined) return undefined;
  return (
    rq(doc, "#aod-container") ??
    rq(doc, "#all-offers-display-scroller") ??
    rq(doc, "#aod-offer-list")?.parentElement ??
    undefined
  );
}

function prefixSections(sections: OtherSection[], prefix: string): OtherSection[] {
  return sections.map((s) => ({ ...s, key: `${prefix}${s.key}` }));
}

export const parseOffers: Parser<OffersData> = (capture: Capture): ParseResult<OffersData> => {
  const meta = newMeta();
  const { doc, fragments } = parseCapture(capture);
  const refIso = capture.captured_at;
  const base = capture.final_url || capture.url;

  // Panel: the fragment first, else a panel already open inside the page.
  let aodDoc: DomDocument | undefined = fragments["aod"];
  let aodRoot: DomElement | undefined;
  if (aodDoc !== undefined) {
    normalizeAodVisibility(aodDoc);
    aodRoot = aodRootOf(aodDoc);
    meta.strategies["aod"] = "fragment";
  }
  if (aodRoot === undefined) {
    const inPage = aodRootOf(doc);
    if (inPage !== undefined) {
      normalizeAodVisibility(inPage);
      aodRoot = inPage;
      aodDoc = doc;
      meta.strategies["aod"] = "in-page";
    } else {
      meta.warnings.push(
        "aod: all-offers panel missing (no fragment, no in-page panel); offers list is empty",
      );
    }
  }

  const pageCons = new Consumption();
  const page = parseProductPage(doc, pageCons, meta, refIso);
  const aodCons = new Consumption();
  const ctx: CardCtx = { meta, cons: aodCons, refIso, base };

  // product header inside the panel
  const product: OffersProduct = { asin: null, title: null };
  let pinned: Offer | null = null;
  const offers: Offer[] = [];
  const data: OffersData = {
    product,
    pinned_offer: null,
    offers,
    no_offers: true,
    no_featured_offer: false,
    filters: [],
    pagination: {
      loaded: 0,
      has_more: false,
      page_size: AOD_PAGE_SIZE,
      url_template: AOD_NEXT_PAGE_TEMPLATE,
    },
    purchase_types: page.purchase_types,
    coupons: page.coupons,
    promotions: page.promotions,
    buybox: page.buybox,
  };
  if (page.typical_price !== undefined) data.typical_price = page.typical_price;
  if (page.list_price !== undefined) data.list_price = page.list_price;
  if (page.featured_price !== undefined) data.featured_price = page.featured_price;

  if (aodRoot !== undefined) {
    const titleEl = q(aodRoot, "#aod-asin-title-text");
    product.title =
      firstOf(
        "product.title",
        [
          ["id", () => text(titleEl)],
          ["label", () => page.title],
        ],
        meta,
        { optional: true },
      ) ?? null;
    const stars = q(aodRoot, "#aod-asin-reviews-star");
    const rating =
      ratingFromClass(stars?.getAttribute("class")) ??
      parseRating(text(q(stars, ".a-icon-alt")))?.value;
    if (rating !== undefined) product.rating = rating;
    const rc = parseCount(text(q(aodRoot, "#aod-asin-reviews-count-title")));
    if (rc !== undefined) product.rating_count = rc;
    const img = attr(q(aodRoot, "#aod-asin-image-id"), "src");
    if (img !== undefined && img !== "") product.image_url = img;
    aodCons.takeAll([q(aodRoot, "#aod-asin-block-asin"), q(aodRoot, "#pinned-image-id")]);

    // pinned offer
    const pinnedEl = q(aodRoot, "#aod-pinned-offer");
    if (pinnedEl !== undefined) {
      const hasOffer =
        rq(pinnedEl, "form.AodAddToCart, [data-aod-atc-action]") !== undefined ||
        q(pinnedEl, "#aod-offer-heading") !== undefined ||
        q(pinnedEl, "[id^=aod-price-]") !== undefined;
      if (hasOffer) {
        const details = q(pinnedEl, "#aod-pinned-offer-additional-content") ?? pinnedEl;
        pinned = parseOfferCard(
          pinnedEl,
          details,
          { pinned: true, collapsed: false, position: 0 },
          ctx,
        );
        meta.strategies["pinned_offer"] = "id";
      } else {
        const msg = text(pinnedEl, {
          exclude: (e) => e.matches("#aod-asin-block-asin, #pinned-image-id"),
        });
        if (msg !== "")
          meta.warnings.push("pinned offer: panel shows a message instead of an offer");
      }
      aodCons.takeAll(
        qa(
          pinnedEl,
          "#aod-pinned-offer-main-content-show-more, #aod-pinned-offer-main-content-show-less",
        ),
      );
    }

    // offer list (visible cards plus the collapsed "more options" part, in order)
    const list = q(aodRoot, "#aod-offer-list") ?? aodRoot;
    let position = 1;
    for (const card of qa(list, "div[id=aod-offer]")) {
      if (card.closest("#aod-pinned-offer, #aod-sticky-pinned-container") !== null) continue;
      if (atcJsonOf(card)?.isStickyPinnedOffer === true) continue;
      const collapsed =
        card.closest("#aod-retail-other-offers-content, .aod-oas-other-offers-hide") !== null;
      offers.push(parseOfferCard(card, card, { pinned: false, collapsed, position }, ctx));
      position++;
    }
    aodCons.takeAll(qa(list, "hr.aod-offer-block-divider"));
    meta.strategies["offers"] = "id";

    // counts and the no-offers message
    const totalEl = rq(aodRoot, "#aod-total-offer-count");
    const totalStr = attr(rq(aodRoot, "#aod-total-offer-count-string"), "value");
    const total = firstOf<number>(
      "total_offer_count",
      [
        ["id", () => parseCount(attr(totalEl, "value"))],
        ["label", () => parseCount(totalStr)],
        ["text-anchor", () => parseCount(text(q(aodRoot, "#aod-filter-offer-count-string")))],
      ],
      meta,
      { optional: true },
    );
    if (total !== undefined) data.total_offer_count = total;
    if (totalStr !== undefined && totalStr !== "") {
      data.total_offer_count_text = totalStr;
      if (/no other sellers|no offers|no featured offers/i.test(totalStr))
        data.no_offers_text = totalStr;
    }
    const heading = text(q(aodRoot, "#aod-filter-offer-count-string"));
    if (heading !== "") data.heading = heading;
    const sort = text(q(aodRoot, "#aod-sort-details-string"));
    if (sort !== "") data.sort_text = sort;
    aodCons.takeAll([q(aodRoot, "#aod-message-component"), q(aodRoot, "#aod-filter-component")]);

    data.filters = parseFilters(aodRoot);
    for (const f of data.filters) {
      const all = pinned === null ? offers : [pinned, ...offers];
      const matches = all.map((o) => filterMatches(f, o));
      if (matches.every((m) => m !== undefined))
        f.loaded_match_count = matches.filter(Boolean).length;
    }
    aodCons.take(q(aodRoot, "#aod-filter-list"));

    const endText = text(q(aodRoot, "#aod-retail-end-of-results"));
    aodCons.takeAll([q(aodRoot, "#aod-retail-footer")]);
    const loaded = offers.length;
    const pag = data.pagination;
    pag.loaded = loaded;
    if (total !== undefined) pag.total = total;
    pag.has_more =
      total !== undefined
        ? total > loaded
        : q(aodRoot, "#aod-retail-show-more-offers") !== undefined && endText === "";
    // The fragment in hand is page 1 (it may hold fewer than a page of offers).
    if (pag.has_more) pag.next_page = Math.max(2, Math.ceil(loaded / AOD_PAGE_SIZE) + 1);
    meta.strategies["pagination"] = total !== undefined ? "id" : "label";
  }

  if (pinned === null && page.fallback_offer !== undefined && aodRoot === undefined) {
    pinned = page.fallback_offer;
  }
  if (product.title === null && page.title !== undefined) product.title = page.title;
  product.asin = pinned?.internal.asin ?? offers[0]?.internal.asin ?? page.asin ?? null;
  // Product-page availability belongs to the featured offer.
  if (
    pinned !== null &&
    pinned.stock_text === undefined &&
    page.buybox.availability_text !== undefined
  ) {
    pinned.stock_text = page.buybox.availability_text;
    const n = stockCountOf(pinned.stock_text);
    if (n !== undefined) pinned.stock_count = n;
  }
  if (
    pinned !== null &&
    pinned.typical_price === undefined &&
    page.typical_price !== undefined &&
    pinned.basis_price === undefined
  ) {
    pinned.typical_price = page.typical_price;
  }
  data.pinned_offer = pinned;
  data.no_offers = pinned === null && offers.length === 0;
  data.no_featured_offer =
    pinned === null || pinned.price === null || page.buybox.state === "no_featured_offer";

  for (const o of pinned === null ? offers : [pinned, ...offers]) {
    o.out_of_stock = isOfferOutOfStock(o);
    o.flags = computeStaticOfferFlags(o, staticContext(data, o));
  }

  // lossless: the panel (primary) and the buy box the page-level fields came from
  const sections: OtherSection[] = [];
  let unparsed = 0;
  let consumedOrEmitted = 0;
  if (aodRoot !== undefined && aodDoc !== undefined) {
    const r = losslessReport(aodDoc, aodCons, { root: aodRoot, base });
    sections.push(...prefixSections(r.sections, "aod:"));
    unparsed += r.counts.unparsed;
    consumedOrEmitted += r.counts.consumed + r.counts.emitted;
  }
  const buyboxRoot = q(doc, "#desktop_buybox") ?? q(doc, "#buybox");
  if (buyboxRoot !== undefined) {
    const r = losslessReport(doc, pageCons, { root: buyboxRoot, base });
    sections.push(...prefixSections(r.sections, "buybox:"));
    unparsed += r.counts.unparsed;
    consumedOrEmitted += r.counts.consumed + r.counts.emitted;
  }
  meta.unparsed_text_chars = unparsed;

  if (
    aodRoot === undefined &&
    buyboxRoot === undefined &&
    pinned === null &&
    page.purchase_types.length === 0
  ) {
    throw new RfError(
      "layout_unrecognized",
      "offers: neither an all-offers panel nor a buy box was found",
    );
  }
  if (consumedOrEmitted === 0 && pinned === null && offers.length === 0) {
    meta.warnings.push("offers: nothing parseable in the panel or the buy box");
  }
  return { data, other_sections: sections, meta };
};
