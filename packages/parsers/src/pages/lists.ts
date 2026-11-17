/**
 * Lists pages: the owner's lists (`list_lists`) and the items on one list (`get_list`).
 *
 * Both captures share one layout: `/hz/wishlist/ls[/<id>]` renders the left navigation of
 * every list (`#your-lists-nav`) next to the selected list (`#list-header`, `#control-bar`,
 * `#g-items`). `/hz/wishlist/intro` is the marketing page shown when there is no list pane;
 * it parses to an empty list of lists.
 *
 * Data that the capture pass marks `data-rf-hidden` (type=hidden inputs, native `<option>`
 * elements) is read on purpose through the raw DOM; visible text still goes through the
 * framework helpers, so hidden templates never leak into the output.
 *
 * Markup that no capture has shown yet (price drops, offer hints, stock text, a visible
 * comment / quantity / priority row, a shared-with-me list, a nav item count, a list
 * description) is read through text anchors and the element ids of the hidden row templates;
 * those strategies are reported in `meta.strategies` under their own names.
 */
import { RfError } from "@rainforest/core";
import type { Capture, OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import { harvestBlobs, tryJson } from "../blobs.ts";
import {
  type DomDocument,
  type DomElement,
  type DomRoot,
  type Link,
  type Money,
  type Rating,
  attr,
  collapse,
  links,
  moneyFromPriceElement,
  parseCapture,
  parseCount,
  parseMoney,
  parseRating,
  q,
  qa,
  ratingFromClass,
  text,
} from "../dom.ts";
import { Consumption, DEFAULT_BLOCK_SELECTOR, losslessReport } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";

// ---- types

export type ListPrivacy = "private" | "shared" | "public" | "unknown";
export type ListKind = "wish_list" | "shopping_list" | "idea_list" | "registry" | "unknown";

/** One entry of the left navigation. */
export interface ListSummary {
  /** The id in `/hz/wishlist/ls/<ID>` (or the `externalId` of an Alexa list link). */
  list_id: string;
  name: string;
  privacy: ListPrivacy;
  /** The privacy text as shown ("Private"). */
  privacy_text?: string;
  is_default: boolean;
  list_kind: ListKind;
  /** Link target without the query string. */
  url_path?: string;
  /** True for the list the right pane shows. */
  selected: boolean;
  /** Only when the navigation shows a count (the captured page does not). */
  item_count?: number;
  /** The secondary line under the name, raw ("Default List"). */
  label?: string;
  /** True for a list somebody else shared with the owner. */
  shared_with_me: boolean;
  /** Owner name from the secondary line of a shared-with-me entry. */
  owner?: string;
  /** Heading of the navigation group the entry sits under, if any. */
  section?: string;
}

export interface ListTab {
  label: string;
  href?: string;
  active: boolean;
}

export interface ControlOption {
  value: string;
  label: string;
  selected: boolean;
}

/** The "Show" (filter) and "Sort by" dropdowns. */
export interface ListControl {
  /** Query parameter name the dropdown drives (`filter`, `sort`). */
  param: string;
  label: string;
  selected_value?: string;
  selected_label?: string;
  options: ControlOption[];
}

export interface ListHeader {
  list_id?: string;
  name?: string;
  privacy: ListPrivacy;
  privacy_text?: string;
  /** Raw list type from the page state ("WishList"). */
  list_type_raw?: string;
  list_kind: ListKind;
  is_shared?: boolean;
  description?: string;
  /** Count shown in the header text ("12 items"); the captured page shows none. */
  item_count?: number;
  /** The hidden `viewItemCount` input: items in the current view as rendered so far. */
  view_item_count?: number;
  collaborator_count?: number;
  can_add_item: boolean;
  can_invite: boolean;
  /** Visible header text no field above accounts for. */
  extra_text?: string[];
}

export interface PriceDrop {
  raw: string;
  percent?: number;
  amount?: Money;
  was?: Money;
  since_added: boolean;
}

export interface OfferHint {
  raw: string;
  count?: number;
  from?: Money;
}

export interface ListItem {
  /** The stable per-item id the page uses for item actions (`data-itemid`, `itemId=`). */
  item_id: string;
  /** 1-based position in page order. */
  position: number;
  /** "page" or the name of the capture fragment the item came from. */
  source: string;
  asin?: string;
  /** Raw `ASIN:<asin>|<marketplace>` the page passes to item actions. */
  external_id?: string;
  title?: string;
  url_path?: string;
  image_url?: string;
  /** Byline without the leading "by". */
  byline?: string;
  brand?: string;
  /** Trailing parenthetical of the byline ("Toy", "Author"). */
  byline_qualifier?: string;
  price?: Money;
  price_high?: Money;
  /** Finite `data-price` attribute, kept apart because it can exist without a visible price. */
  price_hint?: number;
  price_drop?: PriceDrop;
  unit_price?: string;
  added?: { raw: string; iso?: string };
  quantity_wanted?: number;
  quantity_has?: number;
  priority?: string;
  comment?: string;
  availability?: string;
  offers?: OfferHint;
  rating?: Rating;
  review_count?: number;
  prime: boolean;
  delivery_text?: string;
  shipping_fee?: Money;
  is_purchased: boolean;
  purchased_text?: string;
  /** Label of the primary button ("Add to Cart", "See all buying options"). */
  primary_action?: string;
  can_add_to_cart: boolean;
  /** Labels of every visible button on the item, in order. */
  actions: string[];
  /** Visible item text no field above accounts for. */
  extra_text?: string[];
}

export interface ListPagination {
  /** Hidden `itemsRenderedSoFar`: items rendered so far, not a list total. */
  items_rendered?: number;
  /** Inferred: a non-empty `lastEvaluatedKey`; false at the end-of-list marker. */
  has_more: boolean;
  end_of_list: boolean;
  /** Opaque token for the next page (the `lastEvaluatedKey` value). */
  next_token?: string;
  /** Path template the page uses to load more items; its `paginationToken=` is empty. */
  more_url_template?: string;
}

export interface ListPage {
  list: ListHeader;
  /** Every list of the left navigation (empty on a page without one). */
  nav_lists: ListSummary[];
  filter?: ListControl;
  sort?: ListControl;
  /** "list" or "grid", from the active view switcher. */
  view?: string;
  has_search: boolean;
  items: ListItem[];
  pagination: ListPagination;
  is_empty: boolean;
  /** Visible control-bar text no field above accounts for. */
  extra_text?: string[];
}

export interface ListsIndexPage {
  /** "lists" for a page with the navigation, "intro" for the no-lists marketing page. */
  variant: "lists" | "intro";
  lists: ListSummary[];
  selected_list_id?: string;
  /** The list the right pane shows (same shape `get_list` returns). */
  selected_list?: ListPage;
  tabs: ListTab[];
  can_create: boolean;
  /** Path the create-list control opens (no query string). */
  create_list_path?: string;
  help_link?: Link;
}

// ---- small helpers

function rawQa(root: DomRoot | null | undefined, selector: string): DomElement[] {
  if (root == null) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function rawQ(root: DomRoot | null | undefined, selector: string): DomElement | undefined {
  return rawQa(root, selector)[0];
}

/** Value of the first matching input, read through the hidden marker. */
function inputValue(root: DomRoot | null | undefined, selector: string): string | undefined {
  return attr(rawQ(root, selector), "value");
}

function pathOf(href: string): string {
  const m = /^(?:https?:\/\/[^/]+)?([^?#]*)/.exec(href);
  return m?.[1] ?? href;
}

/** Href without scheme/host, the fragment and any `ref` / `ref_` tracking parameter. */
function cleanHref(href: string): string {
  const m = /^(?:https?:\/\/[^/]+)?([^?#]*)(?:\?([^#]*))?/.exec(href);
  const path = m?.[1] ?? href;
  const kept = (m?.[2] ?? "").split("&").filter((p) => p !== "" && !/^ref_?=/.test(p));
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

function jsonAttr(el: DomElement | null | undefined, name: string): Record<string, unknown> {
  const v = tryJson(attr(el, name));
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function bool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === "boolean" ? v : undefined;
}

function idSuffix(el: DomElement | null | undefined, prefix: string): string | undefined {
  const id = el?.id;
  return id !== undefined && id.startsWith(prefix) && id.length > prefix.length
    ? id.slice(prefix.length)
    : undefined;
}

function hasClass(el: DomElement, name: string): boolean {
  return (el.getAttribute("class") ?? "").split(/\s+/).includes(name);
}

const ASIN = /^[A-Z0-9]{10}$/;

const MONTHS: Readonly<Record<string, number>> = {
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

/** "April 21, 2026" -> "2026-04-21". No Date parsing: month names only, validated by calendar. */
export function parseLongDate(s: string | null | undefined): string | undefined {
  if (s == null) return undefined;
  const m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m === null) return undefined;
  const month = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month === undefined || day < 1) return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function privacyOf(raw: string | null | undefined): ListPrivacy {
  const s = (raw ?? "").toLowerCase();
  if (/\bprivate\b/.test(s)) return "private";
  if (/\bshared\b/.test(s)) return "shared";
  if (/\bpublic\b/.test(s)) return "public";
  return "unknown";
}

function kindFromHref(href: string | undefined, typeRaw?: string): ListKind {
  const hint = `${typeRaw ?? ""} ${href ?? ""}`;
  if (/alexa[-_ ]?shopping[-_ ]?list|shopping[-_ ]?list(?!s)/i.test(hint)) return "shopping_list";
  if (/idea/i.test(hint)) return "idea_list";
  if (/registry|baby-reg|wedding/i.test(hint)) return "registry";
  if (/wish[-_ ]?list|\/hz\/wishlist\/ls\//i.test(hint)) return "wish_list";
  return "unknown";
}

function listIdFromHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  const direct = /\/hz\/wishlist\/ls\/([A-Z0-9]{8,16})(?:[/?#]|$)/.exec(href);
  if (direct?.[1] !== undefined) return direct[1];
  const external = /[?&]externalId=([A-Z0-9]{8,16})(?:&|#|$)/.exec(href);
  return external?.[1];
}

/** Element text with consumed elements skipped. */
function residual(el: DomElement | undefined, use: Consumption): string {
  return el === undefined ? "" : text(el, { exclude: (e) => use.has(e) });
}

/** Drop separator-only debris ("·", "|") left between consumed fields. */
function tidy(s: string): string {
  return collapse(s.replace(/(^|\s)[·•|,;:.-]+(?=\s|$)/g, " "));
}

/** Remove the first match of `re` from `s`, returning both. */
function take(s: string, re: RegExp): { match: RegExpExecArray | null; rest: string } {
  const match = re.exec(s);
  if (match === null) return { match: null, rest: s };
  return {
    match,
    rest: collapse(`${s.slice(0, match.index)} ${s.slice(match.index + match[0].length)}`),
  };
}

// ---- navigation

function parseNavEntry(
  entry: DomElement,
  section: string | undefined,
  meta: ParseMeta,
  use: Consumption,
): ListSummary | undefined {
  const anchor =
    entry.localName === "a" ? entry : (q(entry, "a[id^='wl-list-link-']") ?? q(entry, "a[href]"));
  const href = attr(anchor, "href");
  const list_id = firstOf<string>(
    "nav.list_id",
    [
      ["id", () => idSuffix(anchor, "wl-list-link-")],
      ["href", () => listIdFromHref(href)],
      [
        "title-id",
        () => idSuffix(q(entry, "[id^='wl-list-entry-title-']"), "wl-list-entry-title-"),
      ],
    ],
    meta,
  );
  if (list_id === undefined) return undefined;

  const titleEl = q(entry, "[id^='wl-list-entry-title-']") ?? q(entry, ".wl-list-entry-title");
  const name =
    firstOf<string>(
      "nav.name",
      [
        ["id", () => text(titleEl)],
        ["anchor-text", () => text(anchor)],
      ],
      meta,
    ) ?? "";
  use.take(titleEl);

  const privacyEl =
    q(entry, "[id^='wl-list-entry-privacy-']") ?? q(entry, ".wl-list-entry-privacy");
  const privacyText = firstOf<string>("nav.privacy", [["id", () => text(privacyEl)]], meta, {
    optional: true,
  });
  use.take(privacyEl);

  // Second line under the title ("Default List", an owner line for shared lists).
  const rows = qa(entry, ".wl-list-entry-row-wrapper");
  const labelEl = q(entry, "[id='list-default-collaborator-label']") ?? rows[1];
  const label = firstOf<string>("nav.label", [["row", () => text(labelEl)]], meta, {
    optional: true,
  });
  use.take(labelEl);

  const ownerMatch = /^(?:shared by|created by|owned by|list of|owner:?|by)\s+(.+)$/i.exec(
    label ?? "",
  );
  const sharedHeading = /shared with you|friends|shared lists/i.test(section ?? "");
  const count = firstOf<number>(
    "nav.item_count",
    [
      [
        "count-element",
        () => parseCount(text(q(entry, "[id*='entry-count'], [class*='entry-count']"))),
      ],
      [
        "text-anchor",
        () => {
          const m = /(\d[\d,]*)\s+items?\b/i.exec(residual(entry, use));
          return m?.[1] === undefined ? undefined : parseCount(m[1]);
        },
      ],
    ],
    meta,
    { optional: true },
  );

  const summary: ListSummary = {
    list_id,
    name,
    privacy: privacyOf(privacyText),
    is_default: /default list/i.test(label ?? ""),
    list_kind: kindFromHref(href),
    selected: hasClass(entry, "selected"),
    shared_with_me: ownerMatch !== null || sharedHeading,
  };
  if (privacyText !== undefined) summary.privacy_text = privacyText;
  if (href !== undefined) summary.url_path = cleanHref(href);
  if (count !== undefined) summary.item_count = count;
  if (label !== undefined) summary.label = label;
  if (ownerMatch?.[1] !== undefined) summary.owner = collapse(ownerMatch[1]);
  if (section !== undefined) summary.section = section;
  return summary;
}

interface Nav {
  el: DomElement;
  lists: ListSummary[];
  extra: string[];
}

function parseNav(root: DomElement, meta: ParseMeta): Nav | undefined {
  const el = q(root, "#your-lists-nav") ?? q(root, "#left-nav");
  if (el === undefined) return undefined;
  const use = new Consumption();
  const lists: ListSummary[] = [];
  let section: string | undefined;
  const nodes = qa(el, "h1, h2, h3, h4, h5, h6, [role=heading], .wl-list");
  const entries = nodes.filter((n) => hasClass(n, "wl-list"));
  const candidates =
    entries.length > 0 ? nodes : qa(el, "a[id^='wl-list-link-'], a[href*='/hz/wishlist/ls/']");
  for (const node of candidates) {
    if (!hasClass(node, "wl-list") && !node.matches("a")) {
      const heading = text(node);
      if (heading !== "") section = heading;
      use.take(node);
      continue;
    }
    const summary = parseNavEntry(node, section, meta, use);
    if (summary !== undefined) {
      lists.push(summary);
      if (node.matches("a")) use.take(node);
    }
  }
  const leftover = tidy(residual(el, use));
  return { el, lists, extra: leftover === "" ? [] : [leftover] };
}

// ---- header and controls

interface PageState {
  listId?: string;
  listType?: string;
  isShared?: boolean;
}

function parseHeader(
  root: DomElement,
  state: PageState,
  nav: ListSummary[],
  capture: Capture,
  meta: ParseMeta,
  c: Consumption,
): ListHeader {
  const headerEl = q(root, "#list-header");
  const selected = nav.find((l) => l.selected);
  const use = new Consumption();

  const nameEl = q(root, "#profile-list-name");
  const name = firstOf<string>(
    "list.name",
    [
      ["id", () => text(nameEl)],
      ["heading", () => text(q(headerEl, "[role=heading]"))],
      ["nav-selected", () => selected?.name],
    ],
    meta,
  );
  use.take(nameEl);

  const privacyEl = q(root, "#listPrivacy");
  const privacyText = firstOf<string>(
    "list.privacy",
    [
      ["id", () => text(privacyEl)],
      ["nav-selected", () => selected?.privacy_text],
    ],
    meta,
    { optional: true },
  );
  use.take(privacyEl);

  const list_id = firstOf<string>(
    "list.list_id",
    [
      ["hidden-input", () => inputValue(root, "input#listId")],
      ["page-state", () => state.listId],
      ["url", () => listIdFromHref(capture.final_url) ?? listIdFromHref(capture.url)],
      ["nav-selected", () => selected?.list_id],
      ["item-data-id", () => attr(rawQ(root, "li[data-itemid][data-id]"), "data-id")],
    ],
    meta,
    { optional: true },
  );

  const descEl =
    q(root, "#list-description") ??
    q(root, "#wl-list-description") ??
    q(root, ".wl-list-description");
  const description = firstOf<string>("list.description", [["id", () => text(descEl)]], meta, {
    optional: true,
  });
  use.take(descEl);

  const addBtn = q(root, "#wl-ul-add-keyword-button");
  const inviteLink = q(root, "#invite-collaborators-link") ?? q(root, "#inviteAndShare");
  use.take(addBtn);
  use.take(inviteLink);

  const people = q(headerEl, "[aria-label='Manage people']");
  const collaborators = firstOf<number>(
    "list.collaborator_count",
    [["people-icon", () => parseCount(attr(rawQ(people, "img[alt]"), "alt"))]],
    meta,
    { optional: true },
  );
  use.take(people);

  const countText = headerEl === undefined ? "" : residual(headerEl, use);
  const itemCount = firstOf<number>(
    "list.item_count",
    [
      [
        "text-anchor",
        () => {
          const m = /(\d[\d,]*)\s+items?\b/i.exec(countText);
          return m?.[1] === undefined ? undefined : parseCount(m[1]);
        },
      ],
    ],
    meta,
    { optional: true },
  );

  const viewCount = parseCount(inputValue(root, "input#viewItemCount"));
  const typeRaw = state.listType ?? inputValue(root, "#wl-item-search input[name='type']");
  const typeKind = kindFromHref(undefined, typeRaw);
  const headerKind: ListKind =
    typeKind !== "unknown" ? typeKind : (selected?.list_kind ?? "unknown");
  const header: ListHeader = {
    privacy: privacyOf(privacyText),
    list_kind: headerKind,
    can_add_item: addBtn !== undefined,
    can_invite: inviteLink !== undefined,
  };
  if (list_id !== undefined) header.list_id = list_id;
  if (name !== undefined) header.name = name;
  if (privacyText !== undefined) header.privacy_text = privacyText;
  if (typeRaw !== undefined) header.list_type_raw = typeRaw;
  if (state.isShared !== undefined) header.is_shared = state.isShared;
  if (description !== undefined) header.description = description;
  if (itemCount !== undefined) header.item_count = itemCount;
  if (viewCount !== undefined) header.view_item_count = viewCount;
  if (collaborators !== undefined) header.collaborator_count = collaborators;
  const extra = tidy(headerEl === undefined ? "" : residual(headerEl, use));
  // The item-count text is a field of its own; do not repeat it as leftover.
  const leftover =
    itemCount === undefined ? extra : tidy(extra.replace(/\d[\d,]*\s+items?\b/i, " "));
  if (leftover !== "") header.extra_text = [leftover];
  c.take(headerEl);
  return header;
}

function parseControl(
  root: DomElement,
  param: "filter" | "sort",
  ariaLabel: string,
  meta: ParseMeta,
  use: Consumption,
): ListControl | undefined {
  const field = `control.${param}`;
  const options = firstOf<ControlOption[]>(
    `${field}.options`,
    [
      [
        "native-select",
        () =>
          rawQa(root, `select[name='${param}'] option`).map((o) => ({
            value: attr(o, "value") ?? "",
            label: collapse(o.textContent ?? ""),
            selected: o.hasAttribute("selected"),
          })),
      ],
      [
        "dropdown-select",
        () =>
          rawQa(root, `select[aria-label='${ariaLabel}'] option`).map((o) => ({
            value: (attr(o, "value") ?? "").replace(new RegExp(`^${param}\\|`), ""),
            label: collapse(o.textContent ?? ""),
            selected: o.hasAttribute("selected"),
          })),
      ],
    ],
    meta,
    { optional: true },
  );
  const wrapper = qa(root, ".a-dropdown-container").find((d) =>
    new RegExp(`^${param === "sort" ? "sort" : "show"}`, "i").test(text(q(d, ".a-dropdown-label"))),
  );
  const promptLabel = text(q(wrapper, ".a-dropdown-prompt"));
  const label = text(q(wrapper, ".a-dropdown-label")).replace(/:$/, "");
  if (options === undefined && wrapper === undefined) return undefined;
  use.take(wrapper);
  const chosen = options?.find((o) => o.selected);
  const control: ListControl = {
    param,
    label: label || (param === "sort" ? "Sort by" : "Show"),
    options: (options ?? []).filter((o) => o.value !== ""),
  };
  const selectedLabel = promptLabel || chosen?.label;
  if (selectedLabel !== undefined && selectedLabel !== "") control.selected_label = selectedLabel;
  const selectedValue =
    chosen?.value ??
    control.options.find((o) => o.label === selectedLabel)?.value ??
    inputValue(root, `input[name='${param}']`);
  if (selectedValue !== undefined && selectedValue !== "") control.selected_value = selectedValue;
  meta.strategies[`${field}.selected`] =
    chosen !== undefined
      ? "selected-option"
      : promptLabel !== ""
        ? "dropdown-prompt"
        : "hidden-input";
  return control;
}

interface Controls {
  filter?: ListControl;
  sort?: ListControl;
  view?: string;
  has_search: boolean;
  extra: string[];
}

function parseControls(root: DomElement, meta: ParseMeta, c: Consumption): Controls {
  const bar = q(root, "#control-bar");
  const use = new Consumption();
  const out: Controls = { has_search: false, extra: [] };
  if (bar === undefined) return out;
  const filter = parseControl(root, "filter", "Show:", meta, use);
  const sort = parseControl(root, "sort", "Sort by:", meta, use);
  if (filter !== undefined) out.filter = filter;
  if (sort !== undefined) out.sort = sort;
  const search = q(bar, "form#wl-item-search") ?? q(bar, "input[type='search']");
  out.has_search = search !== undefined;
  use.take(search);
  const switchers = qa(bar, "#view-switcher-buttons");
  use.takeAll(switchers);
  const active = q(bar, ".view-switcher-active");
  const view = firstOf<string>(
    "control.view",
    [
      [
        "active-switcher",
        () =>
          active?.id.startsWith("grid")
            ? "grid"
            : active?.id.startsWith("list")
              ? "list"
              : undefined,
      ],
      ["hidden-input", () => inputValue(root, "input[name='viewType']")],
    ],
    meta,
    { optional: true },
  );
  if (view !== undefined) out.view = view;
  const leftover = tidy(residual(bar, use));
  if (leftover !== "") out.extra = [leftover];
  c.take(bar);
  return out;
}

// ---- items

const PRICE_DROP =
  /Price dropped(?: by)?\s*(?:(\d+(?:\.\d+)?)\s*%|(\$[\d,]+(?:\.\d{1,2})?))?(?:\s*\((?:was|from)\s*([^)]*)\))?(?:\s*since (?:you )?added)?/i;
const OFFERS =
  /(\d[\d,]*)\s+(?:used\s*(?:&|and)\s*new|new\s*(?:&|and)\s*used|used|new)(?:\s+offers?)?\s+from\s+(\$[\d,]+(?:\.\d{1,2})?)/i;
const AVAILABILITY =
  /Currently unavailable\.?|(?:Temporarily )?out of stock\.?|Only \d+ left in stock[^.]*\.?|In stock\.?|Usually ships[^.]*\.?|Available (?:from|to ship)[^.]*\.?|No featured offers? available\.?|This item is not available[^.]*\.?|Unavailable\.?/i;
const UNIT_PRICE = /\(\s*\$[\d,]+(?:\.\d{1,2})?\s*\/\s*[A-Za-z][A-Za-z ]*\)/;
const PURCHASED = /\b(?:purchased|bought)\b[^.]{0,60}/i;

function parseItem(
  li: DomElement,
  position: number,
  source: string,
  meta: ParseMeta,
): ListItem | undefined {
  const use = new Consumption();
  const opt = { optional: true } as const;

  const item_id = firstOf<string>(
    "item.item_id",
    [
      ["data-itemid", () => attr(li, "data-itemid")],
      ["container-id", () => idSuffix(q(li, "div[id^='item_']"), "item_")],
      ["name-id", () => idSuffix(q(li, "a[id^='itemName_']"), "itemName_")],
      ["delete-id", () => idSuffix(q(li, "[id^='delete-button-']"), "delete-button-")],
    ],
    meta,
  );
  if (item_id === undefined) return undefined;

  const titleLink = q(li, "a[id^='itemName_']");
  const imageBox = q(li, "[id^='itemImage_']");
  const imageLink = q(imageBox, "a[href]");
  const href = attr(titleLink, "href") ?? attr(imageLink, "href");
  const title = firstOf<string>(
    "item.title",
    [
      ["name-link", () => text(titleLink)],
      ["title-attr", () => attr(titleLink, "title") ?? attr(imageLink, "title")],
      ["image-alt", () => attr(q(imageBox, "img[alt]"), "alt")],
    ],
    meta,
  );
  use.take(titleLink?.closest("h2") ?? titleLink);
  use.take(imageBox);

  const positionExternal = jsonAttr(li, "data-reposition-action-params");
  const external_id = str(positionExternal, "itemExternalId");
  const csaAsin = q(li, "[data-csa-c-item-type='asin'][data-csa-c-item-id]");
  const asin = firstOf<string>(
    "item.asin",
    [
      ["csa-item", () => attr(csaAsin, "data-csa-c-item-id")],
      ["external-id", () => /^ASIN:([A-Z0-9]{10})\b/.exec(external_id ?? "")?.[1]],
      [
        "prime-info",
        () => str(jsonAttr(q(li, "[data-item-prime-info]"), "data-item-prime-info"), "asin"),
      ],
      ["href", () => /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(href ?? "")?.[1]],
    ],
    meta,
    opt,
  );

  const bylineEl = q(li, "[id^='item-byline-']");
  const bylineRaw = firstOf<string>("item.byline", [["id", () => text(bylineEl)]], meta, opt);
  use.take(bylineEl);

  const starsEl = q(li, "[id^='review_stars_']");
  const rating = firstOf<Rating>(
    "item.rating",
    [
      ["alt-text", () => parseRating(text(q(starsEl, ".a-icon-alt")))],
      [
        "aria-label",
        () => parseRating(attr(q(li, "a[aria-label*='out of 5 stars']"), "aria-label")),
      ],
      [
        "star-class",
        () => {
          const v = ratingFromClass(attr(starsEl, "class"));
          return v === undefined ? undefined : { value: v, out_of: 5 };
        },
      ],
    ],
    meta,
    opt,
  );
  use.take(starsEl?.closest(".a-declarative") ?? starsEl);
  const countEl = q(li, "[id^='review_count_']");
  const review_count = firstOf<number>(
    "item.review_count",
    [
      ["count-link", () => parseCount(text(countEl))],
      ["aria-label", () => parseCount(attr(countEl, "aria-label"))],
    ],
    meta,
    opt,
  );
  use.take(countEl);

  const priceEl = q(li, "[id^='itemPrice_']") ?? q(li, ".price-section .a-price");
  const prices = qa(priceEl, ".a-price").length > 0 ? qa(priceEl, ".a-price") : [];
  const price = firstOf<Money>(
    "item.price",
    [
      [
        "price-element",
        () => moneyFromPriceElement(priceEl?.matches(".a-price") ? priceEl : prices[0]),
      ],
      ["price-text", () => parseMoney(text(priceEl))],
    ],
    meta,
    opt,
  );
  const priceHigh =
    prices.length > 1 ? moneyFromPriceElement(prices[prices.length - 1]) : undefined;
  use.take(priceEl);
  const hintRaw = Number(attr(li, "data-price"));
  const price_hint =
    Number.isFinite(hintRaw) && attr(li, "data-price") !== "" ? hintRaw : undefined;

  const badges = qa(li, ".wl-item-delivery-badge");
  const badgeText = badges
    .map((b) => text(b))
    .filter((t) => t !== "")
    .join(" ");
  const prime = badges.some((b) => q(b, ".a-icon-prime, [aria-label='prime']") !== undefined);
  use.takeAll(badges);
  const shippingFee = /\+\s*(\$[\d,]+(?:\.\d{1,2})?)\s*shipping/i.exec(badgeText);

  const addedEl = q(li, "[id^='itemAddedDate_']");
  const addedRaw = firstOf<string>(
    "item.added",
    [
      ["id", () => text(addedEl)],
      ["date-added-row", () => text(q(li, ".dateAddedText"))],
      ["text-anchor", () => /Item added[^.]*?\d{4}/i.exec(residual(li, use))?.[0]],
    ],
    meta,
    opt,
  );
  use.take(addedEl);
  use.take(q(li, ".dateAddedText"));

  const commentEl = q(li, "[id^='itemComment_']");
  const comment = firstOf<string>("item.comment", [["id", () => text(commentEl)]], meta, opt);
  use.take(q(li, "[id^='itemCommentRow_']") ?? commentEl);
  const wantedEl = q(li, "[id^='itemRequested_']");
  const hasEl = q(li, "[id^='itemPurchased_']");
  const wanted = firstOf<number>(
    "item.quantity_wanted",
    [["id", () => parseCount(text(wantedEl))]],
    meta,
    opt,
  );
  const has = firstOf<number>(
    "item.quantity_has",
    [["id", () => parseCount(text(hasEl))]],
    meta,
    opt,
  );
  use.take(q(li, "[id^='itemQuantityRow_']") ?? wantedEl);
  const priorityEl = q(li, "[id^='itemPriorityLabel_']");
  const priority = firstOf<string>(
    "item.priority",
    [
      ["id", () => text(priorityEl)],
      ["text-anchor", () => /Priority:\s*(\w+)/i.exec(residual(li, use))?.[1]],
    ],
    meta,
    opt,
  );
  use.take(q(li, "[id^='itemPriorityRow_']") ?? priorityEl);
  use.takeAll(qa(li, ".g-priority-seperator"));

  const itemAction = q(li, "[id^='itemAction_']");
  const buttons = qa(itemAction ?? li, "span.a-button");
  const actions = buttons.map((b) => text(b)).filter((t) => t !== "");
  const primaryEl = q(li, "span.a-button[id^='pab-']");
  const primary = firstOf<string>(
    "item.primary_action",
    [
      ["pab-button", () => text(primaryEl)],
      ["first-button", () => actions[0]],
    ],
    meta,
    opt,
  );
  use.takeAll(buttons);

  const dropEl = q(li, "[id^='itemPriceDrop'], [class*='price-drop'], [class*='priceDrop']");
  use.take(dropEl);
  let rest = residual(li, use);
  let dropSource: string | undefined;
  if (dropEl !== undefined) {
    dropSource = text(dropEl);
    meta.strategies["item.price_drop"] = "price-drop-element";
  } else {
    const found = take(rest, PRICE_DROP);
    if (found.match !== null) {
      dropSource = found.match[0];
      rest = found.rest;
      meta.strategies["item.price_drop"] = "text-anchor";
    }
  }
  let price_drop: PriceDrop | undefined;
  if (dropSource !== undefined && dropSource !== "") {
    const m = PRICE_DROP.exec(dropSource);
    price_drop = { raw: dropSource, since_added: /since (?:you )?added/i.test(dropSource) };
    if (m?.[1] !== undefined) price_drop.percent = Number(m[1]);
    if (m?.[2] !== undefined) {
      const amount = parseMoney(m[2]);
      if (amount !== undefined) price_drop.amount = amount;
    }
    if (m?.[3] !== undefined) {
      const was = parseMoney(m[3]);
      if (was !== undefined) price_drop.was = was;
    }
  }

  let offers: OfferHint | undefined;
  const offerMatch = take(rest, OFFERS);
  if (offerMatch.match !== null) {
    rest = offerMatch.rest;
    offers = { raw: offerMatch.match[0] };
    if (offerMatch.match[1] !== undefined) offers.count = parseCount(offerMatch.match[1]);
    const from = parseMoney(offerMatch.match[2]);
    if (from !== undefined) offers.from = from;
    meta.strategies["item.offers"] = "text-anchor";
  }
  const unit = take(rest, UNIT_PRICE);
  if (unit.match !== null) {
    rest = unit.rest;
    meta.strategies["item.unit_price"] = "text-anchor";
  }
  const avail = take(rest, AVAILABILITY);
  if (avail.match !== null) {
    rest = avail.rest;
    meta.strategies["item.availability"] = "text-anchor";
  }
  const bought = take(rest, PURCHASED);
  if (bought.match !== null) {
    rest = bought.rest;
    meta.strategies["item.purchased"] = "text-anchor";
  }
  rest = tidy(rest);

  const item: ListItem = {
    item_id,
    position,
    source,
    prime,
    is_purchased:
      (has !== undefined && wanted !== undefined && has > 0 && has >= wanted) ||
      bought.match !== null,
    can_add_to_cart: /add to cart/i.test(primary ?? ""),
    actions,
  };
  if (asin !== undefined && ASIN.test(asin)) item.asin = asin;
  if (external_id !== undefined) item.external_id = external_id;
  if (title !== undefined) item.title = title;
  if (href !== undefined) item.url_path = pathOf(href);
  const img = attr(q(imageBox, "img[src]"), "src");
  if (img !== undefined) item.image_url = img;
  if (bylineRaw !== undefined) {
    const byline = bylineRaw.replace(/^by\s+/i, "");
    item.byline = byline;
    const qual = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(byline);
    item.brand = qual?.[1] !== undefined && qual[1] !== "" ? qual[1] : byline;
    if (qual?.[2] !== undefined) item.byline_qualifier = qual[2];
  }
  if (price !== undefined) item.price = price;
  if (priceHigh !== undefined) item.price_high = priceHigh;
  if (price_hint !== undefined) item.price_hint = price_hint;
  if (price_drop !== undefined) item.price_drop = price_drop;
  if (unit.match !== null) item.unit_price = unit.match[0];
  if (addedRaw !== undefined) {
    item.added = { raw: addedRaw };
    const iso = parseLongDate(addedRaw);
    if (iso !== undefined) item.added.iso = iso;
  }
  if (wanted !== undefined) item.quantity_wanted = wanted;
  if (has !== undefined) item.quantity_has = has;
  if (priority !== undefined) item.priority = priority.toLowerCase();
  if (comment !== undefined) item.comment = comment;
  if (avail.match !== null) item.availability = collapse(avail.match[0]);
  if (offers !== undefined) item.offers = offers;
  if (rating !== undefined) item.rating = rating;
  if (review_count !== undefined) item.review_count = review_count;
  if (badgeText !== "") item.delivery_text = badgeText;
  if (shippingFee?.[1] !== undefined) {
    const fee = parseMoney(shippingFee[1]);
    if (fee !== undefined) item.shipping_fee = fee;
  }
  if (bought.match !== null) item.purchased_text = collapse(bought.match[0]);
  if (primary !== undefined) item.primary_action = primary;
  if (rest !== "") item.extra_text = [rest];
  return item;
}

// ---- pagination

function scanPagination(root: DomRoot, meta: ParseMeta): ListPagination {
  const forms = rawQa(root, "form.scroll-state");
  const form = forms[forms.length - 1];
  const blob = harvestBlobs(root, { known: ["scrollState"], attributes: [] }).known["scrollState"];
  const scroll = blob !== null && typeof blob === "object" ? (blob as Record<string, unknown>) : {};
  const nextRaw = firstOf<string>(
    "pagination.next_token",
    [
      ["form-input", () => inputValue(form, "input[name='lastEvaluatedKey']")],
      ["scroll-state", () => str(scroll, "lastEvaluatedKey")],
    ],
    meta,
    { optional: true },
  );
  const next_token = nextRaw !== undefined && nextRaw !== "" ? nextRaw : undefined;
  const template = firstOf<string>(
    "pagination.more_url",
    [
      ["form-input", () => inputValue(form, "input[name='showMoreUrl']")],
      ["scroll-state", () => str(scroll, "showMoreUrl")],
    ],
    meta,
    { optional: true },
  );
  const renderedRaw = scroll["itemsRenderedSoFar"];
  const rendered = firstOf<number>(
    "pagination.items_rendered",
    [
      ["form-input", () => parseCount(inputValue(form, "input[name='itemsRenderedSoFar']"))],
      ["scroll-state", () => (typeof renderedRaw === "number" ? renderedRaw : undefined)],
    ],
    meta,
    { optional: true },
  );
  const end = q(root, "#endOfListMarker") !== undefined;
  const has_more =
    firstOf<boolean>(
      "pagination.has_more",
      [
        ["end-marker", () => (end ? false : undefined)],
        ["last-evaluated-key", () => (next_token !== undefined ? true : undefined)],
        ["no-token", () => (form !== undefined || blob !== undefined ? false : undefined)],
      ],
      meta,
      { optional: true },
    ) ?? false;
  const out: ListPagination = { has_more, end_of_list: end };
  if (rendered !== undefined) out.items_rendered = rendered;
  if (next_token !== undefined) out.next_token = next_token;
  if (template !== undefined && template !== "") out.more_url_template = template;
  return out;
}

/**
 * Build the URL path that loads the next batch of items from a template and token. The
 * template's `paginationToken` parameter is replaced; everything else is kept.
 */
export function buildMoreItemsPath(template: string, token: string): string {
  const [path = "", query = ""] = template.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("paginationToken", token);
  return `${path}?${params.toString()}`;
}

// ---- shared core

interface Core {
  doc: DomDocument;
  root: DomElement;
  consumed: Consumption;
  meta: ParseMeta;
  tabs: ListTab[];
  can_create: boolean;
  create_list_path?: string;
  help_link?: Link;
  nav: ListSummary[];
  page?: ListPage;
  extra_nav: string[];
}

function parseTabs(root: DomElement, c: Consumption): ListTab[] {
  const tabs: ListTab[] = [];
  const list = q(root, "ul.a-tabs");
  for (const li of qa(list ?? root, "li.a-tab-heading")) {
    const label = text(li);
    if (label === "") continue;
    const tab: ListTab = { label, active: hasClass(li, "a-active") };
    const href = attr(q(li, "a[href]"), "href");
    if (href !== undefined) tab.href = pathOf(href);
    tabs.push(tab);
  }
  c.take(list);
  return tabs;
}

function analyze(capture: Capture): Core {
  const meta = newMeta();
  const { doc, fragments } = parseCapture(capture);
  const pageRoot = q(doc, "#wishlist-page");
  const root = pageRoot ?? doc.body;
  if (pageRoot === undefined) meta.warnings.push("root: #wishlist-page not found, using body");
  const c = new Consumption();
  const core: Core = {
    doc,
    root,
    consumed: c,
    meta,
    tabs: parseTabs(root, c),
    can_create: false,
    nav: [],
    extra_nav: [],
  };

  const create = q(root, "#createList") ?? q(root, ".createListTrigger");
  if (create !== undefined) {
    core.can_create = true;
    const declarative = create.closest(".a-declarative") ?? create.parentElement ?? undefined;
    const url = str(jsonAttr(declarative, "data-show-create-list"), "url");
    if (url !== undefined) core.create_list_path = pathOf(url);
    const box = create.closest(".a-text-right") ?? create;
    const help = links(box).find((l) => l.href !== "" && !l.href.includes("wishlist/create"));
    if (help !== undefined) core.help_link = help;
    c.take(box);
  }

  const nav = parseNav(root, meta);
  if (nav !== undefined) {
    core.nav = nav.lists;
    core.extra_nav = nav.extra;
    c.take(nav.el);
  }

  const hasPane =
    q(root, "#list-header, #wl-item-view, #g-items, #profile-list-name") !== undefined;
  if (hasPane) core.page = analyzePane(capture, root, fragments, core.nav, meta, c);
  return core;
}

function analyzePane(
  capture: Capture,
  root: DomElement,
  fragments: Record<string, DomDocument>,
  nav: ListSummary[],
  meta: ParseMeta,
  c: Consumption,
): ListPage {
  const blobs = harvestBlobs(root, {
    known: ["rememberState", "scrollState", "viewState"],
    attributes: [],
  });
  if (blobs.unknownKeys.length > 0) meta.unknown_blobs = blobs.unknownKeys;
  const remember = blobs.known["rememberState"];
  const state: PageState = {};
  if (remember !== null && typeof remember === "object") {
    const o = remember as Record<string, unknown>;
    const id = str(o, "listId");
    const type = str(o, "listType");
    const shared = bool(o, "isSharedWL");
    if (id !== undefined) state.listId = id;
    if (type !== undefined) state.listType = type;
    if (shared !== undefined) state.isShared = shared;
  }

  const list = parseHeader(root, state, nav, capture, meta, c);
  const controls = parseControls(root, meta, c);

  const items: ListItem[] = [];
  const seen = new Set<string>();
  const addItems = (scope: DomRoot, source: string, consume: boolean): void => {
    let lis = qa(scope, "li[data-itemid]");
    if (lis.length === 0) {
      // Layout fallback: an item container without the list-item wrapper.
      lis = qa(scope, "div[id^='item_']").map((d) => d.closest("li") ?? d);
    }
    for (const li of lis) {
      const item = parseItem(li, items.length + 1, source, meta);
      if (item === undefined || seen.has(item.item_id)) continue;
      seen.add(item.item_id);
      items.push(item);
      if (consume) c.take(li);
    }
  };
  addItems(root, "page", true);
  let pagination = scanPagination(root, meta);
  for (const [name, fragDoc] of Object.entries(fragments)) {
    const before = items.length;
    addItems(fragDoc, name, false);
    if (items.length > before || rawQa(fragDoc, "form.scroll-state").length > 0) {
      pagination = scanPagination(fragDoc, meta);
    }
  }
  const endMarker = q(root, "#endOfListMarker");
  c.take(endMarker);
  // The captured "empty" state of the item area, when no item exists.
  if (items.length === 0) meta.strategies["items"] = "none";

  const page: ListPage = {
    list,
    nav_lists: nav,
    has_search: controls.has_search,
    items,
    pagination,
    is_empty: items.length === 0 && !pagination.has_more,
  };
  if (controls.filter !== undefined) page.filter = controls.filter;
  if (controls.sort !== undefined) page.sort = controls.sort;
  if (controls.view !== undefined) page.view = controls.view;
  if (controls.extra.length > 0) page.extra_text = controls.extra;
  return page;
}

function finish<T>(core: Core, data: T, base: string): ParseResult<T> {
  const report = losslessReport(core.doc, core.consumed, {
    root: core.root,
    base,
    blockSelector: `${DEFAULT_BLOCK_SELECTOR}, .a-section, .your-lists-container, [class^='intro-page']`,
  });
  core.meta.unparsed_text_chars = report.counts.unparsed;
  const other_sections: OtherSection[] = report.sections;
  return { data, other_sections, meta: core.meta };
}

// ---- parsers

/** `list_lists`: every list of the left navigation (or the empty intro page). */
export const parseListsIndex: Parser<ListsIndexPage> = (capture) => {
  const core = analyze(capture);
  const hasNav = q(core.root, "#your-lists-nav, #left-nav") !== undefined;
  const intro = q(core.root, ".your-lists-container, .intro-page-banner") !== undefined;
  if (!hasNav && !intro && core.page === undefined && core.tabs.length === 0) {
    throw new RfError("layout_unrecognized", "no lists navigation, list pane or intro page found");
  }
  let variant: "lists" | "intro" = "lists";
  if (!hasNav) {
    variant = intro ? "intro" : "lists";
    core.meta.warnings.push(
      intro
        ? "lists: intro page without a lists navigation (no lists shown)"
        : "lists: navigation not found",
    );
  } else if (core.nav.length === 0) {
    core.meta.warnings.push("lists: navigation present but no entry parsed");
  }
  const data: ListsIndexPage = {
    variant,
    lists: core.nav,
    tabs: core.tabs,
    can_create: core.can_create,
  };
  const selected = core.nav.find((l) => l.selected)?.list_id ?? core.page?.list.list_id;
  if (selected !== undefined) data.selected_list_id = selected;
  if (core.page !== undefined) data.selected_list = { ...core.page, nav_lists: [] };
  if (core.create_list_path !== undefined) data.create_list_path = core.create_list_path;
  if (core.help_link !== undefined) data.help_link = core.help_link;
  return finish(core, data, capture.final_url);
};

/** `get_list`: header, controls, items in page order and pagination of one list. */
export const parseList: Parser<ListPage> = (capture) => {
  const core = analyze(capture);
  if (core.page === undefined) {
    throw new RfError("layout_unrecognized", "no list header or item area found");
  }
  if (core.page.list.name === undefined && core.page.items.length === 0) {
    core.meta.warnings.push("list: no name and no items parsed");
  }
  return finish(core, core.page, capture.final_url);
};
