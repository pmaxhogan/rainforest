/**
 * DOM layer: parse capture HTML with linkedom and read it through helpers that honor the
 * in-page visibility marker. Every helper is pure and tolerant: a missing element yields
 * undefined / "" / [], never an exception.
 *
 * The root tsconfig carries no DOM lib (other packages must not see browser globals), so
 * this module declares the small structural slice of the DOM it uses and casts once at the
 * linkedom boundary.
 */
import { DOMParser } from "linkedom";
import { HIDDEN_ATTR } from "@rainforest/core";
import type { Capture } from "@rainforest/core";

export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly parentNode: DomNode | null;
  readonly childNodes: ArrayLike<DomNode>;
  readonly textContent: string | null;
}

export interface DomElement extends DomNode {
  readonly tagName: string;
  readonly localName: string;
  readonly id: string;
  readonly parentElement: DomElement | null;
  readonly children: ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  matches(selector: string): boolean;
  closest(selector: string): DomElement | null;
}

export interface DomDocument extends DomNode {
  readonly documentElement: DomElement;
  readonly body: DomElement;
  readonly head: DomElement | null;
  readonly title: string;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

/** Anything a query can start from. */
export type DomRoot = DomDocument | DomElement;

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/** Tags whose content is never rendered as page text. */
export const INVISIBLE_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "title",
  "meta",
  "link",
]);

/** Tags that start a new line of text: a separator goes around them when text is joined. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const HAS_BODY = /<body[\s>]/i;

/** Make sure the source has html and body elements; linkedom does not infer them. */
function normalizeSource(html: string): string {
  if (!HTML_OPEN.test(html)) {
    return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  }
  if (HAS_BODY.test(html)) return html;
  const headEnd = /<\/head\s*>/i.exec(html);
  const open = headEnd ?? (HTML_OPEN.exec(html) as RegExpExecArray);
  const at = open.index + open[0].length;
  let rest = html.slice(at);
  const close = /<\/html\s*>/i.exec(rest);
  rest =
    close === null
      ? `${rest}</body>`
      : `${rest.slice(0, close.index)}</body>${rest.slice(close.index)}`;
  return `${html.slice(0, at)}<body>${rest}`;
}

/**
 * Parse an HTML string into a document. Fragments (no `<html>` element, the usual shape of
 * an ajax fragment), body-less documents and empty input are normalized first, because
 * linkedom otherwise promotes the first element to documentElement or leaves content
 * outside `body`.
 */
export function parseDocument(html: string): DomDocument {
  return new DOMParser().parseFromString(
    normalizeSource(html),
    "text/html",
  ) as unknown as DomDocument;
}

export interface ParsedCapture {
  doc: DomDocument;
  fragments: Record<string, DomDocument>;
}

/** Parse a capture's main document and every fragment. */
export function parseCapture(capture: Capture): ParsedCapture {
  const fragments: Record<string, DomDocument> = {};
  for (const [name, html] of Object.entries(capture.fragments ?? {})) {
    fragments[name] = parseDocument(html);
  }
  return { doc: parseDocument(capture.html), fragments };
}

export function isElement(node: DomNode | null | undefined): node is DomElement {
  return node != null && node.nodeType === ELEMENT_NODE;
}

/** True when this element itself (ignoring ancestors) is hidden or a non-rendering tag. */
export function hiddenSelf(el: DomElement): boolean {
  return INVISIBLE_TAGS.has(el.localName) || el.getAttribute(HIDDEN_ATTR) === "1";
}

/**
 * False if the element or any ancestor carries the hidden marker or is a non-rendering tag
 * (script, style, noscript, template, head).
 */
export function visible(el: DomElement | null | undefined): boolean {
  if (el == null) return false;
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (hiddenSelf(cur)) return false;
  }
  return true;
}

/** First visible element matching the selector, or undefined. Invalid selectors yield undefined. */
export function q(root: DomRoot | null | undefined, selector: string): DomElement | undefined {
  return qa(root, selector)[0];
}

/** All visible elements matching the selector, in document order. */
export function qa(root: DomRoot | null | undefined, selector: string): DomElement[] {
  if (root == null) return [];
  let found: ArrayLike<DomElement>;
  try {
    found = root.querySelectorAll(selector);
  } catch {
    return [];
  }
  return Array.from(found).filter((el) => visible(el));
}

/** Collapse runs of whitespace (including non-breaking spaces) to one space and trim. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export interface TextOptions {
  /** Skip any subtree whose root satisfies this (for example consumed elements). */
  exclude?: (el: DomElement) => boolean;
}

/**
 * Normalized visible text of an element: hidden descendants skipped, block boundaries
 * separated by a space, whitespace collapsed. Returns "" for a missing or hidden element.
 */
export function text(el: DomElement | null | undefined, opts: TextOptions = {}): string {
  if (el == null || !visible(el)) return "";
  const parts: string[] = [];
  appendText(el, parts, opts.exclude);
  return collapse(parts.join(""));
}

function appendText(
  node: DomNode,
  parts: string[],
  exclude: ((el: DomElement) => boolean) | undefined,
): void {
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as DomNode;
    if (child.nodeType === TEXT_NODE) {
      parts.push(child.textContent ?? "");
    } else if (isElement(child)) {
      if (hiddenSelf(child) || (exclude !== undefined && exclude(child))) continue;
      const block = BLOCK_TAGS.has(child.localName);
      if (block) parts.push(" ");
      appendText(child, parts, exclude);
      if (block) parts.push(" ");
    }
  }
}

/** Trimmed attribute value, or undefined when the element or attribute is missing. */
export function attr(el: DomElement | null | undefined, name: string): string | undefined {
  if (el == null) return undefined;
  const v = el.getAttribute(name);
  return v == null ? undefined : v.trim();
}

/**
 * Visible rows of a table as cell text. Rows of nested tables are excluded (they belong
 * to the inner table); rows with no non-empty cell are dropped.
 */
export function tableToRows(
  table: DomElement | null | undefined,
  opts: TextOptions = {},
): string[][] {
  if (table == null || !visible(table)) return [];
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    if (tr.closest("table") !== table || !visible(tr)) continue;
    if (opts.exclude !== undefined && excludedWithin(tr, table, opts.exclude)) continue;
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      if (cell.localName !== "td" && cell.localName !== "th") continue;
      if (hiddenSelf(cell)) continue;
      cells.push(text(cell, opts));
    }
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  return rows;
}

/** True if `el` or an ancestor below `stop` (exclusive) satisfies `exclude`. */
export function excludedWithin(
  el: DomElement,
  stop: DomElement,
  exclude: (el: DomElement) => boolean,
): boolean {
  for (let cur: DomElement | null = el; cur != null && cur !== stop; cur = cur.parentElement) {
    if (exclude(cur)) return true;
  }
  return false;
}

export interface Link {
  text: string;
  href: string;
}

export interface LinkOptions extends TextOptions {
  /** Resolve relative hrefs against this URL. */
  base?: string;
}

/**
 * Visible links inside an element (the element itself counts if it is a link). Text falls
 * back to aria-label, then image alt. Empty, fragment-only and javascript: hrefs are dropped.
 */
export function links(el: DomElement | null | undefined, opts: LinkOptions = {}): Link[] {
  if (el == null || !visible(el)) return [];
  const anchors = el.localName === "a" ? [el] : [];
  anchors.push(...Array.from(el.querySelectorAll("a[href]")));
  const out: Link[] = [];
  for (const a of anchors) {
    if (!visible(a)) continue;
    if (opts.exclude !== undefined && excludedWithin(a, el, opts.exclude) && a !== el) continue;
    const raw = attr(a, "href");
    if (raw === undefined || raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) {
      continue;
    }
    let href = raw;
    if (opts.base !== undefined) {
      try {
        href = new URL(raw, opts.base).toString();
      } catch {
        href = raw;
      }
    }
    const label =
      text(a, opts) || attr(a, "aria-label") || attr(a.querySelector("img[alt]"), "alt") || "";
    out.push({ text: label, href });
  }
  return out;
}

// ---- money

export interface Money {
  amount: number;
  /** ISO 4217 code. */
  currency: string;
  /** The matched source text. */
  raw: string;
}

export interface MoneyRange {
  low: Money;
  high: Money;
  raw: string;
}

/** Currency tokens, longest first so "US$" wins over "$". */
const CURRENCY_TOKENS: readonly (readonly [string, string])[] = [
  ["US$", "USD"],
  ["CDN$", "CAD"],
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["$", "USD"],
  ["\u00a3", "GBP"],
  ["\u20ac", "EUR"],
  ["\u00a5", "JPY"],
  ["USD", "USD"],
  ["CAD", "CAD"],
  ["GBP", "GBP"],
  ["EUR", "EUR"],
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SYMBOL_RE = CURRENCY_TOKENS.map(([t]) => escapeRe(t)).join("|");
const NUMBER_RE = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";
/** sign? symbol number  |  sign? number code */
const MONEY_RE = new RegExp(
  `([-\\u2212])?\\s*(${SYMBOL_RE})\\s*${NUMBER_RE}|([-\\u2212])?${NUMBER_RE}\\s*(USD|CAD|GBP|EUR)\\b`,
  "g",
);
const BARE_RE = new RegExp(`([-\\u2212])?${NUMBER_RE}`, "g");

function currencyOf(token: string): string {
  for (const [t, code] of CURRENCY_TOKENS) if (t === token) return code;
  return "USD";
}

function toAmount(whole: string, fraction: string | undefined, negative: boolean): number {
  const n = Number(`${whole.replace(/,/g, "")}.${fraction ?? "0"}`);
  return negative ? -n : n;
}

export interface MoneyOptions {
  /** Currency for bare numbers ("12.99"); without it a bare number is not money. */
  defaultCurrency?: string;
}

/** Every money amount in a string, in order. */
export function findMoney(s: string | null | undefined, opts: MoneyOptions = {}): Money[] {
  if (s == null || s === "") return [];
  const out: Money[] = [];
  for (const m of s.matchAll(MONEY_RE)) {
    if (m[2] !== undefined && m[3] !== undefined) {
      out.push({
        amount: toAmount(m[3], m[4], m[1] !== undefined),
        currency: currencyOf(m[2]),
        raw: m[0].trim(),
      });
    } else if (m[6] !== undefined && m[8] !== undefined) {
      out.push({
        amount: toAmount(m[6], m[7], m[5] !== undefined),
        currency: m[8],
        raw: m[0].trim(),
      });
    }
  }
  if (out.length === 0 && opts.defaultCurrency !== undefined) {
    for (const m of s.matchAll(BARE_RE)) {
      if (m[2] === undefined) continue;
      out.push({
        amount: toAmount(m[2], m[3], m[1] !== undefined),
        currency: opts.defaultCurrency,
        raw: m[0].trim(),
      });
    }
  }
  return out;
}

/** First money amount in a string: "$1,234.56" -> {amount: 1234.56, currency: "USD"}. */
export function parseMoney(
  s: string | null | undefined,
  opts: MoneyOptions = {},
): Money | undefined {
  return findMoney(s, opts)[0];
}

const RANGE_SEP = /^\s*(?:-|\u2013|\u2014|to)\s*/i;

/**
 * A price range such as "$10.99 - $24.99" or "$10 to 20" (the second amount inherits the
 * first currency). A single amount is not a range: returns undefined.
 */
export function parseMoneyRange(s: string | null | undefined): MoneyRange | undefined {
  if (s == null) return undefined;
  const first = parseMoney(s);
  if (first === undefined) return undefined;
  const at = s.indexOf(first.raw);
  const after = s.slice(at + first.raw.length);
  const sep = RANGE_SEP.exec(after);
  if (sep === null) return undefined;
  const tail = after.slice(sep[0].length);
  const second = parseMoney(tail) ?? parseMoney(tail, { defaultCurrency: first.currency });
  if (second === undefined || !tail.startsWith(second.raw)) return undefined;
  const end = at + first.raw.length + sep[0].length + second.raw.length;
  return { low: first, high: second, raw: s.slice(at, end) };
}

/**
 * Money from an Amazon-style price element (`.a-price`). Prefers the offscreen text
 * (`.a-offscreen`, read even when it carries the hidden marker, because it exists only for
 * screen readers), then the split whole / fraction markup, then the element's visible text.
 * Returns undefined when the price element itself is not visible.
 */
export function moneyFromPriceElement(el: DomElement | null | undefined): Money | undefined {
  if (el == null || !visible(el)) return undefined;
  const offscreen = el.querySelector(".a-offscreen");
  const fromOffscreen = parseMoney(collapse(offscreen?.textContent ?? ""));
  if (fromOffscreen !== undefined) return fromOffscreen;
  const wholeEl = el.querySelector(".a-price-whole");
  if (wholeEl !== null) {
    const whole = (wholeEl.textContent ?? "").replace(/[^0-9]/g, "");
    if (whole !== "") {
      const fraction = (el.querySelector(".a-price-fraction")?.textContent ?? "").replace(
        /[^0-9]/g,
        "",
      );
      const symbol = collapse(el.querySelector(".a-price-symbol")?.textContent ?? "") || "$";
      const frac = fraction === "" ? "00" : fraction.slice(0, 2);
      return {
        amount: Number(`${whole}.${frac}`),
        currency: currencyOf(symbol),
        raw: `${symbol}${whole}.${frac}`,
      };
    }
  }
  return parseMoney(text(el));
}

// ---- counts and ratings

export interface Count {
  value: number;
  /** True for "2K+", "1.5M", "over 10,000" style values. */
  approximate: boolean;
  raw: string;
}

const COUNT_RE = /(over |more than |about |~)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([KkMm])?(\+)?/i;

/** Count with its precision: "1,234 ratings" -> 1234 exact, "2K+ bought" -> 2000 approximate. */
export function parseCountDetail(s: string | null | undefined): Count | undefined {
  if (s == null) return undefined;
  const m = COUNT_RE.exec(s);
  if (m === null || m[2] === undefined) return undefined;
  const base = Number(m[2].replace(/,/g, ""));
  const suffix = m[3]?.toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  return {
    value: Math.round(base * mult),
    approximate: m[1] !== undefined || suffix !== undefined || m[4] !== undefined,
    raw: m[0].trim(),
  };
}

/** Integer count from text such as "1,234 ratings" or "(87)"; undefined if none. */
export function parseCount(s: string | null | undefined): number | undefined {
  return parseCountDetail(s)?.value;
}

export interface Rating {
  value: number;
  out_of: number;
}

/** "4.5 out of 5 stars" -> {value: 4.5, out_of: 5}. Values above the scale are rejected. */
export function parseRating(s: string | null | undefined): Rating | undefined {
  if (s == null) return undefined;
  const m = /(\d+(?:\.\d+)?)\s*out of\s*(\d+)/i.exec(s);
  if (m === null || m[1] === undefined || m[2] === undefined) return undefined;
  const value = Number(m[1]);
  const outOf = Number(m[2]);
  if (outOf <= 0 || value > outOf) return undefined;
  return { value, out_of: outOf };
}

/** Star value from an icon class list such as "a-icon a-star-4-5" -> 4.5 (out of 5). */
export function ratingFromClass(className: string | null | undefined): number | undefined {
  if (className == null) return undefined;
  const m = /\ba-star(?:-mini|-medium|-small)?-(\d)(?:-(\d))?\b/.exec(className);
  if (m === null || m[1] === undefined) return undefined;
  const value = Number(m[1]) + (m[2] === undefined ? 0 : Number(m[2]) / 10);
  return value > 5 ? undefined : value;
}
