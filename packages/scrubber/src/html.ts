/**
 * Structure-preserving HTML scrub. The walker keeps tags, ids, classes, data-* attribute
 * names, ARIA roles, form structure and the data-rf-hidden markers, and replaces
 * everything else. It fails closed: any node that is not an element or text is removed,
 * any attribute not on an allowlist has its value scrubbed, any script that is not an
 * allowlisted JSON blob is dropped. Serialization is our own, ASCII-only and fully escaped.
 */
import { parseHTML } from "linkedom";
import {
  ADDRESS_HINT,
  DROPPED_ATTRS,
  DROPPED_ELEMENTS,
  IDREF_ATTRS,
  ID_PREFIXES,
  IMAGE_URL_ATTRS,
  PARSER_CLASS_TOKENS,
  KEPT_VALUE_ATTRS,
  NAME_HINT,
  REDUCE_DROP_HIDDEN_SELECTORS,
  REDUCE_DROP_SELECTORS,
  REDUCE_KEEP_HIDDEN_SELECTORS,
  SAFE_LITERALS,
  URL_ATTRS,
} from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";
import { registerHtmlScrubber, scrubJson, stringifySafe } from "./json.ts";
import { SCRIPT_TYPES } from "./rules.mjs";
import { scrubText, scrubTokens, type TextMode } from "./text.ts";
import { scrubSrcset, scrubUrl } from "./url.ts";

/** The slice of the linkedom DOM this module uses (no DOM lib in tsconfig). */
interface DomAttr {
  name: string;
  value: string;
}
interface DomNode {
  nodeType: number;
  childNodes: ArrayLike<DomNode>;
  parentNode: DomNode | null;
  data?: string;
  localName?: string;
  attributes?: ArrayLike<DomAttr>;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  removeChild(child: DomNode): DomNode;
  textContent: string | null;
}
type DomElement = DomNode & {
  localName: string;
  attributes: ArrayLike<DomAttr>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

const ELEMENT = 1;
const TEXT = 3;

const KEPT = new Set(KEPT_VALUE_ATTRS);
const URLS = new Set(URL_ATTRS);
const IMAGES = new Set(IMAGE_URL_ATTRS);
const DROPPED = new Set(DROPPED_ATTRS);
const DROPPED_EL = new Set(DROPPED_ELEMENTS);
const LITERALS = new Set(SAFE_LITERALS);
const SCRIPTS = new Set(SCRIPT_TYPES);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const PIXEL_SRC = /(?:\/uedata|\/batch\/\d+\/op|\/pixel|beacon|\/1x1|\/gp\/log)/i;
const STATE_KEY = /^[A-Za-z0-9:._-]{1,128}$/;
// JSON, markup, an absolute or relative URL, or a query string: data, not structure.
const IDREFS = new Set(IDREF_ATTRS);
/** Ids of the document being scrubbed (raw values), for IDREF checks. */
let docIds: ReadonlySet<string> = new Set();

const DATA_IN_KEPT = /[{}<>"?=]|:\/\/|^\s*\//;
const HINT_ATTRS = ["id", "class", "data-feature-name", "data-hook", "name", "data-csa-c-slot-id"];

function asElement(n: DomNode): DomElement {
  return n as DomElement;
}

function attrsOf(el: DomElement): DomAttr[] {
  return Array.from(el.attributes, (a) => ({ name: a.name, value: a.value }));
}

function children(n: DomNode): DomNode[] {
  return Array.from(n.childNodes);
}

/** linkedom splits text at entities; merge neighbours so labels match whole nodes. */
function mergeText(parent: DomNode): void {
  let prev: DomNode | null = null;
  for (const c of children(parent)) {
    if (c.nodeType === TEXT && prev !== null && prev.nodeType === TEXT) {
      prev.data = (prev.data ?? "") + (c.data ?? "");
      parent.removeChild(c);
      continue;
    }
    prev = c;
  }
}

function modeFor(el: DomElement, inherited: TextMode): TextMode {
  if (inherited === "name") return inherited;
  const hint = HINT_ATTRS.map((a) => el.getAttribute(a) ?? "").join(" ");
  // A name line inside an address block is still a name.
  if (NAME_HINT.test(hint)) return "name";
  if (inherited === "address" || ADDRESS_HINT.test(hint)) return "address";
  return "text";
}

function isPixel(el: DomElement): boolean {
  const w = el.getAttribute("width");
  const h = el.getAttribute("height");
  if (w !== null && h !== null && Number(w) <= 1 && Number(h) <= 1) return true;
  return PIXEL_SRC.test(el.getAttribute("src") ?? "");
}

const CLASS_KEEP = new Set(PARSER_CLASS_TOKENS);
const FAKE_IN_CLASS = /FAKE|00000000-0000-4000-8000-/;
const EXPERIMENT_RUN = /([_-])(?=[0-9a-f]*[0-9])[0-9a-f]{4,}(?![0-9a-z])|[0-9]{4,}/gi;

/**
 * Experiment, cohort and build tokens in class names ("a-aui_31337-c", "r-4f1e2d0") become a
 * fixed placeholder, unless a parser queries that exact class (PARSER_CLASS_TOKENS).
 */
function placeholderClasses(value: string): string {
  return value
    .split(/(\s+)/)
    .map((c) =>
      CLASS_KEEP.has(c) || FAKE_IN_CLASS.test(c)
        ? c
        : c.replace(EXPERIMENT_RUN, (_m, sep: string | undefined) => `${sep ?? ""}0000`),
    )
    .join("");
}

function scrubAttrValue(
  el: DomElement,
  tag: string,
  name: string,
  value: string,
  ctx: ScrubContext,
): string {
  // A kept attribute is structural only while it looks like one. JSON, a URL or markup in
  // it (an ad iframe's name= carries a whole config blob) is data: generic path below.
  if (name === "id") {
    const prefix = ID_PREFIXES.find((p) => value.startsWith(p) && value.length > p.length);
    if (prefix !== undefined) {
      ctx.count("token");
      return prefix + ctx.fakeToken(value.slice(prefix.length));
    }
  }
  const idrefOk =
    !IDREFS.has(name) ||
    value
      .trim()
      .split(/\s+/)
      .every((t) => t === "" || docIds.has(t));
  if (KEPT.has(name) && idrefOk && !DATA_IN_KEPT.test(value)) {
    // After the identifier pass, so ids inside a class are mapped before any placeholder.
    const kept = scrubTokens(value, ctx);
    return name === "class" ? placeholderClasses(kept) : kept;
  }
  if (URLS.has(name)) {
    if (name === "srcset" || name === "data-srcset") return scrubSrcset(value, ctx);
    const image = IMAGES.has(name) || (name === "href" && tag === "image");
    if (name === "xlink:href" || (name === "href" && value.trim().startsWith("#"))) {
      return scrubUrl(value, ctx, value.trim().startsWith("#") ? "page" : "image");
    }
    return scrubUrl(value, ctx, image ? "image" : "auto");
  }
  const t = value.trim();
  // asin=, data-asin=, data-bookasin=, data-csa-c-asin=: a 10-character value here is an ASIN even when it
  // is an all-digit ISBN.
  const asinAttr = /asins?$/.test(name);
  if (asinAttr && /^[A-Za-z0-9]{10}$/.test(t)) {
    ctx.count("asin");
    return ctx.fakeAsin(t.toUpperCase());
  }
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      ctx.count("json_blob");
      // data-asins='["0123456789", ...]': each element is judged under an asin key.
      return stringifySafe(scrubJson(parsed, ctx, asinAttr ? "asin" : null));
    } catch {
      // Not JSON: fall through to text rules.
    }
  }
  if (LITERALS.has(t.toLowerCase())) return value;
  // A count of the items on the page ("data-saved-item-quantity") is structure parsers
  // cross-check against the items present; the items themselves are synthetic.
  if (/^\d{1,3}$/.test(t) && /item-?(?:quantity|count)$|numitems$/.test(name)) return value;
  if (/^(?:https?:)?\/\//i.test(t)) return scrubUrl(value, ctx, "auto");
  ctx.count("attr_scrubbed");
  return scrubText(value, ctx);
}

function scrubAttributes(el: DomElement, tag: string, ctx: ScrubContext): void {
  for (const { name: rawName, value } of attrsOf(el)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(rawName);
      ctx.count("handler_dropped");
      continue;
    }
    if (DROPPED.has(name) || /[^\x20-\x7e]/.test(rawName)) {
      el.removeAttribute(rawName);
      ctx.count("attr_dropped");
      continue;
    }
    const newName = scrubTokens(rawName, ctx);
    const newValue = scrubAttrValue(el, tag, name, value, ctx);
    if (newName !== rawName) el.removeAttribute(rawName);
    el.setAttribute(newName, newValue);
  }
}

function keepOnly(el: DomElement, names: readonly string[]): void {
  for (const { name } of attrsOf(el)) {
    if (!names.includes(name.toLowerCase())) el.removeAttribute(name);
  }
}

/** Returns false when the script must be dropped. */
function scrubScript(el: DomElement, ctx: ScrubContext): boolean {
  const type = (el.getAttribute("type") ?? "").trim().toLowerCase();
  if (!SCRIPTS.has(type) || el.getAttribute("src") !== null) return false;
  let stateAttr: string | null = null;
  if (type === "a-state") {
    let state: unknown;
    try {
      state = JSON.parse(el.getAttribute("data-a-state") ?? "");
    } catch {
      return false;
    }
    const key = (state as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !STATE_KEY.test(key)) return false;
    stateAttr = stringifySafe({ key: scrubTokens(key, ctx) });
  }
  let body: unknown;
  try {
    body = JSON.parse((el.textContent ?? "").trim() || "null");
  } catch {
    return false;
  }
  keepOnly(el, ["type", "id", "class", "data-a-state"]);
  el.setAttribute("type", type);
  for (const { name, value } of attrsOf(el)) {
    if (name === "id" || name === "class") el.setAttribute(name, scrubTokens(value, ctx));
  }
  if (stateAttr !== null) el.setAttribute("data-a-state", stateAttr);
  el.textContent = stringifySafe(scrubJson(body, ctx));
  ctx.count("script_kept");
  return true;
}

const RAW_WS = new Set(["pre", "textarea", "listing"]);

/** Collapse a whitespace run to one space, or one newline when it held a line break. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, (ws) => (ws.includes("\n") ? "\n" : " "));
}

function walk(parent: DomNode, mode: TextMode, ctx: ScrubContext, reduce = false): void {
  mergeText(parent);
  const keepWs = !reduce || RAW_WS.has((parent.localName ?? "").toLowerCase());
  for (const node of children(parent)) {
    if (node.nodeType === TEXT) {
      const data = keepWs ? (node.data ?? "") : collapseWs(node.data ?? "");
      node.data = scrubText(data, ctx, mode);
      continue;
    }
    if (node.nodeType !== ELEMENT) {
      parent.removeChild(node);
      ctx.count("comment_dropped");
      continue;
    }
    const el = asElement(node);
    const tag = el.localName.toLowerCase();
    if (DROPPED_EL.has(tag)) {
      parent.removeChild(node);
      ctx.count("element_dropped");
      continue;
    }
    if (tag === "script") {
      if (!scrubScript(el, ctx)) {
        parent.removeChild(node);
        ctx.count("script_dropped");
      }
      continue;
    }
    if (tag === "meta") {
      if (el.getAttribute("charset") === null) {
        parent.removeChild(node);
        ctx.count("element_dropped");
      } else {
        keepOnly(el, []);
        el.setAttribute("charset", "utf-8");
      }
      continue;
    }
    if (tag === "img" && isPixel(el)) {
      parent.removeChild(node);
      ctx.count("pixel_dropped");
      continue;
    }
    const childMode = modeFor(el, mode);
    if (scrubSplitToken(el, ctx, childMode)) {
      scrubAttributes(el, tag, ctx);
      continue;
    }
    if (tag === "iframe" || tag === "frame") {
      el.removeAttribute("src");
      el.removeAttribute("srcdoc");
      for (const c of children(el)) el.removeChild(c);
    }
    scrubAttributes(el, tag, ctx);
    walk(el, childMode, ctx, reduce);
  }
}

interface Queryable {
  querySelectorAll(sel: string): ArrayLike<DomNode & { matches(sel: string): boolean }>;
}

/** Remove chrome and hidden recommendation rails (see REDUCE_* in allowlists.ts). */
function reduceTree(root: DomNode, ctx: ScrubContext): void {
  const q = root as unknown as Queryable;
  const drop = (n: DomNode) => {
    if (n.parentNode !== null) {
      n.parentNode.removeChild(n);
      ctx.count("element_dropped");
    }
  };
  for (const n of Array.from(q.querySelectorAll(REDUCE_DROP_SELECTORS.join(", ")))) drop(n);
  const keep = REDUCE_KEEP_HIDDEN_SELECTORS.join(", ");
  const hidden = REDUCE_DROP_HIDDEN_SELECTORS.map((h) => `${h}[data-rf-hidden='1']`).join(", ");
  for (const n of Array.from(q.querySelectorAll(hidden))) {
    if (n.parentNode === null) continue;
    // Keep a hidden subtree that is, or holds, something a parser reads on purpose.
    if (n.matches(keep) || (n as unknown as Queryable).querySelectorAll(keep).length > 0) continue;
    drop(n);
  }
}

type QEl = DomElement & Queryable & { className?: string };

const YEAR = /(?:^|\D)(?:19|20)\d{2}(?:\D|$)/;

/**
 * A select that enumerates years (the order-history time filter, a registry date picker)
 * says how long the account has existed. Keep at most 3 year options: the selected one and
 * its neighbours; their years then shift like every other date.
 */
function trimYearOptions(root: DomNode, ctx: ScrubContext): void {
  for (const sel of Array.from((root as unknown as Queryable).querySelectorAll("select"))) {
    const opts = Array.from(
      (sel as unknown as Queryable).querySelectorAll("option"),
    ) as unknown as QEl[];
    const years = opts.filter((o) =>
      YEAR.test(`${o.getAttribute("value") ?? ""} ${o.textContent ?? ""}`),
    );
    if (years.length <= 3) continue;
    const sel0 = Math.max(
      0,
      years.findIndex((o) => o.getAttribute("selected") !== null),
    );
    const start = Math.min(Math.max(0, sel0 - 1), years.length - 3);
    years.forEach((o, k) => {
      if ((k < start || k >= start + 3) && o.parentNode !== null) {
        o.parentNode.removeChild(o);
        ctx.count("element_dropped");
        return;
      }
      // A filter year moves by its own offset (see filterYear), like timeFilter= in URLs.
      const fy = (t: string) =>
        t.replace(/(?:19|20)\d{2}/g, (y) => String(ctx.filterYear(Number(y))));
      const v = o.getAttribute("value");
      if (v !== null) o.setAttribute("value", fy(v));
      for (const c of children(o)) if (c.nodeType === TEXT) c.data = fy(c.data ?? "");
    });
  }
}

/**
 * Pagination shows how many pages (so how many orders) the account has. Keep Previous,
 * Next and at most 3 numbered pages around the selected one; drop the rest and the "...".
 */
function trimPagination(root: DomNode, ctx: ScrubContext): void {
  for (const ul of Array.from((root as unknown as Queryable).querySelectorAll(".a-pagination"))) {
    const items = children(ul).filter((c) => c.nodeType === ELEMENT) as QEl[];
    const numbered = items.filter((li) => /^\s*\d+\s*$/.test(li.textContent ?? ""));
    const sel = Math.max(
      0,
      numbered.findIndex((li) => /\ba-selected\b/.test(li.getAttribute("class") ?? "")),
    );
    const start = Math.max(0, Math.min(sel - 1, numbered.length - 3));
    const keep = new Set(numbered.slice(start, start + 3));
    for (const li of items) {
      const isNum = numbered.includes(li);
      const isGap = /^\s*(?:\.{3}|\u2026)\s*$/.test(li.textContent ?? "");
      if ((isNum && !keep.has(li)) || isGap) {
        ul.removeChild(li);
        ctx.count("element_dropped");
      }
    }
  }
}

/** Numbered page labels read 1, 2, 3 in order again (lone digits are permuted). */
function relabelPagination(root: DomNode): void {
  for (const ul of Array.from((root as unknown as Queryable).querySelectorAll(".a-pagination"))) {
    let n = 0;
    for (const li of children(ul).filter((c) => c.nodeType === ELEMENT)) {
      if (!/^\s*\d+\s*$/.test(li.textContent ?? "")) continue;
      n++;
      const holder = (li as unknown as Queryable).querySelectorAll("a")[0] ?? li;
      const t = firstText(holder);
      if (t !== undefined) t.data = String(n);
    }
  }
}

const INLINE = new Set(["span", "b", "i", "em", "strong", "small", "font"]);

/**
 * One token split over sibling inline elements ("<span>0123</span><span>4567</span>", a site
 * that splits codes against scraping) is scrubbed as ONE token and handed back piece by
 * piece, so the joined value equals the same token written whole elsewhere on the page.
 * Returns true when it handled the children.
 */
function scrubSplitToken(el: DomNode, ctx: ScrubContext, mode: TextMode): boolean {
  const kids = children(el).filter((c) => !(c.nodeType === TEXT && (c.data ?? "").trim() === ""));
  if (kids.length < 2) return false;
  const pieces: DomNode[] = [];
  for (const k of kids) {
    if (k.nodeType !== ELEMENT || !INLINE.has(asElement(k).localName.toLowerCase())) return false;
    const inner = children(k);
    if (inner.length !== 1 || inner[0]?.nodeType !== TEXT) return false;
    pieces.push(inner[0]);
  }
  const parts = pieces.map((p) => (p.data ?? "").trim());
  const joined = parts.join("");
  // Codes only (a digit somewhere): split words and names keep the normal per-node rules.
  if (!/^[A-Za-z0-9]{6,}$/.test(joined) || !/[0-9]/.test(joined) || parts.some((p) => p === "")) {
    return false;
  }
  const out = scrubText(joined, ctx, mode);
  let at = 0;
  pieces.forEach((p, k) => {
    const len = out.length === joined.length ? (parts[k] ?? "").length : k === 0 ? out.length : 0;
    p.data = out.slice(at, at + len);
    at += len;
  });
  for (const k of kids) scrubAttributes(asElement(k), asElement(k).localName.toLowerCase(), ctx);
  ctx.count("text_node");
  return true;
}

function firstText(el: DomNode | null | undefined): DomNode | undefined {
  return el
    ? children(el).find((c) => c.nodeType === TEXT && (c.data ?? "").trim() !== "")
    : undefined;
}

/**
 * Amazon draws a price twice: "$12.99" in .a-offscreen and whole/fraction spans. Amounts
 * are scaled independently in each text node, so rewrite the spans from the scrubbed
 * offscreen text and both renderings agree.
 */
function alignPrices(root: DomNode): void {
  for (const p of Array.from((root as unknown as Queryable).querySelectorAll(".a-price"))) {
    const q = p as unknown as Queryable;
    const off = q.querySelectorAll(".a-offscreen")[0];
    const m = /([\d,]+)(?:\.(\d+))?/.exec(off?.textContent ?? "");
    if (m === null) continue;
    const whole = firstText(q.querySelectorAll(".a-price-whole")[0]);
    if (whole !== undefined) whole.data = m[1] ?? "";
    const frac = firstText(q.querySelectorAll(".a-price-fraction")[0]);
    if (frac !== undefined && m[2] !== undefined) frac.data = m[2];
  }
}

const STAR_CLASS = /^a-star-((?:mini|small|medium|large)-)?\d(?:-5)?$/;

/**
 * Star classes ("a-star-4-5") carry the rating: rewrite them from the synthetic rating in
 * the element's own "x.y out of 5" text, or draw one when there is no text.
 */
function alignStars(root: DomNode, ctx: ScrubContext): void {
  for (const el of Array.from(
    (root as unknown as Queryable).querySelectorAll("[class*='a-star-']"),
  )) {
    const e = el as unknown as DomElement;
    const cls = (e.getAttribute("class") ?? "").split(/\s+/);
    if (!cls.some((c) => STAR_CLASS.test(c))) continue;
    const m = /(\d(?:\.\d)?) out of 5/.exec(el.textContent ?? "");
    const r = m !== null ? Number(m[1]) : ctx.int(10, 50) / 10;
    const whole = Math.min(5, Math.max(0, Math.floor(r)));
    const half = r - whole >= 0.5 && whole < 5 ? "-5" : "";
    e.setAttribute(
      "class",
      cls
        .map((c) =>
          STAR_CLASS.test(c) ? `a-star-${STAR_CLASS.exec(c)?.[1] ?? ""}${whole}${half}` : c,
        )
        .join(" "),
    );
  }
}

export interface HtmlOptions {
  /** Drop chrome and hidden subtrees and collapse whitespace (structure-preserving). */
  reduce?: boolean;
}

function escText(s: string): string {
  return s.replace(/[&<>]|[\u{80}-\u{10ffff}]/gu, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    return `&#x${(c.codePointAt(0) ?? 63).toString(16)};`;
  });
}

function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

// Text inside RCDATA elements (title, textarea) is escaped like any other text: entities
// decode there, so the escaped form round-trips. Only kept JSON scripts are raw, and their
// content is already ASCII with < > & escaped by stringifySafe.
function serialize(node: DomNode, inScript = false): string {
  if (node.nodeType === TEXT) return inScript ? (node.data ?? "") : escText(node.data ?? "");
  if (node.nodeType !== ELEMENT) return "";
  const el = asElement(node);
  const tag = el.localName;
  const attrs = attrsOf(el)
    .map((a) => ` ${a.name}="${escAttr(a.value)}"`)
    .join("");
  if (VOID.has(tag.toLowerCase())) return `<${tag}${attrs}>`;
  const script = tag.toLowerCase() === "script";
  const inner = children(el)
    .map((c) => serialize(c, script))
    .join("");
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

const DOC_START = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\b|<html[\s>])/i;

/** Scrub one HTML document or fragment and serialize it ASCII-only. */
export function scrubHtml(html: string, ctx: ScrubContext, opts: HtmlOptions = {}): string {
  const isDoc = DOC_START.test(html);
  const src = isDoc ? html : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(src) as unknown as {
    document: { documentElement: DomNode; body: DomNode };
  };
  const root = document.documentElement;
  // The root element is not visited by walk(): its attributes need the same pass.
  if (isDoc) scrubAttributes(asElement(root), asElement(root).localName.toLowerCase(), ctx);
  const reduce = opts.reduce === true;
  if (reduce) reduceTree(root, ctx);
  trimYearOptions(root, ctx);
  trimPagination(root, ctx);
  const outerIds = docIds;
  docIds = new Set(
    Array.from((root as unknown as Queryable).querySelectorAll("[id]"), (e) =>
      String((e as unknown as DomElement).getAttribute("id") ?? ""),
    ),
  );
  try {
    walk(root, "text", ctx, reduce);
  } finally {
    docIds = outerIds;
  }
  alignPrices(root);
  relabelPagination(root);
  alignStars(root, ctx);
  if (isDoc) return `<!DOCTYPE html>${serialize(root)}`;
  return children(document.body)
    .map((c) => serialize(c))
    .join("");
}

registerHtmlScrubber((h, c) => scrubHtml(h, c));
