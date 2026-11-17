/**
 * Product variants parser: `get_variants`.
 *
 * The variant matrix is embedded twice and this parser reads both and cross-checks them:
 *
 *  - JSON: the `twister-js-init-dpx-data` script (an object literal that is NOT valid JSON:
 *    trailing commas and string concatenation, so each key is extracted on its own) carries
 *    `dimensions`, `variationValues`, `dimensionToAsinMap`, `dimensionValuesDisplayData`,
 *    `variationDisplayLabels`, `selectedVariationValues` and the ASINs; the
 *    `desktop-twister-sort-filter-data` a-state carries the display order and per-value state.
 *    Older layouts carry `asinVariationValues`.
 *  - DOM: the swatch rows (`#inline-twister-row-<dimension>` plus the singleton headers), with
 *    classic `#variation_<dimension>` swatch and dropdown fallbacks.
 *
 * Index semantics: the ids of `dimensionToAsinMap` (for example "1_0_2") hold one index per
 * dimension, in the order of `dimensions`, into that dimension's `variationValues` list.
 * `VariantValue.index` is that canonical index; the order of `values[]` is the display order.
 *
 * Availability semantics, as the page words them: `unavailable` is "Currently unavailable"
 * (the value exists but cannot be bought), `see_options` is "See available options" (the value
 * does not exist together with the current selection of the other dimensions).
 *
 * The product parser owns lossless coverage of the page, so this parser returns no
 * `other_sections` and reports `unparsed_text_chars: 0`.
 */
import { RfError } from "@rainforest/core";
import type { Capture, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  type Money,
  attr,
  collapse,
  moneyFromPriceElement,
  parseDocument,
  q,
  qa,
  text,
  visible,
} from "../dom.ts";
import { harvestBlobs } from "../blobs.ts";
import { firstOf, newMeta } from "../strategy.ts";
import { MediaUrlGate, inlineScriptTexts, jsonAfter } from "./media.ts";

// ---- data model

export type VariantState = "available" | "unavailable" | "see_options" | "unknown";

/** What a swatch shows next to its label. Every field is optional: only what the page shows. */
export interface VariantOffer {
  price?: Money;
  /** Struck-through price. */
  list_price?: Money;
  unit_price?: Money;
  /** Unit of `unit_price`, for example "count". */
  unit?: string;
  /** Stock note (read from a node the page keeps out of view), for example "In stock". */
  availability?: string;
  /** Delivery promise text, for example "Delivery Jan 5". */
  delivery?: string;
  /** Buying-option caption, for example "Used". */
  caption?: string;
  /**
   * Any other text the swatch's slot shows next to the price (a qualifier such as "with a
   * membership"), so a price is never read without its condition.
   */
  note?: string;
}

export interface VariantSwatch extends VariantOffer {
  /** The swatch as rendered: label plus price, caption and delivery text (screen-reader-only text excluded). */
  text: string | null;
  /** Swatch image URL for image swatches (Amazon media hosts only). */
  image: string | null;
}

export interface VariantValue {
  /** Display text of the value. */
  value: string;
  /** Index into the dimension's canonical value list (the position used by the combination ids). */
  index: number | null;
  /** Default child ASIN for this value (the swatch's ASIN). */
  asin: string | null;
  selected: boolean;
  state: VariantState;
  /** The page's own state label (JSON `dimensionValueState` or the swatch slot name). */
  state_raw: string | null;
  /** Swatch kind: "text" or "image". */
  swatch_kind: string | null;
  swatch: VariantSwatch | null;
}

export interface VariantDimension {
  /** Machine key such as `color_name` or `size_name`. */
  key: string;
  /** Display label such as "Color". */
  label: string;
  /** How the page renders the dimension: "swatch", "dropdown", "singleton", ... */
  display_type: string | null;
  /** A dimension with a single value is shown as a plain label, not a choice. */
  singleton: boolean;
  selected_value: string | null;
  /** In display order. */
  values: VariantValue[];
}

export interface VariantCombination extends VariantOffer {
  asin: string;
  /** dimension key -> value text. */
  values: Record<string, string>;
  /** True for the ASIN of the page that was captured. */
  selected: boolean;
}

export interface VariantsData {
  parent_asin: string | null;
  current_asin: string | null;
  /** Empty for a product without variants. */
  dimensions: VariantDimension[];
  /** Every child the page lists (a combination absent here does not exist). */
  combinations: VariantCombination[];
  /** Variant count the page declares. */
  total_variations: number | null;
  /** False when the page lists fewer combinations than it declares (family too large to inline). */
  combinations_complete: boolean;
  /**
   * Child ASINs whose offer (price, availability or delivery) is not on this page: no swatch
   * showed one. The current ASIN is excluded (its offer is the page's own featured offer).
   * Ordered for a small fetch budget: per-value default ASINs first (display order), then the
   * remaining children sorted. The flow fetches these when asked to.
   */
  missing_offer_asins: string[];
}

// ---- small helpers

const ASIN_RE = /^[A-Z0-9]{10}$/;
const norm = (s: string): string => collapse(s).toLowerCase();

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function asinOf(v: unknown): string | null {
  const s = str(v);
  return s !== null && ASIN_RE.test(s) ? s : null;
}

function intOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v);
  return null;
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    else if (typeof item === "number") out.push(String(item));
    else return null;
  }
  return out;
}

function humanize(key: string): string {
  const s = key
    .replace(/_name$/, "")
    .replace(/_/g, " ")
    .trim();
  return s === "" ? key : s.charAt(0).toUpperCase() + s.slice(1);
}

const OFFSCREEN = (el: DomElement): boolean => el.matches(".a-offscreen, .aok-offscreen");

function stripColon(s: string): string {
  return collapse(s).replace(/\s*:\s*$/, "");
}

// ---- page JSON

interface Dpx {
  dimensions: string[] | null;
  variationValues: Record<string, string[]> | null;
  labels: Record<string, string> | null;
  selected: Record<string, number> | null;
  singletons: string[] | null;
  displayTypes: string[] | null;
  toAsin: Record<string, string> | null;
  displayData: Record<string, string[]> | null;
  asinVariationValues: Record<string, Record<string, unknown>> | null;
  currentAsin: string | null;
  landingAsin: string | null;
  parentAsin: string | null;
  total: number | null;
  combinationId: string | null;
}

function scalar(src: string, key: string): string | number | null {
  const m = new RegExp(`"${key}"\\s*:\\s*(?:"([^"]*)"|(-?\\d+(?:\\.\\d+)?))`).exec(src);
  if (m === null) return null;
  if (m[1] !== undefined) return m[1];
  return m[2] === undefined ? null : Number(m[2]);
}

function readDpx(scripts: readonly string[], meta: ParseMeta): Dpx | null {
  const source =
    scripts.find((s) => s.includes("twister-js-init-dpx-data")) ??
    scripts.find((s) => s.includes('"dimensionToAsinMap"') || s.includes('"variationValues"'));
  if (source === undefined) return null;

  const field = (key: string): unknown => {
    const found = jsonAfter(source, new RegExp(`"${key}"\\s*:\\s*`));
    if (found.found && found.value === undefined) {
      meta.warnings.push(`variants: "${key}" blob is malformed JSON`);
    }
    return found.value;
  };
  const record = <T>(v: unknown, pick: (x: unknown) => T | null): Record<string, T> | null => {
    if (!isRecord(v)) return null;
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = pick(x);
      if (p !== null) out[k] = p;
    }
    return out;
  };

  const dpx: Dpx = {
    dimensions: stringArray(field("dimensions")),
    variationValues: record(field("variationValues"), stringArray),
    labels: record(field("variationDisplayLabels"), str),
    selected: record(field("selectedVariationValues"), intOf),
    singletons: stringArray(field("singletonDimensionKeys")),
    displayTypes: stringArray(field("dimensionsDisplayType")),
    toAsin: record(field("dimensionToAsinMap"), asinOf),
    displayData: record(field("dimensionValuesDisplayData"), stringArray),
    asinVariationValues: record(field("asinVariationValues"), (x) => (isRecord(x) ? x : null)),
    currentAsin: asinOf(scalar(source, "currentAsin")),
    landingAsin: asinOf(scalar(source, "landingAsin")),
    parentAsin: asinOf(scalar(source, "parentAsin")),
    total: intOf(scalar(source, "num_total_variations")),
    combinationId: str(scalar(source, "currentDimensionCombinationId")),
  };
  return dpx;
}

interface SortedValue {
  index: number | null;
  value: string;
  asin: string | null;
  stateRaw: string | null;
  kind: string | null;
  image: string | null;
}

function readSortFilter(blob: unknown, gate: MediaUrlGate): Record<string, SortedValue[]> | null {
  if (!isRecord(blob)) return null;
  const dims = blob["sortedDimValuesForAllDims"];
  if (!isRecord(dims)) return null;
  const out: Record<string, SortedValue[]> = {};
  for (const [key, list] of Object.entries(dims)) {
    if (!Array.isArray(list)) continue;
    const values: SortedValue[] = [];
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const value = str(raw["dimensionValueDisplayText"]);
      if (value === null) continue;
      const image = isRecord(raw["imageAttribute"]) ? raw["imageAttribute"]["url"] : null;
      values.push({
        index: intOf(raw["indexInDimList"]),
        value,
        asin: asinOf(raw["defaultAsin"]),
        stateRaw: str(raw["dimensionValueState"]),
        kind: str(raw["dimensionDisplaySubType"]),
        image: gate.url(image),
      });
    }
    out[key] = values;
  }
  return out;
}

/** Map the page's own state label onto VariantState. */
function stateFromRaw(raw: string | null): VariantState {
  if (raw === null) return "unknown";
  const s = raw.toUpperCase();
  if (s === "AVAILABLE" || s === "SELECTED") return "available";
  if (s.includes("CURRENTLY")) return "unavailable";
  if (s === "UNAVAILABLE" || s === "INVALID") return "see_options";
  return "unknown";
}

// ---- DOM swatches

interface DomValue {
  value: string | null;
  index: number | null;
  asin: string | null;
  selected: boolean;
  state: VariantState;
  stateRaw: string | null;
  kind: string | null;
  swatch: VariantSwatch | null;
}

interface DomRow {
  key: string;
  label: string | null;
  singleton: boolean;
  displayType: string;
  values: DomValue[];
}

function moneyOf(el: DomElement | undefined): Money | undefined {
  return el === undefined ? undefined : moneyFromPriceElement(el);
}

/** Price, caption, availability and delivery shown inside one swatch element. */
function readSwatchOffer(li: DomElement, meta: ParseMeta): VariantOffer {
  const offer: VariantOffer = {};
  const prices = qa(li, ".a-price");
  const toPay =
    q(li, ".apex-pricetopay-value") ??
    prices.find(
      (p) =>
        !p.hasAttribute("data-a-strike") &&
        !p.matches(".apex-priceperunit-value, .apex-basisprice-value"),
    );
  const price = moneyOf(toPay);
  if (price !== undefined) offer.price = price;
  const list = moneyOf(
    q(li, ".apex-basisprice-value") ??
      prices.find((p) => p.getAttribute("data-a-strike") === "true"),
  );
  if (list !== undefined) offer.list_price = list;
  const unitEl = q(li, ".apex-priceperunit-value");
  const unit = moneyOf(unitEl);
  if (unit !== undefined) {
    offer.unit_price = unit;
    const label = text(q(li, ".apex-priceperunit-accessibility-label") ?? undefined);
    const per = /\bper\s+(.+)$/i.exec(label);
    const slash = /\/\s*([A-Za-z][\w ]*)/.exec(text(unitEl?.parentElement ?? undefined));
    const u = per?.[1] ?? slash?.[1];
    if (u !== undefined) offer.unit = collapse(u);
  }
  const caption = text(q(li, ".buyingOptionTwisterSwatchCaption"));
  if (caption !== "") offer.caption = caption;
  // The stock note sits in a node the page keeps out of view; it is read raw and counted as such.
  const stock = collapse(li.querySelector("#twisterAvailability")?.textContent ?? "");
  if (stock !== "") {
    offer.availability = stock;
    meta.strategies["swatch_availability"] = "twister-availability-node";
  }
  const delivery =
    text(q(li, ".udm-primary-delivery-message")) || text(q(li, "#deliveryPromisePrefix"));
  if (delivery !== "") offer.delivery = delivery;
  // What is left of the slot after the parts above: qualifiers such as "with a membership".
  const slot = q(li, ".dimension-slot-info");
  const note = text(slot, {
    exclude: (el) =>
      OFFSCREEN(el) ||
      el.matches(
        "#apex_price, .apex_on_twister_price, .a-price, .buyingOptionTwisterSwatchCaption, " +
          ".udm-delivery-block, #deliveryPromisePrefix, #twisterAvailability",
      ),
  });
  if (note !== "") offer.note = note;
  return offer;
}

/**
 * The swatch as rendered. `imageSelector` picks the swatch picture: twister-plus rows use the
 * dedicated `img.swatch-image` (a text swatch may carry badge images that are not swatches).
 */
function swatchOf(
  li: DomElement,
  gate: MediaUrlGate,
  meta: ParseMeta,
  imageSelector: string,
): VariantSwatch | null {
  if (!visible(li)) return null;
  const swatchText = text(li, { exclude: OFFSCREEN });
  const image = gate.url(attr(q(li, imageSelector), "src"));
  const offer = readSwatchOffer(li, meta);
  if (swatchText === "" && image === null && Object.keys(offer).length === 0) return null;
  return { text: swatchText === "" ? null : swatchText, image, ...offer };
}

function plusRowLabel(row: DomElement, key: string): string | null {
  const title = q(row, `[id^="inline-twister-dim-title-"] .a-color-secondary`);
  if (title !== undefined) return stripColon(text(title));
  const aria = attr(
    row.querySelector(`[id^="inline-twister-expander-header-"]`) ?? undefined,
    "aria-label",
  );
  const m = aria === undefined ? null : /^Selected (.+?) is /.exec(aria);
  if (m?.[1] !== undefined) return collapse(m[1]);
  const make = collapse(row.querySelector(`#dim-values-aria-label-${key}`)?.textContent ?? "");
  const n = /^Make an? (.+?) selection$/i.exec(make);
  return n?.[1] === undefined ? null : collapse(n[1]);
}

function plusRows(doc: DomDocument, gate: MediaUrlGate, meta: ParseMeta): DomRow[] {
  const rows: DomRow[] = [];
  for (const row of qa(doc, `[id^="inline-twister-row-"]`)) {
    const key = row.id.slice("inline-twister-row-".length);
    if (key === "") continue;
    const values: DomValue[] = [];
    // Hidden (collapsed) swatches are still choices: read them raw, but only show the swatch of visible ones.
    for (const li of Array.from(row.querySelectorAll("li[data-asin]"))) {
      const slot = attr(li, "data-csa-c-slot-id") ?? "";
      const slotState =
        /swatch(CurrentlyUnavailable|Unavailable|Available|Select\w*)$/.exec(slot)?.[1] ?? null;
      const button = li.querySelector(".a-button");
      const input = li.querySelector("input");
      const labelEl = li.querySelector(".swatch-title-text-display, .swatch-title-text");
      const image = li.querySelector("img.swatch-image");
      const value =
        collapse(labelEl?.textContent ?? "") ||
        collapse(image?.getAttribute("alt") ?? "") ||
        collapse(input?.getAttribute("aria-label") ?? "");
      const selected =
        li.getAttribute("data-initiallyselected") === "true" ||
        input?.getAttribute("aria-checked") === "true" ||
        (button?.getAttribute("class") ?? "").includes("a-button-selected");
      const flaggedUnavailable =
        li.getAttribute("data-initiallyunavailable") === "true" ||
        (button?.getAttribute("class") ?? "").includes("a-button-unavailable");
      let state: VariantState = "available";
      if (slotState === "CurrentlyUnavailable") state = "unavailable";
      else if (slotState === "Unavailable") state = "see_options";
      else if (flaggedUnavailable) {
        state = /currently unavailable/i.test(text(li)) ? "unavailable" : "see_options";
      }
      values.push({
        value: value === "" ? null : value,
        index: intOf(li.getAttribute("data-idxintoggleswatchlist")),
        asin: asinOf(li.getAttribute("data-asin")),
        selected,
        state,
        stateRaw: slotState,
        kind: image !== null ? "image" : "text",
        swatch: swatchOf(li, gate, meta, "img.swatch-image"),
      });
    }
    rows.push({
      key,
      label: plusRowLabel(row, key),
      singleton: false,
      displayType: "swatch",
      values,
    });
  }
  for (const head of qa(doc, `[id^="inline-twister-singleton-header-"]`)) {
    const key = head.id.slice("inline-twister-singleton-header-".length);
    const value = text(q(head, `[id^="inline-twister-expanded-dimension-text-"]`));
    if (key === "" || value === "") continue;
    rows.push({
      key,
      label: stripColon(text(q(head, ".inline-twister-dim-title"))) || null,
      singleton: true,
      displayType: "singleton",
      values: [
        {
          value,
          index: 0,
          asin: null,
          selected: true,
          state: "available",
          stateRaw: null,
          kind: "text",
          swatch: null,
        },
      ],
    });
  }
  return rows;
}

function classicRows(doc: DomDocument, gate: MediaUrlGate, meta: ParseMeta): DomRow[] {
  const rows: DomRow[] = [];
  for (const box of qa(doc, `[id^="variation_"]`)) {
    const key = box.id.slice("variation_".length);
    if (key === "") continue;
    const label = stripColon(text(q(box, ".a-form-label, label")));
    const values: DomValue[] = [];
    const select = q(box, "select");
    if (select !== undefined) {
      for (const option of Array.from(select.querySelectorAll("option"))) {
        const raw = attr(option, "value") ?? "";
        const m = /^(\d+),([A-Z0-9]{10})$/.exec(raw);
        if (m === null) continue; // the "Select" placeholder
        const cls = attr(option, "class") ?? "";
        let state: VariantState = "available";
        if (/CurrentlyUnavailable/i.test(cls)) state = "unavailable";
        else if (/dropdownUnavailable/i.test(cls)) state = "see_options";
        values.push({
          value: collapse(option.textContent ?? "") || null,
          index: Number(m[1]),
          asin: m[2] ?? null,
          selected: option.hasAttribute("selected") || /dropdownSelect/i.test(cls),
          state,
          stateRaw: cls === "" ? null : cls,
          kind: "text",
          swatch: null,
        });
      }
      rows.push({ key, label: label || null, singleton: false, displayType: "dropdown", values });
      continue;
    }
    for (const li of Array.from(box.querySelectorAll("li[data-defaultasin], li[data-asin]"))) {
      const cls = attr(li, "class") ?? "";
      const image = li.querySelector("img");
      const title = (attr(li, "title") ?? "").replace(/^Click to select\s*/i, "");
      const value =
        collapse(title) ||
        collapse(li.querySelector(".twisterTextDiv, .a-button-text")?.textContent ?? "") ||
        collapse(image?.getAttribute("alt") ?? "");
      let state: VariantState = "available";
      if (/swatchCurrentlyUnavailable/.test(cls)) state = "unavailable";
      else if (/swatchUnavailable/.test(cls)) state = "see_options";
      values.push({
        value: value === "" ? null : value,
        index: null,
        asin: asinOf(li.getAttribute("data-defaultasin") ?? li.getAttribute("data-asin")),
        selected: /swatchSelect/.test(cls),
        state,
        stateRaw: cls === "" ? null : cls,
        kind: image !== null ? "image" : "text",
        swatch: swatchOf(li, gate, meta, "img"),
      });
    }
    rows.push({ key, label: label || null, singleton: false, displayType: "swatch", values });
  }
  return rows.filter((r) => r.values.length > 0);
}

// ---- assembling

interface Combo {
  asin: string;
  tuple: number[] | null;
  values: Record<string, string>;
}

const KNOWN_BLOBS = [
  "desktop-twister-sort-filter-data",
  "twister-plus-desktop-inline-twister-collapse-view-asins-data",
  "twister-bo-swatch-captions-data",
  /^data-a-dynamic-image/,
  "imageBlockStateData",
] as const;
const VARIANT_KEY_LIKE = /twister|variation|dimension|swatch|variant/i;
const PRODUCT_MARKERS =
  "#productTitle, #dp, #dp-container, #ppd, #centerCol, #twister_feature_div, #twisterContainer, " +
  `input#ASIN, [id^="inline-twister-row-"], [id^="variation_"]`;

function asinFromUrl(url: string): string | null {
  const m = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(url);
  return m?.[1] ?? null;
}

export const parseVariants: Parser<VariantsData> = (
  capture: Capture,
): ParseResult<VariantsData> => {
  const doc = parseDocument(capture.html);
  const meta = newMeta();
  const gate = new MediaUrlGate();
  const scripts = inlineScriptTexts(doc);

  const harvest = harvestBlobs(doc, { known: KNOWN_BLOBS, attributes: [] });
  const unknown = harvest.unknownKeys.filter((k) => VARIANT_KEY_LIKE.test(k));
  if (unknown.length > 0) meta.unknown_blobs = unknown;
  for (const key of harvest.malformed) {
    if (VARIANT_KEY_LIKE.test(key)) meta.warnings.push(`variants: blob "${key}" is malformed JSON`);
  }

  const dpx = readDpx(scripts, meta);
  if (dpx === null && doc.querySelector(PRODUCT_MARKERS) === null) {
    throw new RfError("layout_unrecognized", "not a product page: no product or twister markers");
  }
  const sorted = readSortFilter(harvest.known["desktop-twister-sort-filter-data"], gate);

  // ---- DOM rows (strategy chosen here, cross-checked below)
  const domRows =
    firstOf<DomRow[]>(
      "dom_rows",
      [
        ["swatch-dom", () => plusRows(doc, gate, meta)],
        ["classic-dom", () => classicRows(doc, gate, meta)],
      ],
      meta,
      { optional: true },
    ) ?? [];
  const domByKey = new Map(domRows.map((r) => [r.key, r]));

  // ---- dimension keys
  const keys =
    firstOf<string[]>(
      "dimension_keys",
      [
        ["blob-dimensions", () => dpx?.dimensions],
        ["blob-variation-values", () => Object.keys(dpx?.variationValues ?? {})],
        ["blob-sort-filter", () => Object.keys(sorted ?? {})],
        ["swatch-dom", () => domRows.map((r) => r.key)],
      ],
      meta,
      { optional: true },
    ) ?? [];

  // ---- combinations
  const dims = keys;
  const vv = dpx?.variationValues ?? {};
  const decodeTuple = (tuple: readonly number[]): Record<string, string> | null => {
    const values: Record<string, string> = {};
    for (let i = 0; i < dims.length; i++) {
      const key = dims[i] as string;
      const v = vv[key]?.[tuple[i] as number];
      if (v === undefined) return null;
      values[key] = v;
    }
    return values;
  };

  const fromMap = (): Combo[] | null => {
    if (dpx?.toAsin == null || dims.length === 0) return null;
    const combos: Combo[] = [];
    let bad = 0;
    for (const [id, asin] of Object.entries(dpx.toAsin)) {
      const tuple = id.split("_").map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
      const values =
        tuple.length === dims.length && tuple.every((n) => Number.isInteger(n))
          ? decodeTuple(tuple)
          : null;
      if (values === null) bad++;
      else combos.push({ asin, tuple, values });
    }
    if (bad > 0) meta.warnings.push(`variants: ${bad} combination id(s) could not be decoded`);
    combos.sort((a, b) => cmpTuple(a.tuple, b.tuple));
    return combos;
  };
  const fromDisplayData = (): Combo[] | null => {
    if (dpx?.displayData == null || dims.length === 0) return null;
    const combos: Combo[] = [];
    for (const [asin, list] of Object.entries(dpx.displayData)) {
      if (!ASIN_RE.test(asin) || list.length !== dims.length) continue;
      const values: Record<string, string> = {};
      dims.forEach((key, i) => {
        values[key] = list[i] as string;
      });
      combos.push({ asin, tuple: tupleOf(values), values });
    }
    combos.sort((a, b) => cmpTuple(a.tuple, b.tuple));
    return combos;
  };
  const tupleOf = (values: Record<string, string>): number[] | null => {
    const tuple: number[] = [];
    for (const key of dims) {
      const i = vv[key]?.indexOf(values[key] as string);
      if (i === undefined || i < 0) return null;
      tuple.push(i);
    }
    return tuple;
  };
  const fromAsinVariationValues = (): Combo[] | null => {
    if (dpx?.asinVariationValues == null || dims.length === 0) return null;
    const combos: Combo[] = [];
    for (const [asin, entry] of Object.entries(dpx.asinVariationValues)) {
      if (!ASIN_RE.test(asin)) continue;
      const tuple: number[] = [];
      const values: Record<string, string> = {};
      let ok = true;
      for (const key of dims) {
        const idx = intOf(entry[key]);
        const value = idx === null ? undefined : vv[key]?.[idx];
        if (idx === null || value === undefined) {
          ok = false;
          break;
        }
        tuple.push(idx);
        values[key] = value;
      }
      if (ok) combos.push({ asin, tuple, values });
    }
    combos.sort((a, b) => cmpTuple(a.tuple, b.tuple));
    return combos;
  };
  const fromSingleRow = (): Combo[] | null => {
    if (dims.length !== 1) return null;
    const row = domByKey.get(dims[0] as string);
    if (row === undefined) return null;
    const combos: Combo[] = [];
    for (const v of row.values) {
      if (v.asin !== null && v.value !== null) {
        combos.push({
          asin: v.asin,
          tuple: v.index === null ? null : [v.index],
          values: { [row.key]: v.value },
        });
      }
    }
    return combos;
  };

  const mapCombos = fromMap();
  const displayCombos = fromDisplayData();
  if (mapCombos !== null && displayCombos !== null) {
    const byAsin = new Map(displayCombos.map((c) => [c.asin, c]));
    let differ = 0;
    for (const c of mapCombos) {
      const other = byAsin.get(c.asin);
      if (other === undefined || dims.some((k) => other.values[k] !== c.values[k])) differ++;
    }
    if (differ > 0 || mapCombos.length !== displayCombos.length) {
      meta.warnings.push(
        `variants: dimensionToAsinMap and dimensionValuesDisplayData disagree (${differ} of ${mapCombos.length} combinations)`,
      );
    }
  }
  const combos =
    firstOf<Combo[]>(
      "combinations",
      [
        ["blob-dimension-to-asin-map", () => mapCombos],
        ["blob-display-data", () => displayCombos],
        ["blob-asin-variation-values", fromAsinVariationValues],
        ["swatch-dom-single-dimension", fromSingleRow],
      ],
      meta,
      { optional: true },
    ) ?? [];

  // ---- identity
  const currentAsin =
    firstOf<string>(
      "current_asin",
      [
        ["blob", () => dpx?.currentAsin ?? dpx?.landingAsin],
        ["id", () => asinOf(doc.querySelector("input#ASIN")?.getAttribute("value") ?? undefined)],
        [
          "data-attr",
          () => asinOf(doc.querySelector("input#asin")?.getAttribute("value") ?? undefined),
        ],
        [
          "swatch-dom",
          () => {
            const counts = new Map<string, number>();
            for (const row of domRows) {
              const sel = row.values.find((v) => v.selected && v.asin !== null);
              if (sel?.asin != null) counts.set(sel.asin, (counts.get(sel.asin) ?? 0) + 1);
            }
            return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
          },
        ],
        ["text-anchor", () => asinFromUrl(capture.final_url) ?? asinFromUrl(capture.url)],
      ],
      meta,
      { optional: true },
    ) ?? null;
  const parentAsin =
    firstOf<string>(
      "parent_asin",
      [
        ["blob", () => dpx?.parentAsin],
        [
          "id",
          () => asinOf(doc.querySelector("input#parentASIN")?.getAttribute("value") ?? undefined),
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;

  if (dpx?.combinationId != null && dpx.toAsin != null && currentAsin !== null) {
    const mapped = dpx.toAsin[dpx.combinationId];
    if (mapped !== undefined && mapped !== currentAsin) {
      meta.warnings.push(
        "variants: currentDimensionCombinationId maps to a different ASIN than the current ASIN",
      );
    }
  }

  // ---- dimension values: JSON structure merged with DOM swatches
  const selectedIdx = dpx?.selected ?? {};
  const dimensions: VariantDimension[] = [];
  const asinConflicts: string[] = [];
  for (const key of dims) {
    const row = domByKey.get(key);
    const sortedValues = sorted?.[key];
    const canon = vv[key];

    interface Raw {
      value: string;
      index: number | null;
      asin: string | null;
      stateRaw: string | null;
      selected: boolean | null;
      kind: string | null;
      image: string | null;
    }
    const raws =
      firstOf<Raw[]>(
        `dimension_values.${key}`,
        [
          [
            "blob-sort-filter",
            () =>
              sortedValues?.map((v) => ({
                value: v.value,
                index: v.index,
                asin: v.asin,
                stateRaw: v.stateRaw,
                selected: v.stateRaw === null ? null : v.stateRaw.toUpperCase() === "SELECTED",
                kind: v.kind,
                image: v.image,
              })),
          ],
          [
            "blob-variation-values",
            () => {
              if (canon === undefined) return null;
              const list = canon.map((value, index) => ({
                value,
                index,
                asin: null,
                stateRaw: null,
                selected: selectedIdx[key] === undefined ? null : selectedIdx[key] === index,
                kind: null,
                image: null,
              }));
              if (row === undefined) return list;
              // Display order is the order of the swatches on the page.
              const rank = (value: string): number => {
                const at = row.values.findIndex(
                  (v) => v.value !== null && norm(v.value) === norm(value),
                );
                return at < 0 ? Number.MAX_SAFE_INTEGER : at;
              };
              return list.sort((a, b) => rank(a.value) - rank(b.value));
            },
          ],
          [
            "swatch-dom",
            () =>
              row?.values
                .filter((v) => v.value !== null)
                .map((v) => ({
                  value: v.value as string,
                  index: v.index,
                  asin: v.asin,
                  // The DOM state is merged below from the swatch itself.
                  stateRaw: null,
                  selected: v.selected,
                  kind: v.kind,
                  image: null,
                })),
          ],
        ],
        meta,
        { optional: true },
      ) ?? [];

    // JSON-vs-JSON and JSON-vs-DOM cross-checks.
    if (sortedValues !== undefined && canon !== undefined) {
      const a = new Set(sortedValues.map((v) => norm(v.value)));
      const b = new Set(canon.map(norm));
      if (a.size !== b.size || [...a].some((x) => !b.has(x))) {
        meta.warnings.push(
          `variants: sort-filter data and variationValues disagree on values of "${key}"`,
        );
      }
    }
    if (row !== undefined && raws.length > 0) {
      const jsonSet = new Set(raws.map((r) => norm(r.value)));
      const domSet = new Set(
        row.values.filter((v) => v.value !== null).map((v) => norm(v.value as string)),
      );
      const onlyJson = [...jsonSet].filter((x) => !domSet.has(x));
      const onlyDom = [...domSet].filter((x) => !jsonSet.has(x));
      if (onlyJson.length > 0 || onlyDom.length > 0) {
        meta.warnings.push(
          `variants: JSON and DOM disagree on values of "${key}" (json only: ${onlyJson.join("|") || "-"}; dom only: ${onlyDom.join("|") || "-"})`,
        );
      }
      const jsonSel = raws.find((r) => r.selected === true)?.value;
      const domSel = row.values.find((v) => v.selected)?.value;
      if (jsonSel != null && domSel != null && norm(jsonSel) !== norm(domSel)) {
        meta.warnings.push(`variants: JSON and DOM disagree on the selected value of "${key}"`);
      }
    }

    const values: VariantValue[] = raws.map((r) => {
      const dom =
        row?.values.find(
          (v) =>
            r.index !== null &&
            v.index === r.index &&
            (v.value === null || norm(v.value) === norm(r.value)),
        ) ?? row?.values.find((v) => v.value !== null && norm(v.value) === norm(r.value));
      if (r.asin !== null && dom?.asin != null && r.asin !== dom.asin) {
        asinConflicts.push(`${key}=${r.value}`);
      }
      const stateRaw = r.stateRaw ?? dom?.stateRaw ?? null;
      const state: VariantState =
        r.stateRaw !== null
          ? stateFromRaw(r.stateRaw)
          : dom !== undefined
            ? dom.state
            : combos.length > 0
              ? "available"
              : "unknown";
      return {
        value: r.value,
        index: r.index ?? dom?.index ?? null,
        asin: r.asin ?? dom?.asin ?? null,
        selected: r.selected ?? dom?.selected ?? false,
        state,
        state_raw: stateRaw,
        swatch_kind: r.kind ?? dom?.kind ?? null,
        swatch: dom?.swatch ?? (r.image === null ? null : { text: null, image: r.image }),
      };
    });
    for (const v of values) {
      if (v.swatch !== null && v.swatch.image === null) {
        const image = sortedValues?.find((s) => s.value === v.value)?.image ?? null;
        if (image !== null) v.swatch = { ...v.swatch, image };
      }
    }
    const selectedValue = values.find((v) => v.selected)?.value ?? null;
    const displayType = dpx?.displayTypes?.[dims.indexOf(key)] ?? row?.displayType ?? null;
    const singleton =
      dpx?.singletons?.includes(key) === true ||
      row?.singleton === true ||
      displayType === "singleton";
    dimensions.push({
      key,
      label: dpx?.labels?.[key] ?? row?.label ?? humanize(key),
      display_type: displayType,
      singleton,
      selected_value: selectedValue,
      values,
    });
  }

  if (asinConflicts.length > 0) {
    meta.warnings.push(
      `variants: ${asinConflicts.length} value(s) have a different default ASIN in the JSON than on their swatch (${asinConflicts.slice(0, 3).join(", ")}); swatch offers are filed under the swatch ASIN`,
    );
  }

  // Children without a default-ASIN on their value: derive from the combination map.
  const currentCombo = combos.find((c) => c.asin === currentAsin);
  for (const dim of dimensions) {
    for (const v of dim.values) {
      if (v.asin !== null || currentCombo === undefined) continue;
      const match = combos.find(
        (c) =>
          c.values[dim.key] === v.value &&
          dims.every((k) => k === dim.key || c.values[k] === currentCombo.values[k]),
      );
      if (match !== undefined) v.asin = match.asin;
    }
  }

  // DOM swatches vs the combination map.
  if (combos.length > 0) {
    const byAsin = new Map(combos.map((c) => [c.asin, c]));
    const bad: string[] = [];
    for (const row of domRows) {
      for (const v of row.values) {
        if (v.asin === null || v.value === null) continue;
        const c = byAsin.get(v.asin);
        if (c === undefined || norm(c.values[row.key] ?? "") !== norm(v.value)) bad.push(v.asin);
      }
    }
    if (bad.length > 0) {
      meta.warnings.push(
        `variants: ${bad.length} swatch ASIN(s) are not in the combination map under their value (${bad.slice(0, 3).join(", ")})`,
      );
    }
  }

  // ---- per-variant offers, only where a swatch shows one. An offer belongs to the ASIN of the
  // swatch it was read from (its own data-asin), never to an ASIN merged in from the JSON.
  const offerByAsin = new Map<string, VariantOffer>();
  for (const row of domRows) {
    for (const v of row.values) {
      if (v.asin === null || v.swatch === null || offerByAsin.has(v.asin)) continue;
      const { text: _text, image: _image, ...offer } = v.swatch;
      if (Object.keys(offer).length > 0) offerByAsin.set(v.asin, offer);
    }
  }
  const hasOffer = (o: VariantOffer | undefined): boolean =>
    o !== undefined &&
    (o.price !== undefined || o.availability !== undefined || o.delivery !== undefined);

  const combinations: VariantCombination[] = combos.map((c) => ({
    asin: c.asin,
    values: c.values,
    selected: c.asin === currentAsin,
    ...(offerByAsin.get(c.asin) ?? {}),
  }));

  const total =
    firstOf<number>(
      "total_variations",
      [
        ["blob", () => dpx?.total],
        ["blob-combinations", () => (combinations.length > 0 ? combinations.length : null)],
      ],
      meta,
      { optional: true },
    ) ?? null;
  let complete = true;
  if (dims.length > 0 && total !== null && combinations.length < total) {
    complete = false;
    meta.warnings.push(
      combinations.length === 0
        ? `variants: the page declares ${total} variants but inlines no combination map (family too large to inline); per-value child ASINs are in dimensions[].values[].asin`
        : `variants: the page lists ${combinations.length} of ${total} declared combinations (family too large to inline)`,
    );
  } else if (dims.length > 0 && combinations.length === 0) {
    complete = false;
  }

  // Per-value default ASINs (the ones a shopper sees as choices) come first, in display order,
  // because the fetch budget is small; every other child follows, sorted.
  const known = new Set<string>();
  for (const dim of dimensions) for (const v of dim.values) if (v.asin !== null) known.add(v.asin);
  const rest = combinations.map((c) => c.asin).filter((asin) => !known.has(asin));
  const missing = [...known, ...rest.sort()].filter(
    (asin) => asin !== currentAsin && !hasOffer(offerByAsin.get(asin)),
  );

  if (currentAsin === null && dimensions.length === 0 && dpx === null) {
    throw new RfError("layout_unrecognized", "no product identity found");
  }

  gate.report(meta, "variants");
  return {
    data: {
      parent_asin: parentAsin,
      current_asin: currentAsin,
      dimensions,
      combinations,
      total_variations: total,
      combinations_complete: complete,
      missing_offer_asins: missing,
    },
    other_sections: [],
    meta,
  };
};

function cmpTuple(a: readonly number[] | null, b: readonly number[] | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
