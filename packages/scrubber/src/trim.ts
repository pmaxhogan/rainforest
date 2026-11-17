/**
 * Item-count trimming. How many orders, subscriptions, saved items or history entries a
 * page shows is a fact about the account. Every repeated item collection listed in
 * TRIM_RULES keeps a seeded random subset of its items, sized uniformly in
 * 2..min(6, n-1), so the count always differs from the real one when there are 3 or more.
 * Collections of 1 or 2 stay as they are (reported in the counts). The page stays
 * self-consistent: embedded id lists lose the removed entries, carousel set sizes and
 * "N items" texts are rewritten, and long ASIN lists for items not on the page are cut too.
 *
 * Runs on the RAW DOM before scrubbing, so removed ids are matched against their real
 * values; nothing it reads is emitted.
 */
import { TRIM_RULES, type TrimRule } from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";

interface El {
  nodeType: number;
  localName: string;
  parentNode: El | null;
  childNodes: ArrayLike<El>;
  textContent: string | null;
  data?: string;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeChild(child: El): El;
  querySelectorAll(sel: string): ArrayLike<El>;
  contains(other: El): boolean;
}

const ASIN = /(?<![A-Za-z0-9])[BX]0[A-Z0-9]{8}(?![A-Za-z0-9])/g;
const ELEMENT = 1;
const TEXT = 3;

export interface TrimReport {
  /** Collection name -> [real size, kept size] for every group seen. */
  groups: { name: string; from: number; to: number }[];
}

function all(root: El, sel: string): El[] {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * The outermost wrapper of `item` that still contains no other item of the set and no
 * `stopAt` element (the boundary of the enclosing collection: an order's header, a
 * shipment's status), so items per order never climb up to whole orders.
 */
function unitOf(item: El, items: El[], stopAt: string | undefined): El {
  let unit = item;
  for (;;) {
    const p = unit.parentNode;
    if (p === null || p.nodeType !== ELEMENT) return unit;
    if (items.some((o) => o !== item && p.contains(o))) return unit;
    if (stopAt !== undefined && (matches(p, stopAt) || all(p, stopAt).length > 0)) return unit;
    unit = p;
  }
}

function matches(el: El, sel: string): boolean {
  return typeof (el as unknown as { matches?: (s: string) => boolean }).matches === "function"
    ? (el as unknown as { matches: (s: string) => boolean }).matches(sel)
    : false;
}

function idsIn(el: El): Set<string> {
  const out = new Set<string>();
  const visit = (n: El) => {
    if (n.nodeType !== ELEMENT) return;
    for (const a of Array.from(n.attributes)) {
      // Item ids only (generic data-id values like "cta" would match unrelated entries).
      if (/^(?:data-itemid|data-item-id)$/.test(a.name) && a.value.trim().length >= 8) {
        out.add(a.value.trim());
      }
      for (const m of a.value.matchAll(ASIN)) out.add(m[0]);
    }
    for (const c of Array.from(n.childNodes)) visit(c);
  };
  visit(el);
  return out;
}

function mentions(v: unknown, ids: Set<string>): boolean {
  if (typeof v === "string") {
    for (const id of ids) if (v === id || (id.length >= 10 && v.includes(id))) return true;
    return false;
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return Object.values(v as Record<string, unknown>).some(
      (x) => typeof x === "string" && mentions(x, ids),
    );
  }
  return false;
}

function asinOf(v: unknown): string | undefined {
  const s =
    typeof v === "string" ? v : v !== null && typeof v === "object" ? JSON.stringify(v) : "";
  return s.match(ASIN)?.[0];
}

/**
 * Filter arrays in a JSON value: drop entries naming a removed item; in a long list where
 * every entry names an ASIN, also drop a random share of the entries whose item is not on
 * the page, so the list length (a history or catalog total) does not survive either.
 */
function filterJson(
  v: unknown,
  removed: Set<string>,
  onPage: Set<string>,
  ctx: ScrubContext,
  cutOffPage: boolean,
): unknown {
  if (Array.isArray(v)) {
    let kept = v
      .filter((e) => !mentions(e, removed))
      .map((e) => filterJson(e, removed, onPage, ctx, cutOffPage));
    if (cutOffPage && kept.length >= 3 && kept.every((e) => asinOf(e) !== undefined)) {
      const off = kept.filter((e) => !onPage.has(asinOf(e) ?? ""));
      if (off.length > 0) {
        const keepOff = ctx.int(0, off.length - 1);
        const chosen = new Set(off.slice(0, keepOff));
        kept = kept.filter((e) => onPage.has(asinOf(e) ?? "") || chosen.has(e));
      }
    }
    return kept;
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = filterJson(x, removed, onPage, ctx, cutOffPage);
    }
    return out;
  }
  return v;
}

function rewriteCounts(root: El, from: number, to: number): void {
  if (from < 3) return;
  const re = new RegExp(`(?<![\\d,.])${from}(\\s+items?\\b|\\s*item\\(s\\))`, "gi");
  const visit = (n: El) => {
    if (n.nodeType === TEXT) {
      if (n.data !== undefined && re.test(n.data)) n.data = n.data.replace(re, `${to}$1`);
      re.lastIndex = 0;
      return;
    }
    if (n.nodeType !== ELEMENT) return;
    for (const a of Array.from(n.attributes)) {
      if (/item-?(?:quantity|count)$|numitems$/.test(a.name) && a.value.trim() === String(from)) {
        n.setAttribute(a.name, String(to));
      } else if (re.test(a.value)) {
        n.setAttribute(a.name, a.value.replace(re, `${to}$1`));
      }
      re.lastIndex = 0;
    }
    for (const c of Array.from(n.childNodes)) visit(c);
  };
  visit(root);
}

function applies(rule: TrimRule, kind: string): boolean {
  return rule.kinds.includes("*") || rule.kinds.includes(kind);
}

/** Trim every repeated item collection of the page. */
export function trimCollections(rootNode: unknown, kind: string, ctx: ScrubContext): TrimReport {
  const root = rootNode as El;
  const report: TrimReport = { groups: [] };
  const removed = new Set<string>();
  for (const rule of TRIM_RULES) {
    if (!applies(rule, kind)) continue;
    const items = all(root, rule.item).filter(
      (el, _i, arr) => !arr.some((o) => o !== el && o.contains(el)),
    );
    const groups = new Map<El, El[]>();
    for (const it of items) {
      const u = unitOf(it, items, rule.stopAt);
      const p = u.parentNode;
      if (p === null) continue;
      const g = groups.get(p) ?? [];
      if (!g.includes(u)) g.push(u);
      groups.set(p, g);
    }
    for (const [parent, units] of groups) {
      const n = units.length;
      if (rule.standardSize !== undefined && n === rule.standardSize) {
        report.groups.push({ name: rule.name, from: n, to: n });
        continue;
      }
      if (n < 3) {
        report.groups.push({ name: rule.name, from: n, to: n });
        continue;
      }
      const k = ctx.int(2, Math.min(6, n - 1));
      const order = units.map((u, i) => ({ u, r: ctx.rand(), i }));
      const keep = new Set(
        order
          .sort((a, b) => a.r - b.r)
          .slice(0, k)
          .map((o) => o.u),
      );
      for (const u of units) {
        if (keep.has(u)) continue;
        for (const id of idsIn(u)) removed.add(id);
        parent.removeChild(u);
        ctx.count("element_dropped");
      }
      // Carousel bookkeeping: set size and positions of what is left.
      let pos = 0;
      for (const u of units) {
        if (!keep.has(u)) continue;
        pos++;
        for (const el of [u, ...all(u, "[aria-setsize], [aria-posinset]")]) {
          if (el.getAttribute("aria-setsize") !== null) el.setAttribute("aria-setsize", String(k));
          if (el === u && el.getAttribute("aria-posinset") !== null)
            el.setAttribute("aria-posinset", String(pos));
        }
      }
      rewriteCounts(root, n, k);
      report.groups.push({ name: rule.name, from: n, to: k });
    }
  }
  // Ids still on the page, then embedded JSON (scripts and JSON-valued attributes).
  const onPage = new Set<string>();
  for (const el of all(root, "[data-asin], a[href*='/dp/']")) {
    for (const v of [el.getAttribute("data-asin") ?? "", el.getAttribute("href") ?? ""]) {
      for (const m of v.matchAll(ASIN)) onPage.add(m[0]);
    }
  }
  for (const id of removed) onPage.delete(id);
  const listAttrs = new Set(
    TRIM_RULES.filter((r) => applies(r, kind)).flatMap((r) => r.idListAttrs ?? []),
  );
  for (const el of all(root, "*")) {
    if (el.localName === "script") {
      const t = (el.textContent ?? "").trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          const next = JSON.stringify(filterJson(JSON.parse(t), removed, onPage, ctx, false));
          if (next !== JSON.stringify(JSON.parse(t))) el.textContent = next;
        } catch {
          // Not JSON: the scrubber drops or handles it later.
        }
      }
    }
    for (const a of Array.from(el.attributes)) {
      const t = a.value.trim();
      if (!(t.startsWith("{") || t.startsWith("["))) continue;
      try {
        const parsed: unknown = JSON.parse(t);
        const next = JSON.stringify(
          filterJson(parsed, removed, onPage, ctx, listAttrs.has(a.name)),
        );
        if (next !== JSON.stringify(parsed)) el.setAttribute(a.name, next);
      } catch {
        // Not JSON.
      }
    }
  }
  return report;
}
