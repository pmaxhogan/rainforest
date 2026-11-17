/**
 * Order details page parser (tool `get_order`).
 *
 * The page is a stack of `data-component` blocks (breadcrumb, orderSummary, shipments, ...).
 * The primary strategy reads those; label / text-anchor strategies cover older or reshuffled
 * layouts. Every element read is marked in a `Consumption`; whatever is left over comes back
 * as `other_sections`.
 *
 * Privacy of the RESULT: the page owner's name, address and purchases are returned as shown
 * (that is the point of the tool). Card digits are different: every payment string goes
 * through `redactDigits`, so the only digits a card can ever contribute are the last four.
 *
 * This module also exports the small helpers the invoice parser shares (dates, charge lines,
 * card text, link classification).
 */
import { RfError } from "@rainforest/core";
import type { OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomElement,
  type DomRoot,
  type Money,
  TEXT_NODE,
  attr,
  collapse,
  hiddenSelf,
  isElement,
  moneyFromPriceElement,
  parseCapture,
  parseMoney,
  q,
  qa,
  text,
  visible,
} from "../dom.ts";
import { firstOf, newMeta } from "../strategy.ts";
import { Consumption, DEFAULT_BLOCK_SELECTOR, losslessReport } from "../lossless.ts";

// ---------------------------------------------------------------------------------------
// Shared types

export interface DateValue {
  raw: string;
  /** YYYY-MM-DD when the date is unambiguous (explicit year, or year inferred from `placed`). */
  iso?: string;
  /** True when the page printed no year and it was taken from the order date. */
  year_inferred?: boolean;
}

export const CHARGE_TYPES = [
  "items_subtotal",
  "shipping",
  "promotion",
  "total_before_tax",
  "tax",
  "rewards",
  "gift_card",
  "fees",
  "tip",
  "grand_total",
  "refund_total",
  "refund",
  "other",
] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

export interface ChargeLine {
  /** Label as shown, without the trailing colon. */
  label: string;
  type: ChargeType;
  /** Signed: discounts and rewards are negative when the page prints them that way. */
  amount?: Money;
  /** The value text as shown ("$12.99", "FREE"). */
  raw: string;
  /** Rows of an inline popover under this line (for example the refund breakdown). */
  breakdown?: ChargeLine[];
}

export type ReadLinkKind = "tracking" | "invoice" | "return_status" | "order_details" | "seller";

export interface ReadLink {
  label: string;
  kind: ReadLinkKind;
  /** Relative path (and query) on the same site; tracking noise params removed. */
  path: string;
}

export type ActionIntent =
  "cancel" | "return" | "review" | "feedback" | "gift_receipt" | "buy_again" | "support" | "other";

/** A button that changes state or leads to a flow that does. Never carries an href. */
export interface ActionLabel {
  label: string;
  intent: ActionIntent;
}

export const SHIPMENT_KINDS = [
  "delivered",
  "arriving",
  "shipped",
  "preparing",
  "delayed",
  "cancelled",
  "refunded",
  "returned",
  "replaced",
  "unknown",
] as const;
export type ShipmentKind = (typeof SHIPMENT_KINDS)[number];

export interface CardInfo {
  /** Normalized brand when recognizable ("Visa", "Mastercard", ...). */
  card_brand?: string;
  /** The instrument name as shown ("Example Visa"). */
  card_name?: string;
  /** Exactly four digits, or absent. */
  last4?: string;
}

export interface PaymentMethod extends CardInfo {
  type: "card" | "gift_card" | "rewards" | "bank" | "other";
  /** Main line as shown, digits redacted. */
  label: string;
  /** Feature / detail lines under the instrument, digits redacted. */
  details: string[];
}

export interface PaymentSummary {
  methods: PaymentMethod[];
  /** Lines not tied to one instrument (rewards applied, gift card balance used), as labeled text. */
  lines: { label: string; amount?: Money; raw: string }[];
  /** First card's brand and last four, for convenience. */
  card_brand?: string;
  last4?: string;
  /** Buttons / links shown in the payment block, labels only. */
  actions: string[];
  /** Any other visible line of the payment block (digits redacted). */
  other_lines: string[];
}

export interface ShipTo {
  /** Heading as shown ("Ship to", "Pick up at"). */
  heading?: string;
  name?: string;
  /** Lines after the name, as shown (street, city/region/postal). */
  address_lines: string[];
  country?: string;
  lines: string[];
}

export interface ReturnWindow {
  text: string;
  eligible?: boolean;
  through?: DateValue;
}

export interface OrderItem {
  asin?: string;
  title: string;
  /** Product page path, e.g. /dp/B0FAKE0001. */
  url_path?: string;
  quantity: number;
  /** Unit price. */
  price?: Money;
  condition?: string;
  seller?: string;
  seller_id?: string;
  return_window?: ReturnWindow;
  /** Per-item state ("Refunded", "Cancelled"), inherited from the shipment when it says so. */
  status?: string;
  /** Text of gift / variation / subscription / installment / service components, by name. */
  extras: Record<string, string>;
  gift?: { sender?: string; message?: string; details?: string; shareable_link_shown?: boolean };
  actions: ActionLabel[];
  links: ReadLink[];
}

export interface ShipmentStatus {
  raw: string;
  kind: ShipmentKind;
  detail?: string;
  /** Delivery / arrival date (or the start of a range). */
  date?: DateValue;
  /** End of a date range ("Arriving Nov 18 - Nov 20"). */
  date_end?: DateValue;
  /** Label of the "When will I get my refund?" style help link. */
  help_label?: string;
  /** Text of that help popover. */
  help_text?: string;
}

export interface Shipment {
  status?: ShipmentStatus;
  tracking?: { path: string; carrier?: string; tracking_id?: string };
  items: OrderItem[];
  links: ReadLink[];
  actions: ActionLabel[];
}

export interface ReturnRefund {
  scope: "order" | "shipment";
  shipment_index?: number;
  /** Status text as shown. */
  status: string;
  detail?: string;
  asins: string[];
  refund_total?: Money;
  /** Dollar amounts and dates found in the status text. */
  amounts: Money[];
  dates: DateValue[];
  breakdown?: ChargeLine[];
  help_text?: string;
  /** Path of the return / refund status page, when the page links one. */
  status_path?: string;
}

export interface OrderDetails {
  order_id?: string;
  placed?: DateValue;
  /** Distinct shipment statuses, joined; "" when the page shows none. */
  status: { summary: string; kinds: ShipmentKind[] };
  /** subscribe_and_save, fresh, whole_foods, pantry, digital, gift, business, shared. */
  order_types: string[];
  brand?: string;
  po_number?: string;
  shared_order_buyer?: string;
  ship_to?: ShipTo;
  payment: PaymentSummary;
  totals: ChargeLine[];
  shipments: Shipment[];
  returns_and_refunds: ReturnRefund[];
  /** Text of the order-level cancellation block, when present. */
  cancellation?: string;
  notices: string[];
  links: ReadLink[];
  actions: ActionLabel[];
}

// ---------------------------------------------------------------------------------------
// Shared helpers

const BREAK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "br",
  "div",
  "dd",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
  "ol",
]);

/** Visible text split into lines at line breaks and block boundaries. */
export function textLines(
  el: DomElement | null | undefined,
  exclude?: (el: DomElement) => boolean,
): string[] {
  if (el == null || !visible(el)) return [];
  const lines: string[] = [];
  let cur = "";
  const flush = (): void => {
    const t = collapse(cur);
    if (t !== "") lines.push(t);
    cur = "";
  };
  const walk = (node: DomElement): void => {
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child === undefined) continue;
      if (child.nodeType === TEXT_NODE) {
        cur += child.textContent ?? "";
      } else if (isElement(child)) {
        if (hiddenSelf(child) || (exclude !== undefined && exclude(child))) continue;
        const brk = BREAK_TAGS.has(child.localName);
        if (brk) flush();
        walk(child);
        if (brk) flush();
      }
    }
  };
  walk(el);
  flush();
  return lines;
}

/** The `[data-component=name]` element under root. */
export function comp(root: DomRoot | null | undefined, name: string): DomElement | undefined {
  return q(root, `[data-component="${name}"]`);
}

const MONTHS: Record<string, number> = {
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

const DATE_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?!\d)/gi;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function validDay(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Every "Month D[, YYYY]" in a string. A year-less date takes the year of `refIso` (rolling
 * to the next year when that would put it before the reference); with no reference it gets
 * no ISO form.
 */
export function findDates(s: string | null | undefined, refIso?: string): DateValue[] {
  if (s == null) return [];
  const out: DateValue[] = [];
  const ref = refIso !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(refIso) ? refIso : undefined;
  for (const m of s.matchAll(DATE_RE)) {
    const mon = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
    const day = Number(m[2]);
    if (mon === undefined) continue;
    const value: DateValue = { raw: m[0].trim() };
    if (m[3] !== undefined) {
      const y = Number(m[3]);
      if (validDay(y, mon, day)) value.iso = `${y}-${pad(mon)}-${pad(day)}`;
    } else if (ref !== undefined) {
      let y = Number(ref.slice(0, 4));
      if (`${y}-${pad(mon)}-${pad(day)}` < ref) y += 1;
      if (validDay(y, mon, day)) {
        value.iso = `${y}-${pad(mon)}-${pad(day)}`;
        value.year_inferred = true;
      }
    }
    out.push(value);
  }
  return out;
}

/** Classify a charge-line label. Order matters: the specific totals come first. */
export function classifyCharge(label: string): ChargeType {
  const l = label.toLowerCase().replace(/[:\s]+$/, "");
  if (/refund/.test(l)) return /total/.test(l) ? "refund_total" : "refund";
  if (/before tax/.test(l)) return "total_before_tax";
  if (/grand total|order total|total for this order|^total$/.test(l)) return "grand_total";
  if (/promotion|discount|coupon|saving|free shipping|subscribe & save|you saved/.test(l)) {
    return "promotion";
  }
  if (/subtotal/.test(l)) return "items_subtotal";
  if (/shipping|handling|delivery/.test(l)) return "shipping";
  if (/\btip\b/.test(l)) return "tip";
  if (/gift card|gift certificate/.test(l)) return "gift_card";
  if (/reward|points/.test(l)) return "rewards";
  if (/\btax\b|\bvat\b|\bgst\b/.test(l)) return "tax";
  if (/\bfee|deposit|customs|duties/.test(l)) return "fees";
  return "other";
}

/** A labeled money line. The value may be a word ("FREE") with no amount. */
export function chargeLine(label: string, valueText: string, money?: Money): ChargeLine {
  const clean = collapse(label).replace(/\s*:\s*$/, "");
  const raw = collapse(valueText);
  const amount = money ?? parseMoney(raw);
  const line: ChargeLine = { label: clean, type: classifyCharge(clean), raw };
  if (amount !== undefined) line.amount = amount;
  return line;
}

/** Rows of an `.od-line-item-row` list (label column, value column), in order. */
export function chargeRows(
  rows: readonly DomElement[],
  used: Consumption,
  meta: ParseMeta,
): ChargeLine[] {
  const out: ChargeLine[] = [];
  for (const row of rows) {
    const cols = Array.from(row.children).filter((c) => !hiddenSelf(c));
    const labelEl =
      q(row, ".od-line-item-row-label") ?? (cols.length >= 2 ? cols[0] : undefined) ?? undefined;
    const valueEl =
      q(row, ".od-line-item-row-content") ??
      (cols.length >= 2 ? cols[cols.length - 1] : undefined) ??
      undefined;
    if (labelEl === undefined || valueEl === undefined || labelEl === valueEl) continue;
    const label = text(labelEl);
    if (label === "") continue;
    const line = chargeLine(label, text(valueEl), moneyFromPriceElement(valueEl));
    const popover = popoverDoc(row, meta);
    if (popover !== undefined) {
      const inner = qa(popover, ".od-line-item-row");
      const sub = chargeRows(inner, new Consumption(), meta).filter(
        (l) => l.label.toLowerCase() !== line.label.toLowerCase(),
      );
      if (sub.length > 0) line.breakdown = sub;
    }
    out.push(line);
    used.take(row);
  }
  return out;
}

/** Parsed `inlineContent` of the first `data-a-popover` under (or on) an element. */
export function popoverDoc(el: DomElement, meta?: ParseMeta): DomRoot | undefined {
  const holder = el.hasAttribute("data-a-popover") ? el : el.querySelector("[data-a-popover]");
  const raw = attr(holder ?? undefined, "data-a-popover");
  if (raw === undefined) return undefined;
  try {
    const json = JSON.parse(raw) as { inlineContent?: unknown };
    if (typeof json.inlineContent !== "string") return undefined;
    return parseCaptureHtml(json.inlineContent);
  } catch {
    meta?.warnings.push("popover: data-a-popover is not valid JSON");
    return undefined;
  }
}

function parseCaptureHtml(html: string): DomRoot {
  return parseCapture({
    kind: "order_details",
    url: "",
    final_url: "",
    captured_at: "",
    html,
  }).doc.body;
}

// ---- links and actions

/** Same-site relative path with tracking noise removed; undefined for off-site or empty hrefs. */
export function relativePath(href: string | undefined): string | undefined {
  if (href === undefined || href === "" || href.startsWith("#") || /^javascript:/i.test(href)) {
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(href, "https://base.invalid");
  } catch {
    return undefined;
  }
  if (u.origin !== "https://base.invalid" && !/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) {
    return undefined;
  }
  const keep: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (/^(ref_?|_encoding|pd_rd_.*|pf_rd_.*|content-id|qid|psc|th)$/i.test(k)) continue;
    keep.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const path = u.pathname.replace(/\/ref=[^/]*$/, "");
  return keep.length > 0 ? `${path}?${keep.join("&")}` : path;
}

/**
 * Read-only destinations, by path. A link that matches none of these is NEVER emitted with
 * its href: it becomes an action label. Mutating flows (return cart, review, feedback, gift
 * receipt, buy again, cancel) are deliberately absent.
 */
export const READ_ONLY_LINK_RULES: readonly {
  kind: ReadLinkKind;
  test: (path: string, query: URLSearchParams) => boolean;
}[] = [
  {
    kind: "tracking",
    test: (p) =>
      /^\/progress-tracker\/package$/.test(p) ||
      /^\/gp\/your-account\/ship-track$/.test(p) ||
      /^\/gp\/css\/shiptrack$/.test(p),
  },
  { kind: "invoice", test: (p) => /^\/gp\/css\/summary\/print\.html$/.test(p) },
  {
    kind: "return_status",
    test: (p, qs) => /^\/spr\/returns\/prep$/.test(p) && qs.has("rmaId"),
  },
  {
    kind: "order_details",
    test: (p) =>
      /^\/gp\/your-account\/order-details$/.test(p) || /^\/gp\/css\/order-details$/.test(p),
  },
  { kind: "seller", test: (p) => /^\/gp\/aag\/main$/.test(p) },
];

export function readLinkKind(path: string): ReadLinkKind | undefined {
  const [p = "", query = ""] = path.split("?");
  const qs = new URLSearchParams(query);
  for (const rule of READ_ONLY_LINK_RULES) if (rule.test(p, qs)) return rule.kind;
  return undefined;
}

export function actionIntent(label: string): ActionIntent {
  const l = label.toLowerCase();
  if (/cancel/.test(l)) return "cancel";
  if (/return|replace|refund/.test(l)) return "return";
  if (/review/.test(l)) return "review";
  if (/feedback/.test(l)) return "feedback";
  if (/gift receipt/.test(l)) return "gift_receipt";
  if (/buy (it )?again/.test(l)) return "buy_again";
  if (/support|help/.test(l)) return "support";
  return "other";
}

export interface ClassifiedControls {
  links: ReadLink[];
  actions: ActionLabel[];
}

/** One control: a read-only link when its path is allowlisted, else an action label. */
export function classifyControl(
  label: string,
  href: string | undefined,
): { link?: ReadLink; action?: ActionLabel } {
  const path = relativePath(href);
  const kind = path === undefined ? undefined : readLinkKind(path);
  if (path !== undefined && kind !== undefined) return { link: { label, kind, path } };
  return { action: { label, intent: actionIntent(label) } };
}

function addControl(out: ClassifiedControls, seen: Set<string>, label: string, href?: string) {
  if (label === "") return;
  const key = `${label}|${relativePath(href) ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  const c = classifyControl(label, href);
  if (c.link !== undefined) out.links.push(c.link);
  if (c.action !== undefined) out.actions.push(c.action);
}

/**
 * Sort the buttons / links under `root` into read-only links (allowlist) and action labels
 * (no href). Marks each control consumed.
 */
export function classifyControls(
  root: DomElement | undefined,
  used: Consumption,
): ClassifiedControls {
  const out: ClassifiedControls = { links: [], actions: [] };
  if (root === undefined) return out;
  const seen = new Set<string>();
  for (const b of qa(root, ".a-button")) {
    addControl(out, seen, text(b), attr(q(b, "a[href]"), "href"));
    used.take(b);
  }
  for (const a of qa(root, "a[href], button")) {
    if (a.closest(".a-button") !== null) continue;
    addControl(out, seen, text(a) || attr(a, "aria-label") || "", attr(a, "href"));
    used.take(a);
  }
  return out;
}

/**
 * Buttons nobody claimed (for example "Change shipping address", "Print"): labels only,
 * recommendation carousels excluded. Marks them consumed.
 */
export function sweepButtons(scope: DomElement, used: Consumption): ClassifiedControls {
  const out: ClassifiedControls = { links: [], actions: [] };
  const seen = new Set<string>();
  for (const b of qa(scope, ".a-button")) {
    if (used.covers(b)) continue;
    if (b.closest(".a-carousel-container, [data-component='personalization']") !== null) continue;
    addControl(out, seen, text(b), attr(q(b, "a[href]"), "href"));
    used.take(b);
  }
  return out;
}

// ---- cards and digits

const BRANDS: readonly (readonly [RegExp, string])[] = [
  [/american express|amex/i, "American Express"],
  [/master\s?card/i, "Mastercard"],
  [/\bvisa\b/i, "Visa"],
  [/discover/i, "Discover"],
  [/diners/i, "Diners Club"],
  [/\bjcb\b/i, "JCB"],
  [/union\s?pay/i, "UnionPay"],
];

/** A bullet written as an escape so the source stays ASCII. */
export const BULLET = "\u2022";

const PAN_LIKE = /(?<![\d$.,])(?:\d[ -]?){12,18}\d(?![\d.,]?\d)/g;

/**
 * Remove card-number-like digit runs from a payment string: a 13-19 digit sequence becomes
 * four bullets plus its last four digits, and any other run of five or more digits is
 * replaced. After this, no payment string can carry more than four consecutive digits.
 */
export function redactDigits(s: string): string {
  return s
    .replace(PAN_LIKE, (m) => `${BULLET.repeat(4)} ${m.replace(/\D/g, "").slice(-4)}`)
    .replace(/(?<![\d$.,\u2022*-])\d{5,}(?![\d]|[.,]\d)/g, "[redacted]");
}

const CARD_TAIL = new RegExp(
  `^(.*?)\\s*(?:[${BULLET}\\u00b7*]{2,}|[xX]{2,}|(?:ending|ends)\\s+(?:in|with)|last\\s+(?:4|four)\\s+digits(?:\\s+are)?:?)\\s*[${BULLET}\\u00b7*xX\\s]*(\\d{4})(?!\\d)`,
  "i",
);

/** Brand, instrument name and last four from text like "Visa ending in 0000". */
export function parseCard(raw: string): CardInfo {
  const safe = redactDigits(raw);
  const out: CardInfo = {};
  const m = CARD_TAIL.exec(safe);
  const name = collapse((m?.[1] ?? safe).replace(/[:\-,]+\s*$/, ""));
  if (m !== null && m[2] !== undefined && /^\d{4}$/.test(m[2])) out.last4 = m[2];
  for (const [re, brand] of BRANDS) {
    if (re.test(name) || re.test(safe)) {
      out.card_brand = brand;
      break;
    }
  }
  if (name !== "" && (out.last4 !== undefined || out.card_brand !== undefined)) {
    out.card_name = name.replace(/\s*(ending|ends)\s*$/i, "").trim();
  }
  return out;
}

/** Redact gift-card claim codes (XXXX-XXXXXX-XXXX) from free text. */
export function redactCodes(s: string): string {
  return s.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{6}-[A-Z0-9]{4,5}\b/g, "[redacted]");
}

// ---- shipment status

export function classifyStatus(s: string): ShipmentKind {
  const l = s.toLowerCase();
  if (/cancel/.test(l)) return "cancelled";
  if (/refund/.test(l)) return "refunded";
  if (/replace/.test(l) && /(sent|shipped|arriv|deliver)/.test(l)) return "replaced";
  if (/return/.test(l)) return "returned";
  if (/delay|running late|late\b/.test(l)) return "delayed";
  if (/deliver(ed)?\b/.test(l) && !/(expected|estimated|arriv|out for|will be)/.test(l)) {
    return "delivered";
  }
  if (/(arriving|arrives|expected|estimated|will arrive|out for delivery|delivery date)/.test(l)) {
    return "arriving";
  }
  if (/(not yet shipped|preparing|processing|pending|payment|packing)/.test(l)) return "preparing";
  if (/(shipped|on the way|in transit|dispatched)/.test(l)) return "shipped";
  if (/\bordered\b/.test(l)) return "preparing";
  return "unknown";
}

const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d|d)\/([A-Z0-9]{10})(?=[/?#]|$)/;

export function asinFromHref(href: string | undefined): string | undefined {
  return href === undefined ? undefined : ASIN_RE.exec(href)?.[1];
}

const ORDER_ID_RE = /\b([A-Z0-9]{3}-\d{7}-\d{7})\b/;

/** Order id from a URL query (`orderID` / `orderId`), if present. */
export function orderIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const m = /[?&]order(?:id|Id|ID)=([A-Z0-9]{3}-\d{7}-\d{7})/.exec(url);
  return m?.[1];
}

export function orderIdFromText(s: string): string | undefined {
  const m = /Order\s*(?:#|number|no\.?|ID)\s*:?\s*([A-Z0-9]{3}-\d{7}-\d{7})/i.exec(s);
  return m?.[1] ?? ORDER_ID_RE.exec(s)?.[1];
}

/** Heading + message of the "unable to load" error banner, when that is all the page shows. */
export function errorBanner(root: DomRoot): { heading: string; message: string } | undefined {
  const banner = comp(root, "errorbanner") ?? q(root, ".a-alert-container");
  if (banner === undefined) return undefined;
  const heading = text(q(banner, ".a-alert-heading, h4, h3"));
  const content = text(q(banner, ".a-alert-content"), {
    exclude: (e) => e.matches(".a-button, a, button"),
  });
  if (heading === "" && content === "") return undefined;
  return { heading, message: content };
}

// ---------------------------------------------------------------------------------------
// Parser

function mergeMeta(into: ParseMeta, from: ParseMeta, prefix: string): void {
  for (const [k, v] of Object.entries(from.strategies)) {
    if (!(`${prefix}.${k}` in into.strategies)) into.strategies[`${prefix}.${k}`] = v;
  }
  for (const w of from.warnings) {
    const msg = `${prefix}: ${w}`;
    if (!into.warnings.includes(msg)) into.warnings.push(msg);
  }
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function afterLabel(s: string, label: RegExp): string {
  return collapse(s.replace(label, ""));
}

export function parseShipTo(
  scope: DomElement,
  used: Consumption,
  meta: ParseMeta,
): ShipTo | undefined {
  const build = (el: DomElement): ShipTo | undefined => {
    const heading = text(q(el, "h1, h2, h3, h4, h5, h6, .a-text-bold"));
    const lines = textLines(el, (e) => /^h[1-6]$/.test(e.localName));
    const rest = heading !== "" ? lines.filter((l) => l !== heading) : lines;
    if (rest.length === 0) return undefined;
    const out: ShipTo = { address_lines: [], lines: rest };
    if (heading !== "") out.heading = heading;
    out.name = rest[0];
    let tail = rest.slice(1);
    const last = tail[tail.length - 1];
    if (last !== undefined && tail.length >= 2 && !/\d/.test(last)) {
      out.country = last;
      tail = tail.slice(0, -1);
    }
    out.address_lines = tail;
    used.take(el);
    return out;
  };
  return firstOf<ShipTo>(
    "ship_to",
    [
      ["data-component", () => build(comp(scope, "shippingAddress") as DomElement)],
      [
        "label",
        () => {
          for (const h of qa(scope, "h1, h2, h3, h4, h5, h6, b, strong, span.a-text-bold")) {
            if (
              !/^(ship(ping)? to|ship(ping)? address|deliver(y)? to|pick ?up (at|location))/i.test(
                text(h),
              )
            ) {
              continue;
            }
            const box = h.parentElement;
            if (box !== null && visible(box)) return build(box);
          }
          return undefined;
        },
      ],
    ],
    meta,
    { optional: true },
  );
}

export function parsePayment(
  scope: DomElement,
  used: Consumption,
  meta: ParseMeta,
): PaymentSummary {
  const payment: PaymentSummary = { methods: [], lines: [], actions: [], other_lines: [] };
  const widget = firstOf<DomElement>(
    "payment",
    [
      ["data-component", () => comp(scope, "viewPaymentPlanSummaryWidget")],
      ["data-component", () => comp(scope, "aapiPaymentMethods")],
      ["aria-label", () => q(scope, "[aria-label='payment method list']")],
      [
        "label",
        () => {
          for (const h of qa(scope, "h1, h2, h3, h4, h5, h6, b, strong, span.a-text-bold")) {
            if (/^payment (method|information)s?\b/i.test(text(h))) {
              const box = h.parentElement;
              if (box !== null && visible(box)) return box;
            }
          }
          return undefined;
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (widget === undefined) return payment;

  const methodEls = qa(widget, "[aria-label='payment method']");
  const instruments = methodEls.length > 0 ? methodEls : [widget];
  for (const inst of instruments) {
    const message = q(inst, "[data-testid='payment-instrument-message']");
    const label = redactDigits(
      text(message) ||
        textLines(inst).find((l) =>
          /\bvisa|master|amex|express|discover|gift|ending|[\u2022*]{2,}/i.test(l),
        ) ||
        "",
    );
    const federated = qa(inst, "[data-testid='federated-feature-detail-item']").map((e) =>
      redactDigits(text(e)),
    );
    const features = qa(inst, "[data-testid='payment-instrument-feature-detail']").map((e) =>
      redactDigits(text(e)),
    );
    const details = [...features, ...federated].filter((d) => d !== "");
    if (label === "" && details.length === 0) continue;
    const card = parseCard(label);
    const lower = label.toLowerCase();
    const method: PaymentMethod = {
      type:
        card.last4 !== undefined || card.card_brand !== undefined
          ? "card"
          : /gift card/.test(lower)
            ? "gift_card"
            : /reward|points/.test(lower)
              ? "rewards"
              : /bank|checking|savings|debit/.test(lower)
                ? "bank"
                : "other",
      label,
      details,
      ...card,
    };
    payment.methods.push(method);
    for (const d of federated) {
      const money = parseMoney(d);
      payment.lines.push({ label: d, raw: d, ...(money !== undefined ? { amount: money } : {}) });
    }
  }
  if (payment.methods.length === 0) {
    // Text-only block: keep the visible lines as one unclassified method.
    const lines = textLines(widget)
      .map(redactDigits)
      .filter((l) => !/^payment method/i.test(l));
    if (lines.length > 0) {
      const card = parseCard(lines[0] ?? "");
      payment.methods.push({
        type: card.last4 !== undefined || card.card_brand !== undefined ? "card" : "other",
        label: lines[0] ?? "",
        details: lines.slice(1),
        ...card,
      });
    }
  }
  const first = payment.methods.find((m) => m.type === "card");
  if (first?.card_brand !== undefined) payment.card_brand = first.card_brand;
  if (first?.last4 !== undefined) payment.last4 = first.last4;
  for (const b of qa(widget, "button, a[href]")) {
    const label = text(b) || attr(b, "aria-label") || "";
    // The "terms" link sits inside a feature detail already captured above.
    if (label !== "" && !payment.methods.some((m) => m.details.some((d) => d.includes(label)))) {
      payment.actions.push(label);
    }
  }
  // Anything else the block shows is kept, never dropped.
  const covered = [
    ...payment.methods.flatMap((m) => [m.label, ...m.details]),
    ...payment.actions,
    ...qa(widget, "h1, h2, h3, h4, h5, h6").map((h) => text(h)),
  ].join(" | ");
  for (const line of textLines(widget).map(redactDigits)) {
    if (!covered.includes(line)) payment.other_lines.push(line);
  }
  used.take(widget);
  return payment;
}

export function parseTotals(scope: DomElement, used: Consumption, meta: ParseMeta): ChargeLine[] {
  const lines = firstOf<ChargeLine[]>(
    "totals",
    [
      [
        "data-component",
        () => {
          const els = [comp(scope, "chargeSummary"), comp(scope, "tips")].filter(
            (e): e is DomElement => e !== undefined,
          );
          const rows = els.flatMap((e) => qa(e, ".od-line-item-row"));
          const out = chargeRows(rows, used, meta);
          for (const e of els) {
            const h = q(e, "h1, h2, h3, h4, h5, h6");
            if (h !== undefined) used.take(h);
          }
          return out;
        },
      ],
      [
        "id",
        () => {
          const box = q(scope, "#od-subtotals");
          return chargeRows(qa(box, ".od-line-item-row, .a-row"), used, meta);
        },
      ],
      [
        "text-anchor",
        () => {
          const rows = qa(scope, ".od-line-item-row");
          return chargeRows(rows, used, meta);
        },
      ],
    ],
    meta,
  );
  return lines ?? [];
}

export interface ItemCtx {
  placedIso?: string;
}

function itemFromGrid(
  _right: DomElement,
  rootEl: DomElement,
  shipmentKind: ShipmentKind,
  shipmentStatus: string | undefined,
  used: Consumption,
  meta: ParseMeta,
  ctx: ItemCtx,
): OrderItem | undefined {
  const titleEl = firstOf<DomElement>(
    "title",
    [
      ["data-component", () => q(comp(rootEl, "itemTitle"), "a[href], span")],
      [
        "text-anchor",
        () => qa(rootEl, "a[href*='/dp/'], a[href*='/gp/product/']").find((a) => text(a) !== ""),
      ],
    ],
    meta,
  );
  const titleScope = titleEl?.closest("[data-component='itemTitle']") ?? titleEl;
  const title = text(titleScope ?? undefined);
  if (title === "") return undefined;
  used.take(titleScope);

  const imageLink = q(comp(rootEl, "itemImage"), "a[href]");
  const asin = firstOf<string>(
    "asin",
    [
      ["link", () => asinFromHref(attr(titleEl?.closest("a") ?? titleEl, "href"))],
      ["image-link", () => asinFromHref(attr(imageLink, "href"))],
      ["data-attr", () => attr(rootEl.closest("[data-asin]") ?? undefined, "data-asin")],
      [
        "text-anchor",
        () => asinFromHref(attr(q(rootEl, "a[href*='/dp/'], a[href*='/gp/product/']"), "href")),
      ],
    ],
    meta,
  );
  used.take(comp(rootEl, "itemImage"));

  const item: OrderItem = {
    title,
    quantity: 1,
    extras: {},
    actions: [],
    links: [],
  };
  if (asin !== undefined) {
    item.asin = asin;
    item.url_path = `/dp/${asin}`;
  }

  const qty = firstOf<number>(
    "quantity",
    [
      [
        "data-component",
        () => {
          const el = comp(rootEl, "quantity");
          const n = /\d+/.exec(text(el))?.[0];
          if (n !== undefined) used.take(el);
          return n === undefined ? undefined : Number(n);
        },
      ],
      [
        "class",
        () => {
          const el = q(rootEl.closest(".a-fixed-left-grid") ?? rootEl, ".od-item-view-qty");
          const n = /\d+/.exec(text(el))?.[0];
          if (n !== undefined) used.take(el);
          return n === undefined ? undefined : Number(n);
        },
      ],
      [
        "text-anchor",
        () => {
          const n = /\b(?:Qty|Quantity)\s*:?\s*(\d+)/i.exec(text(rootEl))?.[0];
          return n === undefined ? undefined : Number(/\d+/.exec(n)?.[0]);
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (qty !== undefined && qty > 0) item.quantity = qty;
  used.take(comp(rootEl, "quantity"));

  const priceEl = comp(rootEl, "unitPrice");
  const price = firstOf<Money>(
    "price",
    [
      ["data-component", () => moneyFromPriceElement(q(priceEl, ".a-price") ?? priceEl)],
      ["class", () => moneyFromPriceElement(q(rootEl, ".a-price, .a-color-price"))],
    ],
    meta,
    { optional: true },
  );
  if (price !== undefined) item.price = price;
  used.take(priceEl);
  if (price !== undefined && priceEl === undefined)
    used.take(q(rootEl, ".a-price, .a-color-price"));

  // seller
  const merchantEl = comp(rootEl, "orderedMerchant");
  const seller = firstOf<{ name: string; id?: string }>(
    "seller",
    [
      [
        "data-component",
        () => {
          const a = q(merchantEl, "a[href]");
          const name = text(a) || afterLabel(text(merchantEl), /^(sold|supplied|shipped) by:?/i);
          if (name === "") return undefined;
          const id = /[?&]seller=([A-Z0-9]+)/.exec(attr(a, "href") ?? "")?.[1];
          return id === undefined ? { name } : { name, id };
        },
      ],
      [
        "text-anchor",
        () => {
          const m = /Sold by:?\s*(.+?)(?:\s{2,}|$)/i.exec(text(rootEl));
          return m?.[1] === undefined ? undefined : { name: collapse(m[1]) };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (seller !== undefined) {
    item.seller = seller.name;
    if (seller.id !== undefined) item.seller_id = seller.id;
  }
  used.take(merchantEl);

  const condEl = comp(rootEl, "itemCondition");
  const cond = afterLabel(text(condEl), /^condition:?/i);
  if (cond !== "") item.condition = cond;
  else {
    const m = /Condition:\s*([A-Za-z][A-Za-z -]*)/.exec(text(rootEl));
    if (m?.[1] !== undefined) item.condition = collapse(m[1]);
  }
  used.take(condEl);

  // return window
  const retEl = comp(rootEl, "itemReturnEligibility");
  const retText = text(retEl);
  if (retText !== "") {
    const rw: ReturnWindow = { text: retText };
    if (
      /eligible|available|until|through/i.test(retText) &&
      !/not eligible|no longer|closed|ended|expired/i.test(retText)
    ) {
      rw.eligible = true;
    } else if (/not eligible|no longer|closed|ended|expired|ineligible/i.test(retText)) {
      rw.eligible = false;
    }
    const d = findDates(retText, ctx.placedIso)[0];
    if (d !== undefined) rw.through = d;
    item.return_window = rw;
  }
  used.take(retEl);

  // plain text components kept under extras
  const EXTRA_COMPONENTS: readonly [string, string][] = [
    ["substitutionDetails", "substitution"],
    ["serviceAppointmentStatus", "service_appointment"],
    ["associatedOrdersForService", "associated_orders"],
    ["deliveryFrequency", "delivery_frequency"],
    ["healthBenefitAccountInformation", "health_benefit_account"],
    ["paidInInstallmentsInformation", "installments"],
    ["customizedItemDetails", "customization"],
    ["purchasedVariationDetails", "variation"],
    ["supplierOfRecord", "supplier_of_record"],
    ["itemStatus", "status_text"],
  ];
  for (const [name, key] of EXTRA_COMPONENTS) {
    const el = comp(rootEl, name);
    const t = redactCodes(text(el));
    if (t !== "") item.extras[key] = t;
    used.take(el);
  }

  // gift components
  const giftParts: Record<string, string> = {};
  for (const [name, key] of [
    ["giftcardsSender", "sender"],
    ["giftMessage", "message"],
    ["giftCardDetails", "details"],
  ] as const) {
    const el = comp(rootEl, name);
    const t = redactCodes(text(el));
    if (t !== "") giftParts[key] = t;
    used.take(el);
  }
  const shareable = comp(rootEl, "giftCardShareableLink");
  const shareableShown = text(shareable) !== "" || q(shareable, "a[href]") !== undefined;
  used.take(shareable);
  if (Object.keys(giftParts).length > 0 || shareableShown) {
    item.gift = { ...giftParts, ...(shareableShown ? { shareable_link_shown: true } : {}) };
  }

  // item-level buttons (itemConnections)
  const conn = classifyControls(comp(rootEl, "itemConnections"), used);
  item.actions.push(...conn.actions);
  item.links.push(...conn.links);

  // per-item status: explicit component text, else inherited when the shipment is in a
  // cancelled / refund / return state
  const explicit = item.extras.status_text;
  if (explicit !== undefined) item.status = explicit;
  else if (
    shipmentStatus !== undefined &&
    (shipmentKind === "cancelled" ||
      shipmentKind === "refunded" ||
      shipmentKind === "returned" ||
      shipmentKind === "replaced")
  ) {
    item.status = shipmentStatus;
  }
  return item;
}

function parseStatus(
  statusEl: DomElement | undefined,
  used: Consumption,
  meta: ParseMeta,
  ctx: ItemCtx,
): ShipmentStatus | undefined {
  if (statusEl === undefined) return undefined;
  const primaryEl = q(statusEl, "h1, h2, h3, h4, h5, .od-status-message, .a-text-bold");
  const trigger = q(statusEl, "a.a-popover-trigger");
  const declarative =
    trigger?.parentElement?.closest("[data-a-popover]") ??
    trigger?.closest("[data-a-popover]") ??
    trigger;
  const exclude = (e: DomElement): boolean => e === primaryEl || e === declarative;
  const raw = text(primaryEl) || textLines(statusEl)[0] || "";
  if (raw === "") return undefined;
  const detail = text(statusEl, { exclude });
  const status: ShipmentStatus = { raw, kind: classifyStatus(raw) };
  if (status.kind === "unknown" && detail !== "") {
    const k = classifyStatus(detail);
    if (k !== "unknown") status.kind = k;
  }
  if (detail !== "") status.detail = detail;
  const dates = findDates(raw, ctx.placedIso);
  const first = dates[0];
  if (first !== undefined) status.date = first;
  const second = dates[1];
  if (second !== undefined) status.date_end = second;
  if (trigger !== undefined) {
    status.help_label = text(trigger);
    const doc = popoverDoc(declarative ?? trigger, meta);
    const help = doc === undefined ? "" : text(doc as DomElement);
    if (help !== "") status.help_text = help;
  }
  used.take(statusEl);
  return status;
}

function trackingFrom(
  status: ShipmentStatus | undefined,
  links: readonly ReadLink[],
): Shipment["tracking"] {
  const link = links.find((l) => l.kind === "tracking");
  const blob = collapse(`${status?.raw ?? ""} ${status?.detail ?? ""}`);
  const carrier =
    /Carrier\s*:?\s*([A-Za-z][A-Za-z0-9 .&-]{1,30}?)(?=\s+Tracking|\s*[|;,]|$)/.exec(blob)?.[1] ??
    /(?:Shipped|Delivered)\s+(?:with|by|via)\s+([A-Za-z][A-Za-z0-9 .&-]{1,25}?)(?=\s*[.|;,]|$)/.exec(
      blob,
    )?.[1];
  const id = /Tracking\s*(?:ID|number|#|no\.?)\s*:?\s*([A-Z0-9]{8,30})/i.exec(blob)?.[1];
  if (link === undefined && carrier === undefined && id === undefined) return undefined;
  const out: NonNullable<Shipment["tracking"]> = { path: link?.path ?? "" };
  if (carrier !== undefined) out.carrier = collapse(carrier);
  if (id !== undefined) out.tracking_id = id;
  return out;
}

export function parseShipments(
  scope: DomElement,
  used: Consumption,
  meta: ParseMeta,
  ctx: ItemCtx,
): Shipment[] {
  type Unit = { box: DomElement; status?: DomElement; items: DomElement[]; conn?: DomElement };
  const modern = (): Unit[] | undefined => {
    const root = comp(scope, "shipments") ?? comp(scope, "orderCard");
    if (root === undefined) return undefined;
    const itemRoots = qa(root, "[data-component='purchasedItemsRightGrid']");
    const boxes: DomElement[] = [];
    for (const r of itemRoots) {
      const box = r.closest(".a-box") ?? comp(root, "shipments") ?? root;
      if (!boxes.includes(box)) boxes.push(box);
    }
    if (boxes.length === 0) {
      for (const s of qa(root, "[data-component='shipmentStatus']")) {
        const box = s.closest(".a-box") ?? root;
        if (!boxes.includes(box)) boxes.push(box);
      }
    }
    if (boxes.length === 0) return undefined;
    return boxes.map((box) => ({
      box,
      status: comp(box, "shipmentStatus"),
      items: qa(box, "[data-component='purchasedItemsRightGrid']"),
      conn: comp(box, "shipmentConnections"),
    }));
  };
  const legacy = (): Unit[] | undefined => {
    const boxes = qa(scope, ".shipment, .a-box.shipment");
    const units: Unit[] = [];
    for (const box of boxes) {
      const grids = qa(box, ".a-fixed-left-grid").filter(
        (g) =>
          q(g, "a[href*='/dp/'], a[href*='/gp/product/']") !== undefined &&
          qa(g, ".a-fixed-left-grid").length === 0,
      );
      if (grids.length === 0) continue;
      units.push({
        box,
        status: q(
          box,
          ".shipment-top-row, .yohtmlc-shipment-status-primaryText, .js-shipment-info-container",
        ),
        items: grids,
        conn: q(box, ".yohtmlc-shipment-level-connections, .a-button-stack"),
      });
    }
    return units.length > 0 ? units : undefined;
  };
  const units = firstOf<Unit[]>(
    "shipments",
    [
      ["data-component", modern],
      ["class", legacy],
      [
        "text-anchor",
        () => {
          // Last resort: every product link outside recommendation carousels, as one shipment.
          const links = qa(scope, "a[href*='/dp/'], a[href*='/gp/product/']").filter(
            (a) =>
              text(a) !== "" &&
              a.closest(".a-carousel-container, [data-component='personalization']") === null,
          );
          if (links.length === 0) return undefined;
          const grids = uniq(
            links.map((a) => a.closest(".a-fixed-left-grid") ?? a.parentElement ?? a),
          );
          return [{ box: scope, items: grids }];
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (units === undefined) return [];

  const out: Shipment[] = [];
  for (const unit of units) {
    const sub = newMeta();
    const status = parseStatus(unit.status, used, sub, ctx);
    // legacy status rows carry the label in plain text
    const kind = status?.kind ?? "unknown";
    const items: OrderItem[] = [];
    for (const r of unit.items) {
      const rootEl = r.closest(".a-fixed-left-grid") ?? r;
      const it = itemFromGrid(r, rootEl, kind, status?.raw, used, sub, ctx);
      if (it !== undefined) items.push(it);
    }
    const controls = classifyControls(unit.conn, used);
    const shipment: Shipment = {
      items,
      links: controls.links,
      actions: controls.actions,
    };
    if (status !== undefined) shipment.status = status;
    const tracking = trackingFrom(status, controls.links);
    if (tracking !== undefined) shipment.tracking = tracking;
    mergeMeta(meta, sub, `shipments`);
    out.push(shipment);
  }
  return out;
}

export function parseOrderTypes(
  scope: DomElement,
  orderId: string | undefined,
  shipments: readonly Shipment[],
  used: Consumption,
): { types: string[]; brand?: string } {
  const types: string[] = [];
  const brandEl = comp(scope, "brandLogo");
  const brand = collapse(
    text(brandEl) ||
      attr(q(brandEl, "img[alt]"), "alt") ||
      attr(q(brandEl, "[aria-label]"), "aria-label") ||
      "",
  );
  used.take(brandEl);
  // Item titles are excluded: a branded product must not mark the whole order.
  const body = [
    comp(scope, "orderCard"),
    comp(scope, "orderSummary"),
    comp(scope, "briefOrderInfoInvoice"),
  ]
    .map((e) => text(e, { exclude: (x) => x.matches("[data-component='itemTitle']") }))
    .join(" ");
  const hay = `${brand} ${body}`;
  if (
    /subscribe\s*(&|and)\s*save/i.test(hay) ||
    shipments.some((s) => s.items.some((i) => i.extras.delivery_frequency !== undefined))
  ) {
    types.push("subscribe_and_save");
  }
  if (/amazon fresh/i.test(hay)) types.push("fresh");
  if (/whole foods/i.test(hay)) types.push("whole_foods");
  if (/pantry/i.test(brand)) types.push("pantry");
  if (/^D\d{2}-/.test(orderId ?? "") || /digital order/i.test(hay)) types.push("digital");
  if (shipments.some((s) => s.items.some((i) => i.gift !== undefined))) types.push("gift");
  if (text(comp(scope, "poNumber")) !== "") types.push("business");
  if (text(comp(scope, "sharedOrderBuyer")) !== "") types.push("shared");
  return brand === "" ? { types } : { types, brand };
}

export const parseOrderDetails: Parser<OrderDetails> = (capture) => {
  const meta = newMeta();
  const used = new Consumption();
  const { doc } = parseCapture(capture);
  const main = q(doc, "[role=main]") ?? q(doc, "#orderDetails") ?? doc.body;
  const scope = q(main, "#orderDetails") ?? main;

  const banner = errorBanner(scope);
  const hasContent =
    comp(scope, "shipments") !== undefined ||
    comp(scope, "orderSummary") !== undefined ||
    comp(scope, "purchasedItems") !== undefined ||
    q(scope, ".shipment") !== undefined;
  if (banner !== undefined && !hasContent) {
    throw new RfError("layout_unrecognized", "order details page shows an error banner", {
      details: { reason: "error_banner", heading: banner.heading },
    });
  }

  // order id
  const order_id = firstOf<string>(
    "order_id",
    [
      ["data-component", () => ORDER_ID_RE.exec(text(comp(scope, "orderId")))?.[1]],
      ["text-anchor", () => orderIdFromText(text(scope))],
      ["url", () => orderIdFromUrl(capture.final_url) ?? orderIdFromUrl(capture.url)],
    ],
    meta,
  );
  used.take(comp(scope, "orderId"));
  used.take(comp(scope, "orderIdLabel"));

  // placed
  const placedEl = comp(scope, "orderDate");
  const placed = firstOf<DateValue>(
    "placed",
    [
      ["data-component", () => findDates(text(placedEl))[0]],
      [
        "text-anchor",
        () => {
          const m = /Order\s+placed:?\s*(.{0,40})/i.exec(text(scope));
          return m?.[1] === undefined ? undefined : findDates(m[1])[0];
        },
      ],
    ],
    meta,
  );
  used.take(placedEl);
  used.take(comp(scope, "orderDateLabel"));
  const ctx: ItemCtx = placed?.iso === undefined ? {} : { placedIso: placed.iso };

  // chrome of the block: breadcrumb and title
  used.take(comp(scope, "breadcrumb"));
  used.take(comp(scope, "orderDetailsTitle"));
  used.take(comp(scope, "printODTitle"));

  const ship_to = parseShipTo(scope, used, meta);
  const payment = parsePayment(scope, used, meta);
  const totals = parseTotals(scope, used, meta);
  const shipments = parseShipments(scope, used, meta, ctx);

  // order-level controls: invoice link and friends
  const invoiceBox = comp(scope, "orderInvoice");
  const orderControls = classifyControls(invoiceBox, used);
  const links = [...orderControls.links];
  const actions = [...orderControls.actions];

  const swept = sweepButtons(scope, used);
  for (const l of swept.links) if (!links.some((x) => x.path === l.path)) links.push(l);
  for (const a of swept.actions) if (!actions.some((x) => x.label === a.label)) actions.push(a);

  const po = afterLabel(text(comp(scope, "poNumber")), /^(po|purchase order)( number| #)?:?/i);
  used.take(comp(scope, "poNumber"));
  const sharedBuyer = text(comp(scope, "sharedOrderBuyer"));
  used.take(comp(scope, "sharedOrderBuyer"));
  const notices: string[] = [];
  for (const name of ["alerts", "debugBanner", "aapiDebug"]) {
    const el = comp(scope, name);
    const t = text(el);
    if (t !== "") notices.push(t);
    used.take(el);
  }
  const cancelledEl = comp(scope, "cancelled");
  const cancellation = text(cancelledEl);
  used.take(cancelledEl);

  const { types, brand } = parseOrderTypes(scope, order_id, shipments, used);

  // returns and refunds, derived from shipment status plus the order-level refund total
  const returns_and_refunds: ReturnRefund[] = [];
  shipments.forEach((s, index) => {
    const st = s.status;
    const link = s.links.find((l) => l.kind === "return_status");
    const interesting =
      st !== undefined &&
      (st.kind === "cancelled" ||
        st.kind === "refunded" ||
        st.kind === "returned" ||
        st.kind === "replaced");
    if (!interesting && link === undefined) return;
    const blob = `${st?.raw ?? ""} ${st?.detail ?? ""}`;
    const entry: ReturnRefund = {
      scope: "shipment",
      shipment_index: index,
      status: st?.raw ?? "",
      asins: s.items.map((i) => i.asin).filter((a): a is string => a !== undefined),
      amounts: findMoneyAll(blob),
      dates: findDates(blob, ctx.placedIso),
    };
    if (st?.detail !== undefined) entry.detail = st.detail;
    if (st?.help_text !== undefined) entry.help_text = st.help_text;
    if (link !== undefined) entry.status_path = link.path;
    returns_and_refunds.push(entry);
  });
  const refundLine = totals.find((l) => l.type === "refund_total");
  if (refundLine !== undefined || cancellation !== "") {
    const entry: ReturnRefund = {
      scope: "order",
      status: refundLine !== undefined ? refundLine.label : "Cancelled",
      asins: [],
      amounts: [],
      dates: [],
    };
    if (refundLine?.amount !== undefined) entry.refund_total = refundLine.amount;
    if (refundLine?.breakdown !== undefined) entry.breakdown = refundLine.breakdown;
    if (cancellation !== "") {
      entry.detail = cancellation;
      entry.amounts = findMoneyAll(cancellation);
      entry.dates = findDates(cancellation, ctx.placedIso);
    }
    returns_and_refunds.push(entry);
  }

  const kinds = uniq(
    shipments.map((s) => s.status?.kind).filter((k): k is ShipmentKind => k !== undefined),
  );
  const summary = uniq(
    shipments.map((s) => s.status?.raw).filter((r): r is string => r !== undefined),
  ).join(" / ");

  const data: OrderDetails = {
    status: { summary, kinds },
    order_types: types,
    payment,
    totals,
    shipments,
    returns_and_refunds,
    notices,
    links,
    actions,
  };
  if (order_id !== undefined) data.order_id = order_id;
  if (placed !== undefined) data.placed = placed;
  if (brand !== undefined) data.brand = brand;
  if (po !== "") data.po_number = po;
  if (sharedBuyer !== "") data.shared_order_buyer = sharedBuyer;
  if (ship_to !== undefined) data.ship_to = ship_to;
  if (cancellation !== "") data.cancellation = cancellation;

  if (order_id === undefined && shipments.length === 0 && totals.length === 0) {
    throw new RfError("layout_unrecognized", "order details page has no recognizable content");
  }
  if (shipments.length === 0) meta.warnings.push("shipments: none found");

  const report = losslessReport(doc, used, {
    root: main,
    blockSelector: `${DEFAULT_BLOCK_SELECTOR}, [data-component]`,
  });
  meta.unparsed_text_chars = report.counts.unparsed;
  const other_sections: OtherSection[] = report.sections;
  const result: ParseResult<OrderDetails> = { data, other_sections, meta };
  return result;
};

export function findMoneyAll(s: string): Money[] {
  const out: Money[] = [];
  for (const m of s.matchAll(/-?\$\s?\d[\d,]*(?:\.\d{1,2})?/g)) {
    const money = parseMoney(m[0]);
    if (money !== undefined) out.push(money);
  }
  return out;
}
