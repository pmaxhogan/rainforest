/**
 * Subscribe & Save hub ("auto-deliveries") page parser.
 *
 * The captured page is a server-rendered hub, not an XHR shell: the upcoming-delivery
 * carousel, the savings banner, the subscription tiles (with subscription id and ASIN in a
 * `data-edit-url`) and a "Recommended for you" carousel are all in the DOM. Prices, quantity
 * discounts and per-subscription status are NOT on the tiles; they live in the per-tile edit
 * modal (`ajax/subscription/` URL, exposed here as `edit_path`).
 *
 * Carousel slides that are scrolled out of view are marked hidden by the capture pass but
 * are real deliveries (`aria-setsize` says how many exist); they are read from the raw DOM
 * and flagged `offscreen`.
 */
import type { Capture, OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import {
  type DomElement,
  type Money,
  Consumption,
  attr,
  collapse,
  firstOf,
  harvestBlobs,
  hiddenSelf,
  losslessReport,
  moneyFromPriceElement,
  newMeta,
  parseCapture,
  parseMoney,
  q,
  qa,
  text,
  visible,
} from "../index.ts";

// ---- types

export interface SubscriptionsTab {
  /** Stable key derived from the link id (`menu-item-button-pill-<key>`), e.g. "deliveries". */
  key: string;
  label: string;
  /** Relative path plus the non-tracking query, e.g. "/auto-deliveries?scrollTo=subscriptions". */
  href_path: string | null;
  selected: boolean;
}

export interface DeliveryItem {
  title: string;
  image_url: string | null;
}

export interface UpcomingDelivery {
  /** Opaque delivery-bundle id (stable identifier for the manage page). */
  bundle_id: string | null;
  /** "Arriving" / "Delivered" / ... when the date label starts with a status word. */
  status_text: string | null;
  /** Date label as shown, e.g. "Tue, Nov 17" (status word removed). */
  date_text: string | null;
  /** ISO date (UTC) from the manage URL epoch, else inferred from the text. */
  delivery_date: string | null;
  last_edit_text: string | null;
  last_edit_date: string | null;
  /** Products pictured on the card (image alt text is the only title the card carries). */
  items: DeliveryItem[];
  /** "+N" overflow count shown after the pictured items. */
  extra_item_count: number;
  /** Visible cards only know pictured + overflow items. */
  item_count: number;
  /** Card is styled as in progress (already shipped / being prepared). */
  in_progress: boolean;
  /** Button labels only ("Manage", "Skip items"); write actions are never exposed as handles. */
  action_labels: string[];
  /** Manage page path with tracking removed (carries ship id, delivery date, bundle id). */
  manage_path: string | null;
  ship_id: string | null;
  /** 1-based position in the carousel. */
  position: number | null;
  /** The slide was scrolled out of view in the capture (read from hidden DOM). */
  offscreen: boolean;
  /** Visible card text no field accounted for. */
  extra_text?: string;
}

export interface SubscriptionFrequency {
  every: number;
  /** "day" | "week" | "month" | "year" */
  unit: string;
}

export interface SubscriptionEntry {
  subscription_id: string | null;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  next_delivery_text: string | null;
  next_delivery_date: string | null;
  quantity: number | null;
  frequency: SubscriptionFrequency | null;
  frequency_text: string | null;
  /** Not on the hub tiles; filled only if a layout shows it. */
  price?: Money;
  savings_pct?: number;
  /** Status wording if the tile shows one (paused, skipped, ...). */
  status_text: string | null;
  /** Edit modal path (ajax) with tracking removed: where price and discount tier live. */
  edit_path: string | null;
  ship_id: string | null;
  /** Label of the edit button only. */
  action_labels: string[];
  extra_text?: string;
}

export interface FrequencyOption {
  /** Opaque option value such as "2W|sns". */
  value: string;
  label: string;
  selected: boolean;
}

export interface SubscribeOffer {
  asin: string | null;
  title: string | null;
  url_path: string | null;
  image_url: string | null;
  /** Subscribe & Save price at the displayed discount tier. */
  price: Money | null;
  /** Percent off as shown ("-15%" -> 15). */
  discount_pct: number | null;
  one_time_price: Money | null;
  list_price: Money | null;
  typical_price: Money | null;
  /** "Extra 10% off" promotion text and its percent. */
  extra_discount_text: string | null;
  extra_discount_pct: number | null;
  /** "Purchased 2 times" badge. */
  purchased_text: string | null;
  purchased_count: number | null;
  default_frequency: string | null;
  frequency_options: FrequencyOption[];
  action_labels: string[];
  extra_text?: string;
}

export interface CategoryFilter {
  id: string | null;
  label: string;
  count: number | null;
}

export interface SavingsSummary {
  total: Money | null;
  /** "Sep 2025" from "since Sep 2025". */
  since_text: string | null;
  text: string;
}

export interface SubscriptionsPage {
  /** No subscriptions and no upcoming deliveries on the page. */
  is_empty: boolean;
  empty_message: string | null;
  /** Program tab shown in the top bar ("Subscribe & Save") and sibling programs ("Buy Again"). */
  program: string | null;
  program_links: { label: string; href_path: string }[];
  /** Section pills: settings, deliveries, subscriptions, shop. */
  tabs: SubscriptionsTab[];
  deliveries_heading: string | null;
  upcoming_deliveries: UpcomingDelivery[];
  /** Number of slides the carousel says it holds (aria-setsize); the last one is the paging sentinel. */
  upcoming_deliveries_total: number | null;
  /**
   * Path of the deliveries API that returns the next window of deliveries (the carousel's
   * paging sentinel `data-next-url`), or null when the carousel is complete.
   */
  deliveries_next_path: string | null;
  savings: SavingsSummary | null;
  subscriptions_heading: string | null;
  subscriptions: SubscriptionEntry[];
  category_filters: CategoryFilter[];
  /** Labels of section-level actions ("Edit All"). */
  action_labels: string[];
  bulk_edit_path: string | null;
  recommended_heading: string | null;
  recommended: SubscribeOffer[];
}

// ---- helpers

const TRACKING_PARAMS = new Set([
  "ref",
  "ref_",
  "pf_rd_p",
  "pf_rd_r",
  "pf_rd_s",
  "pf_rd_t",
  "pf_rd_i",
  "pf_rd_m",
  "pd_rd_w",
  "pd_rd_r",
  "pd_rd_wg",
  "pd_rd_i",
  "content-id",
  "_encoding",
  "qid",
  "sbo",
  "fpw",
  "fpl",
  "psc",
  "sourcePage",
  "clientName",
]);

/** Relative URL with tracking parameters removed; undefined for blank input. */
export function cleanPath(href: string | null | undefined): string | undefined {
  if (href == null || href.trim() === "") return undefined;
  const raw = href.trim();
  const hash = raw.indexOf("#");
  const noHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const qIdx = noHash.indexOf("?");
  if (qIdx < 0) return noHash;
  const path = noHash.slice(0, qIdx);
  const kept: string[] = [];
  for (const pair of noHash.slice(qIdx + 1).split("&")) {
    if (pair === "") continue;
    const key = pair.split("=")[0] ?? "";
    if (TRACKING_PARAMS.has(key)) continue;
    kept.push(pair);
  }
  return kept.length === 0 ? path : `${path}?${kept.join("&")}`;
}

function queryParam(url: string | undefined, name: string): string | undefined {
  if (url === undefined) return undefined;
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return undefined;
  for (const pair of url
    .slice(qIdx + 1)
    .replace(/&amp;/g, "&")
    .split("&")) {
    const eq = pair.indexOf("=");
    if ((eq < 0 ? pair : pair.slice(0, eq)) === name) {
      return eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return undefined;
}

/** Text of an element even when the capture pass hid it (carousel overflow slides). */
function rawText(el: DomElement | null | undefined): string {
  return el == null ? "" : collapse(el.textContent ?? "");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DATE_RE =
  /(?:\b([A-Za-z]{3})[a-z]*\.?,\s*)?\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/;

/**
 * ISO date from "Tue, Nov 17" / "Nov 24" / "Dec 3, 2026". Without a year the year is the
 * first one (from the capture year on) that matches the weekday if given, else the first
 * date not more than 40 days before the capture. Returns undefined when it does not parse.
 */
export function isoFromText(s: string | null | undefined, capturedAt: string): string | undefined {
  if (s == null) return undefined;
  const m = DATE_RE.exec(s);
  if (m === null) return undefined;
  const month = MONTHS.indexOf((m[2] ?? "").toLowerCase());
  const day = Number(m[3]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  const make = (year: number): string | undefined => {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return undefined;
    return d.toISOString().slice(0, 10);
  };
  if (m[4] !== undefined) return make(Number(m[4]));
  const captured = Date.parse(capturedAt);
  if (Number.isNaN(captured)) return undefined;
  const cy = new Date(captured).getUTCFullYear();
  const weekday = m[1] === undefined ? -1 : WEEKDAYS.indexOf(m[1].toLowerCase());
  for (let year = cy - 1; year <= cy + 2; year++) {
    const iso = make(year);
    if (iso === undefined) continue;
    const at = Date.parse(iso);
    if (weekday >= 0) {
      if (new Date(at).getUTCDay() === weekday && at >= captured - 40 * 86_400_000) return iso;
    } else if (at >= captured - 40 * 86_400_000) {
      return iso;
    }
  }
  return undefined;
}

function isoFromEpochMs(v: string | undefined): string | undefined {
  if (v === undefined || !/^\d{9,14}$/.test(v)) return undefined;
  const d = new Date(Number(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function pct(s: string | null | undefined): number | undefined {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(s ?? "");
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** The element right before `el` among its parent's element children. */
function prevSibling(el: DomElement): DomElement | null {
  const kids = Array.from(el.parentElement?.children ?? []);
  const at = kids.indexOf(el);
  return at > 0 ? (kids[at - 1] ?? null) : null;
}

function asinFromHref(href: string | undefined): string | undefined {
  const m = /\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(href ?? "");
  return m?.[1];
}

/** Visible text of an item card that none of its parsed parts covered. */
function leftover(card: DomElement, parts: Consumption): string | undefined {
  const rest = text(card, { exclude: (el) => parts.has(el) });
  return rest === "" ? undefined : rest;
}

/** Elements of a selector including ones the capture pass marked hidden. */
function rawAll(
  root: DomElement | { querySelectorAll(s: string): ArrayLike<DomElement> },
  sel: string,
): DomElement[] {
  try {
    return Array.from(root.querySelectorAll(sel));
  } catch {
    return [];
  }
}

// ---- tabs

function parseTabs(
  doc: ParseDoc,
  used: Consumption,
  meta: ParseMeta,
): {
  tabs: SubscriptionsTab[];
  program: string | null;
  program_links: { label: string; href_path: string }[];
} {
  const pills = q(doc, "#hub-navigation-pills");
  const tabs: SubscriptionsTab[] = [];
  const found =
    firstOf<DomElement[]>(
      "tabs",
      [
        ["id", () => qa(pills, "a[id^='menu-item-button-pill-']")],
        ["data-attr", () => qa(pills, "[data-hub-section] a[href]")],
        [
          "label",
          () =>
            qa(doc, "a[href*='/auto-deliveries']").filter((a) =>
              /pill/i.test(a.getAttribute("class") ?? ""),
            ),
        ],
      ],
      meta,
      { optional: true },
    ) ?? [];
  for (const a of found) {
    const id = attr(a, "id") ?? "";
    const key =
      /^menu-item-button-pill-(.+)$/.exec(id)?.[1] ??
      attr(a.closest("[data-hub-section]"), "data-hub-section") ??
      id;
    const label =
      text(a) || attr(a, "aria-label") || attr(q(a, "img[aria-label]"), "aria-label") || "";
    const selected =
      attr(a, "aria-current") !== undefined || /selected/i.test(a.getAttribute("class") ?? "");
    tabs.push({ key, label, href_path: cleanPath(attr(a, "href")) ?? null, selected });
    used.take(a);
  }
  if (pills !== undefined) used.take(pills);
  const card = pills?.parentElement ?? null;
  const logo = q(doc, "#snsNavigationLogo");
  const program = logo === undefined ? null : text(logo) || null;
  if (logo !== undefined) meta.strategies.program = "id";
  const bar = logo?.parentElement ?? null;
  const program_links: { label: string; href_path: string }[] = [];
  for (const a of qa(bar, "a[href]")) {
    const href = cleanPath(attr(a, "href"));
    if (href !== undefined) program_links.push({ label: text(a), href_path: href });
  }
  if (bar !== null) used.take(bar);
  if (card !== null && tabs.length === 0 && bar === null) used.take(card);
  return { tabs, program, program_links };
}

// ---- deliveries

type ParseDoc = ReturnType<typeof parseCapture>["doc"];

/** A card inside a carousel slide the capture pass hid because it was scrolled out of view. */
function offscreenSlide(card: DomElement): boolean {
  const slide = card.closest("li.a-carousel-card");
  if (slide === null || !hiddenSelf(slide)) return false;
  for (let cur = slide.parentElement; cur !== null; cur = cur.parentElement) {
    if (hiddenSelf(cur)) return false;
  }
  return true;
}

function parseDelivery(
  card: DomElement,
  capturedAt: string,
  offscreen: boolean,
  used: Consumption,
  meta: ParseMeta,
): UpcomingDelivery {
  const parts = new Consumption();
  const manage =
    attr(card, "data-manageurl") ?? attr(q(card, "[data-manageurl]"), "data-manageurl");
  const manageLink =
    manage ?? attr(rawAll(card, "a[href*='deliveryBundleId']")[0], "href") ?? undefined;
  const bold = rawAll(card, "span.a-text-bold").find((s) => !/^\+\s*\d+$/.test(rawText(s)));
  const label = rawText(bold);
  const lm =
    /^(Arriving|Arrives|Delivered|Delivering|Shipped|Delayed|Rescheduled)\b[:\s]*(.*)$/i.exec(
      label,
    );
  const status_text = lm?.[1] ?? null;
  const date_text = (lm === null ? label : (lm[2] ?? "")) || null;
  const lastEl = rawAll(card, "span").find((s) => /^Last day to edit\b/i.test(rawText(s)));
  const last_edit_text = rawText(lastEl).replace(/^Last day to edit\s*/i, "") || null;
  const items: DeliveryItem[] = [];
  for (const img of rawAll(card, "img")) {
    const alt = attr(img, "alt") ?? "";
    const src = attr(img, "src");
    if (alt === "" && src === undefined) continue;
    items.push({ title: alt, image_url: src ?? null });
    parts.take(img);
  }
  const plus = rawAll(card, "[class*='plusCount']")[0];
  const extra = Number(/\+\s*(\d+)/.exec(rawText(plus))?.[1] ?? 0);
  const actions = rawAll(card, "[id^='action-button-container']")
    .map((el) => rawText(el))
    .filter((s) => s !== "");
  for (const el of rawAll(card, "[id^='action-button-container']")) parts.take(el);
  parts.take(bold);
  parts.take(lastEl);
  parts.take(plus);
  const posAttr = attr(card.closest("li"), "aria-posinset");
  const iso =
    firstOf<string>(
      "delivery_date",
      [
        ["data-attr", () => isoFromEpochMs(queryParam(manageLink, "deliveryDate"))],
        ["text-anchor", () => isoFromText(date_text, capturedAt)],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const delivery: UpcomingDelivery = {
    bundle_id:
      attr(card, "data-csa-c-delivery-bundle-id") ??
      queryParam(manageLink, "deliveryBundleId") ??
      attr(q(card, ".hub-delivery-card"), "id") ??
      null,
    status_text,
    date_text,
    delivery_date: iso,
    last_edit_text,
    last_edit_date: isoFromText(last_edit_text, capturedAt) ?? null,
    items,
    extra_item_count: extra,
    item_count: items.length + extra,
    in_progress: rawAll(card, "[class*='inprogress' i]").length > 0,
    action_labels: actions,
    manage_path: cleanPath(manageLink) ?? null,
    ship_id: queryParam(manageLink, "shipId") ?? null,
    position: posAttr === undefined ? null : Number(posAttr) || null,
    offscreen,
  };
  if (!offscreen) {
    const rest = leftover(card, parts);
    if (rest !== undefined) delivery.extra_text = rest;
    used.take(card);
  }
  return delivery;
}

// ---- subscriptions

const FREQ_RE = /(\d+)\s+units?\s+every\s+(\d+)\s+(day|week|month|year)s?/i;

function parseSubscriptionTile(
  tile: DomElement,
  capturedAt: string,
  used: Consumption,
): SubscriptionEntry {
  const parts = new Consumption();
  const editUrl = attr(tile, "data-edit-url");
  const titleEl = q(tile, ".a-truncate-full");
  const img = q(tile, "img");
  const title = text(titleEl) || attr(img, "alt") || text(q(tile, ".a-truncate-cut")) || null;
  const nextEl = qa(tile, "span, div").find(
    (s) => /^Next delivery\b/i.test(text(s)) && s.children.length === 0,
  );
  const freqEl = qa(tile, "span, div").find(
    (s) => FREQ_RE.test(text(s)) && s.children.length === 0,
  );
  const next_delivery_text = text(nextEl).replace(/^Next delivery:?\s*/i, "") || null;
  const fm = FREQ_RE.exec(text(freqEl));
  const editBtn = q(tile, "[data-edit-link], .a-button-text");
  const priceEl = q(tile, ".a-price");
  parts.takeAll([titleEl, img, nextEl, freqEl, editBtn, priceEl, q(tile, ".a-truncate")]);
  const entry: SubscriptionEntry = {
    subscription_id: queryParam(editUrl, "subscriptionId") ?? null,
    asin: queryParam(editUrl, "subAsin") ?? asinFromHref(attr(q(tile, "a[href]"), "href")) ?? null,
    title,
    image_url: attr(img, "src") ?? null,
    next_delivery_text,
    next_delivery_date: isoFromText(next_delivery_text, capturedAt) ?? null,
    quantity: fm?.[1] === undefined ? null : Number(fm[1]),
    frequency:
      fm?.[2] === undefined ? null : { every: Number(fm[2]), unit: (fm[3] ?? "").toLowerCase() },
    frequency_text: text(freqEl) || null,
    status_text: null,
    edit_path: cleanPath(editUrl) ?? null,
    ship_id: queryParam(editUrl, "shipId") ?? null,
    action_labels: text(editBtn) === "" ? [] : [text(editBtn)],
  };
  const money = moneyFromPriceElement(priceEl);
  if (money !== undefined) entry.price = money;
  const save = pct(
    text(qa(tile, "span").find((s) => /\bsave\b/i.test(text(s)) && /%/.test(text(s)))),
  );
  if (save !== undefined) entry.savings_pct = save;
  const rest = leftover(tile, parts);
  if (rest !== undefined) {
    const st = /\b(paused|skipped|cancel+ed|inactive|suspended|on hold)\b[^.]*/i.exec(rest);
    if (st !== null) entry.status_text = st[0];
    entry.extra_text = rest;
  }
  used.take(tile);
  return entry;
}

// ---- recommended

function parseOffer(li: DomElement, used: Consumption): SubscribeOffer {
  const parts = new Consumption();
  const link = qa(li, "a[href*='/dp/']")[0];
  const titleEl = q(li, ".a-truncate-full");
  const img = q(li, "img");
  const itemId = attr(q(li, "[data-csa-c-item-id]"), "data-csa-c-item-id");
  const href = attr(link, "href");
  const asin =
    /asin(?:\.\d+)?\.([A-Z0-9]{10})/.exec(itemId ?? "")?.[1] ??
    attr(q(li, "[data-asin]"), "data-asin") ??
    asinFromHref(href) ??
    null;
  const tier =
    q(li, ".snsTieredPrice") ?? q(li, "[class*='priceToPay']")?.closest(".a-section") ?? undefined;
  const priceEl = q(tier, ".a-price");
  const savingsEl = q(tier, "[class*='priceSavings']");
  const prices: Record<string, Money> = {};
  for (const strike of qa(tier, ".a-text-strike")) {
    const labelEl = prevSibling(strike);
    const label = collapse(text(labelEl).replace(/:$/, ""));
    const m = parseMoney(text(strike));
    if (m === undefined) continue;
    parts.take(strike);
    parts.take(labelEl);
    if (/one[- ]?time/i.test(label)) prices.one_time = m;
    else if (/list/i.test(label)) prices.list = m;
    else if (/typical/i.test(label)) prices.typical = m;
    else prices[label || "other"] = m;
  }
  const promo = q(li, "[id^='ee-promotion-']");
  const badge = q(li, ".a-badge-text");
  const select = rawAll(li, "select")[0];
  const options: FrequencyOption[] = rawAll(li, "select option")
    .filter((o) => o.getAttribute("value") !== "" && o.getAttribute("value") !== null)
    .map((o) => ({
      value: attr(o, "value") ?? "",
      label: rawText(o),
      selected: o.hasAttribute("selected"),
    }));
  const promptEl = q(li, ".a-dropdown-prompt");
  const subBtn = q(li, ".snsSubscribeButton");
  const label = qa(li, "span").find(
    (s) => /^Deliver every/i.test(text(s)) && s.children.length === 0,
  );
  parts.takeAll([
    link,
    titleEl,
    img,
    priceEl,
    savingsEl,
    promo,
    badge,
    select,
    promptEl,
    subBtn,
    label,
    q(li, ".a-dropdown-container"),
    q(li, ".a-truncate"),
  ]);
  const sel = options.find((o) => o.selected);
  const offer: SubscribeOffer = {
    asin,
    title: text(titleEl) || attr(img, "alt") || null,
    url_path: href === undefined ? null : (href.split("?")[0] ?? null),
    image_url: attr(img, "src") ?? null,
    price: moneyFromPriceElement(priceEl) ?? null,
    discount_pct: pct(text(savingsEl)) ?? null,
    one_time_price: prices.one_time ?? null,
    list_price: prices.list ?? null,
    typical_price: prices.typical ?? null,
    extra_discount_text: text(promo) || null,
    extra_discount_pct: pct(text(promo)) ?? null,
    purchased_text: text(badge) || null,
    purchased_count:
      /(\d+)\s+time/i.exec(text(badge))?.[1] === undefined
        ? null
        : Number(/(\d+)\s+time/i.exec(text(badge))?.[1]),
    default_frequency: sel?.label ?? (text(promptEl) || null),
    frequency_options: options,
    action_labels: text(subBtn) === "" ? [] : [text(subBtn)],
  };
  const rest = leftover(li, parts);
  if (rest !== undefined) offer.extra_text = rest;
  used.take(li);
  return offer;
}

// ---- parser

function sectionCard(el: DomElement | undefined): DomElement | undefined {
  return el?.closest("[id^='CardInstance']") ?? undefined;
}

export const parseSubscriptions: Parser<SubscriptionsPage> = (
  capture: Capture,
): ParseResult<SubscriptionsPage> => {
  const { doc } = parseCapture(capture);
  const meta = newMeta();
  const used = new Consumption();

  const { tabs, program, program_links } = parseTabs(doc, used, meta);

  // deliveries
  const scroller = q(doc, "#deliveriesDesktopScroller");
  const cards =
    firstOf<DomElement[]>(
      "upcoming_deliveries",
      [
        ["data-attr", () => rawAll(doc, "[data-csa-c-delivery-bundle-id]")],
        ["id", () => rawAll(scroller ?? doc, ".hub-delivery-card")],
      ],
      meta,
      { optional: true },
    ) ?? [];
  const upcoming_deliveries: UpcomingDelivery[] = [];
  for (const card of cards) {
    const isVisible = visible(card);
    const off = !isVisible && offscreenSlide(card);
    if (!isVisible && !off) continue; // hidden template or non-rendered duplicate
    upcoming_deliveries.push(parseDelivery(card, capture.captured_at, off, used, meta));
  }
  const nextEl = rawAll(doc, "[data-next-url]")[0];
  const deliveries_next_path = cleanPath(attr(nextEl, "data-next-url")) ?? null;
  const setsize = Number(attr(rawAll(doc, "li.a-carousel-card[aria-setsize]")[0], "aria-setsize"));
  const delivHeadEl = q(sectionCard(scroller) ?? doc, "#cardHeader");
  const deliveries_heading = text(delivHeadEl) || null;
  used.take(delivHeadEl);
  for (const btn of qa(scroller, "a.a-carousel-button")) used.take(btn);

  // savings
  const slot = q(doc, "#hub-savings-slot");
  let savings: SavingsSummary | null = null;
  if (slot !== undefined && text(slot) !== "") {
    const body = text(slot);
    savings = {
      total: moneyFromPriceElement(q(slot, ".a-price")) ?? parseMoney(body) ?? null,
      since_text: /\bsince\s+([A-Za-z]+\s+\d{4})/i.exec(body)?.[1] ?? null,
      text: body,
    };
    meta.strategies.savings = "id";
    used.take(slot);
  }

  // subscriptions
  const grid = q(doc, "#subscriptionsDesktopGridLayout");
  const tiles =
    firstOf<DomElement[]>(
      "subscriptions",
      [
        ["id", () => qa(grid, "[data-edit-url]")],
        ["data-attr", () => qa(doc, "[data-mix-operations='editSubscriptionModalHandler']")],
        ["text-anchor", () => qa(doc, "[data-edit-url*='subscriptionId=']")],
      ],
      meta,
      { optional: true },
    ) ?? [];
  const subscriptions = tiles.map((t) => parseSubscriptionTile(t, capture.captured_at, used));

  const headEl = q(doc, "#subscriptions-desktop-section-heading");
  const headTitle = q(headEl, ".a-text-bold");
  const subscriptions_heading = text(headTitle) || null;
  const bulk = q(headEl, "[data-content]");
  const action_labels = qa(headEl, "[role='button'], button, a")
    .map((e) => text(e))
    .filter((s) => s !== "");
  used.take(headEl);

  const filters: CategoryFilter[] = [];
  const filterBox = q(doc, "#categoryFiltersDesktopContainer");
  for (const pill of qa(filterBox, "[data-category-id]")) {
    const label = text(pill);
    const m = /^(.*?)\s*\((\d+)\)\s*$/.exec(label);
    filters.push({
      id: attr(pill, "data-category-id") ?? null,
      label: m?.[1] ?? label,
      count: m?.[2] === undefined ? null : Number(m[2]),
    });
  }
  used.take(filterBox);

  // recommended
  const offerEls =
    firstOf<DomElement[]>(
      "recommended",
      [
        ["data-attr", () => qa(doc, "li[data-id^='asin-faceout']")],
        ["label", () => qa(doc, "[data-csa-c-item-type='asin'][data-csa-c-owner='eemb-sns']")],
      ],
      meta,
      { optional: true },
    ) ?? [];
  const recommended = offerEls.map((li) => parseOffer(li, used));
  const recCard = sectionCard(offerEls[0]) ?? q(doc, "[id^='CardInstance']");
  const recHead = recommended.length > 0 ? q(recCard, "h2") : undefined;
  used.take(recHead);
  for (const btn of qa(recCard, "a.a-carousel-button")) used.take(btn);

  // empty state
  const bodyText = text(doc.body);
  const emptyRe =
    /(you (?:currently )?(?:have|don't have) (?:no|any) (?:active )?(?:subscriptions|upcoming deliveries)[^.]*\.?|no (?:active )?subscriptions[^.]*\.?|no upcoming deliveries[^.]*\.?)/i;
  const emptyMatch = emptyRe.exec(bodyText);
  const is_empty = subscriptions.length === 0 && upcoming_deliveries.length === 0;
  if (is_empty && emptyMatch !== null) {
    for (const el of qa(doc.body, "span, p, div, h1, h2")) {
      if (el.children.length === 0 && emptyRe.test(text(el))) used.take(el);
    }
  }

  const recognized =
    tabs.length > 0 ||
    subscriptions.length > 0 ||
    upcoming_deliveries.length > 0 ||
    savings !== null ||
    recommended.length > 0 ||
    program !== null;
  if (!recognized) {
    throw new RfError(
      "layout_unrecognized",
      "subscriptions page: no hub navigation, deliveries or subscriptions found",
    );
  }
  if (tabs.length === 0) meta.warnings.push("tabs: no hub navigation pills found");
  // The carousel's last slide is the paging sentinel, not a delivery.
  const expected = upcoming_deliveries.length + (deliveries_next_path === null ? 0 : 1);
  if (Number.isFinite(setsize) && setsize > 0 && setsize !== expected) {
    meta.warnings.push(`upcoming_deliveries: carousel says ${setsize} slides, parsed ${expected}`);
  }
  if (subscriptions.length === 0 && !is_empty) {
    meta.warnings.push("subscriptions: none found although deliveries exist");
  }

  const harvest = harvestBlobs(doc, { known: ["a-wlab-states", /^data-a-dynamic-image/] });
  if (harvest.unknownKeys.length > 0) meta.unknown_blobs = harvest.unknownKeys;

  const report = losslessReport(doc, used, { base: capture.final_url });
  meta.unparsed_text_chars = report.counts.unparsed;
  const other_sections: OtherSection[] = report.sections;

  const data: SubscriptionsPage = {
    is_empty,
    empty_message: is_empty ? (emptyMatch?.[1] ?? null) : null,
    program,
    program_links,
    tabs,
    deliveries_heading,
    upcoming_deliveries,
    upcoming_deliveries_total: Number.isFinite(setsize) && setsize > 0 ? setsize : null,
    deliveries_next_path,
    savings,
    subscriptions_heading,
    subscriptions,
    category_filters: filters,
    action_labels,
    bulk_edit_path: cleanPath(attr(bulk, "data-content")) ?? null,
    recommended_heading: text(recHead) || null,
    recommended,
  };
  return { data, other_sections, meta };
};
