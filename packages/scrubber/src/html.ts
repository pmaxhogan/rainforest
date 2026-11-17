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
  IMAGE_URL_ATTRS,
  KEPT_VALUE_ATTRS,
  NAME_HINT,
  SAFE_LITERALS,
  URL_ATTRS,
} from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";
import { scrubJson, stringifySafe } from "./json.ts";
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

function scrubAttrValue(
  el: DomElement,
  tag: string,
  name: string,
  value: string,
  ctx: ScrubContext,
): string {
  if (KEPT.has(name)) return scrubTokens(value, ctx);
  if (URLS.has(name)) {
    if (name === "srcset" || name === "data-srcset") return scrubSrcset(value, ctx);
    const image = IMAGES.has(name) || (name === "href" && tag === "image");
    if (name === "xlink:href" || (name === "href" && value.trim().startsWith("#"))) {
      return scrubUrl(value, ctx, value.trim().startsWith("#") ? "page" : "image");
    }
    return scrubUrl(value, ctx, image ? "image" : "auto");
  }
  const t = value.trim();
  if ((name === "data-asin" || name.endsWith("-asin")) && /^[A-Za-z0-9]{10}$/.test(t)) {
    ctx.count("asin");
    return ctx.fakeAsin(t.toUpperCase());
  }
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      ctx.count("json_blob");
      return stringifySafe(scrubJson(parsed, ctx));
    } catch {
      // Not JSON: fall through to text rules.
    }
  }
  if (LITERALS.has(t.toLowerCase())) return value;
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

function walk(parent: DomNode, mode: TextMode, ctx: ScrubContext): void {
  mergeText(parent);
  for (const node of children(parent)) {
    if (node.nodeType === TEXT) {
      node.data = scrubText(node.data ?? "", ctx, mode);
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
    if (tag === "iframe" || tag === "frame") {
      el.removeAttribute("src");
      el.removeAttribute("srcdoc");
      for (const c of children(el)) el.removeChild(c);
    }
    scrubAttributes(el, tag, ctx);
    walk(el, childMode, ctx);
  }
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
export function scrubHtml(html: string, ctx: ScrubContext): string {
  const isDoc = DOC_START.test(html);
  const src = isDoc ? html : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(src) as unknown as {
    document: { documentElement: DomNode; body: DomNode };
  };
  const root = document.documentElement;
  walk(root, "text", ctx);
  if (isDoc) return `<!DOCTYPE html>${serialize(root)}`;
  return children(document.body)
    .map((c) => serialize(c))
    .join("");
}
