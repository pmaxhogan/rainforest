/**
 * Lossless fallback. Typed parsers mark the elements they consumed; everything else that is
 * visible is split into feature blocks and returned as `other_sections`, and whatever falls
 * through both is counted as `unparsed_text_chars`.
 *
 * Accounting is exact by construction: every visible text node outside chrome lands in
 * exactly one bucket (consumed, emitted, unparsed), decided by its nearest marked ancestor.
 * A text node's size is the length of its text after whitespace collapse and trim, so
 * `total = consumed + emitted + unparsed` always holds. Chrome (nav, header, footer) is
 * excluded from every bucket and from the total.
 */
import type { OtherSection } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  type DomNode,
  type DomRoot,
  TEXT_NODE,
  collapse,
  excludedWithin,
  hiddenSelf,
  isElement,
  links,
  tableToRows,
  text,
  visible,
} from "./dom.ts";

/** Elements a typed parser consumed. Consuming an element consumes its whole subtree. */
export class Consumption {
  readonly #set = new Set<DomElement>();

  /** Mark an element as consumed and return it (null / undefined pass through). */
  take<E extends DomElement | null | undefined>(el: E): E {
    if (el != null) this.#set.add(el);
    return el;
  }

  /** Mark several elements as consumed. */
  takeAll(els: Iterable<DomElement | null | undefined>): void {
    for (const el of els) this.take(el);
  }

  /** True if this exact element was marked. */
  has(el: DomElement): boolean {
    return this.#set.has(el);
  }

  /** True if the element or any ancestor was marked. */
  covers(el: DomElement): boolean {
    for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
      if (this.#set.has(cur)) return true;
    }
    return false;
  }

  get size(): number {
    return this.#set.size;
  }

  elements(): DomElement[] {
    return [...this.#set];
  }
}

/**
 * Site chrome that is never a feature block and never counts as unparsed. Kept short on
 * purpose; callers override it with `chromeSelectors`.
 */
export const DEFAULT_CHROME_SELECTORS: readonly string[] = [
  "header",
  "footer",
  "nav",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "#navbar",
  "#nav-main",
  "#nav-subnav",
  "#navFooter",
  "#skiplink",
];

/** What counts as a feature block by default. */
export const DEFAULT_BLOCK_SELECTOR =
  "[data-feature-name], [data-component-type], [cel_widget_id], section, table, [id]";

/** Blocks with more visible text than this are split into their child blocks when they have any. */
export const DEFAULT_MAX_BLOCK_CHARS = 4000;

export interface LosslessOptions {
  /** Where to look (default: the document body). */
  root?: DomElement;
  blockSelector?: string;
  chromeSelectors?: readonly string[];
  maxBlockChars?: number;
  /** Resolve link hrefs in emitted sections against this URL. */
  base?: string;
}

export interface CoverageCounts {
  /** Visible text characters outside chrome. */
  total: number;
  consumed: number;
  emitted: number;
  unparsed: number;
}

export interface LosslessReport {
  sections: OtherSection[];
  counts: CoverageCounts;
}

type Role = "block" | "rest";

interface Plan {
  root: DomElement | undefined;
  isChrome: (el: DomElement) => boolean;
  roles: Map<DomElement, Role>;
  order: DomElement[];
}

function rootOf(doc: DomRoot, opts: LosslessOptions): DomElement | undefined {
  if (opts.root !== undefined) return opts.root;
  if ("body" in doc) return doc.body;
  return doc;
}

function chromeTest(selectors: readonly string[]): (el: DomElement) => boolean {
  if (selectors.length === 0) return () => false;
  const joined = selectors.join(", ");
  return (el) => {
    try {
      return el.matches(joined);
    } catch {
      return false;
    }
  };
}

function safeMatches(el: DomElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function textLen(node: DomNode): number {
  return collapse(node.textContent ?? "").length;
}

/**
 * Visible text chars per element (chrome excluded), computed in one pass so block sizing
 * does not re-walk subtrees.
 */
function measure(
  el: DomElement,
  isChrome: (el: DomElement) => boolean,
  sizes: Map<DomElement, number>,
): number {
  let n = 0;
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as DomNode;
    if (child.nodeType === TEXT_NODE) n += textLen(child);
    else if (isElement(child) && !hiddenSelf(child) && !isChrome(child)) {
      n += measure(child, isChrome, sizes);
    }
  }
  sizes.set(el, n);
  return n;
}

function plan(doc: DomRoot, consumed: Consumption, opts: LosslessOptions): Plan {
  const root = rootOf(doc, opts);
  const isChrome = chromeTest(opts.chromeSelectors ?? DEFAULT_CHROME_SELECTORS);
  const roles = new Map<DomElement, Role>();
  const order: DomElement[] = [];
  if (root === undefined || !visible(root)) return { root: undefined, isChrome, roles, order };
  if (consumed.covers(root)) return { root, isChrome, roles, order };
  const blockSelector = opts.blockSelector ?? DEFAULT_BLOCK_SELECTOR;
  const maxChars = opts.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  // Ancestors of consumed elements: a block containing consumed content is split.
  const holdsConsumed = new Set<DomElement>();
  for (const el of consumed.elements()) {
    for (let cur = el.parentElement; cur != null; cur = cur.parentElement) {
      if (holdsConsumed.has(cur)) break;
      holdsConsumed.add(cur);
    }
  }
  const sizes = new Map<DomElement, number>();
  measure(root, isChrome, sizes);

  const visit = (el: DomElement): void => {
    for (const child of Array.from(el.children)) {
      if (hiddenSelf(child) || isChrome(child) || consumed.has(child)) continue;
      const size = sizes.get(child) ?? 0;
      if (size === 0) continue;
      if (!safeMatches(child, blockSelector)) {
        visit(child);
        continue;
      }
      const split =
        holdsConsumed.has(child) ||
        (size > maxChars && child.querySelector(blockSelector) !== null);
      if (!split) {
        roles.set(child, "block");
        order.push(child);
        continue;
      }
      // Split: children become their own blocks, the leftover loose text is a "rest" section.
      roles.set(child, "rest");
      order.push(child);
      visit(child);
    }
  };
  visit(root);
  return { root, isChrome, roles, order };
}

type Bucket = "consumed" | "emitted" | "unparsed";

function count(p: Plan, consumed: Consumption): CoverageCounts {
  const counts: CoverageCounts = { total: 0, consumed: 0, emitted: 0, unparsed: 0 };
  if (p.root === undefined) return counts;
  const initial: Bucket = consumed.covers(p.root) ? "consumed" : "unparsed";
  const walk = (el: DomElement, bucket: Bucket): void => {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i] as DomNode;
      if (child.nodeType === TEXT_NODE) {
        const n = textLen(child);
        counts.total += n;
        counts[bucket] += n;
      } else if (isElement(child)) {
        if (hiddenSelf(child) || p.isChrome(child)) continue;
        let next = bucket;
        if (bucket !== "consumed") {
          if (consumed.has(child)) next = "consumed";
          else if (p.roles.has(child)) next = "emitted";
        }
        walk(child, next);
      }
    }
  };
  walk(p.root, initial);
  return counts;
}

/** True if `el` is `ancestor` or inside it. */
function within(el: DomElement, ancestor: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (cur === ancestor) return true;
  }
  return false;
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role=heading]";

function positionalKey(el: DomElement, root: DomElement): string {
  const path: number[] = [];
  for (let cur: DomElement | null = el; cur != null && cur !== root; cur = cur.parentElement) {
    const parent: DomElement | null = cur.parentElement;
    const index = parent === null ? 0 : Array.from(parent.children).indexOf(cur);
    path.push(index);
  }
  return `${el.localName}@${path.reverse().join(".")}`;
}

function keyOf(el: DomElement, root: DomElement): string {
  const named =
    el.id ||
    el.getAttribute("data-feature-name") ||
    el.getAttribute("data-component-type") ||
    el.getAttribute("cel_widget_id");
  return named !== null && named !== "" ? named : positionalKey(el, root);
}

function section(
  el: DomElement,
  role: Role,
  p: Plan,
  consumed: Consumption,
  opts: LosslessOptions,
): OtherSection | undefined {
  const root = p.root as DomElement;
  // Inside a "rest" section, child blocks were emitted on their own; skip them here.
  const exclude = (e: DomElement): boolean =>
    p.isChrome(e) || consumed.has(e) || (role === "rest" && e !== el && p.roles.has(e));
  const body = text(el, { exclude });
  if (body === "") return undefined;
  let heading: string | null = null;
  for (const h of Array.from(el.querySelectorAll(HEADING_SELECTOR))) {
    if (!visible(h) || excludedWithin(h, el, exclude)) continue;
    const t = text(h);
    if (t !== "") {
      heading = t;
      break;
    }
  }
  const tables: string[][][] = [];
  const tableEls = el.localName === "table" ? [el] : Array.from(el.querySelectorAll("table"));
  for (const t of tableEls) {
    if (t !== el) {
      if (excludedWithin(t, el, exclude)) continue;
      // A nested table is reported through its outer table's cell text.
      const outer = t.parentElement?.closest("table");
      if (outer != null && within(outer, el)) continue;
    }
    const rows = tableToRows(t, { exclude });
    if (rows.length > 0) tables.push(rows);
  }
  const found = links(el, { exclude, base: opts.base });
  const key = keyOf(el, root);
  const out: OtherSection = {
    key: role === "rest" ? `${key}:rest` : key,
    heading,
    text: body,
  };
  if (tables.length > 0) out.tables = tables;
  if (found.length > 0) out.links = found;
  return out;
}

/** Sections plus exact coverage counts for one document. */
export function losslessReport(
  doc: DomRoot,
  consumed: Consumption,
  opts: LosslessOptions = {},
): LosslessReport {
  const p = plan(doc, consumed, opts);
  const sections: OtherSection[] = [];
  const seen = new Map<string, number>();
  for (const el of p.order) {
    const s = section(el, p.roles.get(el) as Role, p, consumed, opts);
    if (s === undefined) continue;
    const n = (seen.get(s.key) ?? 0) + 1;
    seen.set(s.key, n);
    if (n > 1) s.key = `${s.key}~${n}`;
    sections.push(s);
  }
  return { sections, counts: count(p, consumed) };
}

/** Every unconsumed visible feature block, outermost first, never a parent and its child. */
export function otherSections(
  doc: DomRoot,
  consumed: Consumption,
  opts: LosslessOptions = {},
): OtherSection[] {
  return losslessReport(doc, consumed, opts).sections;
}

/** Visible text chars neither consumed nor emitted in other_sections. */
export function unparsedTextChars(
  doc: DomRoot,
  consumed: Consumption,
  opts: LosslessOptions = {},
): number {
  return losslessReport(doc, consumed, opts).counts.unparsed;
}

/** Visible text chars outside chrome, with the same counting rule as the report. */
export function visibleTextChars(
  doc: DomDocument | DomElement,
  opts: LosslessOptions = {},
): number {
  const root = rootOf(doc, opts);
  const p: Plan = {
    root: root !== undefined && visible(root) ? root : undefined,
    isChrome: chromeTest(opts.chromeSelectors ?? DEFAULT_CHROME_SELECTORS),
    roles: new Map(),
    order: [],
  };
  return count(p, new Consumption()).total;
}
