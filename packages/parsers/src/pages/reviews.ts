/**
 * Reviews: the dedicated reviews page (tool `get_reviews`, page kind `reviews`) and the review
 * summary embedded in a product page (tool `get_review_summary`).
 *
 * Both pages render the same review card in two dialects:
 *   - reviews page: `li[data-hook=review]` with `review-title`, `review-body`, `review-date`,
 *     `format-strip`, `review-voting-widget`;
 *   - product page: `div[data-hook=review]` with `reviewTitle`, `reviewRichContentContainer`,
 *     `product-variation-attributes`, `helpfulVoteWidget`, `translateButton`.
 * One card parser tries the selectors of both dialects through `firstOf`.
 *
 * Review bodies are complete in the DOM (the product page only clamps them with CSS behind a
 * "Read more" control), so no expansion click is needed.
 */
import { RfError } from "@rainforest/core";
import type { Capture, OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  TEXT_NODE,
  attr,
  collapse,
  hiddenSelf,
  isElement,
  parseCountDetail,
  parseDocument,
  parseRating,
  q,
  qa,
  ratingFromClass,
  text,
  visible,
} from "../dom.ts";
import { Consumption, losslessReport } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";

// ---------------------------------------------------------------------------------------
// types

export interface ReviewAuthor {
  name: string;
  /** Public profile path without tracking suffixes, or null. */
  profile_path: string | null;
}

export interface ReviewDate {
  /** The date as printed, for example "April 17, 2031". */
  raw: string;
  /** YYYY-MM-DD when the printed date parses unambiguously. */
  iso: string | null;
}

export type ReviewBadgeKind = "vine" | "top_reviewer" | "early_reviewer" | "other";

export interface ReviewBadge {
  kind: ReviewBadgeKind;
  label: string;
}

export interface ReviewImage {
  /** Full-size URL derived from the thumbnail by dropping the size modifier. */
  url: string;
  thumbnail_url: string;
}

export interface ReviewVideo {
  url: string | null;
  thumbnail_url: string | null;
}

export interface ReviewMedia {
  images: ReviewImage[];
  videos: ReviewVideo[];
}

/** A seller or brand response shown under a review. */
export interface ReviewResponse {
  from: string | null;
  text: string;
}

export interface Review {
  /** Amazon review id (the `R...` token). */
  review_id: string | null;
  /** Stars, 1..5. */
  rating: number | null;
  title: string | null;
  /** Full review text; paragraph breaks are kept as newlines. */
  body: string;
  date: ReviewDate | null;
  /** The whole "Reviewed in <country> on <date>" line. */
  date_line: string | null;
  /** Country the review was written in, from the date line. */
  country: string | null;
  verified_purchase: boolean;
  /** The "Color: X | Size: Y" strip as key/value pairs. */
  variant_attributes: Record<string, string>;
  variant_strip: string | null;
  /** ASIN of the reviewed variant when the strip links to it. */
  variant_asin: string | null;
  /** "Used - Very Good" style condition badge (renewed and used items). */
  item_condition: string | null;
  /** "One person found this helpful" is 1; no statement is 0. */
  helpful_votes: number;
  helpful_text: string | null;
  author: ReviewAuthor | null;
  badges: ReviewBadge[];
  media: ReviewMedia;
  /** BCP-47 tag of the review text when the page marks it (for example "es", "fr-BE"). */
  language: string | null;
  /** True when the page is showing an Amazon translation of the review. */
  is_translated: boolean;
  translated_from: string | null;
  /** Untranslated text, only when the page carries both versions. */
  original_title: string | null;
  original_body: string | null;
  /** A "Translate review to English" control is offered. */
  can_translate: boolean;
  responses: ReviewResponse[];
  comment_count: number | null;
  /** Path of the single-review page. */
  permalink: string | null;
}

/** "5".."1" -> percent of ratings. */
export type Histogram = Record<string, number>;

export interface AppliedFilter {
  /** Query parameter value, for example "critical". */
  value: string;
  /** What the dropdown shows, for example "Critical reviews". */
  label: string | null;
}

export interface ReviewFilters {
  sortBy: AppliedFilter | null;
  reviewerType: AppliedFilter | null;
  filterByStar: AppliedFilter | null;
  formatType: AppliedFilter | null;
  mediaType: AppliedFilter | null;
  filterByKeyword: string | null;
}

export interface ReviewFilterChoice {
  /** UI label. */
  label: string;
  /** Query parameter value. */
  value: string;
  selected: boolean;
}

/** One filter control and the query parameter it drives. */
export interface ReviewFilterOption {
  /** Query parameter name: sortBy, reviewerType, filterByStar, formatType, mediaType, filterByKeyword. */
  param: string;
  /** UI label of the control, for example "Sort by". */
  label: string | null;
  control: "select" | "text";
  choices: ReviewFilterChoice[];
}

export interface ReviewPagination {
  /** Pages of reviews loaded so far (1 on a fresh page). */
  page: number;
  has_next: boolean;
  next_page_number: number | null;
  /** Opaque token the next-page request carries. */
  next_page_token: string | null;
  /** Relative href of the next-page control. */
  next_url: string | null;
  next_label: string | null;
  /** "show_more" (XHR button), "link" (numbered pagination) or "none". */
  mechanism: "show_more" | "link" | "none";
  /** XHR path the page declares for loading more reviews. */
  ajax_url: string | null;
  /** True when the page declares that numbered `pageNumber` navigation is switched off. */
  page_param_disabled: boolean | null;
}

export interface ProductRef {
  title: string | null;
  brand: string | null;
  brand_path: string | null;
  image_url: string | null;
  /** The product's own variant strip as key/value pairs. */
  variant_attributes: Record<string, string>;
  path: string | null;
}

export interface ReviewsPage {
  asin: string | null;
  product: ProductRef;
  /** Overall star rating. */
  rating: number | null;
  rating_count: number | null;
  /** Reviews with text; null when the page only shows a filtered count. */
  review_count: number | null;
  /** Matching-review count when a filter is applied. */
  matching_count: number | null;
  /** The count line as printed. */
  review_count_text: string | null;
  review_count_approximate: boolean;
  histogram: Histogram;
  filters: ReviewFilters;
  /** "Filtered by ..." banner text, when a filter is applied. */
  filter_banner: string | null;
  filter_options: ReviewFilterOption[];
  /** "From the United States" style headers above review groups. */
  section_headers: string[];
  reviews: Review[];
  pagination: ReviewPagination;
  /** A "Translate all reviews to English" control is offered. */
  can_translate_all: boolean;
  write_review_path: string | null;
  is_empty: boolean;
  /** Why the list is empty ("no reviews match"); null whenever cards are present. */
  empty_message: string | null;
  /** The "problem filtering reviews" error, when it is rendered. */
  filter_error: string | null;
}

export interface ReviewAspect {
  /** Chip label as displayed. */
  label: string;
  sentiment: "positive" | "negative" | "mixed" | "neutral" | null;
  mentions: number | null;
  /** Mention count as displayed ("6.1K"). */
  mentions_text: string | null;
}

export interface CustomersSay {
  /** The AI generated summary sentence(s). */
  text: string;
  ai_generated: boolean;
  /** The disclosure line next to the summary. */
  disclosure: string | null;
}

export interface ReviewSummary {
  asin: string | null;
  rating: number | null;
  rating_count: number | null;
  /** Rating line as printed or announced ("4.5 out of 5 stars, 2,222 ratings"). */
  rating_text: string | null;
  histogram: Histogram;
  customers_say: CustomersSay | null;
  aspects: ReviewAspect[];
  top_positive_review: Review | null;
  top_critical_review: Review | null;
  /** First-page review cards embedded on the product page. */
  featured_reviews: Review[];
  featured_header: string | null;
  /** The "reviews from other countries" block. */
  other_country_reviews: Review[];
  other_country_header: string | null;
  /** Relative href of the "See more reviews" link. */
  see_all_reviews_path: string | null;
  /** A "Translate all reviews to English" control is offered. */
  can_translate_all: boolean;
}

// ---------------------------------------------------------------------------------------
// text helpers

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
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

const SEP = "\u0001";

interface WalkOptions {
  exclude?: (el: DomElement) => boolean;
  /** Keep line structure (br and block boundaries become newlines). */
  lines?: boolean;
  /** Render `.a-icon-text-separator` icons as a separator marker. */
  separators?: boolean;
}

function walkText(node: DomElement, out: string[], opts: WalkOptions): void {
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child === undefined) continue;
    if (child.nodeType === TEXT_NODE) {
      out.push(child.textContent ?? "");
      continue;
    }
    if (!isElement(child) || hiddenSelf(child)) continue;
    if (opts.exclude !== undefined && opts.exclude(child)) continue;
    if (child.localName === "br") {
      out.push(opts.lines === true ? "\n" : " ");
      continue;
    }
    if (opts.separators === true && child.matches(".a-icon-text-separator")) {
      out.push(SEP);
      continue;
    }
    const block = BLOCK_TAGS.has(child.localName);
    if (block) out.push(opts.lines === true ? "\n" : " ");
    walkText(child, out, opts);
    if (block) out.push(opts.lines === true ? "\n" : " ");
  }
}

function normalizeLines(s: string): string {
  return s
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text keeping paragraph breaks as newlines (at most one blank line in a row). */
function richText(el: DomElement | undefined, exclude?: (el: DomElement) => boolean): string {
  if (el === undefined || !visible(el)) return "";
  const out: string[] = [];
  walkText(el, out, { lines: true, exclude });
  return normalizeLines(out.join(""));
}

/** Visible text split at separator icons and "|" characters. */
function separatedParts(el: DomElement | undefined): string[] {
  if (el === undefined || !visible(el)) return [];
  const out: string[] = [];
  walkText(el, out, { separators: true });
  return out
    .join("")
    .split(new RegExp(`[${SEP}|]`))
    .map((p) => collapse(p))
    .filter((p) => p !== "");
}

/** Raw text content of an element, ignoring visibility (used for markup that is never rendered). */
function rawText(el: DomElement | null | undefined): string {
  return el == null ? "" : collapse(el.textContent ?? "");
}

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Path without query, fragment or the trailing `/ref=...` tracking segment. */
function cleanPath(href: string | undefined): string | null {
  if (href === undefined || href === "" || /^javascript:/i.test(href) || href.startsWith("#")) {
    return null;
  }
  let path = href.split("#")[0] ?? "";
  path = path.split("?")[0] ?? "";
  path = path.replace(/\/ref=[^/]*$/, "");
  return path === "" ? null : path;
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

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "May 19, 2032" or "19 May 2032" -> "2032-05-19"; null when not unambiguous. */
export function isoFromDateText(raw: string): string | null {
  const us = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(raw);
  const eu = /\b(\d{1,2})\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(raw);
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  if (us !== null) {
    month = MONTHS[(us[1] ?? "").slice(0, 3).toLowerCase()];
    day = Number(us[2]);
    year = Number(us[3]);
  } else if (eu !== null) {
    month = MONTHS[(eu[2] ?? "").slice(0, 3).toLowerCase()];
    day = Number(eu[1]);
    year = Number(eu[3]);
  }
  if (month === undefined || day === undefined || year === undefined) return null;
  if (day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** "Reviewed in the United States on May 19, 2032" -> country and date parts. */
export function parseReviewDateLine(line: string): {
  country: string | null;
  date: ReviewDate | null;
} {
  const m = /Reviewed in (?:the )?(.+?)\s+on\s+(.+)$/i.exec(line);
  if (m === null) {
    const iso = isoFromDateText(line);
    return { country: null, date: iso === null ? null : { raw: collapse(line), iso } };
  }
  const raw = collapse(m[2] ?? "");
  return { country: collapse(m[1] ?? "") || null, date: { raw, iso: isoFromDateText(raw) } };
}

/** "One person found this helpful" -> 1, "2,345 people found this helpful" -> 2345. */
export function parseHelpfulVotes(s: string): number | null {
  if (/\bone person\b/i.test(s)) return 1;
  const m = /([\d,]+)\s+(?:people|persons?)\b/i.exec(s);
  return m === null ? null : toInt(m[1]);
}

function lowestCommonAncestor(els: readonly DomElement[]): DomElement | undefined {
  const first = els[0];
  if (first === undefined) return undefined;
  for (let cur: DomElement | null = first; cur != null; cur = cur.parentElement) {
    const holder: DomElement = cur;
    if (els.every((e) => contains(holder, e))) return holder;
  }
  return undefined;
}

function contains(ancestor: DomElement, el: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (cur === ancestor) return true;
  }
  return false;
}

function asinFromPath(path: string | undefined): string | null {
  if (path === undefined) return null;
  const m =
    /\/(?:product-reviews|dp|gp\/product|portal\/customer-reviews|customer-reviews)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(
      path,
    );
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------
// the review card

interface CardContext {
  meta: ParseMeta;
  consumed: Consumption;
}

const BADGE_PATTERNS: readonly (readonly [ReviewBadgeKind, RegExp])[] = [
  ["vine", /\bvine\b/i],
  ["top_reviewer", /\b(top (contributor|reviewer)|hall of fame|top \d+ reviewer|#\d+ reviewer)\b/i],
  ["early_reviewer", /\bearly reviewer\b/i],
];

const BADGE_SELECTOR = [
  ".a-profile-descriptor",
  ".c7y-badge-text",
  "[data-hook=vine-badge]",
  "[data-hook=linkless-vine-review-badge]",
  "[data-hook=vine-review-badge]",
  "[data-hook$='-badge']:not([data-hook=avp-badge]):not([data-hook=item-condition-badge])",
].join(", ");

const STAR_EXCLUDE = (el: DomElement): boolean =>
  el.matches("[data-hook$='review-star-rating'], .a-icon-star, .a-icon-alt");

function classifyBadge(label: string): ReviewBadgeKind {
  for (const [kind, re] of BADGE_PATTERNS) if (re.test(label)) return kind;
  return "other";
}

function parseStrip(strip: DomElement | undefined): {
  attributes: Record<string, string>;
  raw: string | null;
} {
  const attributes: Record<string, string> = {};
  const parts = separatedParts(strip);
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon > 0) {
      const key = collapse(part.slice(0, colon));
      const value = collapse(part.slice(colon + 1));
      if (key !== "" && value !== "") attributes[key] = value;
    } else {
      attributes["Variant"] = part;
    }
  }
  return { attributes, raw: parts.length === 0 ? null : parts.join(" | ") };
}

/** Parse one review card (either dialect). */
export function parseReviewCard(card: DomElement, ctx: CardContext): Review {
  const { meta, consumed } = ctx;
  const take = <E extends DomElement | null | undefined>(el: E): E => consumed.take(el);

  const titleLink = q(card, "[data-hook=review-title][href], a[href*='/customer-reviews/srp/']");
  const titleEl = firstOf<DomElement>(
    "review.title",
    [
      ["review-title", () => q(card, "[data-hook=review-title], [data-hook=cmps-review-title]")],
      ["reviewTitle", () => q(card, "[data-hook=reviewTitle]")],
      ["css", () => q(card, ".review-title-content, .review-title")],
    ],
    meta,
    { optional: true },
  );
  const title = titleEl === undefined ? "" : text(titleEl, { exclude: STAR_EXCLUDE });
  take(titleEl);
  take(titleEl?.parentElement?.localName === "a" ? titleEl.parentElement : undefined);

  const review_id =
    firstOf<string>(
      "review.id",
      [
        ["id-attr", () => (/^R[A-Z0-9]{6,}$/.test(card.id) ? card.id : undefined)],
        [
          "customer-review-id",
          () =>
            /^customer_review-(R[A-Z0-9]{6,})$/.exec(
              attr(q(card, "[id^='customer_review-']"), "id") ?? "",
            )?.[1],
        ],
        [
          "title-link",
          () =>
            /\/(R[A-Z0-9]{6,})(?:[/?]|$)/.exec(
              attr(titleLink ?? titleEl?.closest("a[href]") ?? undefined, "href") ?? "",
            )?.[1],
        ],
        ["data-attr", () => attr(card, "data-review-id")],
      ],
      meta,
      { optional: true },
    ) ?? null;

  const starEl = q(card, "[data-hook$='review-star-rating'], i.review-rating");
  const rating =
    firstOf<number>(
      "review.rating",
      [
        [
          "star-alt",
          () => parseRating(rawText(starEl?.querySelector(".a-icon-alt") ?? starEl))?.value,
        ],
        ["star-class", () => ratingFromClass(starEl?.getAttribute("class"))],
        ["icon-alt", () => parseRating(rawText(q(card, ".a-icon-alt")))?.value],
      ],
      meta,
      { optional: true },
    ) ?? null;
  take(starEl);

  const bodyEl = firstOf<DomElement>(
    "review.body",
    [
      ["rich-content", () => q(card, "[data-hook=reviewRichContentContainer]")],
      ["review-body", () => q(card, "[data-hook=review-body]")],
      ["review-text", () => q(card, "[data-hook=reviewText]")],
      ["css", () => q(card, ".review-text-content, .review-text")],
    ],
    meta,
    { optional: true },
  );
  const body = richText(bodyEl, (e) => e.matches("[data-hook=reviewExpandButtonContainer]"));
  take(bodyEl?.closest("[data-hook=reviewTextContainer]") ?? bodyEl);

  // Translation: the page carries the original and the translated text next to each other,
  // only one of them rendered.
  const translated = qa(card, ".cr-translated-review-content").filter((e) => text(e) !== "");
  const translationInfo = q(card, "[data-hook=translationInfo]");
  const translatedFrom =
    /translated from\s+(.+?)\s+by\s+amazon/i.exec(text(translationInfo))?.[1] ?? null;
  const is_translated = translated.length > 0 || translationInfo !== undefined;
  const originals = Array.from(card.querySelectorAll(".cr-original-review-content"));
  const originalFor = (scope: DomElement | undefined): string | null => {
    if (scope === undefined || !is_translated) return null;
    const hit = originals.find((e) => contains(scope, e));
    const t = rawText(hit);
    return t === "" ? null : t;
  };
  take(translationInfo);
  const language =
    firstOf<string>(
      "review.language",
      [
        ["original-lang", () => attr(originals[0], "lang")],
        ["title-lang", () => attr(q(card, "[data-hook=reviewTitle][lang]"), "lang")],
        ["body-lang", () => attr(q(card, "[data-hook=reviewRichContentContainer][lang]"), "lang")],
        ["any-lang", () => attr(card.querySelector("[data-hook=review-body] [lang]"), "lang")],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const translateControl = q(
    card,
    "[data-hook=cr-translate-this-review-link], [data-hook=translateButton], .cr-translate-this-review-section",
  );
  const can_translate = translateControl !== undefined;
  take(q(card, ".cr-translate-this-review-section"));
  take(q(card, "[data-hook=translateButton]"));
  take(q(card, "[data-hook=seeOriginalReviewLink]"));
  take(q(card, "[data-hook=translationErrorMessage]"));

  const dateEl = firstOf<DomElement>(
    "review.date",
    [
      ["review-date", () => q(card, "[data-hook=review-date]")],
      ["css", () => q(card, ".review-date")],
      [
        "text-anchor",
        () =>
          qa(card, "span, div").find(
            (e) => e.children.length === 0 && /^Reviewed in .+ on .+/i.test(text(e)),
          ),
      ],
    ],
    meta,
    { optional: true },
  );
  const dateLine = dateEl === undefined ? null : text(dateEl);
  const parsedDate =
    dateLine === null ? { country: null, date: null } : parseReviewDateLine(dateLine);
  take(dateEl);

  // Variant strip, verified badge and condition badge.
  const stripEl = firstOf<DomElement>(
    "review.variant_strip",
    [
      [
        "format-strip",
        () => q(card, "a[data-hook=format-strip], [data-hook=format-strip-linkless]"),
      ],
      [
        "variation-attributes",
        () =>
          qa(card, "[data-hook=product-variation-attributes] a:not([data-hook])").find(
            (a) => q(a, "[data-hook=avp-badge], [data-hook=item-condition-badge]") === undefined,
          ),
      ],
    ],
    meta,
    { optional: true },
  );
  const strip = parseStrip(stripEl);
  const variant_asin = asinFromPath(attr(stripEl, "href")) ?? null;
  take(stripEl);
  const avpEl = firstOf<DomElement>(
    "review.verified_purchase",
    [
      ["avp-badge", () => q(card, "[data-hook=avp-badge]")],
      [
        "text-anchor",
        () =>
          qa(card, "span, a").find(
            (e) => e.children.length === 0 && /^Verified Purchase$/i.test(text(e)),
          ),
      ],
    ],
    meta,
    { optional: true },
  );
  take(avpEl);
  const conditionEl = q(card, "[data-hook=item-condition-badge]");
  const item_condition =
    conditionEl === undefined
      ? null
      : collapse(text(conditionEl).replace(/^Condition:\s*/i, "")) || null;
  take(conditionEl);

  // Helpful votes.
  const voteEl = firstOf<DomElement>(
    "review.helpful_votes",
    [
      ["vote-statement", () => q(card, "[data-hook=helpful-vote-statement]")],
      ["css", () => q(card, ".cr-vote-text")],
    ],
    meta,
    { optional: true },
  );
  const helpful_text = voteEl === undefined ? null : text(voteEl) || null;
  const helpful_votes = (helpful_text === null ? null : parseHelpfulVotes(helpful_text)) ?? 0;
  take(voteEl);
  // Vote controls: the Helpful button, its (hidden) feedback states and the Report link are
  // interface chrome. Wrappers stay unconsumed so a new control next to them still surfaces.
  for (const sel of [
    ".cr-helpful-icon-button",
    "[data-hook=helpfulVoteButton]",
    ".cr-vote-focusable",
    "[data-hook=reportAbuseButton]",
    ".cr-footer-line-height",
  ]) {
    for (const el of qa(card, sel)) take(el);
  }

  // Author and badges.
  const genome = q(card, "[data-hook=genome-widget]");
  const nameEl = q(card, ".a-profile-name");
  const profileEl = q(card, "a.a-profile[href]") ?? genome?.querySelector("a[href]") ?? undefined;
  const author: ReviewAuthor | null =
    nameEl === undefined
      ? null
      : { name: text(nameEl), profile_path: cleanPath(attr(profileEl ?? undefined, "href")) };
  const badges: ReviewBadge[] = [];
  const addBadge = (label: string): void => {
    const clean = collapse(label);
    if (clean === "" || /^Verified Purchase$/i.test(clean)) return;
    if (!badges.some((b) => b.label === clean))
      badges.push({ kind: classifyBadge(clean), label: clean });
  };
  for (const el of qa(card, BADGE_SELECTOR)) {
    addBadge(text(el));
    take(el);
  }
  for (const [kind, re] of BADGE_PATTERNS) {
    if (badges.some((b) => b.kind === kind)) continue;
    const hit = qa(card, "span, div, a").find(
      (e) =>
        e.children.length === 0 &&
        !e.matches(".a-profile-name") &&
        e.closest("[data-hook^='format-strip']") === null &&
        e.closest(
          "[data-hook$='-body'], [data-hook=reviewText], [data-hook$='itle'], [data-hook=reviewTitle]",
        ) === null &&
        re.test(text(e)) &&
        text(e).length <= 80,
    );
    if (hit !== undefined) {
      addBadge(text(hit));
      take(hit);
    }
  }
  take(nameEl);
  take(q(card, ".a-profile-avatar-wrapper"));

  // Media.
  const images: ReviewImage[] = [];
  for (const img of qa(card, "img[data-hook=review-image-tile], img.review-image-tile")) {
    const thumb = attr(img, "src");
    if (thumb === undefined || thumb === "") continue;
    images.push({
      url: thumb.replace(/\._[A-Za-z0-9,_-]+(\.[A-Za-z]{3,4})$/, "$1"),
      thumbnail_url: thumb,
    });
    take(img);
  }
  take(q(card, ".review-image-container"));
  const videos: ReviewVideo[] = [];
  for (const v of qa(card, "video, [data-hook*='video' i]")) {
    if (v.localName === "video") {
      videos.push({
        url: attr(v, "src") ?? attr(v.querySelector("source[src]") ?? undefined, "src") ?? null,
        thumbnail_url: attr(v, "poster") ?? null,
      });
    } else if (v.querySelector("video") === null) {
      videos.push({
        url: attr(v.querySelector("a[href]") ?? undefined, "href") ?? null,
        thumbnail_url: attr(v.querySelector("img[src]") ?? undefined, "src") ?? null,
      });
    } else continue;
    take(v);
  }

  // Seller / brand responses and comments.
  const responses: ReviewResponse[] = [];
  const responseEls: DomElement[] = [];
  for (const el of qa(
    card,
    "[data-hook*='response' i]:not([data-hook*='error' i]), .review-response, .cr-response, .reviewResponse",
  )) {
    if (responseEls.some((r) => contains(r, el))) continue;
    const t = richText(el);
    if (t === "") continue;
    const label = text(q(el, "strong, .a-text-bold, b"));
    responses.push({
      from: label === "" ? null : label,
      text: label !== "" && t.startsWith(label) ? t.slice(label.length).replace(/^[\s:]+/, "") : t,
    });
    responseEls.push(el);
    take(el);
  }
  const commentEl = q(card, "[data-hook=review-comment], .review-comment-total");
  const comment_count = toInt(/(\d[\d,]*)/.exec(text(commentEl))?.[1]) ?? null;
  take(commentEl);

  return {
    review_id,
    rating,
    title: title === "" ? null : title,
    body,
    date: parsedDate.date,
    date_line: dateLine,
    country: parsedDate.country,
    verified_purchase: avpEl !== undefined,
    variant_attributes: strip.attributes,
    variant_strip: strip.raw,
    variant_asin,
    item_condition,
    helpful_votes,
    helpful_text,
    author,
    badges,
    media: { images, videos },
    language,
    is_translated,
    translated_from: translatedFrom,
    original_title: originalFor(titleEl),
    original_body: originalFor(bodyEl),
    can_translate,
    responses,
    comment_count,
    permalink: cleanPath(attr(titleLink ?? titleEl?.closest("a[href]") ?? undefined, "href")),
  };
}

/** Outermost visible review cards of a document, in order. */
function reviewCards(root: DomDocument | DomElement): DomElement[] {
  return qa(root, "[data-hook=review]").filter((el) => {
    const outer = el.parentElement?.closest("[data-hook=review]");
    return outer === null || outer === undefined;
  });
}

// ---------------------------------------------------------------------------------------
// rating block and histogram (shared by both parsers)

interface RatingBlock {
  rating: number | null;
  rating_count: number | null;
  rating_text: string | null;
  histogram: Histogram;
}

const STAR_WORDS: Record<string, string> = {
  five: "5",
  four: "4",
  three: "3",
  two: "2",
  one: "1",
};

function parseHistogram(
  scope: readonly DomElement[],
  meta: ParseMeta,
  consumed: Consumption,
): Histogram {
  const fromAria = (): Histogram | undefined => {
    const h: Histogram = {};
    for (const root of scope) {
      for (const a of qa(root, "[aria-label]")) {
        const m = /^(\d)\s+stars?\s+(?:represents?|is|are)\s+(\d{1,3})%/i.exec(
          attr(a, "aria-label") ?? "",
        );
        if (m?.[1] !== undefined && m[2] !== undefined) {
          h[m[1]] = Number(m[2]);
          consumed.take(a);
        }
      }
    }
    return Object.keys(h).length > 0 ? h : undefined;
  };
  const fromRows = (): Histogram | undefined => {
    const h: Histogram = {};
    for (const root of scope) {
      for (const row of qa(
        root,
        "#histogramTable tr, [data-hook=histogram-table-row], tr.a-histogram-row",
      )) {
        const m = /(\d)\s*star.*?(\d{1,3})\s*%/i.exec(text(row));
        if (m?.[1] !== undefined && m[2] !== undefined) {
          h[m[1]] = Number(m[2]);
          consumed.take(row);
        }
      }
    }
    return Object.keys(h).length > 0 ? h : undefined;
  };
  const fromHref = (): Histogram | undefined => {
    const h: Histogram = {};
    for (const root of scope) {
      for (const a of qa(root, "a[href*='filterByStar=']")) {
        const star = /filterByStar=(five|four|three|two|one)_star/.exec(attr(a, "href") ?? "")?.[1];
        const pct = /(\d{1,3})\s*%/.exec(text(a))?.[1];
        const digit = star === undefined ? undefined : STAR_WORDS[star];
        if (digit !== undefined && pct !== undefined) {
          h[digit] = Number(pct);
          consumed.take(a);
        }
      }
    }
    return Object.keys(h).length > 0 ? h : undefined;
  };
  return (
    firstOf<Histogram>(
      "histogram",
      [
        ["aria-label", fromAria],
        ["table-rows", fromRows],
        ["filter-href", fromHref],
      ],
      meta,
      { optional: true },
    ) ?? {}
  );
}

function parseRatingBlock(
  scope: readonly DomElement[],
  doc: DomDocument,
  meta: ParseMeta,
  consumed: Consumption,
): RatingBlock {
  const ariaEl = firstOf<DomElement>(
    "rating_line",
    scope.map(
      (root) =>
        [
          "aria-label",
          () =>
            qa(root, "[aria-label]").find((e) =>
              /\d(?:\.\d+)?\s+out of\s+5\s+stars/i.test(attr(e, "aria-label") ?? ""),
            ),
        ] as const,
    ),
    meta,
    { optional: true },
  );
  const aria = attr(ariaEl, "aria-label");
  const rating =
    firstOf<number>(
      "rating",
      [
        ["aria-label", () => parseRating(aria)?.value],
        [
          "out-of-text",
          () =>
            parseRating(
              text(
                scope
                  .map((r) => q(r, "[data-hook=rating-out-of-text]"))
                  .find((e) => e !== undefined),
              ),
            )?.value,
        ],
        [
          "icon-alt",
          () =>
            parseRating(
              rawText(
                qa(scope[0], ".a-icon-alt").find((e) => e.closest("[data-hook=review]") === null),
              ),
            )?.value,
        ],
        ["acr-popover", () => parseRating(text(q(doc, "#acrPopover .a-icon-alt")))?.value],
        ["acr-title", () => parseRating(attr(q(doc, "#acrPopover"), "title"))?.value],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const countText = (re: RegExp): string | undefined => {
    for (const r of scope) {
      for (const e of qa(
        r,
        "[data-hook=total-review-count], [data-hook=cr-filter-info-review-rating-count]",
      )) {
        const m = re.exec(text(e));
        if (m !== null) return m[0];
      }
    }
    return undefined;
  };
  const rating_count =
    firstOf<number>(
      "rating_count",
      [
        ["aria-label", () => toInt(/,\s*([\d,]+)\s+ratings?/i.exec(aria ?? "")?.[1]) ?? undefined],
        ["global-ratings", () => parseCountDetail(countText(/[\d,]+\s+global ratings?/i))?.value],
        [
          "total-ratings",
          () =>
            toInt(
              /([\d,]+)\s+total ratings?/i.exec(countText(/[\d,]+\s+total ratings?/i) ?? "")?.[1],
            ) ?? undefined,
        ],
        [
          "acr-count",
          () =>
            parseCountDetail(
              attr(q(doc, "#acrCustomerReviewText"), "aria-label") ??
                text(q(doc, "#acrCustomerReviewText")),
            )?.value,
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  consumed.take(ariaEl);
  for (const r of scope) consumed.take(r.id === "averageCustomerReviewsAnchor" ? r : undefined);
  return {
    rating,
    rating_count,
    rating_text: aria ?? null,
    histogram: parseHistogram(scope, meta, consumed),
  };
}

interface CountsText {
  rating_count?: number;
  review_count?: number;
  matching?: boolean;
  approximate: boolean;
}

/** "2,222 total ratings, 333 with reviews", "9,876 customer reviews", "More than 7,000 matching customer reviews". */
export function parseCountsText(s: string): CountsText {
  const both = /([\d,]+)\s+total ratings?,\s*([\d,]+)\s+with reviews?/i.exec(s);
  if (both !== null) {
    return {
      rating_count: toInt(both[1]) ?? undefined,
      review_count: toInt(both[2]) ?? undefined,
      approximate: false,
    };
  }
  const reviews =
    /(more than |over |about )?([\d,]+)\+?\s+(matching\s+)?(?:customer\s+|global\s+)?reviews?/i.exec(
      s,
    );
  const ratings = /([\d,]+)\s+(?:global |total )?ratings?/i.exec(s);
  const out: CountsText = { approximate: false };
  if (reviews !== null) {
    out.review_count = toInt(reviews[2]) ?? undefined;
    out.approximate = reviews[1] !== undefined;
    out.matching = reviews[3] !== undefined;
  }
  if (ratings !== null) out.rating_count = toInt(ratings[1]) ?? undefined;
  return out;
}

// ---------------------------------------------------------------------------------------
// the reviews page

const FILTER_PARAMS = [
  ["sortBy", "sort-order-dropdown"],
  ["reviewerType", "reviewer-type-dropdown"],
  ["filterByStar", "star-count-dropdown"],
  ["formatType", "format-type-dropdown"],
  ["mediaType", "media-type-dropdown"],
] as const;

const FILTER_DEFAULTS: Record<string, string> = {
  sortBy: "helpful",
  reviewerType: "all_reviews",
  filterByStar: "all_stars",
  formatType: "all_formats",
  mediaType: "all_contents",
};

const STATE_KEYS = [
  "asin",
  "filterByStar",
  "formatType",
  "filterByKeyword",
  "reviewerType",
  "reviewsAjaxUrl",
  "isArpPaginationDisabled",
] as const;

type ReviewState = Partial<Record<(typeof STATE_KEYS)[number], unknown>>;

/** Whitelisted keys of `#cr-state-object` (it also carries a customer id and CSRF tokens). */
function readState(doc: DomDocument | DomElement): ReviewState | undefined {
  const raw = attr(doc.querySelector("#cr-state-object") ?? undefined, "data-state");
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ReviewState = {};
    for (const key of STATE_KEYS) if (key in parsed) out[key] = parsed[key];
    return out;
  } catch {
    return undefined;
  }
}

function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url, "https://www.example.com").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

interface SelectInfo {
  param: string;
  select: DomElement;
  label: string | null;
  choices: ReviewFilterChoice[];
  /** Wrapper of the visible dropdown (label, button), consumed by the page parser. */
  container: DomElement | null;
  /** Value of the option carrying the `selected` attribute. */
  selected_value: string | undefined;
  /** Value of the option whose label the dropdown button shows. */
  prompt_value: string | undefined;
}

function optionParam(select: DomElement): string | undefined {
  for (const opt of Array.from(select.querySelectorAll("option"))) {
    const raw = opt.getAttribute("data-reviews-state-param");
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const key = Object.keys(parsed).find((k) => k !== "pageNumber" && k !== "nextPageToken");
      if (key !== undefined) return key;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Read every filter dropdown. Options are never rendered (hidden marker), so read raw markup. */
function readSelects(doc: DomDocument): SelectInfo[] {
  const out: SelectInfo[] = [];
  const selects = qa(doc, "#cm_cr-view_opt_sort_filter select, select.a-native-dropdown");
  const seen = new Set<DomElement>();
  for (const select of selects) {
    if (seen.has(select)) continue;
    seen.add(select);
    const byId = FILTER_PARAMS.find(([, id]) => id === select.id)?.[0];
    const param = optionParam(select) ?? byId;
    if (param === undefined || !FILTER_PARAMS.some(([p]) => p === param)) continue;
    const choices: ReviewFilterChoice[] = Array.from(select.querySelectorAll("option")).flatMap(
      (opt) => {
        const value = opt.getAttribute("value");
        const label = rawText(opt);
        if (value === null || value === "" || label === "") return [];
        return [{ label, value, selected: opt.hasAttribute("selected") }];
      },
    );
    const labelEl = doc.querySelector(`label[for='${select.id}']`);
    const container =
      select.closest(".a-dropdown-container")?.parentElement ?? select.parentElement;
    const prompt = collapse(container?.querySelector(".a-dropdown-prompt")?.textContent ?? "");
    const selected = choices.find((c) => c.selected);
    const byPrompt = prompt === "" ? undefined : choices.find((c) => c.label === prompt);
    const applied = selected?.value ?? byPrompt?.value;
    out.push({
      param,
      select,
      label: rawText(labelEl) || null,
      choices: choices.map((c) => ({
        ...c,
        selected: applied === undefined ? c.selected : c.value === applied,
      })),
      container: select.closest(".a-dropdown-container"),
      selected_value: selected?.value,
      prompt_value: byPrompt?.value,
    });
  }
  return out;
}

function findReviewsRoot(doc: DomDocument): DomElement {
  const anchors = [
    "#cm_cr-brdcmb",
    "#cm_cr-product_info",
    "#cm_cr-review_list",
    "#cm_cr-pagination_bar",
  ]
    .map((s) => q(doc, s))
    .filter((e): e is DomElement => e !== undefined);
  const cards = reviewCards(doc);
  if (anchors.length === 0 && cards[0] !== undefined) anchors.push(cards[0]);
  const lca = lowestCommonAncestor(anchors);
  return lca ?? doc.body;
}

/** The element whose visible text the reviews parser accounts for (for coverage checks). */
export function reviewsMainRoot(doc: DomDocument): DomElement {
  return findReviewsRoot(doc);
}

function parseVariantList(el: DomElement | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (el === undefined) return attributes;
  for (const item of qa(el, "li.cr-variations-list-item, li")) {
    if (item.querySelector("a[aria-label^='Change']") !== null && text(item).startsWith("Change"))
      continue;
    for (const part of separatedParts(item)) {
      const colon = part.indexOf(":");
      if (colon > 0) attributes[collapse(part.slice(0, colon))] = collapse(part.slice(colon + 1));
    }
  }
  return attributes;
}

export const parseReviews: Parser<ReviewsPage> = (capture: Capture): ParseResult<ReviewsPage> => {
  const meta = newMeta();
  const consumed = new Consumption();
  const doc = parseDocument(capture.html);
  const state = readState(doc);
  const params = queryOf(capture.final_url || capture.url);
  const cards = reviewCards(doc);
  const listEl = q(doc, "#cm_cr-review_list");
  const infoEl = q(doc, "#cm_cr-product_info");
  if (cards.length === 0 && listEl === undefined && infoEl === undefined && state === undefined) {
    throw new RfError("layout_unrecognized", "no reviews page markers found");
  }
  const root = findReviewsRoot(doc);

  // reviews
  const reviews = cards.map((card) => parseReviewCard(card, { meta, consumed }));

  // product
  const productTitleEl = firstOf<DomElement>(
    "product.title",
    [
      ["product-link", () => q(doc, "[data-hook=product-link]")],
      ["info-title", () => q(doc, ".product-info-title a, .product-info-title")],
      ["breadcrumb", () => q(doc, "#cm_cr-brdcmb a[href*='/dp/']")],
    ],
    meta,
    { optional: true },
  );
  const docTitle = collapse(doc.title ?? "").replace(
    /^Amazon\.com:\s*(Customer reviews:\s*)?/i,
    "",
  );
  const brandEl = q(doc, "[data-hook=cr-product-byline] a[href]");
  const asin =
    firstOf<string>(
      "asin",
      [
        ["state-object", () => asString(state?.asin)?.match(/^[A-Z0-9]{10}$/)?.[0]],
        [
          "capture-url",
          () =>
            asinFromPath(
              new URL(capture.final_url || capture.url, "https://www.example.com").pathname,
            ) ?? undefined,
        ],
        [
          "product-link",
          () =>
            asinFromPath(attr(productTitleEl?.closest("a[href]") ?? productTitleEl, "href")) ??
            undefined,
        ],
        [
          "asin-in-url",
          () => asinFromPath(attr(q(doc, "#cm_cr-brdcmb a[href*='/dp/']"), "href")) ?? undefined,
        ],
      ],
      meta,
    ) ?? null;
  const product: ProductRef = {
    title: (productTitleEl === undefined ? "" : text(productTitleEl)) || docTitle || null,
    brand: brandEl === undefined ? null : text(brandEl) || null,
    brand_path: cleanPath(attr(brandEl, "href")),
    image_url: attr(q(doc, "img[data-hook=cr-product-image]"), "src") ?? null,
    variant_attributes: parseVariantList(q(doc, "ul.cr-variations-list")),
    path: cleanPath(attr(productTitleEl?.closest("a[href]") ?? productTitleEl, "href")),
  };
  const writeEl = q(doc, "#writeReviewButton a[href], a[href*='/review/create-review']");

  // rating, counts, histogram
  const ratingScope = [
    q(doc, "#averageCustomerReviewsAnchor"),
    q(doc, ".reviewNumericalSummary"),
    q(doc, "#cm_cr-product_info"),
  ].filter((e): e is DomElement => e !== undefined);
  const block = parseRatingBlock(ratingScope, doc, meta, consumed);
  const countEl = q(doc, "[data-hook=cr-filter-info-review-rating-count]");
  const review_count_text = countEl === undefined ? null : text(countEl) || null;
  const counts =
    review_count_text === null ? { approximate: false } : parseCountsText(review_count_text);
  const bannerEl = q(doc, "[data-hook=cr-filter-info-text]");
  const filteredBanner = bannerEl === undefined ? null : text(bannerEl) || null;
  const isFiltered = counts.matching === true || filteredBanner !== null;
  const rating_count = block.rating_count ?? counts.rating_count ?? null;

  // filters
  const selects = readSelects(doc);
  const filterValue = (param: keyof typeof FILTER_DEFAULTS & string): AppliedFilter | null => {
    const info = selects.find((s) => s.param === param);
    const labelOf = (v: string): string | null =>
      info?.choices.find((c) => c.value === v)?.label ?? null;
    const hit = firstOf<string>(
      `filter.${param}`,
      [
        ["selected-attr", () => info?.selected_value],
        ["dropdown-prompt", () => info?.prompt_value],
        ["state-object", () => asString((state as Record<string, unknown> | undefined)?.[param])],
        ["capture-url", () => params.get(param) ?? undefined],
        ["default-option", () => (info === undefined ? undefined : FILTER_DEFAULTS[param])],
      ],
      meta,
      { optional: true },
    );
    return hit === undefined ? null : { value: hit, label: labelOf(hit) };
  };
  const keyword =
    firstOf<string>(
      "filter.filterByKeyword",
      [
        ["input-value", () => attr(q(doc, "#filterByKeywordTextBox"), "value")],
        ["state-object", () => asString(state?.filterByKeyword)],
        ["capture-url", () => params.get("filterByKeyword") ?? undefined],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const filters: ReviewFilters = {
    sortBy: filterValue("sortBy"),
    reviewerType: filterValue("reviewerType"),
    filterByStar: filterValue("filterByStar"),
    formatType: filterValue("formatType"),
    mediaType: filterValue("mediaType"),
    filterByKeyword: keyword,
  };
  const filter_options: ReviewFilterOption[] = selects.map((s) => ({
    param: s.param,
    label: s.label,
    control: "select",
    choices: s.choices,
  }));
  if (q(doc, "#filterByKeywordTextBox") !== undefined) {
    filter_options.push({
      param: "filterByKeyword",
      label:
        rawText(doc.querySelector("label[for='filterByKeywordTextBox']")) ||
        "Search customer reviews",
      control: "text",
      choices: [],
    });
  }

  // pagination
  const showMore = q(doc, "[data-hook=show-more-button]");
  const classicNext = q(doc, "ul.a-pagination li.a-last:not(.a-disabled) a[href]");
  const selectedPage = q(doc, "ul.a-pagination li.a-selected");
  let nextState: Record<string, unknown> = {};
  try {
    nextState = JSON.parse(attr(showMore, "data-reviews-state-param") ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    nextState = {};
  }
  const nextNumber =
    firstOf<number>(
      "pagination.next_page_number",
      [
        ["show-more-state", () => toInt(asString(nextState.pageNumber)) ?? undefined],
        [
          "classic-href",
          () =>
            toInt(/[?&]pageNumber=(\d+)/.exec(attr(classicNext, "href") ?? "")?.[1]) ?? undefined,
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const hasNext = showMore !== undefined || classicNext !== undefined;
  const page =
    firstOf<number>(
      "pagination.page",
      [
        ["next-minus-one", () => (hasNext && nextNumber !== null ? nextNumber - 1 : undefined)],
        ["classic-selected", () => toInt(text(selectedPage).match(/\d+/)?.[0]) ?? undefined],
        ["capture-url", () => toInt(params.get("pageNumber") ?? undefined) ?? undefined],
        ["first-page", () => 1],
      ],
      meta,
    ) ?? 1;
  const urlPage = toInt(params.get("pageNumber") ?? undefined);
  if (urlPage !== null && urlPage !== page) {
    meta.warnings.push(
      `pagination: URL asked for pageNumber=${urlPage} but the page shows page ${page}`,
    );
  }
  const pagination: ReviewPagination = {
    page,
    has_next: hasNext,
    next_page_number: hasNext ? nextNumber : null,
    next_page_token: asString(nextState.nextPageToken) ?? null,
    next_url: attr(showMore ?? classicNext, "href") ?? null,
    next_label: text(showMore ?? classicNext) || null,
    mechanism: showMore !== undefined ? "show_more" : classicNext !== undefined ? "link" : "none",
    ajax_url: asString(state?.reviewsAjaxUrl) ?? null,
    page_param_disabled:
      typeof state?.isArpPaginationDisabled === "boolean" ? state.isArpPaginationDisabled : null,
  };

  // empty / error states: only a page without review cards can be "empty"; the filter error
  // block is reported on its own whenever it is rendered.
  const errorEl = q(doc, ".review-filter-error");
  const filter_error = errorEl === undefined ? null : text(errorEl) || null;
  const noReviewsEl =
    reviews.length > 0
      ? undefined
      : firstOf<DomElement>(
          "empty_message",
          [
            ["no-reviews-section", () => q(doc, ".no-reviews-section, [data-hook=no-reviews]")],
            ["error-block", () => errorEl],
            [
              "text-anchor",
              () =>
                qa(listEl ?? doc, "span, div, p").find(
                  (e) => e.children.length === 0 && /\bno (customer )?reviews\b/i.test(text(e)),
                ),
            ],
          ],
          meta,
          { optional: true },
        );
  const empty_message = noReviewsEl === undefined ? null : text(noReviewsEl) || null;

  // section headers
  const headers = qa(
    doc,
    "[data-hook=arp-local-reviews-header], [data-hook=arp-global-reviews-header]",
  );
  const translateAll = q(doc, "[data-hook=cr-translate-these-reviews-link]");

  // Consume what is exposed above, piece by piece, so anything unknown inside these containers
  // still surfaces in other_sections. Buy box, customer-service and footer links carry no typed
  // output and are left to other_sections on purpose.
  for (const sel of [
    "#cm_cr-brdcmb",
    "#averageCustomerReviewsAnchor",
    "#cm_cr-view_opt_search",
    "#cm_cr-pagination_bar",
    ".cr-translate-these-reviews-section",
    ".no-reviews-section",
    ".product-title",
    "[data-hook=cr-product-byline]",
    ".product-image",
    "ul.cr-variations-list",
    "#writeReviewButton",
    ".reviews-sort-order-label",
    "#reviews-filter-by-label",
    "[data-hook=cr-filtered-by-text]",
    "[data-hook=cr-filter-info-text]",
    "[data-hook=cr-filter-info-review-rating-count]",
    "#filter-info-section hr",
    "[data-hook=cr-filter-info-section] a[data-reviews-state-param]",
  ]) {
    for (const el of qa(doc, sel)) consumed.take(el);
  }
  for (const info of selects) {
    consumed.take(info.container);
    consumed.take(q(doc, `label[for='${info.select.id}']`));
  }
  consumed.takeAll(headers);
  consumed.take(errorEl);

  if (block.rating === null) meta.warnings.push("rating: not found");
  if (reviews.length === 0 && empty_message === null) {
    meta.warnings.push("reviews: no review cards and no empty-state message");
  }
  const report = losslessReport(doc, consumed, { root, base: capture.final_url || capture.url });
  meta.unparsed_text_chars = report.counts.unparsed;
  meta.warnings = [...new Set(meta.warnings)];

  const data: ReviewsPage = {
    asin,
    product,
    rating: block.rating,
    rating_count,
    review_count: isFiltered ? null : (counts.review_count ?? null),
    matching_count: isFiltered ? (counts.review_count ?? null) : null,
    review_count_text,
    review_count_approximate: counts.approximate,
    histogram: block.histogram,
    filters,
    filter_banner: filteredBanner,
    filter_options,
    section_headers: headers.map((h) => text(h)).filter((t) => t !== ""),
    reviews,
    pagination,
    can_translate_all: translateAll !== undefined,
    write_review_path: cleanPath(attr(writeEl, "href")),
    is_empty: reviews.length === 0,
    empty_message,
    filter_error,
  };
  return { data, other_sections: report.sections as OtherSection[], meta };
};

// ---------------------------------------------------------------------------------------
// the review summary on a product page

const SUMMARY_ROOTS = [
  "#customer-reviews_feature_div",
  "#reviewsMedley",
  "[data-hook=reviews-medley-widget]",
  "#customerReviews",
];

/** The element holding the product page's reviews section (for coverage checks). */
export function reviewSummaryRoot(doc: DomDocument): DomElement | undefined {
  for (const sel of SUMMARY_ROOTS) {
    const el = q(doc, sel);
    if (el !== undefined) return el;
  }
  return undefined;
}

const ASPECT_ARIA =
  /^(positive|negative|mixed|neutral)\s+aspect,\s*(.+?),\s*([\d,]+)\s+mentions?$/i;

function parseAspect(tab: DomElement): ReviewAspect | undefined {
  const aria = attr(tab, "aria-label") ?? "";
  const m = ASPECT_ARIA.exec(aria);
  const shown = text(tab);
  const tail = /\s*\(([\d.,]+\s*[KkMm]?\+?)\)\s*$/.exec(shown);
  const label =
    collapse(tail === null ? shown : shown.slice(0, tail.index)) || collapse(m?.[2] ?? "");
  if (label === "") return undefined;
  const sentiment = m?.[1]?.toLowerCase() as ReviewAspect["sentiment"] | undefined;
  return {
    label,
    sentiment: sentiment ?? null,
    mentions: m === null ? (parseCountDetail(tail?.[1])?.value ?? null) : toInt(m[3]),
    mentions_text: tail?.[1] === undefined ? null : collapse(tail[1]),
  };
}

export const parseReviewSummary: Parser<ReviewSummary> = (
  capture: Capture,
): ParseResult<ReviewSummary> => {
  const meta = newMeta();
  const consumed = new Consumption();
  const doc = parseDocument(capture.html);
  const sectionRoot = reviewSummaryRoot(doc);
  if (sectionRoot === undefined) {
    const hasAcr = q(doc, "#averageCustomerReviews, #acrPopover") !== undefined;
    if (!hasAcr) throw new RfError("layout_unrecognized", "no customer reviews section found");
    meta.warnings.push("reviews section: container not found, using the page body");
  }
  const root = sectionRoot ?? doc.body;
  const state = readState(doc);

  const asin =
    firstOf<string>(
      "asin",
      [
        ["state-object", () => asString(state?.asin)?.match(/^[A-Z0-9]{10}$/)?.[0]],
        [
          "asin-input",
          () =>
            /^[A-Z0-9]{10}$/.exec(
              attr(doc.querySelector("input#ASIN") ?? undefined, "value") ?? "",
            )?.[0],
        ],
        [
          "capture-url",
          () =>
            asinFromPath(
              new URL(capture.final_url || capture.url, "https://www.example.com").pathname,
            ) ?? undefined,
        ],
        [
          "canonical",
          () =>
            asinFromPath(attr(doc.querySelector("link[rel=canonical]") ?? undefined, "href")) ??
            undefined,
        ],
      ],
      meta,
    ) ?? null;

  // rating block
  const ratingScope = [q(root, "#averageCustomerReviewsAnchor"), root].filter(
    (e): e is DomElement => e !== undefined,
  );
  const block = parseRatingBlock(ratingScope, doc, meta, consumed);

  // Customers say
  const heading = firstOf<DomElement>(
    "customers_say",
    [["heading-text", () => qa(root, "h2, h3, h4").find((h) => /^customers say\b/i.test(text(h)))]],
    meta,
    { optional: true },
  );
  let customers_say: CustomersSay | null = null;
  const aspects: ReviewAspect[] = [];
  if (heading !== undefined) {
    const container = heading.parentElement ?? heading;
    let sentenceEl: DomElement | undefined;
    for (const sib of Array.from(container.children)) {
      if (sib === heading || sib.querySelector("[role=tablist]") !== null) continue;
      const t = text(sib);
      if (t !== "" && !/^(AI Generated|Generated from)/i.test(t)) {
        sentenceEl = sib;
        break;
      }
    }
    const sentence = sentenceEl === undefined ? "" : text(sentenceEl);
    const disclosure = qa(container, "span, div").find(
      (e) => e.children.length === 0 && /^AI Generated|^Generated from the text/i.test(text(e)),
    );
    if (sentence !== "") {
      customers_say = {
        text: sentence,
        ai_generated: disclosure !== undefined || /\bAI\b/.test(text(container)),
        disclosure: disclosure === undefined ? null : text(disclosure),
      };
    }
    for (const tab of qa(container, "[role=tab]")) {
      const aspect = parseAspect(tab);
      if (aspect !== undefined) aspects.push(aspect);
    }
    // Granular: the summary sentence, the disclosure lines, the "Select to learn more" prompt
    // and the chip list. Anything else inside the block still surfaces in other_sections.
    consumed.takeAll([heading, sentenceEl, ...qa(container, "[role=tablist]")]);
    consumed.takeAll(
      qa(container, "span, div, h4").filter(
        (e) =>
          e.children.length === 0 &&
          /^(AI Generated|Generated from the text|Select to learn more)/i.test(text(e)),
      ),
    );
  }

  // review cards
  const cards = reviewCards(root);
  const other: Review[] = [];
  const featured: Review[] = [];
  let topPositive: Review | null = null;
  let topCritical: Review | null = null;
  let featuredHeader: string | null = null;
  let otherHeader: string | null = null;
  const headingFor = (card: DomElement): { el: DomElement | undefined; text: string } => {
    const section = card.closest("[data-hook=topReviewsSection]");
    const h = section === null ? undefined : q(section, "h3, h2");
    return { el: h, text: text(h) };
  };
  const labelled = (re: RegExp): DomElement | undefined => {
    const h = qa(root, "h2, h3, h4, span, div").find(
      (e) => e.children.length === 0 && re.test(text(e)),
    );
    if (h === undefined) return undefined;
    for (let cur: DomElement | null = h.parentElement; cur != null; cur = cur.parentElement) {
      const hit = reviewCards(cur)[0];
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const positiveCard = labelled(/^top positive review$/i);
  const criticalCard = labelled(/^top critical review$/i);
  for (const card of cards) {
    const review = parseReviewCard(card, { meta, consumed });
    if (card === positiveCard) topPositive = review;
    else if (card === criticalCard) topCritical = review;
    else {
      const head = headingFor(card);
      const isOther =
        card.closest("#internationalTopReviews, [id*='nternationalTopReviews']") !== null ||
        /other countries|international/i.test(head.text);
      if (isOther) {
        other.push(review);
        otherHeader = head.text || otherHeader;
      } else {
        featured.push(review);
        featuredHeader = head.text || featuredHeader;
      }
    }
  }
  for (const section of qa(root, "[data-hook=topReviewsSection]")) {
    consumed.take(q(section, "h3, h2"));
  }
  const seeAllLinks = qa(
    root,
    "a#cm_cr_top_reviews_to_arp_button, a[data-hook=see-all-reviews-link], a[href*='/portal/customer-reviews/'][href*='show_all']",
  );
  const seeAll = seeAllLinks[0];
  consumed.takeAll(seeAllLinks.map((a) => a.closest(".a-section") ?? a));
  const translateAllEl = q(
    root,
    "[data-hook=translateAllReviewsButton], [data-hook=cr-translate-these-reviews-link]",
  );
  consumed.take(translateAllEl?.closest(".a-button") ?? translateAllEl);
  consumed.take(q(root, "#cr-top-reviews-live-region"));

  if (block.rating === null) meta.warnings.push("rating: not found");
  const report = losslessReport(doc, consumed, { root, base: capture.final_url || capture.url });
  meta.unparsed_text_chars = report.counts.unparsed;
  meta.warnings = [...new Set(meta.warnings)];

  const data: ReviewSummary = {
    asin,
    rating: block.rating,
    rating_count: block.rating_count,
    rating_text: block.rating_text,
    histogram: block.histogram,
    customers_say,
    aspects,
    top_positive_review: topPositive,
    top_critical_review: topCritical,
    featured_reviews: featured,
    featured_header: featuredHeader,
    other_country_reviews: other,
    other_country_header: otherHeader,
    see_all_reviews_path: cleanPath(attr(seeAll, "href")),
    can_translate_all: translateAllEl !== undefined,
  };
  return { data, other_sections: report.sections, meta };
};
