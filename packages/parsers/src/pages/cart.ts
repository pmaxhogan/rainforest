/**
 * Cart page parser (`/gp/cart/view.html`): active line items, the Saved for later list,
 * subtotal, cart-level notices and the empty-cart state.
 *
 * Verified against a real capture for: the saved-for-later list, the empty active cart, the
 * tab captions and the shared line-item markup (`.sc-list-item`, its data attributes, title,
 * price, availability, seller, variation and action controls). NOT verified against real
 * markup (no capture with active items existed when this was written): the active-item
 * quantity control (select, text input or stepper are all tried), the selection checkbox,
 * the subtotal block, the checkout control, cart-level banners and multi-cart groups. Those
 * strategies are marked "unverified" below; the lossless accounting keeps anything they miss
 * visible in `other_sections` or an item's `details`.
 *
 * Never emitted: form tokens, offer ids (`data-encoded-offering`, `data-best-offer-id`,
 * `data-previous-offer-id`), request/session ids, checkout control values.
 */
import type { Capture, OtherSection, ParseResult, Parser } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import {
  Consumption,
  type DomElement,
  type Money,
  attr,
  collapse,
  findMoney,
  firstOf,
  losslessReport,
  moneyFromPriceElement,
  newMeta,
  parseCount,
  parseDocument,
  parseMoney,
  q,
  qa,
  text,
  tryJson,
} from "../index.ts";

export interface CartVariant {
  name: string;
  value: string;
}

export type CartNoticeKind =
  "price_change" | "low_stock" | "unavailable" | "free_shipping" | "important" | "message";

export interface CartNotice {
  kind: CartNoticeKind;
  text: string;
  /** Money amounts quoted in the message (for a price change: usually old then new). */
  amounts?: Money[];
}

export type QuantityControl = "dropdown" | "text" | "stepper" | "none";

export interface CartItem {
  /** Stable per-line identifier the cart page uses for its actions (`data-itemid`). */
  item_id: string;
  list: "active" | "saved";
  /** Which cart the item sits in (for example a grocery cart) when the page splits them. */
  group: string | null;
  asin: string | null;
  title: string | null;
  /** Product link path only: no host, no query string. */
  url_path: string | null;
  /** Seller id from the product link's `smid` parameter. */
  seller_id: string | null;
  image_url: string | null;
  variant: CartVariant[];
  price: Money | null;
  list_price: Money | null;
  /** Savings or discount text shown beside the price ("Save 10%"). */
  savings: string | null;
  /** Other text in the price block (unit price, coupon hints). */
  price_notes: string[];
  quantity: number | null;
  quantity_control: QuantityControl;
  /** Numeric options of a quantity dropdown. */
  quantity_options: number[];
  /** True when the dropdown ends in an open-ended "10+" option (switches to a text input). */
  quantity_open_ended: boolean;
  max_quantity: number | null;
  seller: string | null;
  ships_from: string | null;
  /** Raw sold-by / shipped-from lines. */
  fulfillment: string[];
  condition: string | null;
  delivery: string[];
  /** ISO dates found in delivery lines (only when the line spells out the year). */
  delivery_dates: string[];
  in_stock: boolean | null;
  stock_text: string | null;
  low_stock_count: number | null;
  /** The offer the line was added with is gone (`data-unavailable-item`). */
  offer_unavailable: boolean;
  gift_option: boolean | null;
  gift_wrapped: boolean | null;
  is_prime: boolean;
  subscribe_and_save: boolean;
  subscribe_hints: string[];
  returns: string | null;
  badges: string[];
  notices: CartNotice[];
  /** Selected-for-checkout checkbox (active items only). */
  selected: boolean | null;
  /** Control names the line offers: delete, save-for-later, move-to-cart, add-best-offer, ... */
  actions: string[];
  /** Visible text on the line that no field above accounts for. */
  details: string[];
}

export interface CartSubtotal {
  amount: number;
  currency: string;
  raw: string;
  /** The "(N items)" count in the subtotal label. */
  item_count: number | null;
}

export interface CartPage {
  is_empty: boolean;
  empty_message: string | null;
  active_items: CartItem[];
  saved_items: CartItem[];
  active_count: number;
  saved_count: number;
  /** Sum of active line quantities (null when any quantity is unknown). */
  active_quantity_total: number | null;
  /** The count the Saved for later caption declares (cross-check for saved_count). */
  saved_declared_count: number | null;
  subtotal: CartSubtotal | null;
  notices: CartNotice[];
  /** Distinct cart group names seen on active items. */
  groups: string[];
  /** A visible checkout control exists. Its text and form values are never read. */
  checkout_available: boolean;
}

const HOST = "https://www.example.com";
const FULL_TITLE = ".sc-grid-item-product-title .a-truncate-full, .a-truncate-full";
const TITLE_CELL = ".sc-item-product-title-cont";
const PRICE_BLOCK = ".sc-item-price-block";
const CONTENT_LIST =
  "ul[data-feature-id=sc-item-content-list], [data-feature-id=sc-item-content-list]";
const ACTION_LINKS = ".sc-action-links";
const ALERT_BOX = ".a-alert-inline, .a-alert, [role=alert]";

const PRICE_CHANGE_RE =
  /price[^.]{0,40}(?:changed|dropped|increased|decreased)|updated this item|price change|best offer/i;
const UNAVAILABLE_RE = /no longer available|currently unavailable|out of stock|unavailable/i;
const LOW_STOCK_RE = /only\s+(\d+)\s+left/i;
const FREE_SHIP_RE = /free shipping|free delivery|qualif(?:y|ies) for free/i;

function classifyNotice(t: string): CartNoticeKind {
  if (PRICE_CHANGE_RE.test(t)) return "price_change";
  if (UNAVAILABLE_RE.test(t)) return "unavailable";
  if (LOW_STOCK_RE.test(t)) return "low_stock";
  if (FREE_SHIP_RE.test(t)) return "free_shipping";
  return "message";
}

function makeNotice(kind: CartNoticeKind, t: string): CartNotice {
  const notice: CartNotice = { kind, text: t };
  const amounts = findMoney(t);
  if (amounts.length > 0) notice.amounts = amounts;
  return notice;
}

function pathOnly(href: string | undefined): string | null {
  if (href === undefined || href === "") return null;
  let p: string;
  try {
    p = new URL(href, HOST).pathname;
  } catch {
    p = href.split(/[?#]/)[0] ?? href;
  }
  return p === "" ? null : p;
}

function queryParam(href: string | undefined, name: string): string | null {
  if (href === undefined) return null;
  try {
    return new URL(href, HOST).searchParams.get(name);
  } catch {
    return null;
  }
}

function isoFromText(s: string): string[] {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const out: string[] = [];
  for (const m of s.matchAll(/\b([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})\b/g)) {
    const idx = months.findIndex((n) => n.startsWith((m[1] ?? "").toLowerCase().slice(0, 3)));
    if (idx < 0) continue;
    const mm = String(idx + 1).padStart(2, "0");
    out.push(`${m[3]}-${mm}-${String(m[2]).padStart(2, "0")}`);
  }
  return out;
}

function numAttr(el: DomElement | undefined, name: string): number | null {
  const v = attr(el, name);
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True if `el` is `anc` or inside it. */
function isWithin(el: DomElement, anc: DomElement | undefined): boolean {
  for (let cur: DomElement | null = el; cur != null; cur = cur.parentElement) {
    if (cur === anc) return true;
  }
  return false;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

/** Text of `el` skipping consumed elements (and the truncated twin of a title). */
function cleanText(el: DomElement | null | undefined, cons: Consumption): string {
  return text(el, { exclude: (e) => cons.has(e) });
}

/** Elements matching the selector that are not inside another match (outermost only). */
function outermost(root: DomElement, selector: string): DomElement[] {
  const all = qa(root, selector);
  const set = new Set(all);
  return all.filter((el) => {
    for (let cur = el.parentElement; cur != null && cur !== root; cur = cur.parentElement) {
      if (set.has(cur)) return false;
    }
    return true;
  });
}

export interface Segment {
  el: DomElement;
  text: string;
}

/**
 * Finest text-bearing pieces under `root` that are not consumed: wrappers that only hold
 * several text-bearing children are descended into, anything else is one segment.
 */
function segments(root: DomElement, cons: Consumption): Segment[] {
  const out: Segment[] = [];
  const visit = (el: DomElement): void => {
    if (cons.covers(el)) return;
    const full = cleanText(el, cons);
    if (full === "") return;
    const kids = Array.from(el.children).filter(
      (k) => !cons.covers(k) && cleanText(k, cons) !== "",
    );
    const own = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && collapse(n.textContent ?? "") !== "",
    );
    if (!own && kids.length > 0) {
      for (const k of kids) visit(k);
      return;
    }
    out.push({ el, text: full });
  };
  for (const k of Array.from(root.children)) visit(k);
  const loose = Array.from(root.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => collapse(n.textContent ?? ""))
    .filter((t) => t !== "");
  for (const t of loose) out.push({ el: root, text: t });
  return out;
}

// ---- line items

interface ItemContext {
  meta: ReturnType<typeof newMeta>;
  cons: Consumption;
  missing: Record<string, number>;
}

function itemIdOf(item: DomElement, ctx: ItemContext): string | undefined {
  return firstOf<string>(
    "item.item_id",
    [
      ["data-attr", () => attr(item, "data-itemid")],
      ["element-id", () => /^sc-(?:item|saved|active)-(.+)$/.exec(item.id)?.[1] ?? undefined],
      [
        "action-json",
        () => {
          const holder = item.querySelector("[data-sc-item-action]");
          const json = tryJson(attr(holder ?? undefined, "data-sc-item-action"));
          const id = (json as { itemID?: unknown } | null)?.itemID;
          return typeof id === "string" ? id : undefined;
        },
      ],
      [
        "input-name",
        () => {
          for (const input of Array.from(item.querySelectorAll("input[name^='submit.']"))) {
            const parts = (input.getAttribute("name") ?? "").split(".");
            if (parts.length >= 3) return parts.slice(2).join(".");
          }
          return undefined;
        },
      ],
    ],
    ctx.meta,
    { optional: true },
  );
}

function listOf(item: DomElement): "active" | "saved" {
  const t = attr(item, "data-itemtype")?.toLowerCase();
  if (t === "saved") return "saved";
  if (t === "active") return "active";
  return item.closest("#sc-saved-cart, [data-listtype=saved-for-later]") !== null
    ? "saved"
    : "active";
}

function groupOf(item: DomElement): string | null {
  for (let cur = item.parentElement; cur != null; cur = cur.parentElement) {
    const explicit = attr(cur, "data-cart-name") ?? attr(cur, "data-carttype");
    if (explicit !== undefined && explicit !== "") return explicit;
    const id = cur.id;
    if (
      /^sc-.+-cart$/.test(id) &&
      !["sc-active-cart", "sc-saved-cart", "sc-retail-cart"].includes(id)
    ) {
      const heading = q(cur, ".sc-cart-header h2, h2, h3");
      const name = text(heading);
      return name !== "" ? name : id;
    }
  }
  return null;
}

function parseVariants(item: DomElement, cons: Consumption): CartVariant[] {
  const out: CartVariant[] = [];
  for (const li of qa(item, ".sc-product-variation")) {
    const label = q(li, ".a-text-bold");
    let name = text(label).replace(/\s*:\s*$/, "");
    let value = "";
    if (label !== undefined) {
      value = text(li, { exclude: (e) => e === label }).replace(/^\s*:\s*/, "");
    } else {
      const m = /^([^:]+):\s*(.*)$/.exec(text(li));
      if (m !== null) {
        name = (m[1] ?? "").trim();
        value = (m[2] ?? "").trim();
      }
    }
    if (name !== "" || value !== "") out.push({ name, value });
    cons.take(li);
  }
  return out;
}

interface QuantityInfo {
  quantity: number | null;
  control: QuantityControl;
  options: number[];
  openEnded: boolean;
  max: number | null;
}

function parseQuantity(item: DomElement, ctx: ItemContext): QuantityInfo {
  // Controls are form data, not text: read them from the raw DOM (a native <select> is often
  // visually hidden behind its styled replacement).
  const select = item.querySelector("select[name^='quantity'], select[data-action*='quantity']");
  const input = item.querySelector(
    "input[name='quantityBox'], input[name^='quantity'], input.sc-quantity-textfield, input[aria-label*='uantity']",
  );
  const stepper = q(item, "[data-a-selector='value'], .sc-quantity-stepper-value");
  const container =
    q(item, ".sc-action-quantity") ??
    (select ?? input ?? stepper)?.closest(
      ".a-dropdown-container, .a-declarative, .a-spinner-wrapper",
    ) ??
    undefined;
  if (container !== undefined) ctx.cons.take(container);

  const options: number[] = [];
  let openEnded = false;
  let max: number | null = null;
  let control: QuantityControl = "none";
  if (select !== null) {
    control = "dropdown";
    for (const opt of Array.from(select.querySelectorAll("option"))) {
      const label = collapse(opt.textContent ?? "");
      const raw = opt.getAttribute("value") ?? label;
      const n = Number(raw);
      if (/\+\s*$/.test(label)) openEnded = true;
      if (Number.isFinite(n) && n > 0) options.push(n);
    }
    if (!openEnded && options.length > 0) max = Math.max(...options);
  } else if (input !== null) {
    control = "text";
    max = numAttr(input, "max") ?? numAttr(input, "data-max");
  } else if (stepper !== undefined) {
    control = "stepper";
    const stepperRoot = stepper.closest(".sc-action-quantity, .a-spinner-wrapper");
    max = numAttr(stepperRoot ?? undefined, "data-max");
  }

  const quantity =
    firstOf<number>(
      "item.quantity",
      [
        [
          "select",
          () => {
            if (select === null) return undefined;
            const chosen =
              select.querySelector("option[selected]") ??
              Array.from(select.querySelectorAll("option"))[0];
            const n = Number(chosen?.getAttribute("value") ?? collapse(chosen?.textContent ?? ""));
            return Number.isFinite(n) && n > 0 ? n : undefined;
          },
        ],
        [
          "text-input",
          () => {
            const n = Number(attr(input ?? undefined, "value"));
            return Number.isFinite(n) && n > 0 ? n : undefined;
          },
        ],
        ["stepper", () => parseCount(text(stepper)) ?? undefined],
        [
          "label",
          () => {
            const m = /(?:qty|quantity)\s*:?\s*(\d+)/i.exec(text(q(item, ".a-dropdown-prompt")));
            return m === null ? undefined : Number(m[1]);
          },
        ],
        ["data-attr", () => numAttr(item, "data-quantity") ?? undefined],
      ],
      ctx.meta,
      { optional: true },
    ) ?? null;
  return { quantity, control, options: uniq(options), openEnded, max };
}

function parsePrice(
  item: DomElement,
  ctx: ItemContext,
): { price: Money | null; list: Money | null; savings: string | null; notes: string[] } {
  const block = q(item, PRICE_BLOCK);
  const { cons } = ctx;
  let listEl: DomElement | undefined;
  let payEl: DomElement | undefined;
  if (block !== undefined) {
    listEl = q(
      block,
      ".a-price.a-text-price, .sc-list-price, .a-text-strike, [data-a-strike='true']",
    );
    payEl =
      q(block, ".apex-price-to-pay-value") ??
      q(block, ".sc-badge-price-to-pay .sc-price, .sc-badge-price-to-pay") ??
      qa(block, ".a-price").find((e) => !isWithin(e, listEl)) ??
      qa(block, ".sc-price").find((e) => !isWithin(e, listEl));
  }
  const price =
    firstOf<Money>(
      "item.price",
      [
        ["price-element", () => moneyFromPriceElement(payEl)],
        ["price-text", () => parseMoney(text(payEl))],
        ["block-text", () => parseMoney(text(block, { exclude: (e) => e === listEl }))],
        [
          "data-attr",
          () => {
            const v = attr(item, "data-price") ?? attr(item, "data-displayprice");
            const n = Number(v);
            if (v === undefined || v === "" || !Number.isFinite(n)) return undefined;
            return { amount: n, currency: "USD", raw: v };
          },
        ],
      ],
      ctx.meta,
      { optional: true },
    ) ?? null;
  const list = listEl === undefined ? null : (moneyFromPriceElement(listEl) ?? null);
  cons.take(payEl);
  cons.take(listEl);
  // Anything else in the price block: savings text first, then plain notes.
  const notes: string[] = [];
  let savings: string | null = null;
  if (block !== undefined) {
    for (const seg of segments(block, cons)) {
      if (savings === null && /save|off\b|%|discount|coupon/i.test(seg.text)) savings = seg.text;
      else notes.push(seg.text);
      cons.take(seg.el);
    }
  }
  return { price, list, savings, notes: uniq(notes) };
}

function actionsOf(item: DomElement, links: DomElement | undefined): string[] {
  const out: string[] = [];
  for (const el of Array.from(item.querySelectorAll("[data-action]"))) {
    const a = el.getAttribute("data-action");
    if (a === null || a === "" || !el.matches("input, button, a")) continue;
    out.push(a);
  }
  for (const el of Array.from(item.querySelectorAll("[data-sc-item-action]"))) {
    const json = tryJson(el.getAttribute("data-sc-item-action"));
    const a = (json as { action?: unknown } | null)?.action;
    if (typeof a === "string") out.push(a);
  }
  if (links === undefined) return uniq(out);
  for (const input of Array.from(links.querySelectorAll("input[name^='submit.']"))) {
    const parts = (input.getAttribute("name") ?? "").split(".");
    if (parts.length >= 3 && parts[1] !== undefined) out.push(parts[1]);
  }
  return uniq(out);
}

function parseItem(item: DomElement, ctx: ItemContext): CartItem | undefined {
  const { cons, meta } = ctx;
  const itemId = itemIdOf(item, ctx);
  if (itemId === undefined) {
    ctx.missing["item_id"] = (ctx.missing["item_id"] ?? 0) + 1;
    return undefined;
  }

  // Title and link.
  const titleCell = q(item, TITLE_CELL);
  const link =
    q(item, "a.sc-product-title, a.sc-product-link.sc-product-title") ??
    q(titleCell, "a[href]") ??
    q(item, ".sc-image-wrap a[href], a.sc-product-link[href]");
  const title =
    firstOf<string>(
      "item.title",
      [
        ["full-title", () => text(q(item, FULL_TITLE))],
        [
          "title-link",
          () =>
            text(link, {
              exclude: (e) => (e.getAttribute("class") ?? "").includes("a-truncate-cut"),
            }),
        ],
        ["truncated", () => text(q(item, ".a-truncate-cut"))],
        ["data-attr", () => attr(item, "data-producttitle")],
        ["image-alt", () => attr(q(item, "img.sc-product-image"), "alt")],
      ],
      meta,
      { optional: true },
    ) ?? null;
  cons.take(titleCell);
  const href = attr(link, "href");

  const asin =
    firstOf<string>(
      "item.asin",
      [
        ["data-attr", () => attr(item, "data-asin")],
        [
          "csa-item-id",
          () => /^amzn1\.asin\.([A-Z0-9]{10})$/.exec(attr(item, "data-csa-c-item-id") ?? "")?.[1],
        ],
        [
          "link",
          () => /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(pathOnly(href) ?? "")?.[1],
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;

  const imageEl = q(item, "img.sc-product-image, .sc-image-wrap img");
  const imageWrap = q(item, ".sc-image-wrap");
  cons.take(imageWrap);
  const imageSrc = attr(imageEl, "src");

  const { price, list, savings, notes } = parsePrice(item, ctx);
  const variant = parseVariants(item, cons);
  const qty = parseQuantity(item, ctx);

  // Availability and stock.
  const availEls = qa(item, "[data-csa-c-content-id='availability'], .sc-product-availability");
  const availEl = availEls[0];
  const stockText = availEl === undefined ? null : text(availEl) || null;
  cons.takeAll(availEls);
  const scarcity = q(item, ".sc-product-scarcity");
  const lowStockMatch = LOW_STOCK_RE.exec(text(scarcity) || stockText || "");
  const notices: CartNotice[] = [];
  if (scarcity !== undefined && text(scarcity) !== "") {
    notices.push(makeNotice("low_stock", text(scarcity)));
  } else if (lowStockMatch !== null && stockText !== null) {
    notices.push(makeNotice("low_stock", stockText));
  }
  const outOfStockAttr = attr(item, "data-outofstock");
  const inStock = firstOf<boolean>(
    "item.in_stock",
    [
      ["data-attr", () => (outOfStockAttr === "1" ? false : undefined)],
      ["text", () => (stockText !== null && UNAVAILABLE_RE.test(stockText) ? false : undefined)],
      [
        "text-in-stock",
        () => (stockText !== null && /in stock|only \d+ left/i.test(stockText) ? true : undefined),
      ],
      ["data-attr-ok", () => (outOfStockAttr === "0" ? true : undefined)],
    ],
    meta,
    { optional: true },
  );

  // Seller and fulfillment.
  const sellerEls = qa(item, ".sc-seller, [data-csa-c-content-id='seller'] .a-size-small");
  const fulfillment: string[] = [];
  let seller: string | null = null;
  let shipsFrom: string | null = null;
  for (const el of sellerEls) {
    const raw = text(el);
    if (raw === "") continue;
    fulfillment.push(raw);
    const linkEl = q(el, "a");
    const label = text(el, { exclude: (e) => e === linkEl }).replace(/\s*:\s*$/, "");
    const value = linkEl !== undefined ? text(linkEl) : raw.replace(/^[^:]*:\s*/, "");
    if (/ships?(?:ped)? from|fulfilled/i.test(label)) shipsFrom ??= value;
    else seller ??= value;
    cons.take(el);
  }
  const sellerBlock = q(item, "[data-csa-c-content-id='seller']");
  cons.take(sellerBlock);
  if (seller === null && shipsFrom !== null) seller = shipsFrom;

  // Delivery, returns, prime.
  const returnsEl = q(item, ".sc-free-returns");
  const returns = returnsEl === undefined ? null : text(returnsEl).replace(/^&\s*/, "") || null;
  cons.take(returnsEl);
  const deliveryEls = outermost(
    item,
    ".sc-delivery-messaging, [data-csa-c-content-id*='delivery-block'], [data-csa-c-content-id='delivery-message']",
  );
  const delivery: string[] = [];
  let isPrime = attr(item, "data-isprimeasin") === "1";
  for (const el of deliveryEls) {
    if (q(el, ".a-icon-prime") !== undefined) isPrime = true;
    const t = cleanText(el, cons);
    if (t !== "") delivery.push(t);
    cons.take(el);
  }
  if (!isPrime && q(item, ".a-icon-prime") !== undefined) isPrime = true;
  const deliveryDates = uniq(delivery.flatMap(isoFromText));

  // Badges, condition, gift, subscribe and save.
  const badgeEls = qa(item, "[data-csa-c-content-id='product-insights-badge']");
  const badges = badgeEls.map((e) => text(e)).filter((t) => t !== "");
  cons.takeAll(badgeEls);

  const condEl = q(item, "[class*='condition']");
  let condition: string | null = null;
  if (condEl !== undefined) {
    condition = text(condEl).replace(/^condition\s*:?\s*/i, "") || null;
    cons.take(condEl);
  }

  const giftAttr = attr(item, "data-giftable");
  const giftEls = qa(item, ".sc-gift-option, [class*='gift-option'], [class*='gift-checkbox']");
  const giftOption =
    firstOf<boolean>(
      "item.gift_option",
      [
        ["data-attr", () => (giftAttr === "1" ? true : giftAttr === "0" ? false : undefined)],
        ["element", () => (giftEls.length > 0 ? true : undefined)],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const giftWrappedAttr = attr(item, "data-giftwrapped");
  const giftWrapped = giftWrappedAttr === "1" ? true : giftWrappedAttr === "0" ? false : null;
  cons.takeAll(giftEls);

  const subEls = outermost(
    item,
    "[data-csa-c-content-id*='subscribe'], [class*='subscribe'], [class*='sns-']",
  );
  const subscribeHints = subEls.map((e) => cleanText(e, cons)).filter((t) => t !== "");
  cons.takeAll(subEls);
  let subscribe = subscribeHints.length > 0;
  if (!subscribe) {
    const m = /subscribe\s*(?:&|and)\s*save|delivery every/i.exec(text(q(item, CONTENT_LIST)));
    if (m !== null) subscribe = true;
  }

  // Alert boxes inside the line (price change, important messages).
  for (const box of outermost(item, ALERT_BOX)) {
    if (cons.covers(box)) continue;
    const t = cleanText(box, cons);
    if (t === "") continue;
    notices.push(makeNotice(classifyNotice(t), t));
    cons.take(box);
  }
  const bwm = qa(item, "[data-csa-c-content-id='buybox-winner-message']");
  cons.takeAll(bwm);

  // Selection checkbox and gift/other checkboxes.
  const boxes = Array.from(item.querySelectorAll("input[type='checkbox']"));
  const selBox = boxes.find(
    (b) =>
      !/gift/i.test(`${b.getAttribute("name") ?? ""} ${b.id} ${b.getAttribute("class") ?? ""}`),
  );
  const selected =
    selBox === undefined
      ? null
      : selBox.hasAttribute("checked") || selBox.getAttribute("aria-checked") === "true";

  // Controls.
  const links = q(item, ACTION_LINKS);
  const actions = actionsOf(item, links);
  cons.take(links);

  // Leftover text on the line, block by block, so nothing is silently dropped.
  const details: string[] = [];
  const contentList = q(item, CONTENT_LIST);
  const blocks: DomElement[] = [];
  if (contentList !== undefined) {
    for (const child of Array.from(contentList.children)) {
      if (child.matches(".sc-grid-content-tail")) blocks.push(...Array.from(child.children));
      else blocks.push(child);
    }
  }
  const blockSet = new Set(blocks);
  for (const block of blocks) {
    if (cons.covers(block)) continue;
    for (const seg of segments(block, cons)) {
      const kind = classifyNotice(seg.text);
      if (kind !== "message") notices.push(makeNotice(kind, seg.text));
      else details.push(seg.text);
    }
  }
  const rest = text(item, { exclude: (e) => cons.has(e) || blockSet.has(e) });
  if (rest !== "") details.push(rest);
  cons.take(item);

  const seen = new Set<string>();
  const dedupedNotices = notices.filter((n) => {
    const key = `${n.kind}|${n.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const list_ = listOf(item);
  return {
    item_id: itemId,
    list: list_,
    group: list_ === "active" ? groupOf(item) : null,
    asin,
    title,
    url_path: pathOnly(href),
    seller_id: queryParam(href, "smid"),
    image_url: imageSrc ?? null,
    variant,
    price,
    list_price: list,
    savings,
    price_notes: notes,
    quantity: qty.quantity,
    quantity_control: qty.control,
    quantity_options: qty.options,
    quantity_open_ended: qty.openEnded,
    max_quantity: qty.max,
    seller,
    ships_from: shipsFrom,
    fulfillment,
    condition,
    delivery,
    delivery_dates: deliveryDates,
    in_stock: inStock ?? null,
    stock_text: stockText,
    low_stock_count: lowStockMatch === null ? null : Number(lowStockMatch[1]),
    offer_unavailable: attr(item, "data-unavailable-item") === "1",
    gift_option: giftOption,
    gift_wrapped: giftWrapped,
    is_prime: isPrime,
    subscribe_and_save: subscribe,
    subscribe_hints: subscribeHints,
    returns,
    badges,
    notices: dedupedNotices,
    selected: list_ === "active" ? selected : null,
    actions,
    details,
  };
}

// ---- page level

function parseSubtotal(
  root: DomElement,
  cons: Consumption,
  meta: ReturnType<typeof newMeta>,
): CartSubtotal | undefined {
  return firstOf<CartSubtotal>(
    "subtotal",
    [
      [
        // unverified against a real active cart
        "id",
        () => {
          const label = q(root, "#sc-subtotal-label-activecart, #sc-subtotal-label-buybox");
          const amountEl = q(
            root,
            "#sc-subtotal-amount-activecart .sc-price, #sc-subtotal-amount-buybox .sc-price, #sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox",
          );
          const money = parseMoney(text(amountEl));
          if (money === undefined) return undefined;
          cons.take(label);
          cons.take(amountEl?.closest("[id^='sc-subtotal-amount']") ?? amountEl);
          return {
            ...money,
            item_count: parseCount(/\((\d[\d,]*)\s*items?\)/i.exec(text(label))?.[1]) ?? null,
          };
        },
      ],
      [
        "text-anchor",
        () => {
          const scopes = qa(root, "#sc-buy-box, [class*='subtotal'], [id*='subtotal']");
          for (const scope of scopes) {
            const t = text(scope);
            const m =
              /subtotal\s*\((\d[\d,]*)\s*items?\)\s*:?\s*(\S*\$\s*[\d,]+(?:\.\d{1,2})?)/i.exec(t);
            if (m === null) continue;
            const money = parseMoney(m[2]);
            if (money === undefined) continue;
            // Consume the tightest element carrying the anchor, never the whole buy box.
            const tight = qa(scope, "*").find(
              (e) => /subtotal/i.test(text(e)) && text(e).length < 120,
            );
            cons.take(tight ?? (scope.id === "sc-buy-box" ? undefined : scope));
            return { ...money, item_count: parseCount(m[1]) ?? null };
          }
          return undefined;
        },
      ],
    ],
    meta,
    { optional: true },
  );
}

function parseCartNotices(root: DomElement, cons: Consumption): CartNotice[] {
  const out: CartNotice[] = [];
  const selectors = [
    "#cart-important-message-box",
    "#enforcement-banner-widget",
    "#sc-important-message",
    "[data-name='Important Messages']",
    "#sc-price-change-banner",
    "#sc-buy-box .a-alert-content",
    "#sc-buy-box [id*='free-shipping'], #sc-buy-box [id*='freeShipping']",
  ];
  const seen = new Set<DomElement>();
  for (const sel of selectors) {
    for (const el of qa(root, sel)) {
      if (el.closest(".sc-list-item") !== null || seen.has(el)) continue;
      const t = text(el);
      if (t === "") continue;
      seen.add(el);
      const kind: CartNoticeKind =
        sel.includes("important") || sel.includes("Important") || sel.includes("enforcement")
          ? "important"
          : classifyNotice(t);
      out.push(makeNotice(kind, t));
      cons.take(el);
    }
  }
  // Alert boxes in the active cart card but outside any line item.
  for (const box of outermost(
    root,
    "#sc-active-cart .a-alert-inline, #sc-active-cart [role=alert]",
  )) {
    if (box.closest(".sc-list-item") !== null || cons.covers(box)) continue;
    const t = text(box);
    if (t === "") continue;
    out.push(makeNotice(classifyNotice(t), t));
    cons.take(box);
  }
  return out;
}

export const parseCart: Parser<CartPage> = (capture: Capture): ParseResult<CartPage> => {
  const meta = newMeta();
  const cons = new Consumption();
  const doc = parseDocument(capture.html);
  const root = q(doc, "#sc-page-content") ?? q(doc, "[role=main]") ?? q(doc, "#a-page") ?? doc.body;

  const hasActiveCart = q(doc, "#sc-active-cart, #sc-retail-cart-container") !== undefined;
  const hasSavedCart = q(doc, "#sc-saved-cart, #sc-saved-cart-items") !== undefined;
  const emptyEl = q(doc, ".sc-empty-cart, [data-name='Empty Cart']");

  // Line items.
  const found =
    firstOf<DomElement[]>(
      "items",
      [
        ["data-itemid", () => qa(root, ".sc-list-item[data-itemid], [data-itemid][data-asin]")],
        ["sc-list-item", () => qa(root, ".sc-list-item")],
        [
          "list-body",
          () => qa(root, ".sc-list-body > [data-asin], #sc-saved-cart-items > [data-asin]"),
        ],
      ],
      meta,
      { optional: true },
    ) ?? [];

  if (!hasActiveCart && !hasSavedCart && found.length === 0 && emptyEl === undefined) {
    throw new RfError(
      "layout_unrecognized",
      "cart page: no cart container, line item or empty-cart marker",
    );
  }

  const ctx: ItemContext = { meta, cons, missing: {} };
  const active: CartItem[] = [];
  const saved: CartItem[] = [];
  const seenIds = new Set<string>();
  for (const el of found) {
    const item = parseItem(el, ctx);
    if (item === undefined) continue;
    const key = `${item.list}:${item.item_id}`;
    if (seenIds.has(key)) {
      meta.warnings.push("cart: duplicate item id skipped");
      continue;
    }
    seenIds.add(key);
    (item.list === "saved" ? saved : active).push(item);
  }
  for (const [field, n] of Object.entries(ctx.missing)) {
    meta.warnings.push(`cart: ${n} line item(s) without ${field} skipped`);
  }
  const incomplete = [...active, ...saved].filter(
    (i) => i.title === null || i.asin === null,
  ).length;
  if (incomplete > 0) meta.warnings.push(`cart: ${incomplete} line item(s) missing title or asin`);

  // Empty state.
  const emptyHeading =
    q(doc, "#sc-active-cart .sc-your-amazon-cart-is-empty, #sc-active-cart h3") ??
    q(doc, ".sc-your-amazon-cart-is-empty");
  const emptyMessage = emptyHeading === undefined ? null : text(emptyHeading) || null;
  if (emptyMessage !== null) cons.take(emptyHeading);
  cons.take(emptyEl);
  const isEmptyMarker = firstOf<boolean>(
    "is_empty",
    [
      ["empty-marker", () => (emptyEl !== undefined ? true : undefined)],
      [
        "data-attr",
        () => {
          const n = numAttr(q(doc, "#sc-active-cart"), "data-cart-total-item-count");
          return n === 0 ? true : undefined;
        },
      ],
      ["item-count", () => (hasActiveCart && active.length === 0 ? true : undefined)],
    ],
    meta,
    { optional: true },
  );
  if (active.length > 0 && isEmptyMarker === true) {
    meta.warnings.push("cart: empty-cart marker present alongside active items");
  }
  const isEmpty = active.length === 0;

  // Saved caption and headings (fixed UI labels).
  const caption = q(doc, "#sc-saved-cart-list-caption-text");
  const savedDeclared =
    firstOf<number>(
      "saved_declared_count",
      [
        ["data-attr", () => numAttr(caption, "data-saved-item-quantity") ?? undefined],
        [
          "label",
          () => {
            const m = /saved for later\s*\((\d[\d,]*)\s*items?\)/i.exec(
              text(q(doc, "#sc-secondary-list")),
            );
            return m === null ? undefined : parseCount(m[1]);
          },
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;
  if (savedDeclared !== null && savedDeclared !== saved.length) {
    meta.warnings.push(
      `cart: saved caption declares ${savedDeclared} item(s) but ${saved.length} were parsed`,
    );
  }
  cons.take(q(doc, "#sc-secondary-list-tab"));
  cons.takeAll(qa(doc, "#sc-secondary-list .sc-list-head"));
  cons.takeAll(qa(doc, "#sc-active-items-header"));

  const subtotal = parseSubtotal(root, cons, meta);
  const notices = parseCartNotices(root, cons);

  const checkoutEls = qa(
    root,
    "[name='proceedToRetailCheckout'], #sc-buy-box-ptc-button, [data-feature-id='proceed-to-checkout-action']",
  );
  cons.takeAll(checkoutEls);

  const quantities = active.map((i) => i.quantity);
  const total = quantities.every((n): n is number => n !== null)
    ? quantities.reduce((a, b) => a + b, 0)
    : null;
  const groups = uniq(active.map((i) => i.group).filter((g): g is string => g !== null));

  const report = losslessReport(doc, cons, { root });
  meta.unparsed_text_chars = report.counts.unparsed;
  const other: OtherSection[] = report.sections;

  return {
    data: {
      is_empty: isEmpty,
      empty_message: emptyMessage,
      active_items: active,
      saved_items: saved,
      active_count: active.length,
      saved_count: saved.length,
      active_quantity_total: active.length === 0 ? 0 : total,
      saved_declared_count: savedDeclared,
      subtotal: subtotal ?? null,
      notices,
      groups,
      checkout_available: checkoutEls.length > 0,
    },
    other_sections: other,
    meta,
  };
};
