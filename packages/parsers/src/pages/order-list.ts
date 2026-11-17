/**
 * Parser for the "Your Orders" list (`/your-orders/orders`), page kind `order_list`.
 *
 * Layout (desktop, current): a main section holds breadcrumbs, the page heading, an order
 * search form, filter tabs, a count + time-filter form, one `.order-card` per order and a
 * pagination bar. A card has a header (`.order-header`: placed, total, ship to, order id,
 * order-level links) and one `.delivery-box` per shipment (status, items, shipment actions).
 * Items come in two flavors: `.item-box` rows and `.yo-enhanced-card` carousel cards (used
 * when a shipment holds several items).
 *
 * Privacy of the DATA: the ship-to name is returned (it belongs in the result); the hidden
 * address popover preload is never read. Actions are returned as plain labels; a URL path
 * is attached only for an allowlist of read-only destinations (order details, invoice,
 * tracking, product pages). Everything else, including anything that mutates, is label only.
 */
import { RfError } from "@rainforest/core";
import type { Capture, OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  type DomRoot,
  type Money,
  attr,
  collapse,
  hiddenSelf,
  parseCount,
  parseDocument,
  parseMoney,
  q,
  qa,
  text,
  visible,
} from "../dom.ts";
import { Consumption, DEFAULT_BLOCK_SELECTOR, losslessReport } from "../lossless.ts";
import type { LosslessOptions } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";

// ---- public types

export interface DateText {
  raw: string;
  /** YYYY-MM-DD when the text names a real calendar date. */
  iso?: string;
  /** End of a range ("December 1 - December 3"). */
  iso_end?: string;
  /** True when the page showed no year and it was resolved against the order's placed date. */
  year_inferred?: boolean;
}

export interface ActionLink {
  label: string;
  /** Stable machine key from the page (`track_package`, `return_replace`, ...), when present. */
  key?: string;
  /** Relative path, only for read-only destinations (see READ_ONLY_PATHS). */
  path?: string;
  /** True when the page hides the action behind "More options". */
  collapsed?: boolean;
}

export type StatusKind =
  | "delivered"
  | "out_for_delivery"
  | "arriving"
  | "shipped"
  | "preparing"
  | "refunded"
  | "return"
  | "cancelled"
  | "other"
  | "none";

export interface ItemNotice {
  text: string;
  kind: "subscription" | "other";
  date?: DateText;
}

export interface ReturnWindow {
  text: string;
  state: "closed" | "open";
  date?: DateText;
}

export interface OrderItem {
  asin: string | null;
  title: string;
  /** Relative product path without tracking parameters. */
  url_path?: string;
  image_url?: string;
  /** From the quantity badge on the image, shown only when above 1. */
  quantity?: number;
  /** Secondary line under the title (variant, seller) when the page shows one. */
  details?: string;
  return_window?: ReturnWindow;
  notices: ItemNotice[];
  /** Item-level buttons, labels only ("Buy it again"). */
  actions: ActionLink[];
}

export interface Shipment {
  status_primary?: string;
  status_secondary?: string;
  /** Other visible text in the status area (for example a "When will I get my refund?" link). */
  status_extra: string[];
  status_kind: StatusKind;
  status_date?: DateText;
  /** Status text when it is about a return or refund. */
  return_or_refund?: string;
  items: OrderItem[];
  /** Collapsed-list marker such as "and 3 more items", when the page shows one. */
  more_items?: { text: string; count?: number };
  actions: ActionLink[];
  /** Read-only tracking page path, from the "Track package" action. */
  tracking_path?: string;
}

export interface HeaderField {
  label: string;
  value: string;
}

export interface OrderCard {
  index: number;
  order_id: string | null;
  order_type: "physical" | "digital" | "other";
  placed?: DateText;
  total?: Money;
  /** Name only, as shown on the card. Private data: belongs in the result, never in the repo. */
  ship_to?: string;
  /** Header label/value pairs this parser has no typed field for. */
  header_fields: HeaderField[];
  order_details_path?: string;
  invoice_path?: string;
  /** One line per shipment status ("Delivered November 9 - Your package was ..."). */
  status_lines: string[];
  shipments: Shipment[];
  /** Order-level links and buttons, labels (plus read-only paths). */
  actions: ActionLink[];
  /** True when every shipment status (or the header) says cancelled. */
  is_cancelled: boolean;
  /** True when at least one shipment status says cancelled. */
  has_cancelled_shipment: boolean;
  /** Only set when the card itself says "archived"; the page has no other archived marker. */
  is_archived?: boolean;
  return_or_refund?: string;
  item_count: number;
}

export interface TimeFilterOption {
  label: string;
  /** Value for the `timeFilter` query parameter (`last30`, `months-3`, `year-2026`). */
  value: string;
  selected: boolean;
  ref?: string;
}

export interface TimeFilter {
  options: TimeFilterOption[];
  selected_value?: string;
  selected_label?: string;
}

export interface FilterTab {
  label: string;
  kind:
    | "orders"
    | "buy_again"
    | "not_yet_shipped"
    | "digital"
    | "cancelled"
    | "archived"
    | "amazon_pay"
    | "other";
  selected: boolean;
  /** Relative path (absolute URL when the tab leaves the main site); absent on the selected tab. */
  path?: string;
  external?: boolean;
  /** Value of the `orderFilter` query parameter the tab link carries. */
  filter_value?: string;
}

export interface PaginationPage {
  label: string;
  current: boolean;
  path?: string;
  /** Value of the index parameter in this page's link. */
  index?: number;
}

export interface Pagination {
  current_label?: string;
  current_index?: number;
  pages: PaginationPage[];
  has_prev: boolean;
  has_next: boolean;
  prev_path?: string;
  next_path?: string;
  /** True when the bar shows an ellipsis between page numbers. */
  has_gap: boolean;
  last_label?: string;
  /** Query parameter that carries the position (`page`). */
  index_param?: string;
  /** Parameter value of the first page (0 means zero-based). */
  index_base?: number;
  /** Parameter increase per page. */
  index_step?: number;
}

export interface RequestedFilters {
  time_filter: string | null;
  order_filter: string | null;
  page: number | null;
  /** Whether the page reflects the requested `timeFilter` (null: none requested). */
  time_filter_applied: boolean | null;
  /** Whether a tab for the requested `orderFilter` is selected (null: none requested). */
  order_filter_applied: boolean | null;
}

export interface SearchForm {
  action_path: string;
  method: string;
  query_param?: string;
  hidden: Record<string, string>;
}

export interface OrderListPage {
  heading?: string;
  breadcrumbs: string[];
  requested: RequestedFilters;
  /** "199 orders placed in" (the period itself is the selected time filter). */
  order_count_text?: string;
  order_count?: number;
  time_filter?: TimeFilter;
  tabs: FilterTab[];
  selected_tab?: FilterTab["kind"];
  pagination?: Pagination;
  orders: OrderCard[];
  /** Message shown when the list is empty. */
  empty_text?: string;
  search?: SearchForm;
  /** Other read-only page links (for example "View transactions"). */
  links: { label: string; path: string }[];
}

// ---- lossless configuration

/** Block selector for the lossless pass: feature blocks of this page plus generic AUI boxes. */
export const ORDER_LIST_BLOCK_SELECTOR = `${DEFAULT_BLOCK_SELECTOR}, .order-card, .order-header, .delivery-box, .item-box, .yo-enhanced-card, .page-tabs, .a-section, .a-box, .a-row, .a-alert`;

const ROOT_SELECTORS: readonly string[] = [
  "section.your-orders-content-container",
  ".js-yo-main-content",
  ".your-orders-content-container",
  "#a-page",
];

function mainRoot(doc: DomDocument): DomElement {
  for (const sel of ROOT_SELECTORS) {
    const el = q(doc, sel);
    if (el !== undefined) return el;
  }
  return doc.body;
}

/** Lossless options for a document (main content root and block selector). Tests reuse it. */
export function orderListLosslessOptions(doc: DomDocument): LosslessOptions {
  return { root: mainRoot(doc), blockSelector: ORDER_LIST_BLOCK_SELECTOR };
}

// ---- links

const SITE = "https://www.amazon.com";
const STRIP_PARAMS = /^(?:ref|ref_|_encoding|pd_rd_[a-z]+|pf_rd_[a-z]+)$/;

/** Destinations that only read. Anything else is returned without a path. Fail closed. */
export const READ_ONLY_PATHS: readonly RegExp[] = [
  /^\/your-orders\/order-details(?:[/?]|$)/,
  /^\/gp\/css\/order-details(?:[/?]|$)/,
  /^\/gp\/your-account\/order-details(?:[/?]|$)/,
  /^\/gp\/css\/summary\/print\.html(?:[/?]|$)/,
  /^\/progress-tracker\//,
  /^\/gp\/your-account\/ship-track(?:[/?]|$)/,
  /^\/gp\/css\/shiptrack(?:[/?]|$)/,
  /^\/dp\//,
  /^\/gp\/product\//,
];

export function isReadOnlyPath(path: string): boolean {
  return READ_ONLY_PATHS.some((re) => re.test(path));
}

interface CleanLink {
  path: string;
  external: boolean;
}

/** Relative path + query without tracking parameters; absolute URL for other hosts. */
export function cleanLink(href: string | null | undefined): CleanLink | undefined {
  if (href == null) return undefined;
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw, SITE);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  for (const key of Array.from(url.searchParams.keys())) {
    if (STRIP_PARAMS.test(key)) url.searchParams.delete(key);
  }
  const pathname = url.pathname.replace(/\/ref=[^/?]*$/, "");
  const rest = `${pathname}${url.search}`;
  const external = url.host !== "www.amazon.com";
  return { path: external ? `${url.origin}${rest}` : rest, external };
}

function readOnlyPath(href: string | null | undefined): string | undefined {
  const link = cleanLink(href);
  if (link === undefined || link.external) return undefined;
  return isReadOnlyPath(link.path) ? link.path : undefined;
}

// ---- dates

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_PART =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RE = new RegExp(
  `\\b${MONTH_PART}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?` +
    `(?:\\s*(?:-|\\u2013|\\u2014|to)\\s*(?:${MONTH_PART}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?)?`,
  "i",
);

function monthNumber(name: string): number {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? 0;
}

function isoOf(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return d.toISOString().slice(0, 10);
}

function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

/**
 * First date in a string. Without a year the order's placed date supplies it (next year when
 * the date would fall more than a month before the placed date); with no placed date the
 * ISO form is left out. Relative words ("today", "Monday") are not dates here.
 */
export function parseDateText(
  s: string | null | undefined,
  placedIso?: string,
): DateText | undefined {
  if (s == null) return undefined;
  const m = DATE_RE.exec(s);
  if (m === null) return undefined;
  const month = monthNumber(m[1] as string);
  const day = Number(m[2]);
  const out: DateText = { raw: collapse(m[0]) };
  let year: number | undefined = m[3] === undefined ? undefined : Number(m[3]);
  let inferred = false;
  if (year === undefined && placedIso !== undefined) {
    const placedYear = Number(placedIso.slice(0, 4));
    const base = isoOf(placedYear, month, day);
    year = placedYear;
    if (base !== undefined && dayNumber(placedIso) - dayNumber(base) > 31) year = placedYear + 1;
    inferred = true;
  }
  if (year === undefined) return out;
  const iso = isoOf(year, month, day);
  if (iso === undefined) return out;
  out.iso = iso;
  if (inferred) out.year_inferred = true;
  if (m[5] !== undefined) {
    const endMonth = m[4] === undefined ? month : monthNumber(m[4]);
    let endYear = m[6] === undefined ? year : Number(m[6]);
    let end = isoOf(endYear, endMonth, Number(m[5]));
    if (end !== undefined && end < iso && m[6] === undefined) {
      endYear += 1;
      end = isoOf(endYear, endMonth, Number(m[5]));
    }
    if (end !== undefined) out.iso_end = end;
  }
  return out;
}

// ---- small helpers

const ORDER_ID_RE = /\b([A-Z0-9]{3}-\d{7}-\d{7})\b/;

function ownText(el: DomElement): string {
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) parts.push(n.textContent ?? "");
  }
  return collapse(parts.join(" "));
}

function classOf(el: DomElement): string {
  return el.getAttribute("class") ?? "";
}

function childElements(el: DomElement): DomElement[] {
  return Array.from(el.children);
}

/** True when the element is not itself visible only because of its own hidden marker. */
function hiddenOnlyBySelf(el: DomElement): boolean {
  return hiddenSelf(el) && (el.parentElement === null || visible(el.parentElement));
}

function intFrom(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /\d+/.exec(s);
  return m === null ? undefined : Number(m[0]);
}

/** Merge per-card strategy names into page meta; mixed strategies are listed together. */
class StrategyLog {
  readonly #seen = new Map<string, Set<string>>();

  add(card: ParseMeta, index: number, meta: ParseMeta): void {
    for (const [field, name] of Object.entries(card.strategies)) {
      let set = this.#seen.get(field);
      if (set === undefined) {
        set = new Set();
        this.#seen.set(field, set);
      }
      set.add(name);
    }
    for (const w of card.warnings) meta.warnings.push(`orders[${index}]: ${w}`);
  }

  into(meta: ParseMeta): void {
    for (const [field, set] of this.#seen) {
      const names = [...set].sort();
      meta.strategies[`order.${field}`] =
        names.length === 1 ? (names[0] as string) : names.join("+");
    }
  }
}

// ---- status

interface StatusInfo {
  kind: StatusKind;
  return_or_refund?: string;
}

function classifyStatus(primary: string, secondary: string): StatusKind {
  const probe = primary !== "" ? primary : secondary;
  if (probe === "") return "none";
  if (/cancel/i.test(probe)) return "cancelled";
  if (/refund/i.test(probe)) return "refunded";
  if (/\breturn|replacement/i.test(probe)) return "return";
  if (/out for delivery/i.test(probe)) return "out_for_delivery";
  if (/deliver(?:ed|y attempted)/i.test(probe)) return "delivered";
  if (/^(?:now )?arriving|^expected|estimated delivery/i.test(probe)) return "arriving";
  if (/^shipped|on (?:its|the) way|in transit/i.test(probe)) return "shipped";
  if (/prepar|not yet shipped|processing|pending|preorder/i.test(probe)) return "preparing";
  return "other";
}

function statusInfo(primary: string, secondary: string, extra: string[]): StatusInfo {
  const kind = classifyStatus(primary, secondary);
  const all = [primary, secondary, ...extra].filter((s) => s !== "").join(" - ");
  const aboutReturn = kind === "refunded" || kind === "return" || /refund|\breturn/i.test(all);
  return aboutReturn && all !== "" ? { kind, return_or_refund: all } : { kind };
}

// ---- item parsing

const ASIN_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing)\/([A-Z0-9]{10})(?:[/?]|$)/;

function asinFromHref(href: string | null | undefined): string | undefined {
  if (href == null) return undefined;
  const m = ASIN_PATH_RE.exec(href);
  return m === null ? undefined : m[1];
}

function parseActionList(root: DomElement, consumed: Consumption): ActionLink[] {
  const out: ActionLink[] = [];
  const anchors = qa(root, "a.a-button-text, a[role=button], button");
  const seen = new Set<DomElement>();
  for (const a of anchors) {
    if (seen.has(a)) continue;
    seen.add(a);
    const label = text(a);
    if (label === "") continue;
    const action: ActionLink = { label };
    const path = readOnlyPath(attr(a, "href"));
    if (path !== undefined) action.path = path;
    out.push(action);
  }
  consumed.take(root);
  return out;
}

function classifyNotice(
  row: string,
  placedIso: string | undefined,
): { kind: "closed" | "open" | "subscription" | "other"; date?: DateText } {
  const date = parseDateText(row, placedIso);
  if (/return window (?:closed|ended|expired)/i.test(row)) {
    return date === undefined ? { kind: "closed" } : { kind: "closed", date };
  }
  if (/eligible (?:through|until|for return)|return(?:able)? (?:through|until|by)/i.test(row)) {
    return date === undefined ? { kind: "open" } : { kind: "open", date };
  }
  if (/auto-delivered|subscribe|every \d+ (?:week|month|day)/i.test(row)) {
    return date === undefined ? { kind: "subscription" } : { kind: "subscription", date };
  }
  return date === undefined ? { kind: "other" } : { kind: "other", date };
}

function hasNestedRow(row: DomElement): boolean {
  return row.querySelector(".a-row") !== null;
}

/** True when `inner` is `outer` or sits inside it. */
function within(inner: DomElement, outer: DomElement): boolean {
  for (let cur: DomElement | null = inner; cur != null; cur = cur.parentElement) {
    if (cur === outer) return true;
  }
  return false;
}

function parseItem(
  el: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
  placedIso: string | undefined,
): OrderItem {
  const titleEl = firstOf<DomElement>(
    "item.title_element",
    [
      ["product-title", () => q(el, ".yohtmlc-product-title")],
      ["enhanced-title", () => q(el, ".yo-enhanced-title")],
      [
        "dp-link",
        () => qa(el, "a[href*='/dp/'], a[href*='/gp/product/']").find((a) => text(a) !== ""),
      ],
    ],
    meta,
    { optional: true },
  );
  const titleLink = titleEl === undefined ? undefined : (q(titleEl, "a[href]") ?? titleEl);
  const imageEl = q(el, "img");
  const title =
    firstOf<string>(
      "item.title",
      [
        ["title-link", () => (titleLink === undefined ? undefined : text(titleLink))],
        ["title-element", () => (titleEl === undefined ? undefined : text(titleEl))],
        ["image-alt", () => attr(imageEl, "alt")],
      ],
      meta,
    ) ?? "";
  const hrefs = [
    attr(titleLink, "href"),
    attr(q(el, "a[href*='/dp/'], a[href*='/gp/product/']"), "href"),
  ];
  const href = hrefs.find((h) => h !== undefined && asinFromHref(h) !== undefined) ?? hrefs[0];
  const asin =
    firstOf<string>(
      "item.asin",
      [
        ["url", () => hrefs.map(asinFromHref).find((a) => a !== undefined)],
        ["data-attr", () => attr(el, "data-asin") ?? attr(q(el, "[data-asin]"), "data-asin")],
      ],
      meta,
    ) ?? null;
  const item: OrderItem = {
    asin,
    title,
    notices: [],
    actions: [],
  };
  const cleaned = cleanLink(href);
  if (cleaned !== undefined && !cleaned.external) item.url_path = cleaned.path;
  const src = attr(imageEl, "src");
  if (src !== undefined && /^https?:\/\//i.test(src)) item.image_url = src;

  const qtyEl = q(el, ".product-image__qty");
  const quantity = intFrom(text(qtyEl));
  if (quantity !== undefined) item.quantity = quantity;

  consumed.take(titleEl);
  consumed.take(q(el, ".product-image, .yo-enhanced-card-image"));
  consumed.take(qtyEl);
  const actionsEl = q(el, ".yohtmlc-item-level-connections");
  if (actionsEl !== undefined) item.actions = parseActionList(actionsEl, consumed);

  // Leaf rows that are neither the title nor the buttons: details line and notices.
  const details: string[] = [];
  for (const row of qa(el, ".a-row")) {
    if (hasNestedRow(row)) continue;
    if (titleEl !== undefined && (within(titleEl, row) || within(row, titleEl))) continue;
    if (consumed.covers(row)) continue;
    if (actionsEl !== undefined && (within(actionsEl, row) || within(row, actionsEl))) continue;
    const t = text(row);
    if (t === "") {
      consumed.take(row);
      continue;
    }
    const c = classifyNotice(t, placedIso);
    if (c.kind === "closed" || c.kind === "open") {
      if (item.return_window === undefined) {
        item.return_window = { text: t, state: c.kind };
        if (c.date !== undefined) item.return_window.date = c.date;
        consumed.take(row);
        continue;
      }
    }
    if (c.kind === "other" && /\ba-color-secondary\b/.test(classOf(row))) {
      details.push(t);
    } else {
      const notice: ItemNotice = {
        text: t,
        kind: c.kind === "subscription" ? "subscription" : "other",
      };
      if (c.date !== undefined) notice.date = c.date;
      item.notices.push(notice);
    }
    consumed.take(row);
  }
  if (details.length > 0) item.details = details.join(" | ");
  return item;
}

// ---- shipment parsing

function actionKey(li: DomElement): string | undefined {
  const id = attr(li, "data-csa-c-item-id");
  if (id === undefined || id === "") return undefined;
  const m = /_fed_(.+)$/.exec(id);
  return m === null ? id : m[1];
}

function parseShipmentActions(
  box: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
): { actions: ActionLink[]; tracking_path?: string } {
  const actions: ActionLink[] = [];
  const list = q(box, ".yo-collapsible-actions__list");
  if (list !== undefined && list.querySelector("li") !== null) {
    meta.strategies["shipment.actions"] = "collapsible-list";
    for (const li of Array.from(list.querySelectorAll("li"))) {
      if (li.closest("ul") !== list) continue;
      const collapsed = hiddenOnlyBySelf(li);
      if (!visible(li) && !collapsed) continue;
      const anchor = li.querySelector("a[href]");
      const label = collapse((anchor !== null ? anchor.textContent : li.textContent) ?? "");
      if (label === "") continue;
      const action: ActionLink = { label };
      const key = actionKey(li);
      if (key !== undefined) action.key = key;
      const path = readOnlyPath(anchor?.getAttribute("href"));
      if (path !== undefined) action.path = path;
      if (collapsed) action.collapsed = true;
      actions.push(action);
      if (!collapsed) consumed.take(li);
    }
    consumed.take(q(box, ".yo-collapsible-actions__toggle"));
  } else {
    const right = q(box, ".a-fixed-right-grid-col.a-col-right");
    if (right !== undefined) {
      meta.strategies["shipment.actions"] = "right-column";
      actions.push(...parseActionList(right, consumed));
    }
  }
  const out: { actions: ActionLink[]; tracking_path?: string } = { actions };
  const track = actions.find(
    (a) => (a.key ?? "").includes("track") || /track package/i.test(a.label),
  );
  if (track?.path !== undefined) out.tracking_path = track.path;
  return out;
}

const MORE_ITEMS_RE = /\b(?:and|\+)\s*(\d+)\s+more(?:\s+items?)?\b|\b(\d+)\s+more\s+items?\b/i;

function findMoreItems(
  box: DomElement,
  itemEls: DomElement[],
  consumed: Consumption,
): { text: string; count?: number } | undefined {
  const list = q(box, "ul.a-unordered-list") ?? box;
  for (const el of qa(list, "*")) {
    if (itemEls.some((i) => within(el, i))) continue;
    if (consumed.covers(el)) continue;
    const own = ownText(el);
    const m = MORE_ITEMS_RE.exec(own);
    if (m === null) continue;
    consumed.take(el);
    const count = Number(m[1] ?? m[2]);
    return Number.isFinite(count) ? { text: own, count } : { text: own };
  }
  return undefined;
}

function parseShipment(
  box: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
  placedIso: string | undefined,
): Shipment {
  const primaryEl = q(box, ".yohtmlc-shipment-status-primaryText");
  const secondaryEl = q(box, ".yohtmlc-shipment-status-secondaryText");
  const primary = text(primaryEl);
  const secondary = text(secondaryEl);

  // Everything else in the status rows of the left column (help links, notes).
  const extra: string[] = [];
  const left = q(box, ".a-fixed-right-grid-col.a-col-left") ?? box;
  for (const row of childElements(left)) {
    if (!visible(row) || !classOf(row).split(/\s+/).includes("a-row")) continue;
    if (row.querySelector(".item-box, .yo-enhanced-card, .a-carousel") !== null) continue;
    const rest = text(row, { exclude: (e) => e === primaryEl || e === secondaryEl });
    if (rest !== "") extra.push(rest);
    consumed.take(row);
  }
  consumed.take(primaryEl);
  consumed.take(secondaryEl);

  const itemEls = firstOf<DomElement[]>(
    "shipment.items",
    [
      ["item-box", () => qa(box, ".item-box, .yo-enhanced-card")],
      ["product-title", () => qa(box, ".yohtmlc-product-title").map((t) => t.parentElement ?? t)],
      [
        "dp-link",
        () =>
          qa(box, "a[href*='/dp/']")
            .filter((a) => text(a) !== "")
            .map((a) => a),
      ],
    ],
    meta,
    { optional: true },
  );
  const items = (itemEls ?? []).map((el) => parseItem(el, consumed, meta, placedIso));

  const shipment: Shipment = {
    status_extra: extra,
    status_kind: "none",
    items,
    actions: [],
  };
  const info = statusInfo(primary, secondary, extra);
  shipment.status_kind = info.kind;
  if (primary !== "") shipment.status_primary = primary;
  if (secondary !== "") shipment.status_secondary = secondary;
  const date = parseDateText(primary, placedIso) ?? parseDateText(secondary, placedIso);
  if (date !== undefined && info.kind !== "none") shipment.status_date = date;
  if (info.return_or_refund !== undefined) shipment.return_or_refund = info.return_or_refund;

  const more = findMoreItems(box, itemEls ?? [], consumed);
  if (more !== undefined) shipment.more_items = more;

  const acts = parseShipmentActions(box, consumed, meta);
  shipment.actions = acts.actions;
  if (acts.tracking_path !== undefined) shipment.tracking_path = acts.tracking_path;
  return shipment;
}

// ---- order card parsing

function slotOrderId(card: DomElement): string | undefined {
  const slot = attr(card, "data-csa-c-slot-id");
  if (slot === undefined) return undefined;
  const m = /\.order-card\.(.+)$/.exec(slot);
  return m === null ? undefined : m[1];
}

function headerKey(label: string): "placed" | "total" | "ship_to" | "order_id" | undefined {
  const l = label.toLowerCase().replace(/[:#]/g, "").trim();
  if (/^(?:order placed|ordered on|placed on|order date)$/.test(l)) return "placed";
  if (/^(?:total|order total|grand total)$/.test(l)) return "total";
  if (/^(?:ship to|ships to|deliver to|sent to|gift to)$/.test(l)) return "ship_to";
  if (/^order(?: number| id)?$/.test(l)) return "order_id";
  return undefined;
}

function parseCard(
  card: DomElement,
  index: number,
  consumed: Consumption,
  meta: ParseMeta,
  pageKind: string,
): OrderCard {
  const header = firstOf<DomElement>(
    "header",
    [
      ["order-header", () => q(card, ".order-header")],
      ["offset-box", () => q(card, ".a-box.a-color-offset-background")],
    ],
    meta,
    { optional: true },
  );

  // Header fields by label; unknown labels are kept as-is.
  const fields = new Map<string, string>();
  const headerFields: HeaderField[] = [];
  const headerActions: ActionLink[] = [];
  let orderDetailsPath: string | undefined;
  let invoicePath: string | undefined;
  const headerItems = header === undefined ? [] : qa(header, ".order-header__header-list-item");
  for (const item of headerItems) {
    const labelEl = q(item, ".a-text-caps");
    const label = text(labelEl);
    const real = qa(item, "a[href]").filter((a) => cleanLink(attr(a, "href")) !== undefined);
    if (label === "" && real.length > 0) {
      for (const a of real) {
        const action: ActionLink = { label: text(a) };
        const path = readOnlyPath(attr(a, "href"));
        if (path !== undefined) {
          action.path = path;
          if (/order-details/.test(path) && orderDetailsPath === undefined) orderDetailsPath = path;
          if (/print\.html/.test(path) && invoicePath === undefined) invoicePath = path;
        }
        if (action.label !== "") headerActions.push(action);
      }
      consumed.take(item);
      continue;
    }
    const value = text(item, { exclude: (e) => e === labelEl });
    const key = headerKey(label);
    if (key !== undefined && !fields.has(key)) fields.set(key, value);
    else if (label !== "" || value !== "") headerFields.push({ label, value });
    consumed.take(item);
  }

  // Order id.
  const detailsHref = qa(card, "a[href*='order-details'], a[href*='orderID=']")
    .map((a) => attr(a, "href"))
    .find((h) => h !== undefined);
  const orderId =
    firstOf<string>(
      "order_id",
      [
        ["id-element", () => ORDER_ID_RE.exec(text(q(card, ".yohtmlc-order-id")))?.[1]],
        ["slot-id", () => ORDER_ID_RE.exec(slotOrderId(card) ?? "")?.[1]],
        [
          "details-link",
          () => {
            if (detailsHref === undefined) return undefined;
            return ORDER_ID_RE.exec(
              new URL(detailsHref, SITE).searchParams.get("orderID") ?? "",
            )?.[1];
          },
        ],
        ["header-text", () => ORDER_ID_RE.exec(fields.get("order_id") ?? "")?.[1]],
      ],
      meta,
    ) ?? null;
  if (orderDetailsPath === undefined) orderDetailsPath = readOnlyPath(detailsHref);

  const placedRaw = firstOf<string>(
    "placed",
    [
      ["label", () => fields.get("placed")],
      ["header-date", () => parseDateText(text(header))?.raw],
    ],
    meta,
  );
  const placed = parseDateText(placedRaw);
  const placedIso = placed?.iso;
  const total = firstOf<Money>(
    "total",
    [
      ["label", () => parseMoney(fields.get("total"))],
      ["header-money", () => parseMoney(text(header))],
    ],
    meta,
    { optional: true },
  );

  const card_: OrderCard = {
    index,
    order_id: orderId,
    order_type: "other",
    header_fields: headerFields,
    status_lines: [],
    shipments: [],
    actions: headerActions,
    is_cancelled: false,
    has_cancelled_shipment: false,
    item_count: 0,
  };
  if (placed !== undefined) card_.placed = placed;
  if (total !== undefined) card_.total = total;
  const shipTo = fields.get("ship_to");
  if (shipTo !== undefined && shipTo !== "") card_.ship_to = shipTo;
  if (orderDetailsPath !== undefined) card_.order_details_path = orderDetailsPath;
  if (invoicePath !== undefined) card_.invoice_path = invoicePath;

  // Ask-about-order pill (a button, not data).
  const pill = q(card, ".yo-ask-order-pill");
  if (pill !== undefined) {
    const label = text(pill);
    if (label !== "") card_.actions.push({ label });
    consumed.take(pill);
  }

  // Shipments.
  const boxes = firstOf<DomElement[]>(
    "shipments",
    [
      ["delivery-box", () => qa(card, ".delivery-box")],
      [
        "item-containers",
        () => {
          const els = qa(card, ".item-box, .yo-enhanced-card");
          return els.length > 0 ? [card] : [];
        },
      ],
    ],
    meta,
    { optional: true },
  );
  for (const box of boxes ?? []) {
    card_.shipments.push(parseShipment(box, consumed, meta, placedIso));
  }

  card_.item_count = card_.shipments.reduce((n, s) => n + s.items.length, 0);
  for (const s of card_.shipments) {
    const line = [s.status_primary, s.status_secondary].filter((x) => x !== undefined).join(" - ");
    if (line !== "") card_.status_lines.push(line);
  }
  const cancelledShipments = card_.shipments.filter((s) => s.status_kind === "cancelled").length;
  const headerText = [...fields.values(), ...headerFields.map((f) => `${f.label} ${f.value}`)].join(
    " ",
  );
  const headerCancelled = /\bcancel/i.test(headerText);
  card_.has_cancelled_shipment = cancelledShipments > 0 || headerCancelled;
  card_.is_cancelled =
    headerCancelled ||
    (card_.shipments.length > 0 && cancelledShipments === card_.shipments.length);
  if (/\barchived\b/i.test(headerText)) card_.is_archived = true;
  const refunds = card_.shipments
    .map((s) => s.return_or_refund)
    .filter((x): x is string => x !== undefined);
  if (refunds.length > 0) card_.return_or_refund = refunds.join(" | ");

  card_.order_type =
    firstOf<OrderCard["order_type"]>(
      "order_type",
      [
        [
          "id-prefix",
          () =>
            orderId === null
              ? undefined
              : /^D\d\d-/.test(orderId)
                ? "digital"
                : /^\d{3}-/.test(orderId)
                  ? "physical"
                  : "other",
        ],
        ["tab", () => (pageKind === "digital" ? "digital" : undefined)],
      ],
      meta,
      { optional: true },
    ) ?? "other";
  return card_;
}

// ---- page-level parsing

function parseRequested(capture: Capture): {
  time_filter: string | null;
  order_filter: string | null;
  page: number | null;
} {
  try {
    const u = new URL(capture.final_url || capture.url, SITE);
    const page = u.searchParams.get("page");
    return {
      time_filter: u.searchParams.get("timeFilter"),
      order_filter: u.searchParams.get("orderFilter"),
      page: page !== null && /^\d+$/.test(page) ? Number(page) : null,
    };
  } catch {
    return { time_filter: null, order_filter: null, page: null };
  }
}

function tabKind(
  label: string,
  filter: string | undefined,
  path: string | undefined,
): FilterTab["kind"] {
  const l = label.toLowerCase();
  if (/^orders?$/.test(l)) return "orders";
  if (/buy again/.test(l) || /\/buyagain/.test(path ?? "")) return "buy_again";
  if (/not yet shipped|open orders/.test(l) || filter === "open") return "not_yet_shipped";
  if (/digital/.test(l) || filter === "digital") return "digital";
  if (/cancel/.test(l) || filter === "cancelled") return "cancelled";
  if (/archiv/.test(l) || filter === "archived") return "archived";
  if (/amazon pay/.test(l)) return "amazon_pay";
  return "other";
}

function parseTabs(root: DomElement, consumed: Consumption, meta: ParseMeta): FilterTab[] {
  const items = firstOf<DomElement[]>(
    "tabs",
    [
      ["page-tabs", () => qa(root, ".page-tabs li.page-tabs__tab")],
      ["tablist", () => qa(root, "[role=tablist] > *, ul.a-tabs > li")],
    ],
    meta,
    { optional: true },
  );
  const tabs: FilterTab[] = [];
  for (const li of items ?? []) {
    const label = text(li);
    if (label === "") continue;
    const anchor = q(li, "a[href]");
    const link = cleanLink(attr(anchor, "href"));
    const cls = classOf(li);
    const selected =
      /--selected|\bselected\b|\ba-active\b/.test(cls) ||
      attr(li, "aria-current") === "page" ||
      attr(li, "aria-selected") === "true";
    let filter: string | undefined;
    if (link !== undefined) {
      filter = new URL(link.path, SITE).searchParams.get("orderFilter") ?? undefined;
    }
    const tab: FilterTab = { label, kind: tabKind(label, filter, link?.path), selected };
    if (link !== undefined) {
      tab.path = link.path;
      if (link.external) tab.external = true;
    }
    if (filter !== undefined) tab.filter_value = filter;
    tabs.push(tab);
    consumed.take(li);
  }
  if (tabs.length > 0 && !tabs.some((t) => t.selected)) {
    const bare = tabs.filter((t) => t.path === undefined);
    if (bare.length === 1) (bare[0] as FilterTab).selected = true;
  }
  return tabs;
}

function parseTimeFilter(
  root: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
): TimeFilter | undefined {
  const select = firstOf<DomElement>(
    "time_filter",
    [
      ["select-id", () => q(root, "select#time-filter")],
      ["select-name", () => q(root, "select[name=timeFilter]")],
      ["form", () => q(root, ".js-time-filter-form select")],
    ],
    meta,
    { optional: true },
  );
  if (select === undefined) return undefined;
  // The native select is replaced by a custom dropdown, so its options carry the hidden
  // marker; read them from the raw DOM (the select itself is visible).
  const options: TimeFilterOption[] = [];
  for (const o of Array.from(select.querySelectorAll("option"))) {
    const value = attr(o, "value");
    const label = collapse(o.textContent ?? "");
    if (value === undefined || value === "" || label === "") continue;
    const opt: TimeFilterOption = { label, value, selected: o.hasAttribute("selected") };
    const ref = attr(o, "data-ref");
    if (ref !== undefined) opt.ref = ref;
    options.push(opt);
  }
  const filter: TimeFilter = { options };
  const prompt = text(q(select.closest("form") ?? root, ".a-dropdown-prompt"));
  const chosen =
    options.find((o) => o.selected) ??
    (prompt === "" ? undefined : options.find((o) => o.label === prompt));
  if (chosen !== undefined) filter.selected_value = chosen.value;
  if (prompt !== "") filter.selected_label = prompt;
  else if (chosen !== undefined) filter.selected_label = chosen.label;
  consumed.take(select.closest("form") ?? select);
  return options.length > 0 ? filter : undefined;
}

const COUNT_TEXT_RE = /\b\d[\d,]*\s+orders?\b/i;

function parseCount_(
  root: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
): { text: string; count: number | undefined } | undefined {
  const el = firstOf<DomElement>(
    "order_count",
    [
      [
        "time-filter-label",
        () => {
          const l = q(root, "label.time-filter__label, label[for=time-filter]");
          return l !== undefined && COUNT_TEXT_RE.test(text(l)) ? l : undefined;
        },
      ],
      [
        "count-row",
        () =>
          qa(root, ".a-row.a-spacing-base").find(
            (r) => r.closest(".order-card") === null && COUNT_TEXT_RE.test(text(r)),
          ),
      ],
      [
        "bold-count",
        () =>
          qa(root, "b, strong").find(
            (b) => b.closest(".order-card") === null && COUNT_TEXT_RE.test(text(b)),
          )?.parentElement ?? undefined,
      ],
    ],
    meta,
    { optional: true },
  );
  if (el === undefined) return undefined;
  const t = text(el);
  const m = COUNT_TEXT_RE.exec(t);
  const count = m === null ? undefined : parseCount(m[0]);
  // The enclosing form is consumed by the time-filter step; consume only a bare row here.
  if (el.localName !== "label") consumed.take(el);
  return { text: t, count };
}

function parsePagination(
  root: DomElement,
  consumed: Consumption,
  meta: ParseMeta,
): Pagination | undefined {
  const ul = firstOf<DomElement>(
    "pagination",
    [
      ["a-pagination", () => q(root, "ul.a-pagination")],
      ["pagination-class", () => q(root, ".a-pagination")],
    ],
    meta,
    { optional: true },
  );
  if (ul === undefined) return undefined;
  const pages: PaginationPage[] = [];
  let prev: { path?: string } | undefined;
  let next: { path?: string } | undefined;
  let gap = false;
  let current: PaginationPage | undefined;
  for (const li of childElements(ul)) {
    if (!visible(li)) continue;
    const t = text(li);
    const cls = classOf(li);
    const link = cleanLink(attr(q(li, "a[href]"), "href"));
    if (/^(?:\.{3}|\u2026)$/.test(t)) {
      gap = true;
    } else if (/previous/i.test(t) && !/^\d+$/.test(t)) {
      prev = link === undefined ? {} : { path: link.path };
    } else if (/\bnext\b/i.test(t) || (/\ba-last\b/.test(cls) && !/^\d+$/.test(t))) {
      next = link === undefined ? {} : { path: link.path };
    } else if (/^\d+$/.test(t)) {
      const page: PaginationPage = { label: t, current: /\ba-selected\b/.test(cls) };
      if (link !== undefined) page.path = link.path;
      pages.push(page);
      if (page.current) current = page;
    }
  }
  consumed.take(ul);

  const pagination: Pagination = {
    pages,
    has_prev: prev?.path !== undefined,
    has_next: next?.path !== undefined,
    has_gap: gap,
  };
  if (prev?.path !== undefined) pagination.prev_path = prev.path;
  if (next?.path !== undefined) pagination.next_path = next.path;
  if (current !== undefined) pagination.current_label = current.label;
  const last = pages[pages.length - 1];
  if (last !== undefined) pagination.last_label = last.label;

  // Which query parameter carries the position, and how it counts.
  const candidates = ["page", "startIndex", "start", "pageNumber"];
  const paths = [...pages.map((p) => p.path), prev?.path, next?.path].filter(
    (p): p is string => p !== undefined,
  );
  const param = candidates.find((c) => paths.some((p) => new URL(p, SITE).searchParams.has(c)));
  if (param !== undefined) {
    pagination.index_param = param;
    const valueOf = (p: string | undefined): number | undefined => {
      if (p === undefined) return undefined;
      const v = new URL(p, SITE).searchParams.get(param);
      return v !== null && /^\d+$/.test(v) ? Number(v) : undefined;
    };
    for (const p of pages) {
      const v = valueOf(p.path);
      if (v !== undefined) p.index = v;
    }
    const numbered = pages.filter((p) => p.index !== undefined);
    const a = numbered[0];
    const b = numbered[1];
    if (a !== undefined && b !== undefined) {
      const dl = Number(b.label) - Number(a.label);
      const step = ((b.index as number) - (a.index as number)) / dl;
      if (Number.isFinite(step) && step > 0) {
        pagination.index_step = step;
        pagination.index_base = (a.index as number) - (Number(a.label) - 1) * step;
      }
    }
    if (current !== undefined && pagination.index_step !== undefined) {
      pagination.current_index =
        (pagination.index_base as number) + (Number(current.label) - 1) * pagination.index_step;
    } else if (current?.index !== undefined) {
      pagination.current_index = current.index;
    }
  }
  return pagination;
}

function parseSearchForm(root: DomElement, consumed: Consumption): SearchForm | undefined {
  const bar = q(root, ".search-bar");
  const form = bar === undefined ? q(root, "form[action*='your-orders/search']") : q(bar, "form");
  if (form === undefined) return undefined;
  const link = cleanLink(attr(form, "action"));
  if (link === undefined) return undefined;
  const hidden: Record<string, string> = {};
  let queryParam: string | undefined;
  for (const input of Array.from(form.querySelectorAll("input"))) {
    const name = attr(input, "name");
    if (name === undefined || name === "") continue;
    const type = (attr(input, "type") ?? "text").toLowerCase();
    if (type === "hidden") {
      if (!STRIP_PARAMS.test(name)) hidden[name] = attr(input, "value") ?? "";
    } else if (type === "search" || type === "text") {
      queryParam = name;
    }
  }
  consumed.take(bar ?? form);
  const out: SearchForm = {
    action_path: link.path,
    method: (attr(form, "method") ?? "get").toLowerCase(),
    hidden,
  };
  if (queryParam !== undefined) out.query_param = queryParam;
  return out;
}

const EMPTY_RE =
  /\b(?:haven['\u2019]?t placed|have not placed|not placed any|no orders|didn['\u2019]?t find any|no results)\b/i;

function findEmptyText(root: DomElement, consumed: Consumption): string | undefined {
  for (const el of qa(root, "*")) {
    if (consumed.covers(el) || el.closest(".page-tabs, .breadcrumbs") !== null) continue;
    const own = ownText(el);
    if (own !== "" && EMPTY_RE.test(own)) {
      const t = text(el);
      consumed.take(el);
      return t;
    }
  }
  return undefined;
}

// ---- entry point

export const parseOrderList: Parser<OrderListPage> = (
  capture: Capture,
): ParseResult<OrderListPage> => {
  const doc = parseDocument(capture.html);
  const meta = newMeta();
  const consumed = new Consumption();
  const opts = orderListLosslessOptions(doc);
  const root = opts.root as DomElement;

  // Page chrome of the content area.
  const headingEl = q(root, "h1");
  const heading = text(headingEl) || undefined;
  consumed.take(headingEl);
  const crumbs = qa(root, "ul.breadcrumbs");
  const breadcrumbs: string[] = [];
  for (const ul of crumbs) {
    for (const li of qa(ul, "li")) {
      if (/--divider/.test(classOf(li))) continue;
      const t = text(li);
      if (t !== "") breadcrumbs.push(t);
    }
    consumed.take(ul);
  }

  const search = parseSearchForm(root, consumed);
  const tabs = parseTabs(root, consumed, meta);
  const timeFilter = parseTimeFilter(root, consumed, meta);
  const count = parseCount_(root, consumed, meta);
  const pagination = parsePagination(root, consumed, meta);

  const links: { label: string; path: string }[] = [];
  const tx = q(root, "[data-csa-c-content-id='yo-view-transactions-desktop']");
  if (tx !== undefined) {
    const a = q(tx, "a[href]");
    const link = cleanLink(attr(a, "href"));
    if (a !== undefined && link !== undefined) links.push({ label: text(a), path: link.path });
    consumed.take(tx);
  }

  // Orders.
  const cardEls = firstOf<DomElement[]>(
    "orders",
    [
      ["order-card-class", () => qa(root, ".order-card")],
      ["csa-content-id", () => qa(root, "[data-csa-c-content-id='amzn1.yourorders.order-card']")],
      ["js-order-card", () => qa(root, ".js-order-card")],
      ["csa-slot-id", () => qa(root, "[data-csa-c-slot-id^='amzn1.yourorders.order-card.']")],
    ],
    meta,
    { optional: true },
  );
  const orders: OrderCard[] = [];
  const log = new StrategyLog();
  const selectedTab = tabs.find((t) => t.selected);
  (cardEls ?? []).forEach((el, i) => {
    const cardMeta = newMeta();
    orders.push(parseCard(el, i, consumed, cardMeta, selectedTab?.kind ?? ""));
    log.add(cardMeta, i, meta);
  });
  log.into(meta);

  let emptyText: string | undefined;
  if (orders.length === 0) emptyText = findEmptyText(root, consumed);

  // Recognizable skeleton? Otherwise this is not an order list.
  const skeleton =
    orders.length > 0 ||
    tabs.length > 0 ||
    timeFilter !== undefined ||
    count !== undefined ||
    pagination !== undefined ||
    emptyText !== undefined ||
    search !== undefined;
  if (!skeleton) {
    throw new RfError("layout_unrecognized", "no order list structure found on the page");
  }
  if (orders.length === 0 && emptyText === undefined && (count?.count ?? 0) > 0) {
    meta.warnings.push("order count is above zero but no order cards were found");
  }

  const requestedRaw = parseRequested(capture);
  const requested: RequestedFilters = {
    ...requestedRaw,
    time_filter_applied:
      requestedRaw.time_filter === null
        ? null
        : timeFilter?.selected_value === requestedRaw.time_filter,
    order_filter_applied:
      requestedRaw.order_filter === null
        ? null
        : tabs.some((t) => t.selected && t.filter_value === requestedRaw.order_filter),
  };
  if (requested.order_filter_applied === false) {
    meta.warnings.push(
      `requested orderFilter=${requestedRaw.order_filter} is not reflected by any selected tab; the page shows the default list`,
    );
  }
  if (requested.time_filter_applied === false) {
    meta.warnings.push(
      `requested timeFilter=${requestedRaw.time_filter} is not the selected time filter`,
    );
  }

  const data: OrderListPage = { breadcrumbs, requested, tabs, orders, links };
  if (heading !== undefined) data.heading = heading;
  if (count !== undefined) {
    data.order_count_text = count.text;
    if (count.count !== undefined) data.order_count = count.count;
  }
  if (timeFilter !== undefined) data.time_filter = timeFilter;
  if (selectedTab !== undefined) data.selected_tab = selectedTab.kind;
  if (pagination !== undefined) data.pagination = pagination;
  if (emptyText !== undefined) data.empty_text = emptyText;
  if (search !== undefined) data.search = search;

  const report = losslessReport(doc as DomRoot, consumed, opts);
  const other: OtherSection[] = report.sections;
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data, other_sections: other, meta };
};
