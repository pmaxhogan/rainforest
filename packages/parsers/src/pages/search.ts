/**
 * Search results page parser (`/s?k=...`).
 *
 * Every result is labeled organic or sponsored from several INDEPENDENT signals (holder
 * class, label text, label class, ad-feedback hooks, sponsored click URLs, "Sponsored Ad"
 * ARIA text, sponsored impression counters, sponsored cart refs, ad creative data, ad widget
 * structure). `is_sponsored` is true when ANY of them fires and every signal that fired is
 * recorded, so a page that drops one marker still labels its ads.
 *
 * Hidden cards: a content blocker in the browser may hide sponsored cards. A hidden card or
 * widget that carries a sponsored signal is still reported (`hidden_in_browser: true`,
 * `position: null`); a hidden one without any sponsored signal is a template and is skipped
 * (counted in `hidden_skipped`).
 */
import { HIDDEN_ATTR, RfError } from "@rainforest/core";
import type { Capture, ParseMeta, Parser } from "@rainforest/core";
import {
  type Count,
  type DomElement,
  type Money,
  type MoneyRange,
  type Rating,
  attr,
  collapse,
  moneyFromPriceElement,
  parseCapture,
  parseCountDetail,
  parseMoney,
  parseMoneyRange,
  parseRating,
  q,
  qa,
  ratingFromClass,
  text,
  visible,
} from "../dom.ts";
import { Consumption, losslessReport } from "../lossless.ts";
import { type Strategy, firstOf, newMeta } from "../strategy.ts";

// ---- exported types

export type SearchResultKind = "organic" | "sponsored" | "sponsored_brand" | "sponsored_video";

export type SearchWidgetType =
  | "sponsored_brand"
  | "sponsored_video"
  | "sponsored_carousel"
  | "display_ad"
  | "featured_brands"
  | "carousel"
  | "narrow_search"
  | "related_searches"
  | "more_ways_to_shop"
  | "editorial"
  | "help"
  | "other";

/** Independent sponsorship signals, in the order they are evaluated. */
export const SPONSORED_SIGNALS = [
  "ad_holder_class",
  "sponsored_label_text",
  "sponsored_label_class",
  "ad_feedback",
  "sponsored_click_url",
  "aria_sponsored_ad",
  "sp_impression_counter",
  "sponsored_cart_ref",
  "ad_creative_data",
  "ad_widget_structure",
] as const;
export type SponsoredSignal = (typeof SPONSORED_SIGNALS)[number];

export interface UnitPrice {
  amount: Money;
  /** Unit text as shown: "count", "ounce", "feet", "lb". */
  unit: string;
  raw: string;
}

export interface Badge {
  /** Normalized type: best_seller, amazons_choice, overall_pick, top_rated, deal, ... */
  type: string;
  text: string;
  /** Extra context such as the category of a Best Seller badge. */
  context?: string;
}

export interface BoughtPastMonth extends Count {
  text: string;
}

export interface MoreBuyingChoices {
  price?: Money;
  /** "(19+ used & new offers)" without the parentheses. */
  offers_text?: string;
  offer_count?: Count;
  /** Path of the offer-listing link (query dropped). */
  url_path?: string;
  notes?: string[];
}

export interface Spec {
  name: string;
  value: string;
}

/** Fields shared by result cards and product items inside widgets. */
export interface ProductFields {
  asin: string;
  title?: string;
  /** Canonical product path: /dp/<ASIN>. */
  url_path: string;
  brand?: string;
  subtitle?: string;
  /** Size / pack chip next to the title, such as "32 Ounce (Pack of 2)". */
  variant_label?: string;
  byline?: string;
  price?: Money;
  price_range?: MoneyRange;
  list_price?: Money;
  /** Label shown before the strike price: "List", "Typical", "List Price", ... */
  list_price_label?: string;
  unit_price?: UnitPrice;
  savings_percent?: number;
  coupon?: string;
  coupon_price?: Money;
  subscribe_and_save?: string;
  /** Promotion lines under the price ("5% back with ...", "Save 5% on 2 select item(s)"). */
  promotions?: string[];
  format?: string;
  rating?: Rating;
  review_count?: Count;
  bought_past_month?: BoughtPastMonth;
  badges: Badge[];
  prime: boolean;
  delivery_badge?: string;
  /** Delivery lines, raw. */
  delivery: string[];
  stock_text?: string;
  variant_hints: string[];
  more_buying_choices?: MoreBuyingChoices;
  certifications?: string[];
  small_business: boolean;
  climate_pledge_friendly?: boolean;
  specs?: Spec[];
  /** Call-to-action buttons: "Add to cart", "See options", "Add to delivery". */
  cta?: string[];
  see_options: boolean;
  renewed: boolean;
  /** Grocery / store markers: "Whole Foods Market", "Amazon Fresh", "SNAP EBT", ... */
  store_markers?: string[];
  /** Suggested shopper questions shown on the card ("Will it ...?"). */
  insight_prompts?: string[];
  /** Visible lines inside a parsed block that no field above took. */
  notes?: string[];
}

export interface SearchResult extends ProductFields {
  /** 1-based position among VISIBLE result cards; null for a card hidden in the browser. */
  position: number | null;
  /** The page's data-index for the card (orders results and widgets together). */
  index?: number;
  kind: SearchResultKind;
  is_sponsored: boolean;
  sponsored_signals: SponsoredSignal[];
  /** Disclosure text shown on the card ("Sponsored", "Featured from Amazon brands"). */
  sponsored_label?: string;
  hidden_in_browser: boolean;
  /** Results section heading the card sits under ("Results", "More results"). */
  section?: string;
}

export interface WidgetItem extends ProductFields {
  is_sponsored: boolean;
  sponsored_signals: SponsoredSignal[];
  /** Line above the item inside a shelf ("fake shelf header"). */
  header?: string;
}

export interface WidgetLink {
  text: string;
  /** Opaque search token (relative same-site /s URL) when the link is a search link. */
  token?: string;
  href?: string;
}

export interface SearchWidget {
  type: SearchWidgetType;
  heading?: string;
  index?: number;
  is_sponsored: boolean;
  sponsored_signals: SponsoredSignal[];
  sponsored_label?: string;
  hidden_in_browser: boolean;
  items: WidgetItem[];
  links: WidgetLink[];
  /** Short visible text of the widget that is neither heading, item nor link. */
  text?: string;
}

/** Longest leftover widget text folded into `SearchWidget.text` (longer goes to other_sections). */
export const WIDGET_TEXT_MAX = 300;

export interface RefinementOption {
  label: string;
  selected: boolean;
  count?: number;
  /** Relative same-site /s URL that applies (or removes) this option; null when not a link. */
  token: string | null;
  /** The page's node id for the option, when present (for example "p_85/0000000001"). */
  id?: string;
  /** True when the option sits behind a collapsed "See more" expander. */
  collapsed?: boolean;
}

export interface RefinementRange {
  low_label?: string;
  high_label?: string;
  low_param?: string;
  high_param?: string;
}

export interface RefinementGroup {
  /** Stable group key from the page (for example "p_36", "p_n_condition-type"). */
  key: string;
  heading: string;
  options: RefinementOption[];
  range?: RefinementRange;
}

export interface SortOption {
  label: string;
  value: string;
  selected: boolean;
  token?: string;
}

export interface PageLink {
  page: number;
  current: boolean;
  token?: string;
}

export interface Pagination {
  current_page: number;
  last_visible_page?: number;
  pages: PageLink[];
  next_token: string | null;
  prev_token: string | null;
  has_next: boolean;
}

export type CorrectionType =
  "showing_results_for" | "search_instead_for" | "no_results" | "did_you_mean" | "other";

export interface Correction {
  type: CorrectionType;
  text: string;
  query?: string;
  token?: string;
}

export interface AppliedFilter {
  group: string;
  label: string;
  /** Token that removes the filter, when the page offers one. */
  token?: string;
}

export interface ResultRange {
  first?: number;
  last?: number;
  total?: number;
  total_approximate?: boolean;
}

export interface HiddenSkipped {
  /** Hidden result cards with no sponsored signal (templates), skipped. */
  results: number;
  /** Hidden widgets with no sponsored signal, skipped. */
  widgets: number;
  /** Hidden result cards reported because they are sponsored. */
  sponsored_results: number;
  /** Hidden widgets reported because they are sponsored. */
  sponsored_widgets: number;
}

export interface SearchPage {
  query?: string;
  department?: { label?: string; alias?: string };
  total_results_text?: string;
  result_range?: ResultRange;
  results: SearchResult[];
  widgets: SearchWidget[];
  refinements: RefinementGroup[];
  applied_filters: AppliedFilter[];
  sort_options: SortOption[];
  pagination?: Pagination;
  corrections: Correction[];
  hidden_skipped: HiddenSkipped;
}

// ---- small helpers

interface Mutable {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const ASIN_RE = /^[A-Z0-9]{10}$/;

function asinOrUndefined(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const v = s.trim().toUpperCase();
  return ASIN_RE.test(v) ? v : undefined;
}

function matches(el: DomElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** Raw (visibility-blind) query, used only for structural signals and hidden data. */
function rawAll(root: DomElement, selector: string): DomElement[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Screen-reader duplicates that would double visible text: off-screen helper text outside a
 * price, the visual half of a price (its `.a-offscreen` copy is kept) and the cut half of a
 * truncated string when the full half is present.
 */
function isDuplicate(el: DomElement): boolean {
  if (matches(el, ".aok-offscreen")) return true;
  if (
    matches(el, ".a-offscreen") &&
    !matches(el, ".a-truncate-full") &&
    el.parentElement?.closest(".a-price") == null
  ) {
    return true;
  }
  if (el.getAttribute("aria-hidden") === "true" && el.parentElement != null) {
    if (matches(el.parentElement, ".a-price")) return true;
  }
  if (matches(el, ".a-truncate-cut")) {
    const full = el.parentElement?.querySelector(".a-truncate-full");
    if (full != null && visible(full)) return true;
  }
  return false;
}

/** Visible text without screen-reader duplicates, optionally skipping more subtrees. */
function clean(el: DomElement | null | undefined, skip?: (el: DomElement) => boolean): string {
  return text(el, { exclude: (e) => isDuplicate(e) || (skip !== undefined && skip(e)) });
}

function within(el: DomElement, ancestor: DomElement): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (cur === ancestor) return true;
  }
  return false;
}

/** Keep the elements that have no ancestor in the list (document order preserved). */
function outermost(els: DomElement[]): DomElement[] {
  const set = new Set(els);
  return els.filter((el) => {
    for (let cur = el.parentElement; cur != null; cur = cur.parentElement) {
      if (set.has(cur)) return false;
    }
    return true;
  });
}

/** Leaf elements matching the selector (no matching descendant), visible only. */
function leaves(root: DomElement, selector: string): DomElement[] {
  return qa(root, selector).filter((el) => q(el, selector) === undefined);
}

function pushUnique(list: string[], s: string): void {
  const v = collapse(s);
  if (v !== "" && !list.includes(v)) list.push(v);
}

/**
 * Normalize an href into an opaque search token: the path + query of a same-site `/s` URL.
 * Anything else (another host, another path, javascript:, fragments) yields undefined.
 */
export function searchToken(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined;
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#") || /^javascript:/i.test(raw)) return undefined;
  let url: URL;
  let origin: string;
  try {
    origin = new URL(base).origin;
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  if (url.pathname !== "/s" && !url.pathname.startsWith("/s/")) return undefined;
  return `${url.pathname}${url.search}`;
}

function pathOf(href: string | undefined, base: string): string | undefined {
  if (href === undefined || href === "" || href.startsWith("#")) return undefined;
  try {
    const url = new URL(href, base);
    if (url.origin !== new URL(base).origin) return undefined;
    // "/ref=..." path segments are click attribution, not part of the resource.
    return url.pathname.replace(/\/ref=[^/]*$/, "");
  } catch {
    return undefined;
  }
}

function urlParam(urlText: string, name: string): string | undefined {
  try {
    const v = new URL(urlText).searchParams.get(name);
    return v === null || v === "" ? undefined : v;
  } catch {
    return undefined;
  }
}

/** Strategy tally across many cards: field -> strategy -> hits. */
class Tally {
  readonly #counts = new Map<string, Map<string, number>>();

  merge(prefix: string, meta: ParseMeta): void {
    for (const [field, name] of Object.entries(meta.strategies)) {
      const key = `${prefix}.${field}`;
      const m = this.#counts.get(key) ?? new Map<string, number>();
      m.set(name, (m.get(name) ?? 0) + 1);
      this.#counts.set(key, m);
    }
  }

  writeTo(meta: ParseMeta): void {
    for (const [field, m] of this.#counts) {
      meta.strategies[field] = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}:${n}`)
        .join(",");
    }
  }
}

// ---- sponsorship signals

const LABEL_TEXTS: readonly RegExp[] = [/^sponsored$/i, /^featured from (amazon|our) brands$/i];

const SIGNAL_SELECTORS: Partial<Record<SponsoredSignal, string>> = {
  sponsored_label_class:
    "[class*='sponsored-label'], .s-sponsored-header, .s-sponsored-label-info-icon, .puis-sponsored-label-text",
  ad_feedback:
    "[aria-label*='ad feedback'], [aria-label*='Ad feedback'], [data-action='multi-ad-feedback-form-trigger'], [data-ad-feedback-payload], [class*='ad-feedback'], [class*='adFeedback'], [data-s-safe-ajax-modal-trigger*='feedback-form'], .ape-feedback",
  sponsored_click_url:
    "a[href*='/sspa/click'], a[href*='sponsored-ads.amazon.'], a[href*='aax-us-'], a[href*='/aax/']",
  aria_sponsored_ad: "[aria-label^='Sponsored Ad'], img[alt^='Sponsored Ad']",
  sp_impression_counter: "[data-component-props*='sp_delivered']",
  sponsored_cart_ref: "form[action*='_sspa']",
  ad_creative_data:
    "[data-ad-creative-list], [data-ad-metrics], [data-aax-impression-pixel], [data-is-sponsored-label-active]",
  ad_widget_structure:
    "[data-component-type^='sbv-'], [data-component-type^='spv-'], .sb-desktop, .sbx-desktop, .sbv-video-single-product, .sp-video-widget-creative, [id^='ape_Search']",
};

/** Own (direct) text of an element, collapsed. */
function ownText(el: DomElement): string {
  let s = "";
  const kids = el.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n !== undefined && n.nodeType === 3) s += n.textContent ?? "";
  }
  return collapse(s);
}

/** Label elements: own text "Sponsored" (or an equivalent disclosure). Raw, visibility-blind. */
export function sponsoredLabelElements(root: DomElement): DomElement[] {
  const out: DomElement[] = [];
  for (const el of [root, ...rawAll(root, "span, a, div, p, h2, h3, h4, label")]) {
    if (el.localName === "script" || el.localName === "style") continue;
    const t = ownText(el);
    if (t !== "" && t.length < 40 && LABEL_TEXTS.some((re) => re.test(t))) out.push(el);
  }
  return out;
}

/**
 * Every sponsorship signal that fires for an element (a result card or a widget). Structural:
 * reads the raw DOM, so it works on cards a content blocker hid. `stop` bounds the holder
 * class walk (the results container).
 */
export function sponsoredSignals(el: DomElement, stop?: DomElement): SponsoredSignal[] {
  const out: SponsoredSignal[] = [];
  let holder = false;
  for (let cur: DomElement | null = el; cur != null && cur !== stop; cur = cur.parentElement) {
    if (matches(cur, ".AdHolder")) holder = true;
  }
  if (holder || rawAll(el, ".AdHolder").length > 0) out.push("ad_holder_class");
  if (sponsoredLabelElements(el).length > 0) out.push("sponsored_label_text");
  for (const name of SPONSORED_SIGNALS) {
    const sel = SIGNAL_SELECTORS[name];
    if (sel === undefined) continue;
    if (matches(el, sel) || rawAll(el, sel).length > 0) out.push(name);
  }
  return out;
}

/**
 * The element that holds a disclosure label: its label link / popover trigger, never a wide
 * container (cards are wrapped in `.a-declarative` too, so only an immediate popover parent
 * counts).
 */
function labelHolder(label: DomElement, bound: DomElement): DomElement {
  const near = label.closest(
    "[class*='sponsored-label-text'], .puis-label-popover, .s-label-popover",
  );
  const holder = near != null && within(near, bound) && near !== bound ? near : label;
  const parent = holder.parentElement;
  if (parent != null && parent !== bound && parent.getAttribute("data-action") === "a-popover")
    return parent;
  return holder;
}

/** Disclosure text to show: a visible label first, then any label. */
function labelText(el: DomElement): string | undefined {
  const labels = sponsoredLabelElements(el);
  const vis = labels.find((l) => visible(l)) ?? labels[0];
  return vis === undefined ? undefined : ownText(vis);
}

// ---- hidden-card unmasking

/**
 * Inside a hidden subtree only its root carries the marker, so elements that would be hidden
 * anyway are not marked. These classes are what the page uses to hide them.
 */
const EMULATED_HIDDEN =
  ".aok-hidden, .a-popover-preload, .rio-hidden, .a-hidden, input[type='hidden'], [style*='display: none'], [style*='display:none']";

/**
 * Make a hidden subtree readable through the normal visibility-aware helpers: clear the marker
 * on the given elements and mark the descendants the page itself hides. Mutates the parser's
 * private DOM only.
 */
function unmask(markers: DomElement[], root: DomElement): void {
  for (const m of markers) (m as unknown as Mutable).removeAttribute(HIDDEN_ATTR);
  for (const el of rawAll(root, EMULATED_HIDDEN)) {
    (el as unknown as Mutable).setAttribute(HIDDEN_ATTR, "1");
  }
}

/** Hidden markers on the element and its ancestors up to (excluding) `stop`. */
function hiddenMarkers(el: DomElement, stop: DomElement): DomElement[] {
  const out: DomElement[] = [];
  for (let cur: DomElement | null = el; cur != null && cur !== stop; cur = cur.parentElement) {
    if (cur.getAttribute(HIDDEN_ATTR) === "1") out.push(cur);
  }
  return out;
}

// ---- product field extraction (cards and widget items)

interface Ctx {
  consumed: Consumption;
  base: string;
}

function stripSponsoredPrefix(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const v = collapse(s.replace(/^Sponsored Ad\s*-\s*/i, ""));
  return v === "" ? undefined : v;
}

const MAIN_PRICE_EXCLUDE =
  ".s-coupon-tile-container, .s-coupon-component, [data-cy='secondary-offer-recipe']";

function mainPriceElements(root: DomElement): DomElement[] {
  return qa(root, ".a-price").filter(
    (p) =>
      !matches(p, ".a-text-price") &&
      p.getAttribute("data-a-strike") !== "true" &&
      p.closest(MAIN_PRICE_EXCLUDE) == null,
  );
}

const FORMAT_RE =
  /^(Paperback|Hardcover|Kindle|Audible Audiobook|Audio CD|Mass Market Paperback|Board book|Spiral-bound|Library Binding|DVD|Blu-ray|Prime Video|MP3 Music|Vinyl)\b/;

const STORE_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/Whole Foods Market/i, "Whole Foods Market"],
  [/Amazon Fresh/i, "Amazon Fresh"],
  [/SNAP EBT/i, "SNAP EBT"],
  [/Add to delivery/i, "Add to delivery"],
];

/** Parse product fields from a card or item root. Consumes what it reads. */
function parseProduct(root: DomElement, ctx: Ctx, meta: ParseMeta): ProductFields | undefined {
  const c = ctx.consumed;
  const notes: string[] = [];
  const badges: Badge[] = [];
  const read = new Set<DomElement>();
  const take = (el: DomElement | undefined): DomElement | undefined => {
    if (el !== undefined) {
      read.add(el);
      c.take(el);
    }
    return el;
  };
  /** Record whatever text of a block no field read, then consume the block. */
  const finish = (block: DomElement | undefined): void => {
    if (block === undefined) return;
    const rest = clean(block, (e) => read.has(e));
    if (rest !== "") notes.push(rest);
    c.take(block);
  };

  const asin = firstOf<string>(
    "asin",
    [
      ["data-asin", () => asinOrUndefined(attr(root, "data-asin"))],
      [
        "csa-item-id",
        () => {
          const el = [root, ...rawAll(root, "[data-csa-c-item-id*='amzn1.asin']")].find((e) =>
            /amzn1\.asin\./.test(attr(e, "data-csa-c-item-id") ?? ""),
          );
          const m = /amzn1\.asin\.(?:1\.)?([A-Z0-9]{10})/.exec(
            attr(el, "data-csa-c-item-id") ?? "",
          );
          return m?.[1];
        },
      ],
      [
        "dp-link",
        () => {
          for (const a of rawAll(root, "a[href*='/dp/']")) {
            const m = /\/dp\/([A-Z0-9]{10})/.exec(attr(a, "href") ?? "");
            if (m?.[1] !== undefined) return m[1];
          }
          return undefined;
        },
      ],
      [
        "descendant-data-asin",
        () => asinOrUndefined(attr(rawAll(root, "[data-asin]")[0], "data-asin")),
      ],
    ],
    meta,
  );
  if (asin === undefined) return undefined;

  // Disclosure labels are reported through the sponsorship fields, not as notes.
  for (const l of sponsoredLabelElements(root)) {
    if (visible(l)) take(labelHolder(l, root));
  }
  // Suggested shopper questions sit inside the title block on some cards.
  const insightPrompts: string[] = [];
  for (const p of qa(
    root,
    "[data-product-insight-prompt-click], [data-action*='product-insight-prompt']",
  )) {
    if (c.covers(p)) continue;
    const t = clean(p);
    if (t !== "") pushUnique(insightPrompts, t);
    take(p);
  }

  // -- title recipe
  const titleRecipe = q(root, "[data-cy='title-recipe']");
  const titleScope = titleRecipe ?? root;
  const titleHeading = qa(titleScope, "h2").find((h) => !matches(h, ".a-size-mini"));
  const title = firstOf<string>(
    "title",
    [
      ["aria-label", () => stripSponsoredPrefix(attr(titleHeading, "aria-label"))],
      ["heading", () => stripSponsoredPrefix(clean(titleHeading))],
      [
        "title-link",
        () => {
          const a = qa(titleScope, "a[href]").find((l) =>
            /\/dp\/|\/sspa\/click|\/clk/.test(attr(l, "href") ?? ""),
          );
          return stripSponsoredPrefix(clean(a));
        },
      ],
      ["truncate-full", () => stripSponsoredPrefix(clean(q(root, ".a-truncate-full")))],
      [
        "img-alt",
        () => stripSponsoredPrefix(attr(rawAll(root, "img.s-image[alt], img[alt]")[0], "alt")),
      ],
    ],
    meta,
  );
  if (titleHeading !== undefined) {
    take(titleHeading.closest("a") ?? titleHeading);
  }
  const brandEl =
    titleRecipe === undefined
      ? undefined
      : q(titleRecipe, "h2.a-size-mini, .a-row.a-color-secondary h2");
  const brand = clean(take(brandEl)) || undefined;
  const subtitleEl = q(titleScope, ".title-differentiators");
  const subtitle = clean(take(subtitleEl)) || undefined;
  const chips = qa(titleScope, ".s-background-color-platinum").map((el) => clean(take(el)));
  const variantLabel = chips[0] || undefined;
  const extraChips = chips.slice(1).filter((t) => t !== "");
  let byline: string | undefined;
  if (titleRecipe !== undefined) {
    for (const row of leaves(titleRecipe, ".a-row")) {
      const t = clean(row, (e) => read.has(e));
      if (/^by\s/i.test(t)) {
        byline = t;
        take(row);
      }
    }
    for (const b of qa(titleRecipe, ".a-badge-text")) {
      const t = clean(b);
      if (t !== "") badges.push({ type: slug(t), text: t });
      take(b);
    }
    finish(titleRecipe);
  }

  // -- badges outside the recipes
  for (const rb of qa(root, ".rio-badge-component")) {
    const label = clean(q(rb, ".rio-badge-label")) || clean(rb);
    if (label === "") continue;
    const type = slug(rb.id || label);
    const group = attr(q(rb, "[aria-label]"), "aria-label");
    const context =
      group !== undefined && group.startsWith(label) ? collapse(group.slice(label.length)) : "";
    badges.push(context === "" ? { type, text: label } : { type, text: label, context });
    take(rb.closest("[id='amazonBadges-capsule-view']") ?? rb);
  }
  for (const sb of qa(root, "[data-component-type='s-status-badge-component'], .a-badge")) {
    if (read.has(sb) || c.covers(sb)) continue;
    const t = clean(q(sb, ".a-badge-text")) || clean(sb);
    if (t === "") continue;
    const id = sb.id || attr(q(sb, ".a-badge[id]"), "id") || "";
    const idType = /-(amazons-choice|best-seller|deal|new-release)$/.exec(id)?.[1];
    const wrap = sb.closest("[aria-label]");
    const label = attr(wrap, "aria-label");
    const badge: Badge = { type: idType !== undefined ? slug(idType) : slug(t), text: t };
    if (label !== undefined && label !== t) badge.context = label;
    if (!badges.some((b) => b.text === t)) badges.push(badge);
    take(sb);
  }
  const container = q(root, ".puis-status-badge-container");
  if (container !== undefined && clean(container, (e) => c.covers(e)) === "") c.take(container);

  // -- reviews block
  const reviews = q(root, "[data-cy='reviews-block']");
  const rScope = reviews ?? root;
  const rating = firstOf<Rating>(
    "rating",
    [
      ["icon-alt", () => parseRating(clean(q(rScope, ".a-icon-alt")))],
      ["aria-label", () => parseRating(attr(q(rScope, "[aria-label*='out of 5']"), "aria-label"))],
      [
        "rating-number",
        () => {
          const star = q(rScope, "i[class*='a-star']");
          const holder = star?.parentElement?.closest("div") ?? undefined;
          const num = qa(holder, "span").find((s) => /^[0-5](\.\d)?$/.test(clean(s)));
          return num === undefined ? undefined : { value: Number(clean(num)), out_of: 5 };
        },
      ],
      [
        "star-class",
        () => {
          const v = ratingFromClass(attr(q(rScope, "i[class*='a-star']"), "class"));
          return v === undefined ? undefined : { value: v, out_of: 5 };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (rating !== undefined) {
    take(q(rScope, ".a-popover-trigger") ?? q(rScope, "i[class*='a-star']"));
    const num = qa(rScope, "span[aria-hidden='true'], span").find((s) =>
      /^\d(\.\d)?$/.test(clean(s)),
    );
    take(num);
    for (const s of qa(rScope, "[class*='ratingNumber']")) take(s);
  }
  const countLink = qa(rScope, "a[aria-label]").find((a) =>
    /ratings?$/i.test(attr(a, "aria-label") ?? ""),
  );
  const reviewCount = firstOf<Count>(
    "review_count",
    [
      ["aria-label", () => parseCountDetail(attr(countLink, "aria-label"))],
      [
        "count-text",
        () => parseCountDetail(clean(q(rScope, ".s-underline-text, [class*='reviewCount']"))),
      ],
      [
        "text-anchor",
        () => {
          const el = qa(rScope, "span").find(
            (s) => /^\(?[\d.,]+[KkMm]?\)?$/.test(clean(s)) && !read.has(s),
          );
          return el === undefined ? undefined : parseCountDetail(clean(el));
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (reviewCount !== undefined) {
    take(countLink ?? q(rScope, ".s-underline-text, [class*='reviewCount']"));
  }
  let bought: BoughtPastMonth | undefined;
  if (reviews !== undefined) {
    for (const row of qa(reviews, "span")) {
      if (read.has(row)) continue;
      const t = clean(row);
      if (/bought in past month/i.test(t)) {
        const n = parseCountDetail(t);
        if (n !== undefined) bought = { ...n, text: t };
        take(row);
      } else if (/^#\d+\s+Top Rated$/i.test(t)) {
        badges.push({ type: "top_rated", text: t });
        take(row);
      } else if (/^New on Amazon/i.test(t)) {
        badges.push({ type: "new_on_amazon", text: t });
        take(row);
      }
    }
    finish(reviews);
  }

  // -- price recipe
  const priceRecipe = q(root, "[data-cy='price-recipe']");
  const pScope = priceRecipe ?? root;
  const mains = mainPriceElements(pScope);
  const priceEl = mains[0];
  const price = firstOf<Money>(
    "price",
    [
      ["a-price", () => moneyFromPriceElement(priceEl)],
      [
        "price-to-pay-attr",
        () =>
          parseMoney(attr(q(pScope, "[data-csa-c-price-to-pay]"), "data-csa-c-price-to-pay"), {
            defaultCurrency: "USD",
          }),
      ],
    ],
    meta,
    { optional: true },
  );
  let priceRange: MoneyRange | undefined;
  if (priceEl !== undefined && mains[1] !== undefined) {
    const row = priceEl.parentElement?.closest(".a-row") ?? priceEl.parentElement;
    if (row != null && within(mains[1], row)) priceRange = parseMoneyRange(clean(row));
  }
  for (const m of mains) if (m.closest(".a-row") === priceEl?.closest(".a-row")) take(m);
  const strike = qa(pScope, ".a-price[data-a-strike='true']")[0];
  let listPriceLabel: string | undefined;
  const listPrice = firstOf<Money>(
    "list_price",
    [
      ["strike", () => moneyFromPriceElement(strike)],
      [
        "text-anchor",
        () => {
          const m = /(List Price|List|Typical price|Typical|Was):\s*(\$[\d,]+(?:\.\d{2})?)/.exec(
            clean(pScope),
          );
          return m?.[2] === undefined ? undefined : parseMoney(m[2]);
        },
      ],
      [
        "strike-attr",
        () =>
          moneyFromPriceElement(q(pScope, "[data-strikethroughprice] .a-price, .a-text-strike")),
      ],
    ],
    meta,
    { optional: true },
  );
  if (listPrice !== undefined) {
    const m = /(List Price|List|Typical price|Typical|Was):/.exec(
      clean(strike?.parentElement ?? pScope),
    );
    listPriceLabel = m?.[1];
    if (strike !== undefined) {
      const holder = strike.parentElement;
      if (
        holder != null &&
        holder !== pScope &&
        /^(List Price|List|Typical price|Typical|Was):?\s*\$/.test(clean(holder))
      ) {
        take(holder);
      } else take(strike);
      for (const lbl of qa(holder ?? pScope, "span")) {
        if (/^(List Price|List|Typical price|Typical|Was):$/.test(clean(lbl))) take(lbl);
      }
    }
  }
  const unitHolder = qa(pScope, "span").find(
    (s) =>
      q(s, ".a-text-price") !== undefined && /\/\s*[A-Za-z]/.test(clean(s)) && /^\(/.test(clean(s)),
  );
  const unitPrice = firstOf<UnitPrice>(
    "unit_price",
    [
      [
        "text-price",
        () => {
          if (unitHolder === undefined) return undefined;
          const amount = moneyFromPriceElement(q(unitHolder, ".a-text-price"));
          const unit = /\/\s*([^)]+?)\s*\)/.exec(clean(unitHolder))?.[1];
          return amount === undefined || unit === undefined
            ? undefined
            : { amount, unit, raw: clean(unitHolder) };
        },
      ],
      [
        "text-anchor",
        () => {
          const holder = qa(pScope, "span, div").find((s) =>
            /^\(\s*\$[\d.,]+\s*\/\s*[^)]+\)$/.test(clean(s)),
          );
          const t = clean(holder);
          const m = /^\(\s*(\$[\d.,]+)\s*\/\s*([^)]+?)\s*\)$/.exec(t);
          const amount = parseMoney(m?.[1]);
          if (holder === undefined || amount === undefined || m?.[2] === undefined)
            return undefined;
          take(holder);
          return { amount, unit: m[2], raw: t };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (unitHolder !== undefined && unitPrice !== undefined) take(unitHolder);
  const savingsEl = q(pScope, ".apex-savings-percent, [class*='savingsPercentage']");
  const savings = /-?(\d{1,2})%/.exec(clean(savingsEl))?.[1];
  const savingsPercent = savings === undefined ? undefined : Number(savings);
  take(savingsEl);
  let coupon: string | undefined;
  let couponPrice: Money | undefined;
  let sns: string | undefined;
  const couponEls = outermost(
    qa(root, ".s-coupon-component, .s-coupon-tile-container, .s-coupon-unclipped"),
  );
  for (const ce of couponEls) {
    const tileText = clean(q(ce, ".s-coupon-tile-text-content"));
    const t = tileText !== "" ? tileText : clean(ce);
    if (t === "") continue;
    const tilePrice = moneyFromPriceElement(
      q(ce, ".s-coupon-tile-price-content .a-price, .a-price"),
    );
    if (/subscribe/i.test(t)) sns = t;
    else {
      // Label and price are adjacent inline spans with no whitespace between them.
      coupon = clean(ce).replace(/([A-Za-z])\$(\d)/g, "$1 $$$2");
      if (tilePrice !== undefined) couponPrice = tilePrice;
    }
    take(ce);
  }
  let format: string | undefined;
  const promotions: string[] = [];
  if (priceRecipe !== undefined) {
    for (const a of qa(priceRecipe, "a")) {
      const t = clean(a);
      if (FORMAT_RE.test(t)) {
        format = t;
        take(a);
      }
    }
    for (const row of leaves(priceRecipe, ".a-row")) {
      if (c.covers(row)) continue;
      const t = clean(row, (e) => read.has(e));
      if (t === "") continue;
      if (/Subscribe\s*&\s*Save|when you subscribe/i.test(t) && sns === undefined) sns = t;
      else pushUnique(promotions, t);
      take(row);
    }
    finish(priceRecipe);
  }

  // -- delivery
  const deliveryRecipe = q(root, "[data-cy='delivery-recipe']");
  const dScope = deliveryRecipe ?? root;
  const delivery: string[] = [];
  const badgeRow = q(dScope, ".udm-badge-block");
  const deliveryBadge = clean(badgeRow) || undefined;
  take(badgeRow);
  const primeHit = firstOf<boolean>(
    "prime",
    [
      ["icon", () => (q(root, "i.a-icon-prime, .a-icon-prime") !== undefined ? true : undefined)],
      [
        "aria-label",
        () =>
          q(root, "[aria-label='Prime'], [aria-label='Amazon Prime']") !== undefined
            ? true
            : undefined,
      ],
      [
        "text-anchor",
        () => (/\bwith Prime\b|\bPrime members\b/i.test(clean(dScope)) ? true : undefined),
      ],
    ],
    meta,
    { optional: true },
  );
  let stock: string | undefined;
  const stockEl = qa(dScope, ".a-color-price, .a-color-state").find((s) =>
    /left in stock|out of stock|unavailable|in stock/i.test(clean(s)),
  );
  if (stockEl !== undefined) {
    stock = clean(stockEl);
    take(stockEl);
  }
  if (deliveryRecipe !== undefined || q(root, ".udm-delivery-block") !== undefined) {
    const dRoot = deliveryRecipe ?? (q(root, ".udm-delivery-block") as DomElement);
    for (const row of leaves(dRoot, ".a-row")) {
      if (c.covers(row)) continue;
      const t = clean(row, (e) => read.has(e));
      if (t === "") continue;
      if (stock === undefined && /left in stock|out of stock|currently unavailable/i.test(t))
        stock = t;
      else pushUnique(delivery, t);
      take(row);
    }
    finish(dRoot);
  }

  // -- certifications
  const certRecipe = q(root, "[data-cy='certification-recipe']");
  const certifications: string[] = [];
  let climate: boolean | undefined;
  if (certRecipe !== undefined) {
    for (const pill of qa(certRecipe, "[data-cy='s-pc-faceout-badge'], .s-pc-badge")) {
      const t = clean(pill);
      if (t !== "") pushUnique(certifications, t);
      take(pill);
    }
    if (rawAll(certRecipe, "[alt*='Climate Pledge']").length > 0) climate = true;
    finish(certRecipe);
  }
  const smallBusiness = certifications.some((t) => /^Small Business\b/i.test(t));

  // -- more buying choices
  const secondary = q(root, "[data-cy='secondary-offer-recipe']");
  let mbc: MoreBuyingChoices | undefined;
  if (secondary !== undefined) {
    mbc = {};
    const label = qa(secondary, "span").find((s) => /^More Buying Choices$/i.test(clean(s)));
    take(label);
    const priceSpan = qa(secondary, "span.a-color-base, .a-price").find(
      (s) => parseMoney(clean(s)) !== undefined,
    );
    const p = parseMoney(clean(priceSpan));
    if (p !== undefined) mbc.price = p;
    take(priceSpan);
    const link = q(secondary, "a[href]");
    const lt = clean(link).replace(/^\(|\)$/g, "");
    if (lt !== "") {
      mbc.offers_text = lt;
      const n = parseCountDetail(lt);
      if (n !== undefined) mbc.offer_count = n;
      const path = pathOf(attr(link, "href"), ctx.base);
      if (path !== undefined) mbc.url_path = path;
    }
    take(link);
    const rest = clean(secondary, (e) => read.has(e));
    if (rest !== "") mbc.notes = [rest];
    c.take(secondary);
  }

  // -- specs
  const detailsRecipe = q(root, "[data-cy='product-details-recipe']");
  let specs: Spec[] | undefined;
  if (detailsRecipe !== undefined) {
    specs = [];
    const labels = qa(detailsRecipe, "span.a-color-secondary");
    for (const l of labels) {
      const name = clean(l);
      const col = l.parentElement?.closest(".puisg-col, .a-row, div") ?? l.parentElement;
      const value = col == null ? undefined : q(col, "span.a-text-bold");
      if (name !== "" && value !== undefined) {
        specs.push({ name, value: clean(value) });
        take(l);
        take(value);
        for (const s of qa(col as DomElement, "span")) if (clean(s) === ":") take(s);
      }
    }
    for (const row of leaves(detailsRecipe, "span, div")) {
      if (read.has(row) || c.covers(row)) continue;
      const t = clean(row);
      const m = /^([^:]{1,40}):\s*(.+)$/.exec(t);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        specs.push({ name: m[1].trim(), value: m[2].trim() });
        take(row);
      }
    }
    finish(detailsRecipe);
    if (specs.length === 0) specs = undefined;
  }

  // -- variants, buttons, compare
  const variantHints: string[] = [...extraChips];
  for (const opt of qa(root, ".s-variation-options-options-text")) {
    const box = opt.parentElement ?? opt;
    const t = clean(box).replace(/^Options:\s*/i, "");
    if (t !== "") pushUnique(variantHints, t);
    take(box);
  }
  for (const el of qa(root, "u, a, span")) {
    if (c.covers(el)) continue;
    const t = clean(el);
    if (/^\+\s?\d+\s+other\s/i.test(t)) {
      pushUnique(variantHints, t);
      take(el);
    }
  }
  for (const sw of qa(
    root,
    "[class*='color-swatch'] [aria-label], .s-color-swatch-outer-circle [aria-label]",
  )) {
    pushUnique(variantHints, attr(sw, "aria-label") ?? "");
    take(sw);
  }
  const cta: string[] = [];
  for (const b of qa(root, ".a-button-text, [data-cy='add-to-cart'] .a-button-text")) {
    if (c.covers(b)) continue;
    const t = clean(b);
    if (t !== "") pushUnique(cta, t);
    take(b.closest(".a-button") ?? b);
  }
  const atc = q(root, "[data-cy='add-to-cart']");
  if (atc !== undefined && clean(atc, (e) => c.covers(e)) === "") c.take(atc);
  for (const cmp of qa(
    root,
    ".copilot-compare-data, .s-csa-instrumentation-wrapper[data-csa-c-content-id='puis-copilot-product-comparison-button']",
  )) {
    c.take(cmp);
  }

  // -- derived flags
  const full = `${title ?? ""} ${brand ?? ""} ${subtitle ?? ""}`;
  const renewed = /\bRenewed\b/i.test(full);
  const storeMarkers: string[] = [];
  const markerText = `${full} ${delivery.join(" ")} ${cta.join(" ")} ${badges.map((b) => b.text).join(" ")}`;
  for (const [re, name] of STORE_MARKERS) if (re.test(markerText)) storeMarkers.push(name);

  const out: ProductFields = {
    asin,
    url_path: `/dp/${asin}`,
    badges,
    prime: primeHit === true,
    delivery,
    variant_hints: variantHints,
    small_business: smallBusiness,
    see_options: cta.some((t) => /^See options$/i.test(t)),
    renewed,
  };
  if (title !== undefined) out.title = title;
  if (brand !== undefined) out.brand = brand;
  if (subtitle !== undefined) out.subtitle = subtitle;
  if (variantLabel !== undefined) out.variant_label = variantLabel;
  if (byline !== undefined) out.byline = byline;
  if (price !== undefined) out.price = price;
  if (priceRange !== undefined) out.price_range = priceRange;
  if (listPrice !== undefined) out.list_price = listPrice;
  if (listPriceLabel !== undefined) out.list_price_label = listPriceLabel;
  if (unitPrice !== undefined) out.unit_price = unitPrice;
  if (savingsPercent !== undefined) out.savings_percent = savingsPercent;
  if (coupon !== undefined) out.coupon = coupon;
  if (couponPrice !== undefined) out.coupon_price = couponPrice;
  if (sns !== undefined) out.subscribe_and_save = sns;
  if (promotions.length > 0) out.promotions = promotions;
  if (format !== undefined) out.format = format;
  if (rating !== undefined) out.rating = rating;
  if (reviewCount !== undefined) out.review_count = reviewCount;
  if (bought !== undefined) out.bought_past_month = bought;
  if (deliveryBadge !== undefined) out.delivery_badge = deliveryBadge;
  if (stock !== undefined) out.stock_text = stock;
  if (mbc !== undefined) out.more_buying_choices = mbc;
  if (certifications.length > 0) out.certifications = certifications;
  if (climate !== undefined) out.climate_pledge_friendly = climate;
  if (specs !== undefined) out.specs = specs;
  if (cta.length > 0) out.cta = cta;
  if (storeMarkers.length > 0) out.store_markers = storeMarkers;
  if (insightPrompts.length > 0) out.insight_prompts = insightPrompts;
  if (notes.length > 0) out.notes = notes;
  return out;
}

// ---- results

const RESULT_SELECTOR = "[data-component-type='s-search-result']";

function kindOf(signals: SponsoredSignal[], el: DomElement): SearchResultKind {
  if (signals.length === 0) return "organic";
  if (
    rawAll(
      el,
      "[data-component-type^='sbv-'], .sbv-video-single-product, .sp-video-widget-creative",
    ).length > 0
  ) {
    return "sponsored_video";
  }
  if (rawAll(el, ".sb-desktop, .sbx-desktop").length > 0) return "sponsored_brand";
  return "sponsored";
}

// ---- widgets

function widgetType(
  el: DomElement,
  sponsored: boolean,
  heading: string | undefined,
): SearchWidgetType {
  const has = (sel: string): boolean => matches(el, sel) || rawAll(el, sel).length > 0;
  const cls = el.getAttribute("class") ?? "";
  const inner = rawAll(el, "[class*='template=']")
    .map((e) => e.getAttribute("class") ?? "")
    .join(" ");
  const templates = `${cls} ${inner}`;
  if (has("[data-component-type='text-reformulation-widget'], .textref-link-wrapper"))
    return "related_searches";
  if (
    has("[data-component-type='s-tiles-carousel-component'], .s-tiles-header") ||
    /template=SEARCH_TILES/.test(templates)
  ) {
    return "narrow_search";
  }
  if (
    has(
      "[data-component-type^='sbv-'], [data-component-type^='spv-'], .sbv-video-single-product, .sp-video-widget-creative",
    ) ||
    /VIDEO/.test(templates)
  ) {
    return "sponsored_video";
  }
  if (has(".sb-desktop, .sbx-desktop")) return "sponsored_brand";
  if (has("[id^='ape_'], [data-placement-name], .ape-feedback")) return "display_ad";
  if (has("[class*='featured-brands']")) return "featured_brands";
  if (
    has("[class*='mwts'], [aria-label='More ways to shop']") ||
    /^More ways to shop$/i.test(heading ?? "")
  ) {
    return "more_ways_to_shop";
  }
  if (
    /editorial/i.test(templates) ||
    has("[class*='editorial'], [data-component-type*='editorial']") ||
    /editorial/i.test(heading ?? "")
  ) {
    return "editorial";
  }
  if (/^Need help\??$/i.test(heading ?? "")) return "help";
  if (has("[data-component-type='s-searchgrid-carousel'], .a-carousel-container")) {
    return sponsored ? "sponsored_carousel" : "carousel";
  }
  return sponsored ? "sponsored_brand" : "other";
}

function widgetHeading(el: DomElement, meta: ParseMeta): { text?: string; el?: DomElement } {
  let hit: DomElement | undefined;
  const textOf = (h: DomElement | undefined): string | undefined => {
    const t = clean(h, (e) => LABEL_TEXTS.some((re) => re.test(ownText(e))));
    if (t === "" || LABEL_TEXTS.some((re) => re.test(t))) return undefined;
    hit = h;
    return t;
  };
  const strategies: Strategy<string>[] = [
    [
      "heading-tag",
      () =>
        textOf(
          qa(el, "h2, h3, [role='heading']").find(
            (h) => clean(h) !== "" && h.closest(RESULT_SELECTOR) == null && h.closest("li") == null,
          ),
        ),
    ],
    [
      "widget-title-attr",
      () => {
        const holder = q(el, "[data-csa-c-widget-title]");
        const t = attr(holder, "data-csa-c-widget-title");
        if (holder !== undefined && t !== undefined && clean(holder) === collapse(t)) hit = holder;
        return t;
      },
    ],
    [
      "title-class",
      () =>
        textOf(
          q(
            el,
            ".s-tiles-header-title, [class*='Title_title'], [class*='headline'], [class*='Headline']",
          ),
        ),
    ],
    ["aria-region", () => attr(q(el, "[role='region'][aria-label]"), "aria-label")],
  ];
  const t = firstOf("heading", strategies, meta, { optional: true });
  return { text: t, el: hit };
}

/** Search tiles keep their target in a JSON attribute and use href="#". */
function tileUrl(a: DomElement): string | undefined {
  const holder = a.closest("[data-s-tile-lotl]");
  if (holder == null) return undefined;
  try {
    const v = JSON.parse(holder.getAttribute("data-s-tile-lotl") ?? "") as { url?: unknown };
    return typeof v.url === "string" ? v.url : undefined;
  } catch {
    return undefined;
  }
}

function widgetLinks(el: DomElement, ctx: Ctx, type: SearchWidgetType): WidgetLink[] {
  const out: WidgetLink[] = [];
  const seen = new Set<string>();
  for (const a of qa(el, "a")) {
    if (ctx.consumed.covers(a)) continue;
    const href = attr(a, "href");
    let label = clean(a);
    if (label === "") {
      const alt = attr(q(a, "img[alt]"), "alt") ?? attr(a, "aria-label");
      label = collapse(alt ?? "");
    }
    if (label === "" || /^(Next page|Previous page|See more|See less)$/i.test(label)) continue;
    const token = searchToken(href, ctx.base) ?? searchToken(tileUrl(a), ctx.base);
    const link: WidgetLink = { text: label };
    if (token !== undefined) link.token = token;
    else if (type !== "narrow_search") {
      // Same-site paths only: off-site ad click URLs are tracking blobs, not data.
      const path = pathOf(href, ctx.base);
      if (path !== undefined) link.href = path;
    }
    const key = `${link.text}|${link.token ?? link.href ?? ""}`;
    if (seen.has(key)) {
      ctx.consumed.take(a);
      continue;
    }
    seen.add(key);
    out.push(link);
    ctx.consumed.take(a);
  }
  return out;
}

function widgetItemRoots(el: DomElement): DomElement[] {
  const cands = qa(el, "[data-asin], [data-csa-c-item-id*='amzn1.asin']").filter((c) => {
    const a = asinOrUndefined(attr(c, "data-asin"));
    if (a !== undefined) return true;
    return /amzn1\.asin\.(?:1\.)?[A-Z0-9]{10}/.test(attr(c, "data-csa-c-item-id") ?? "");
  });
  // Promote a candidate to its carousel card when it sits inside one.
  const roots = cands.map((c) => c.closest("li.a-carousel-card") ?? c);
  const uniq = [...new Set(roots)].filter((r) => within(r, el));
  return outermost(uniq);
}

// ---- refinements, sort, pagination, info bar

function refinementGroups(
  scope: DomElement | undefined,
  ctx: Ctx,
  meta: ParseMeta,
): RefinementGroup[] {
  if (scope === undefined) return [];
  const groups: RefinementGroup[] = [];
  const lists = Array.from(scope.querySelectorAll("ul[id^='filter-'], div[id^='filter-']")).filter(
    (u) => visible(u) || u.parentElement == null || visible(u.parentElement),
  );
  for (const list of outermost(lists)) {
    if (!visible(list)) continue;
    const key =
      list.id.replace(/^filter-/, "") ||
      list.closest("[role='group'][id]")?.id ||
      `group${groups.length}`;
    const labelledBy = attr(list, "aria-labelledby");
    const ownerDoc = list.closest("#s-refinements") ?? scope;
    const headingEl =
      (labelledBy !== undefined ? q(ownerDoc, `[id='${labelledBy}']`) : undefined) ??
      q(ownerDoc, `[id='${key}-title']`) ??
      q(list, ".sf-refinement-heading") ??
      (list.parentElement != null
        ? qa(list.parentElement, "[role='heading']").find(
            (h) => h.parentElement === list.parentElement,
          )
        : undefined);
    const heading = clean(headingEl) || key;
    if (headingEl !== undefined) ctx.consumed.take(headingEl);
    const options: RefinementOption[] = [];
    for (const li of Array.from(list.querySelectorAll("li"))) {
      // A "See more" wrapper li holds the collapsed options as nested li elements.
      if (li.querySelector("li") != null) {
        for (const ex of qa(li, ".a-expander-header")) ctx.consumed.take(ex);
        continue;
      }
      const collapsed = !visible(li);
      if (collapsed && li.closest(".a-expander-content") == null) continue;
      const link = Array.from(li.querySelectorAll("a[href]")).find(
        (a) => !matches(a, ".a-expander-header"),
      );
      const raw = collapse(
        collapsed
          ? (li.textContent ?? "")
          : clean(li) ||
              attr(link, "aria-label")
                ?.replace(/^(Apply|Remove)\s+(the\s+)?/i, "")
                .replace(/\s+filter.*$/i, "") ||
              "",
      );
      if (raw === "" && link === undefined) continue;
      const countM = /\(([\d,]+)\)\s*$/.exec(raw);
      // "Apply 4 Stars & Up filter to narrow results": the ARIA label carries the option name
      // with the spacing the visual icon + text markup loses.
      const ariaName = /^(?:Apply|Remove)\s+(?:the\s+)?(.+?)\s+filter\b/i.exec(
        attr(link, "aria-label") ?? "",
      )?.[1];
      const textLabel = (countM === null ? raw : raw.slice(0, countM.index)).trim();
      const label = (collapsed ? undefined : ariaName) ?? (textLabel || ariaName || "");
      const selected = firstOf<boolean>(
        "refinement.selected",
        [
          [
            "aria-current",
            () => (link?.getAttribute("aria-current") === "true" ? true : undefined),
          ],
          [
            "checkbox",
            () => (li.querySelector("input[type='checkbox'][checked]") != null ? true : undefined),
          ],
          [
            "bold-label",
            () => (li.querySelector(".a-text-bold") != null && !collapsed ? true : undefined),
          ],
          [
            "remove-aria",
            () => (/^Remove\b/i.test(attr(link, "aria-label") ?? "") ? true : undefined),
          ],
        ],
        meta,
        { optional: true },
      );
      const opt: RefinementOption = {
        label,
        selected: selected === true,
        token: searchToken(attr(link, "href"), ctx.base) ?? null,
      };
      if (countM?.[1] !== undefined) opt.count = Number(countM[1].replace(/,/g, ""));
      if (li.id !== "") opt.id = li.id;
      if (collapsed) opt.collapsed = true;
      options.push(opt);
      if (!collapsed) ctx.consumed.take(li);
    }
    for (const ex of qa(list, ".a-expander-header")) ctx.consumed.take(ex);
    const group: RefinementGroup = { key, heading, options };
    const slider = list.querySelector("[data-slider-props], form.sf-range-slider");
    if (slider != null) {
      const range: RefinementRange = {};
      const lo = clean(q(list, ".sf-lower-bound-label"));
      const hi = clean(q(list, ".sf-upper-bound-label"));
      if (lo !== "") range.low_label = lo;
      if (hi !== "") range.high_label = hi;
      const props = attr(slider, "data-slider-props");
      try {
        const p = props === undefined ? {} : (JSON.parse(props) as Record<string, unknown>);
        if (typeof p.lowerBoundParamName === "string") range.low_param = p.lowerBoundParamName;
        if (typeof p.upperBoundParamName === "string") range.high_param = p.upperBoundParamName;
      } catch {
        meta.warnings.push(`refinements: price slider props are not JSON (${key})`);
      }
      group.range = range;
      for (const s of qa(list, ".sf-range-slider-row")) ctx.consumed.take(s);
      const sub = q(list, ".sf-refinement-heading");
      if (sub !== undefined) ctx.consumed.take(sub);
    }
    if (options.length === 0 && group.range === undefined) continue;
    groups.push(group);
    if (clean(list, (e) => ctx.consumed.covers(e)) === "") ctx.consumed.take(list);
  }
  return groups;
}

function sortOptions(doc: DomElement, ctx: Ctx, meta: ParseMeta): SortOption[] {
  const select = q(doc, "#s-result-sort-select") ?? q(doc, "select[name='s']");
  const out: SortOption[] = [];
  if (select !== undefined) {
    for (const o of Array.from(select.querySelectorAll("option"))) {
      const label = collapse(o.textContent ?? "");
      const value = attr(o, "value") ?? "";
      if (label === "" && value === "") continue;
      const opt: SortOption = { label, value, selected: o.hasAttribute("selected") };
      const token = searchToken(attr(o, "data-url"), ctx.base);
      if (token !== undefined) opt.token = token;
      out.push(opt);
    }
    meta.strategies.sort_options = "select";
    const box = select.closest(".a-dropdown-container") ?? select;
    const prompt = clean(q(box, ".a-dropdown-prompt"));
    if (prompt !== "" && !out.some((o) => o.selected)) {
      for (const o of out) if (o.label === prompt) o.selected = true;
    }
    ctx.consumed.take(box);
    return out;
  }
  // Fallback: a link list of sort choices.
  for (const a of qa(doc, "a[href*='&s='], a[href*='?s=']").filter((a) =>
    /sr_st_/.test(attr(a, "href") ?? ""),
  )) {
    const value = urlParam(new URL(attr(a, "href") ?? "", ctx.base).toString(), "s") ?? "";
    const opt: SortOption = {
      label: clean(a),
      value,
      selected: a.getAttribute("aria-current") === "true",
    };
    const token = searchToken(attr(a, "href"), ctx.base);
    if (token !== undefined) opt.token = token;
    out.push(opt);
    ctx.consumed.take(a);
  }
  if (out.length > 0) meta.strategies.sort_options = "links";
  return out;
}

function parsePagination(
  scope: DomElement,
  ctx: Ctx,
  base: string,
  meta: ParseMeta,
): Pagination | undefined {
  const strip = firstOf<DomElement>(
    "pagination",
    [
      ["strip-class", () => q(scope, ".s-pagination-strip")],
      ["nav-aria", () => q(scope, "[role='navigation'][aria-label='pagination']")],
      ["container-class", () => q(scope, ".s-pagination-container")],
    ],
    meta,
    { optional: true },
  );
  if (strip === undefined) return undefined;
  const pages: PageLink[] = [];
  let current: number | undefined;
  let next: string | null = null;
  let prev: string | null = null;
  let hasNext = false;
  for (const item of qa(strip, ".s-pagination-item")) {
    const t = clean(item);
    const href = attr(item, "href");
    const token = searchToken(href, base);
    if (matches(item, ".s-pagination-next")) {
      next = token ?? null;
      hasNext = token !== undefined && !matches(item, ".s-pagination-disabled");
      continue;
    }
    if (matches(item, ".s-pagination-previous")) {
      prev = token ?? null;
      continue;
    }
    if (!/^\d+$/.test(t)) continue;
    const n = Number(t);
    const isCurrent =
      matches(item, ".s-pagination-selected") || item.getAttribute("aria-current") === "page";
    if (isCurrent) current = n;
    const link: PageLink = { page: n, current: isCurrent };
    if (token !== undefined) link.token = token;
    pages.push(link);
  }
  if (current === undefined) {
    const p = Number(urlParam(base, "page") ?? "1");
    current = Number.isInteger(p) && p > 0 ? p : 1;
    meta.warnings.push("pagination: no selected page item, current page taken from the URL");
  }
  const nums = pages.map((p) => p.page);
  const out: Pagination = {
    current_page: current,
    pages,
    next_token: next,
    prev_token: prev,
    has_next: hasNext,
  };
  if (nums.length > 0) out.last_visible_page = Math.max(...nums);
  ctx.consumed.take(strip.closest(".s-pagination-container") ?? strip);
  return out;
}

const CORRECTION_PATTERNS: readonly (readonly [RegExp, CorrectionType])[] = [
  [/^Showing results for\b/i, "showing_results_for"],
  [/^Search instead for\b/i, "search_instead_for"],
  [/^No results for\b/i, "no_results"],
  [/^Did you mean\b/i, "did_you_mean"],
  [/^Results for\b/i, "showing_results_for"],
];

function parseCorrections(scope: DomElement, ctx: Ctx): Correction[] {
  const out: Correction[] = [];
  const seen = new Set<DomElement>();
  for (const el of qa(scope, "span, div, h1, h2, h3, p")) {
    if (ctx.consumed.covers(el) || el.closest(RESULT_SELECTOR) != null) continue;
    const own = ownText(el);
    const hit = CORRECTION_PATTERNS.find(([re]) => re.test(own));
    if (hit === undefined) continue;
    const row = el.closest(".a-row");
    const near = row != null && within(row, scope) ? row : (el.parentElement ?? el);
    const box = clean(near).length <= 300 ? near : el;
    if (seen.has(box)) continue;
    seen.add(box);
    const t = clean(box);
    const link = qa(box, "a[href]")[0];
    const corr: Correction = { type: hit[1], text: t };
    const quoted = /["“]([^"”]+)["”]/.exec(t)?.[1];
    const linkText = clean(link);
    const stateText = clean(q(box, ".a-color-state, .a-text-bold"));
    const qText =
      linkText !== "" ? linkText : (quoted ?? (stateText !== "" ? stateText : undefined));
    if (qText !== undefined && qText !== "") corr.query = qText.replace(/^["“]|["”]$/g, "");
    const token = searchToken(attr(link, "href"), ctx.base);
    if (token !== undefined) corr.token = token;
    out.push(corr);
    ctx.consumed.take(box);
  }
  return out;
}

function parseRange(s: string): ResultRange | undefined {
  const m =
    /(?:(\d[\d,]*)\s*-\s*(\d[\d,]*)\s+of\s+)?(over\s+|about\s+)?(\d[\d,]*)\s+results?/i.exec(s);
  if (m === null) return undefined;
  const r: ResultRange = {};
  if (m[1] !== undefined) r.first = Number(m[1].replace(/,/g, ""));
  if (m[2] !== undefined) r.last = Number(m[2].replace(/,/g, ""));
  if (m[4] !== undefined) r.total = Number(m[4].replace(/,/g, ""));
  r.total_approximate = m[3] !== undefined;
  return r;
}

// ---- main

export const parseSearch: Parser<SearchPage> = (capture: Capture) => {
  const meta = newMeta();
  const { doc } = parseCapture(capture);
  const base = capture.final_url || capture.url;
  const consumed = new Consumption();
  const ctx: Ctx = { consumed, base };
  const tally = new Tally();

  const search = doc.querySelector("#search") ?? undefined;
  const mainSlot =
    q(doc, ".s-main-slot") ??
    q(doc, ".s-result-list") ??
    q(doc, "[data-component-type='s-search-results']");
  const rail = q(doc, "#s-refinements");
  const infoBar = q(doc, "[data-component-type='s-result-info-bar']");
  if (
    search === undefined &&
    mainSlot === undefined &&
    rail === undefined &&
    infoBar === undefined
  ) {
    throw new RfError(
      "layout_unrecognized",
      "search page: no results container, info bar or refinements",
    );
  }
  if (mainSlot === undefined) meta.warnings.push("results: no results container found");
  const root = search ?? doc.body;

  const data: SearchPage = {
    results: [],
    widgets: [],
    refinements: [],
    applied_filters: [],
    sort_options: [],
    corrections: [],
    hidden_skipped: { results: 0, widgets: 0, sponsored_results: 0, sponsored_widgets: 0 },
  };

  // -- info bar: totals, query, corrections that live there
  const crumb =
    infoBar === undefined
      ? undefined
      : (q(infoBar, ".s-breadcrumb h2, .s-breadcrumb") ?? q(infoBar, "h2"));
  const total = firstOf<string>(
    "total_results_text",
    [
      [
        "info-bar",
        () =>
          clean(
            crumb === undefined
              ? undefined
              : qa(crumb, "span").find((s) => /results?\b/i.test(clean(s))),
          ),
      ],
      [
        "text-anchor",
        () => {
          const el = qa(root, "span, h2").find((s) =>
            /^\d[\d,]*(-\d[\d,]*)? of (over |about )?\d[\d,]* results?/i.test(clean(s)),
          );
          return clean(el);
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (total !== undefined) {
    data.total_results_text = total;
    const r = parseRange(total);
    if (r !== undefined) data.result_range = r;
  }
  const query = firstOf<string>(
    "query",
    [
      [
        "info-bar-state",
        () =>
          clean(crumb === undefined ? undefined : q(crumb, ".a-color-state")).replace(
            /^["“]|["”]$/g,
            "",
          ),
      ],
      ["search-box", () => attr(doc.querySelector("#twotabsearchtextbox") ?? undefined, "value")],
      ["url", () => urlParam(base, "k")],
    ],
    meta,
    { optional: true },
  );
  if (query !== undefined) data.query = query;
  if (crumb !== undefined) consumed.take(crumb);
  const department = firstOf<{ label?: string; alias?: string }>(
    "department",
    [
      [
        "search-dropdown",
        () => {
          const o = doc.querySelector("#searchDropdownBox option[selected]");
          if (o == null) return undefined;
          const alias = attr(o, "value")?.replace(/^search-alias=/, "");
          const label = collapse(o.textContent ?? "");
          return label === "" && alias === undefined
            ? undefined
            : { ...(label !== "" ? { label } : {}), ...(alias !== undefined ? { alias } : {}) };
        },
      ],
      [
        "url",
        () => {
          const alias = urlParam(base, "i");
          return alias === undefined ? undefined : { alias };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (department !== undefined) data.department = department;

  data.sort_options = sortOptions(root, ctx, meta);
  if (infoBar !== undefined && clean(infoBar, (e) => consumed.covers(e)) === "")
    consumed.take(infoBar);

  // -- corrections (info bar and top of the results area), before widgets claim them
  data.corrections = parseCorrections(root, ctx);
  if (data.corrections.length > 0) meta.strategies.corrections = "text-anchor";

  // -- results and widgets, in DOM order
  let position = 0;
  let section: string | undefined;
  const children = mainSlot === undefined ? [] : Array.from(mainSlot.children);
  for (const child of children) {
    if (["script", "style", "link", "noscript", "template"].includes(child.localName)) continue;
    const idxRaw = attr(child, "data-index");
    const index = idxRaw !== undefined && /^\d+$/.test(idxRaw) ? Number(idxRaw) : undefined;
    const markers = hiddenMarkers(child, mainSlot as DomElement);
    const hiddenInBrowser = markers.length > 0 || !visible(child);
    if (hiddenInBrowser && markers.length === 0) continue; // hidden from above the results list
    const signals = sponsoredSignals(child, mainSlot);

    // Cards are direct children of the results list: widgets embed card-like markup.
    if (matches(child, RESULT_SELECTOR)) {
      if (hiddenInBrowser) {
        if (signals.length === 0) {
          data.hidden_skipped.results++;
          continue;
        }
        unmask(markers, child);
        data.hidden_skipped.sponsored_results++;
      }
      const m = newMeta();
      const fields = parseProduct(child, ctx, m);
      tally.merge("results", m);
      if (fields === undefined) {
        meta.warnings.push(`results: card at data-index ${idxRaw ?? "?"} has no ASIN; skipped`);
        continue;
      }
      if (fields.title === undefined) meta.warnings.push(`results: ${fields.asin} has no title`);
      const result: SearchResult = {
        position: hiddenInBrowser ? null : ++position,
        kind: kindOf(signals, child),
        is_sponsored: signals.length > 0,
        sponsored_signals: signals,
        hidden_in_browser: hiddenInBrowser,
        ...fields,
      };
      if (index !== undefined) result.index = index;
      const label = signals.length > 0 ? labelText(child) : undefined;
      if (label !== undefined) result.sponsored_label = label;
      if (section !== undefined) result.section = section;
      if (hiddenInBrowser) consumed.take(child);
      data.results.push(result);
      continue;
    }

    // Results section headers ("Results", "More results").
    const header = q(child, "[data-component-type='s-messaging-widget-results-header']");
    if (header !== undefined && !hiddenInBrowser) {
      const t = clean(q(header, "h2") ?? header);
      if (t !== "") section = t;
      consumed.take(child);
      continue;
    }
    // Pagination strip.
    if (
      !hiddenInBrowser &&
      q(child, ".s-pagination-strip, .s-pagination-container") !== undefined
    ) {
      const p = parsePagination(child, ctx, base, meta);
      if (p !== undefined) data.pagination = p;
      continue;
    }

    if (hiddenInBrowser) {
      if (signals.length === 0) {
        data.hidden_skipped.widgets++;
        continue;
      }
      unmask(markers, child);
      data.hidden_skipped.sponsored_widgets++;
    }
    const before = clean(child, (e) => consumed.covers(e));
    if (before === "") {
      if (hiddenInBrowser) consumed.take(child);
      continue;
    }
    const wm = newMeta();
    const heading = widgetHeading(child, wm);
    const type = widgetType(child, signals.length > 0, heading.text);
    const widget: SearchWidget = {
      type,
      is_sponsored: signals.length > 0,
      sponsored_signals: signals,
      hidden_in_browser: hiddenInBrowser,
      items: [],
      links: [],
    };
    if (heading.text !== undefined) widget.heading = heading.text;
    if (heading.el !== undefined) consumed.take(heading.el);
    if (index !== undefined) widget.index = index;
    const label = signals.length > 0 ? labelText(child) : undefined;
    if (label !== undefined) widget.sponsored_label = label;
    for (const l of sponsoredLabelElements(child)) {
      if (visible(l)) consumed.take(labelHolder(l, child));
    }
    for (const itemRoot of widgetItemRoots(child)) {
      const im = newMeta();
      const fields = parseProduct(itemRoot, ctx, im);
      tally.merge("widget_items", im);
      if (fields === undefined) continue;
      const itemSignals = sponsoredSignals(itemRoot, child);
      const item: WidgetItem = {
        ...fields,
        is_sponsored: widget.is_sponsored || itemSignals.length > 0,
        sponsored_signals: itemSignals,
      };
      const head = q(itemRoot, ".s-product-header");
      const ht = clean(head);
      if (ht !== "") {
        item.header = ht;
        consumed.take(head);
      }
      widget.items.push(item);
      for (const l of qa(itemRoot, "a"))
        if (!consumed.covers(l) && clean(l) === "") consumed.take(l);
      if (clean(itemRoot, (e) => consumed.covers(e)) === "") consumed.take(itemRoot);
    }
    for (const b of qa(
      child,
      ".a-carousel-button, .a-carousel-goto-nextpage, .a-carousel-goto-prevpage",
    )) {
      consumed.take(b);
    }
    widget.links = widgetLinks(child, ctx, type);
    tally.merge(`widgets.${type}`, wm);
    // A short remainder (disclosure footers, "or" between links) is kept as the widget's text;
    // a long one stays unconsumed so the lossless report carries it.
    const rest = clean(child, (e) => consumed.covers(e));
    if (rest !== "" && rest.length <= WIDGET_TEXT_MAX) {
      widget.text = rest;
      consumed.take(child);
    }
    if (hiddenInBrowser) consumed.take(child);
    data.widgets.push(widget);
  }

  // Blocks outside the results list (none seen in captures) reach other_sections.

  // -- refinements and applied filters
  data.refinements = refinementGroups(
    rail ?? q(root, "[data-component-type='s-filters-panel-view']"),
    ctx,
    meta,
  );
  if (data.refinements.length > 0)
    meta.strategies.refinements = rail !== undefined ? "id" : "data-attr";
  // Screen-reader skip links in the rail ("Skip to main search results").
  for (const a of qa(root, "a.aok-offscreen"))
    if (a.closest(RESULT_SELECTOR) == null) consumed.take(a);
  for (const g of data.refinements) {
    for (const o of g.options) {
      if (!o.selected) continue;
      const f: AppliedFilter = { group: g.heading, label: o.label };
      if (o.token !== null) f.token = o.token;
      data.applied_filters.push(f);
    }
  }
  if (data.applied_filters.length > 0) meta.strategies.applied_filters = "refinements";
  else {
    const rh = urlParam(base, "rh");
    if (rh !== undefined) {
      for (const part of rh.split(",")) {
        const [group, value] = part.split(":");
        if (group !== undefined && value !== undefined)
          data.applied_filters.push({ group, label: value });
      }
      if (data.applied_filters.length > 0) meta.strategies.applied_filters = "url";
    }
  }

  // Pagination outside the results list (some layouts render it after the list).
  if (data.pagination === undefined) {
    const p = parsePagination(root, ctx, base, meta);
    if (p !== undefined) data.pagination = p;
  }

  if (data.results.length === 0 && !data.corrections.some((c) => c.type === "no_results")) {
    meta.warnings.push("results: no result cards found");
  }

  tally.writeTo(meta);
  const report = losslessReport(doc, consumed, { root });
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data, other_sections: report.sections, meta };
};
