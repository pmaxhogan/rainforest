/**
 * "Your Browsing History" (`/gp/history`) page parser.
 *
 * The page is server-rendered but only the first batch of cards is in the DOM (12 in the
 * captured case); every item id of the whole history is in the grid's `data-client-recs-list`
 * attribute and the remaining cards render client-side while the page scrolls. The result
 * therefore carries both the parsed cards and the full ASIN list so a caller can tell how
 * much is still unrendered (`unrendered_asins`, `has_more`).
 */
import type { Capture, OtherSection, ParseResult, Parser } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import {
  type DomElement,
  type Money,
  type Rating,
  Consumption,
  attr,
  firstOf,
  harvestBlobs,
  losslessReport,
  newMeta,
  parseCapture,
  parseMoney,
  parseRating,
  q,
  qa,
  ratingFromClass,
  text,
  tryJson,
} from "../index.ts";

// ---- types

export interface BrowsingHistoryItem {
  /** Position in the grid (`p13n-asin-index-N`), 0-based. */
  position: number | null;
  asin: string | null;
  title: string | null;
  /** Product path without tracking or the `/ref=` suffix, e.g. "/<slug>/dp/<ASIN>". */
  url_path: string | null;
  image_url: string | null;
  price: Money | null;
  /** Per-unit price text such as "($0.28/count)", with its amount when it parses. */
  unit_price_text: string | null;
  unit_price: Money | null;
  rating: Rating | null;
  review_count: number | null;
  prime: boolean;
  /** Prime delivery badge text ("Tomorrow", "Two-Day"). */
  delivery_badge: string | null;
  /** "FREE delivery Tomorrow, Nov 17" as shown. */
  delivery_message: string | null;
  /** Just the date part of the delivery message ("Tomorrow, Nov 17" or a range). */
  delivery_date_text: string | null;
  /** "Best Seller" and similar ribbons. */
  badges: string[];
  /** Label of the per-card remove control (a write action; label only). */
  remove_label: string | null;
  /** Nearest preceding date-group heading when the grid has them. */
  viewed_group: string | null;
  /** Visible card text no field accounted for. */
  extra_text?: string;
}

export type HistoryStatus = "enabled" | "disabled" | "paused" | "unknown";

export interface BrowsingHistoryPage {
  heading: string | null;
  description: string | null;
  /** On/off/paused state from the page metadata or a visible alert. */
  history_status: HistoryStatus;
  /** Raw status token from the page metadata ("ENABLED"). */
  history_status_raw: string | null;
  /** Pause expiry token from the metadata ("0" when not paused). */
  pause_expiration: string | null;
  /** Visible alert text when the page shows the history as off or paused. */
  status_message: string | null;
  is_empty: boolean;
  empty_message: string | null;
  items: BrowsingHistoryItem[];
  /** Every viewed ASIN the page knows about, in order (rendered or not). */
  all_asins: string[];
  /** Total number of items in the history when the page says so. */
  total_items: number | null;
  /** ASINs in `all_asins` that have no rendered card yet. */
  unrendered_asins: string[];
  /** More cards exist than are rendered: scroll to load them. */
  has_more: boolean;
  /** The end-of-list sentinel is present in the DOM. */
  end_of_list_marker: boolean;
  /** Date-group headings in page order, when the grid has any. */
  group_headings: string[];
  /** Section links of the "Your Amazon.com" sub-navigation, tracking removed. */
  section_links: { label: string; href_path: string }[];
}

// ---- helpers

/** Product path: query string, fragment and the `/ref=...` tail removed. */
export function productPath(href: string | null | undefined): string | undefined {
  if (href == null || href.trim() === "") return undefined;
  let path = href.trim().split("#")[0] ?? "";
  path = path.split("?")[0] ?? "";
  const ref = path.indexOf("/ref=");
  if (ref >= 0) path = path.slice(0, ref);
  return path === "" ? undefined : path;
}

function asinFromHref(href: string | undefined): string | undefined {
  return /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(href ?? "")?.[1];
}

function relPath(href: string | null | undefined): string | undefined {
  if (href == null || href.trim() === "") return undefined;
  const raw = href.trim();
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return raw.split("#")[0];
  const kept = raw
    .slice(qIdx + 1)
    .split("#")[0]
    ?.split("&")
    .filter(
      (p) => p !== "" && !/^(ref_?|pf_rd_[a-z]|pd_rd_[a-z]+|content-id|_encoding|ie)=/.test(p),
    );
  const path = raw.slice(0, qIdx);
  return kept === undefined || kept.length === 0 ? path : `${path}?${kept.join("&")}`;
}

function statusOf(raw: string | undefined): HistoryStatus {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "enabled" || v === "on") return "enabled";
  if (v === "disabled" || v === "off") return "disabled";
  if (v === "paused") return "paused";
  return "unknown";
}

function parseItem(cell: DomElement, group: string | null): BrowsingHistoryItem {
  const parts = new Consumption();
  const id = attr(cell, "id") ?? "";
  const pos = /^p13n-asin-index-(\d+)$/.exec(id)?.[1];
  const link = q(cell, "a[href*='/dp/']");
  const href = attr(link, "href");
  const itemId = attr(q(cell, "[data-csa-c-item-id]"), "data-csa-c-item-id");
  const asin =
    /asin\.([A-Z0-9]{10})/.exec(itemId ?? "")?.[1] ??
    attr(q(cell, "[data-asin]"), "data-asin") ??
    asinFromHref(href) ??
    null;
  const titleEl =
    q(cell, ".p13n-sc-truncate-desktop-type2") ?? q(cell, "a[role='link'] span > div");
  const img = q(cell, "img.p13n-product-image") ?? q(cell, "img");
  const title = text(titleEl) || attr(link, "title") || attr(img, "alt") || null;
  const priceEl = q(cell, "[class*='p13n-sc-price_']");
  const priceBox = priceEl ?? q(cell, ".a-price") ?? q(cell, ".a-color-price");
  const price = parseMoney(text(priceEl)) ?? parseMoney(text(priceBox)) ?? null;
  const unitEl = q(cell, ".a-size-mini.a-color-price");
  const ratingLink = q(cell, "a[aria-label*='out of']");
  const ratingLabel = attr(ratingLink, "aria-label") ?? text(q(cell, ".a-icon-alt"));
  const starEl = q(cell, "[class*='a-star']");
  const rating =
    parseRating(ratingLabel) ??
    (starEl === undefined
      ? undefined
      : (() => {
          const v = ratingFromClass(starEl.getAttribute("class"));
          return v === undefined ? undefined : { value: v, out_of: 5 };
        })()) ??
    null;
  const countText =
    /([\d,]+)\s+ratings?/i.exec(ratingLabel)?.[1] ?? text(q(cell, ".a-color-tertiary"));
  const review_count =
    countText === "" || countText === undefined
      ? null
      : (() => {
          const n = Number(countText.replace(/[^0-9]/g, ""));
          return Number.isFinite(n) && /\d/.test(countText) ? n : null;
        })();
  const primeEl = q(cell, ".a-icon-prime");
  const badgeEl = q(cell, ".a-icon-prime-with-text .a-icon-text");
  const deliveryEl = q(cell, ".udm-primary-delivery-message");
  const dateEl = q(deliveryEl, ".a-text-bold");
  const badgeEls = qa(cell, ".p13n-best-seller, [class*='_badge-container_']");
  const badges: string[] = [];
  for (const b of badgeEls) {
    const t = text(b);
    if (t !== "" && !badges.includes(t)) badges.push(t);
  }
  const removeEl = q(cell, ".p13n-individual-feedbackButton");
  const stars = q(cell, ".a-icon-row");
  parts.takeAll([
    link,
    titleEl,
    img,
    priceEl ?? priceBox,
    unitEl,
    ratingLink,
    stars,
    primeEl,
    badgeEl,
    deliveryEl,
    removeEl,
    ...badgeEls,
    q(cell, ".udm-delivery-block"),
  ]);
  const item: BrowsingHistoryItem = {
    position: pos === undefined ? null : Number(pos),
    asin,
    title,
    url_path: productPath(href) ?? null,
    image_url: attr(img, "src") ?? null,
    price,
    unit_price_text: text(unitEl) || null,
    unit_price: parseMoney(text(unitEl)) ?? null,
    rating: rating ?? null,
    review_count,
    prime: primeEl !== undefined,
    delivery_badge: text(badgeEl) || null,
    delivery_message: text(deliveryEl) || null,
    delivery_date_text: text(dateEl) || null,
    badges,
    remove_label: text(removeEl) || null,
    viewed_group: group,
  };
  const rest = text(cell, { exclude: (el) => parts.has(el) });
  if (rest !== "") item.extra_text = rest;
  return item;
}

// ---- parser

export const parseBrowsingHistory: Parser<BrowsingHistoryPage> = (
  capture: Capture,
): ParseResult<BrowsingHistoryPage> => {
  const { doc } = parseCapture(capture);
  const meta = newMeta();
  const used = new Consumption();

  const grid = q(doc, ".p13n-ybh-grid") ?? q(doc, ".p13n-desktop-grid");
  const header = q(doc, ".browsingHistoryHeader");
  const heading =
    firstOf<string>(
      "heading",
      [
        ["id", () => text(q(header, "h2"))],
        [
          "text-anchor",
          () => text(qa(doc.body, "h1, h2").find((h) => /browsing history/i.test(text(h)))),
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const description =
    firstOf<string>(
      "description",
      [
        [
          "label",
          () =>
            text(
              qa(header, "p").find(
                (p) => p.closest(".a-alert-inline") === null && text(p).length > 0,
              ),
            ),
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  used.take(header);

  // status
  const metaEl = doc.querySelector(".p13n-ybh-metadata");
  const rawStatus = attr(metaEl ?? undefined, "data-browsing-history-status");
  const disabledMsg = q(doc, "#browsingHistoryDisabledMessage");
  const pausedMsg = q(doc, "#browsingHistoryPausedMessage");
  let history_status: HistoryStatus = "unknown";
  let status_message: string | null = null;
  if (disabledMsg !== undefined && text(disabledMsg) !== "") {
    history_status = "disabled";
    status_message = text(disabledMsg);
    meta.strategies.history_status = "label";
  } else if (pausedMsg !== undefined && text(pausedMsg) !== "") {
    history_status = "paused";
    status_message = text(pausedMsg);
    meta.strategies.history_status = "label";
  } else if (statusOf(rawStatus) !== "unknown") {
    history_status = statusOf(rawStatus);
    meta.strategies.history_status = "data-attr";
  } else {
    meta.warnings.push("history_status: no status metadata or alert found");
  }

  // items
  const cells =
    firstOf<DomElement[]>(
      "items",
      [
        ["id", () => qa(grid ?? doc, "[id^='p13n-asin-index-']")],
        ["data-attr", () => qa(grid ?? doc, "[data-csa-c-item-type='asin']")],
        ["text-anchor", () => qa(grid ?? doc, ".p13n-sc-uncoverable-faceout")],
      ],
      meta,
      { optional: true },
    ) ?? [];
  // date-group headings, if the grid has any (document order against the cards)
  const groupOf = new Map<DomElement, string>();
  const group_headings: string[] = [];
  if (grid !== undefined) {
    let current: string | null = null;
    for (const el of qa(grid, "h3, h4, [id^='p13n-asin-index-']")) {
      if (/^h[34]$/.test(el.localName)) {
        if (el.closest("[id^='p13n-asin-index-']") !== null) continue;
        current = text(el) || null;
        if (current !== null) {
          group_headings.push(current);
          used.take(el);
        }
      } else if (current !== null) {
        groupOf.set(el, current);
      }
    }
  }
  const items = cells.map((cell) => {
    const item = parseItem(cell, groupOf.get(cell) ?? null);
    used.take(cell);
    return item;
  });

  // full id list
  const recsEl = doc.querySelector("[data-client-recs-list]");
  const recs =
    firstOf<string[]>(
      "all_asins",
      [
        [
          "data-attr",
          () => {
            const v = tryJson(attr(recsEl ?? undefined, "data-client-recs-list"));
            if (!Array.isArray(v)) return undefined;
            return v
              .map((e) => (e as { id?: unknown } | null)?.id)
              .filter((x): x is string => typeof x === "string");
          },
        ],
        ["id", () => items.map((i) => i.asin).filter((a): a is string => a !== null)],
      ],
      meta,
      { optional: true },
    ) ?? [];
  const rendered = new Set(items.map((i) => i.asin));
  const unrendered_asins = recs.filter((a) => !rendered.has(a));
  const end_of_list_marker = doc.querySelector("#endOfList") !== null;

  // empty state
  const emptyEl = q(doc, ".p13n-empty-ybh") ?? q(doc, "#browsingHistoryEmpty");
  const empty_message = text(emptyEl) || null;
  used.take(emptyEl);
  const is_empty = items.length === 0;

  // sub navigation (chrome, but useful and cheap)
  const section_links: { label: string; href_path: string }[] = [];
  for (const a of qa(doc, "#nav-subnav a[href]")) {
    const label = text(a) || attr(a, "aria-label") || "";
    const href_path = relPath(attr(a, "href"));
    if (href_path !== undefined) section_links.push({ label, href_path });
  }

  if (heading === null && items.length === 0 && recs.length === 0 && empty_message === null) {
    throw new RfError(
      "layout_unrecognized",
      "browsing history page: no heading, items or empty state found",
    );
  }
  if (recs.length > 0 && items.length === 0 && empty_message === null) {
    meta.warnings.push("items: ids are listed but no card rendered yet");
  }

  const harvest = harvestBlobs(doc, { known: ["a-wlab-states", /^data-a-dynamic-image/] });
  if (harvest.unknownKeys.length > 0) meta.unknown_blobs = harvest.unknownKeys;

  const report = losslessReport(doc, used, { base: capture.final_url });
  meta.unparsed_text_chars = report.counts.unparsed;
  const other_sections: OtherSection[] = report.sections;

  const data: BrowsingHistoryPage = {
    heading,
    description,
    history_status,
    history_status_raw: rawStatus ?? null,
    pause_expiration: attr(metaEl ?? undefined, "data-browsing-history-pause-expiration") ?? null,
    status_message,
    is_empty,
    empty_message: is_empty ? empty_message : null,
    items,
    all_asins: recs,
    total_items: recs.length > 0 ? recs.length : null,
    unrendered_asins,
    has_more: unrendered_asins.length > 0,
    end_of_list_marker,
    group_headings,
    section_links,
  };
  return { data, other_sections, meta };
};
