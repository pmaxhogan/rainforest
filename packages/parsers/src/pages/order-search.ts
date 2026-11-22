/**
 * Parser for the order search results (`/your-orders/search`), page kind `order_search`.
 *
 * Layout (desktop, current): the main `.hzsearch-content-container` holds breadcrumbs
 * (`ul.hzsearch-breadcrumbs`), the page heading, the search form (`.search-bar`, its box
 * prefilled with the query), a summary line (`p.hzsearch-results-summary`: `N orders
 * matching "<query>"`) and one `.a-fixed-left-grid` per matching ITEM: an image link, a
 * title link, a row with the order link ("View order details") and "Ordered on <date>",
 * and item buttons. Ten items to a page, with a `ul.a-pagination` bar when there are more.
 * A page lists items, not orders: an order with two matching items has two rows, so the
 * summary's order count can be below the number of rows.
 *
 * No match: no summary line and no rows; a bold paragraph says so and a second one says
 * what the search covers.
 *
 * Actions are returned as plain labels; a URL path is attached only for the read-only
 * destinations of the order list parser (order details, product pages).
 */
import { RfError } from "@rainforest/core";
import type { Capture, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  type DomRoot,
  attr,
  collapse,
  parseDocument,
  q,
  qa,
  text,
} from "../dom.ts";
import { Consumption, DEFAULT_BLOCK_SELECTOR, losslessReport } from "../lossless.ts";
import type { LosslessOptions } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";
import {
  type ActionLink,
  type DateText,
  type Pagination,
  cleanLink,
  isReadOnlyPath,
  parseDateText,
  parsePagination,
} from "./order-list.ts";

// ---- public types

export interface OrderSearchHit {
  index: number;
  asin: string | null;
  title: string;
  /** Relative product path without tracking parameters. */
  url_path?: string;
  image_url?: string;
  /** The order this item was bought in. */
  order_id: string | null;
  order_details_path?: string;
  /** "Ordered on <date>". */
  ordered?: DateText;
  /** Item buttons, labels only ("Buy it again", "View your item"). */
  actions: ActionLink[];
}

export interface OrderSearchPage {
  heading?: string;
  breadcrumbs: string[];
  /** What the call asked for, read from the requested URL. */
  requested: { query: string | null; page: number | null };
  /** The query as the page's own search box shows it. */
  query?: string;
  /** `3 orders matching "..."`, as shown. */
  match_text?: string;
  /** Matching orders across all pages. Rows are items, so this can be below the row count. */
  order_count?: number;
  /** One row per matching item. */
  results: OrderSearchHit[];
  pagination?: Pagination;
  /** Message shown when nothing matched. */
  empty_text?: string;
}

// ---- lossless configuration

export const ORDER_SEARCH_BLOCK_SELECTOR = `${DEFAULT_BLOCK_SELECTOR}, .a-fixed-left-grid, .a-section, .a-row, .a-alert`;

const ROOT_SELECTORS: readonly string[] = [".hzsearch-content-container", "[role=main]", "#a-page"];

function mainRoot(doc: DomDocument): DomElement {
  for (const sel of ROOT_SELECTORS) {
    const el = q(doc, sel);
    if (el !== undefined) return el;
  }
  return doc.body;
}

/** Lossless options for a document (main content root and block selector). Tests reuse it. */
export function orderSearchLosslessOptions(doc: DomDocument): LosslessOptions {
  return { root: mainRoot(doc), blockSelector: ORDER_SEARCH_BLOCK_SELECTOR };
}

// ---- small helpers

const SITE = "https://www.amazon.com";
const ORDER_LINK = "a[href*='order-details']";
const PRODUCT_LINK = "a[href*='/dp/'], a[href*='/gp/product/']";
const ORDER_ID_RE = /\b([A-Z0-9]{3}-\d{7}-\d{7})\b/;
const ASIN_PATH_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/;
const ORDERED_RE = /\bordered\b/i;
const MATCHING_RE = /\b(\d[\d,]*)\s+orders?\s+matching\b/i;
const EMPTY_RE = /\b(?:no results|no orders|didn['\u2019]?t find any|could not find)\b/i;

function ownText(el: DomElement): string {
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) parts.push(n.textContent ?? "");
  }
  return collapse(parts.join(" "));
}

function orderIdOf(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  let id: string | null;
  try {
    const params = new URL(href, SITE).searchParams;
    id = params.get("orderID") ?? params.get("orderId");
  } catch {
    return undefined;
  }
  const m = id === null ? null : ORDER_ID_RE.exec(id);
  return m === null ? undefined : m[1];
}

function readOnlyPath(href: string | undefined): string | undefined {
  const link = cleanLink(href);
  if (link === undefined || link.external) return undefined;
  return isReadOnlyPath(link.path) ? link.path : undefined;
}

/** Merge per-row strategy names and warnings into page meta. */
function mergeRowMeta(
  seen: Map<string, Set<string>>,
  row: ParseMeta,
  index: number,
  meta: ParseMeta,
): void {
  for (const [field, name] of Object.entries(row.strategies)) {
    let set = seen.get(field);
    if (set === undefined) {
      set = new Set();
      seen.set(field, set);
    }
    set.add(name);
  }
  for (const w of row.warnings) meta.warnings.push(`results[${index}]: ${w}`);
}

// ---- rows

/**
 * The rows of the page. Primary: the grid each item is laid out in. Fallback: for each
 * order link, the largest ancestor that still holds only that one order link.
 */
function findRows(root: DomElement, meta: ParseMeta): DomElement[] {
  const rows = firstOf<DomElement[]>(
    "results",
    [
      [
        "left-grid",
        () => qa(root, ".a-fixed-left-grid").filter((g) => q(g, ORDER_LINK) !== undefined),
      ],
      [
        "order-link",
        () => {
          const out: DomElement[] = [];
          for (const link of qa(root, ORDER_LINK)) {
            let row: DomElement = link;
            for (
              let up = row.parentElement;
              up !== null && up !== root && qa(up, ORDER_LINK).length === 1;
              up = up.parentElement
            ) {
              row = up;
            }
            if (row !== link && !out.includes(row)) out.push(row);
          }
          return out;
        },
      ],
    ],
    meta,
    { optional: true },
  );
  return rows ?? [];
}

function parseRow(
  el: DomElement,
  index: number,
  consumed: Consumption,
  meta: ParseMeta,
): OrderSearchHit {
  const imageEl = q(el, "img");
  const productLinks = qa(el, PRODUCT_LINK);
  const titleLink = productLinks.find((a) => text(a) !== "");
  const title =
    firstOf<string>(
      "title",
      [
        ["title-link", () => (titleLink === undefined ? undefined : text(titleLink))],
        ["image-alt", () => attr(imageEl, "alt")],
      ],
      meta,
    ) ?? "";
  const productHref = productLinks
    .map((a) => attr(a, "href"))
    .find((h) => h !== undefined && ASIN_PATH_RE.test(h));
  const asin =
    firstOf<string>(
      "asin",
      [
        [
          "url",
          () => (productHref === undefined ? undefined : ASIN_PATH_RE.exec(productHref)?.[1]),
        ],
        ["data-attr", () => attr(el, "data-asin") ?? attr(q(el, "[data-asin]"), "data-asin")],
      ],
      meta,
    ) ?? null;

  const orderLink = q(el, ORDER_LINK);
  const orderHref = attr(orderLink, "href");
  const orderId =
    firstOf<string>(
      "order_id",
      [
        ["order-link", () => orderIdOf(orderHref)],
        ["text", () => ORDER_ID_RE.exec(text(el))?.[1]],
      ],
      meta,
    ) ?? null;

  // "Ordered on <date>" sits next to the order link; elsewhere, any leaf saying "ordered".
  const dateEl = firstOf<DomElement>(
    "ordered",
    [
      [
        "order-row",
        () =>
          orderLink?.parentElement == null
            ? undefined
            : Array.from(orderLink.parentElement.children).find(
                (c) => c !== orderLink && parseDateText(text(c)) !== undefined,
              ),
      ],
      [
        "text-anchor",
        () =>
          qa(el, "*").find((c) => {
            const own = ownText(c);
            return ORDERED_RE.test(own) && parseDateText(own) !== undefined;
          }),
      ],
    ],
    meta,
    { optional: true },
  );

  const hit: OrderSearchHit = { index, asin, title, order_id: orderId, actions: [] };
  const product = cleanLink(productHref);
  if (product !== undefined && !product.external) hit.url_path = product.path;
  const src = attr(imageEl, "src");
  if (src !== undefined && /^https?:\/\//i.test(src)) hit.image_url = src;
  const orderPath = readOnlyPath(orderHref);
  if (orderPath !== undefined) hit.order_details_path = orderPath;
  const ordered = parseDateText(text(dateEl));
  if (ordered !== undefined) hit.ordered = ordered;

  for (const a of qa(el, "a.a-button-text, a[role=button], button")) {
    const label = text(a);
    if (label === "") continue;
    const action: ActionLink = { label };
    const path = readOnlyPath(attr(a, "href"));
    if (path !== undefined) action.path = path;
    hit.actions.push(action);
    consumed.take(a);
  }

  // Only what was read is consumed, so any other text in the row stays visible to the
  // lossless pass.
  consumed.takeAll(productLinks);
  consumed.take(orderLink);
  consumed.take(dateEl);
  return hit;
}

// ---- page chrome

function parseRequested(capture: Capture): OrderSearchPage["requested"] {
  try {
    const params = new URL(capture.url).searchParams;
    const page = params.get("page");
    return {
      query: params.get("search"),
      page: page !== null && /^\d+$/.test(page) ? Number(page) : null,
    };
  } catch {
    return { query: null, page: null };
  }
}

function sameQuery(a: string, b: string): boolean {
  return collapse(a).toLowerCase() === collapse(b).toLowerCase();
}

// ---- entry point

export const parseOrderSearch: Parser<OrderSearchPage> = (
  capture: Capture,
): ParseResult<OrderSearchPage> => {
  const doc = parseDocument(capture.html);
  const meta = newMeta();
  const consumed = new Consumption();
  const opts = orderSearchLosslessOptions(doc);
  const root = opts.root as DomElement;

  const headingEl = q(root, "h1");
  const heading = text(headingEl) || undefined;
  consumed.take(headingEl);
  const breadcrumbs: string[] = [];
  for (const ul of qa(root, "ul.hzsearch-breadcrumbs, ul.breadcrumbs")) {
    for (const li of qa(ul, "li")) {
      if (/--divider/.test(li.getAttribute("class") ?? "")) continue;
      const t = text(li);
      if (t !== "") breadcrumbs.push(t);
    }
    consumed.take(ul);
  }

  // The search form: its box shows the query the results are for.
  const bar = q(root, ".search-bar") ?? q(root, "form[action*='your-orders/search']");
  const form = bar === undefined ? undefined : (q(bar, "form") ?? bar);
  consumed.take(bar);

  const summaryEl = firstOf<DomElement>(
    "match_text",
    [
      ["summary-class", () => q(root, ".hzsearch-results-summary")],
      [
        "text-anchor",
        () => qa(root, "p, h2, h3, span, div").find((el) => MATCHING_RE.test(ownText(el))),
      ],
    ],
    meta,
    { optional: true },
  );
  const matchText = text(summaryEl) || undefined;
  const countMatch = matchText === undefined ? null : MATCHING_RE.exec(matchText);
  const orderCount =
    countMatch === null ? undefined : Number((countMatch[1] as string).replace(/,/g, ""));

  const requested = parseRequested(capture);
  const query = firstOf<string>(
    "query",
    [
      ["search-box", () => attr(q(form, "input[name='search'], input[type='search']"), "value")],
      ["summary", () => text(q(summaryEl, "strong, b"))],
    ],
    meta,
    { optional: true },
  );
  consumed.take(summaryEl);

  const pagination = parsePagination(root, consumed, meta);

  const results: OrderSearchHit[] = [];
  const seen = new Map<string, Set<string>>();
  findRows(root, meta).forEach((el, i) => {
    const rowMeta = newMeta();
    results.push(parseRow(el, i, consumed, rowMeta));
    mergeRowMeta(seen, rowMeta, i, meta);
  });
  for (const [field, set] of seen) meta.strategies[`result.${field}`] = [...set].sort().join("+");

  let emptyText: string | undefined;
  if (results.length === 0) {
    const el = qa(root, "*").find((c) => !consumed.covers(c) && EMPTY_RE.test(ownText(c)));
    if (el !== undefined) {
      // The message and the hint under it share one small section.
      const box = el.parentElement;
      const whole = box !== null && box !== root && text(box).length <= 400 ? box : el;
      emptyText = text(whole);
      consumed.take(whole);
    }
  }

  // A page with no rows must say so itself. Anything else is not a results page this
  // parser understands, and reporting it as "nothing found" would be a wrong answer.
  if (results.length === 0 && emptyText === undefined) {
    throw new RfError(
      "layout_unrecognized",
      matchText === undefined
        ? "no order search structure found on the page"
        : "the page reports matching orders but no result rows were found",
    );
  }
  if (results.length > 0 && matchText === undefined) {
    meta.warnings.push("result rows were found without the summary line");
  }
  if (requested.query !== null && query !== undefined && !sameQuery(requested.query, query)) {
    meta.warnings.push("the page's search box does not show the requested query");
  }

  const data: OrderSearchPage = { breadcrumbs, requested, results };
  if (heading !== undefined) data.heading = heading;
  if (query !== undefined) data.query = query;
  if (matchText !== undefined) data.match_text = matchText;
  if (orderCount !== undefined) data.order_count = orderCount;
  if (pagination !== undefined) data.pagination = pagination;
  if (emptyText !== undefined) data.empty_text = emptyText;

  const report = losslessReport(doc as DomRoot, consumed, opts);
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data, other_sections: report.sections, meta };
};
