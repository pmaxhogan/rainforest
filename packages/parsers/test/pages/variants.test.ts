import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { parseVariants } from "../../src/pages/variants.ts";
import type { VariantsData } from "../../src/pages/variants.ts";

function capture(html: string): Capture {
  return {
    kind: "product",
    url: "https://www.example.com/dp/B0FAKE0001",
    final_url: "https://www.example.com/dp/B0FAKE0001",
    captured_at: "2000-01-01T00:00:00.000Z",
    html,
  };
}

const page = (body: string): string =>
  `<!DOCTYPE html><html><head></head><body><span id="productTitle">Invented product</span>${body}</body></html>`;

// ---- builders that reproduce the structure of the page (ids, classes, attributes) with invented content

interface DpxSpec {
  dimensions: string[];
  /** Object key order is deliberately independent of `dimensions`. */
  variationValues: Record<string, string[]>;
  labels?: Record<string, string>;
  selected: Record<string, number>;
  /** "i_j_k" -> ASIN, one index per dimension in the order of `dimensions`. */
  map?: Record<string, string>;
  displayData?: Record<string, string[]>;
  asinVariationValues?: Record<string, Record<string, string>>;
  total?: number;
  current?: string;
  parent?: string;
  singletons?: string[];
  combinationId?: string;
  /** Raw replacements for keys, to make a payload malformed. */
  raw?: Record<string, string>;
}

function dpxScript(spec: DpxSpec): string {
  const j = (k: string, v: unknown): string => spec.raw?.[k] ?? JSON.stringify(v);
  const parts: string[] = [
    `"isTabletWeb" : false`,
    `"ajaxUrlParams" : "&productTypeDefinition=FAKE&parentAsin=${spec.parent ?? "B0FAKE0000"}" + "&landingAsin=${spec.current ?? "B0FAKE0001"}"`,
    `"updateDivLists" : { "full" : [{"dtu":"fake_feature_div","lb":0}], }`,
    `"currentAsin" : "${spec.current ?? "B0FAKE0001"}"`,
    `"landingAsin": "${spec.current ?? "B0FAKE0001"}"`,
    `"parentAsin" : "${spec.parent ?? "B0FAKE0000"}"`,
  ];
  if (spec.map !== undefined)
    parts.push(`"dimensionToAsinMap" : ${j("dimensionToAsinMap", spec.map)}`);
  if (spec.asinVariationValues !== undefined) {
    parts.push(`"asinVariationValues" : ${j("asinVariationValues", spec.asinVariationValues)}`);
  }
  parts.push(
    `"variationValues" : ${j("variationValues", spec.variationValues)}`,
    `"selectedVariationValues" : ${j("selectedVariationValues", spec.selected)}`,
    `"currentDimensionCombinationId" : "${spec.combinationId ?? ""}"`,
    `"num_total_variations" : ${spec.total ?? Object.keys(spec.map ?? {}).length}`,
    `"dimensions" : ${j("dimensions", spec.dimensions)}`,
    // The real page ends this array with a trailing comma, which is not valid JSON.
    `"dimensionsDisplayType" : [ ${spec.dimensions.map((d) => (spec.singletons?.includes(d) === true ? '"singleton"' : '"swatch"')).join(",")}, ]`,
  );
  if (spec.displayData !== undefined) {
    parts.push(
      `"dimensionValuesDisplayData" : ${j("dimensionValuesDisplayData", spec.displayData)}`,
    );
  }
  parts.push(
    `"variationDisplayLabels" : ${j("variationDisplayLabels", spec.labels ?? {})}`,
    `"singletonDimensionKeys" : ${JSON.stringify(spec.singletons ?? [])}`,
    `"unavailablePopOverStringValue" : "See available options"`,
  );
  return `<script type="text/javascript"> P.register('twister-js-init-dpx-data', function() { var dataToReturn = { ${parts.join(", ")} }; return dataToReturn; }); </script>`;
}

interface SortedSpec {
  value: string;
  index: number;
  asin: string;
  state: string;
  kind?: string;
  image?: string;
}

function sortFilterState(dims: Record<string, SortedSpec[]>): string {
  const sortedDimValuesForAllDims: Record<string, unknown[]> = {};
  for (const [key, list] of Object.entries(dims)) {
    sortedDimValuesForAllDims[key] = list.map((s) => ({
      indexInDimList: s.index,
      defaultAsin: s.asin,
      dimensionValueState: s.state,
      dimensionValueDisplayText: s.value,
      dimensionDisplaySubType: s.kind ?? "text",
      ...(s.image === undefined ? {} : { imageAttribute: { url: s.image, width: 40, height: 40 } }),
    }));
  }
  const payload = JSON.stringify({ sortedVariations: [], sortedDimValuesForAllDims });
  return `<script type="a-state" data-a-state="{&quot;key&quot;:&quot;desktop-twister-sort-filter-data&quot;}">${payload}</script>`;
}

interface LiSpec {
  asin: string;
  index: number;
  label: string;
  selected?: boolean;
  /** "swatchAvailable" (default), "swatchUnavailable" or "swatchCurrentlyUnavailable". */
  slot?: string;
  flaggedUnavailable?: boolean;
  hidden?: boolean;
  image?: string;
  price?: string;
  list?: string;
  unit?: string;
  caption?: string;
  stock?: string;
  delivery?: string;
  /** Qualifier text next to the price, for example "with a membership". */
  note?: string;
  /** A badge picture inside the slot (it is not a swatch image). */
  badge?: boolean;
}

function swatchLi(s: LiSpec): string {
  const slot = s.slot ?? "swatchAvailable";
  const labelHtml =
    s.image === undefined
      ? `<div class="a-section a-spacing-none swatch-title-text-container"><span class="a-size-base swatch-title-text-display swatch-title-text">${s.label}</span></div>`
      : `<img id="inline-twister-image-${s.index}" class="swatch-image" src="${s.image}" alt="${s.label}">`;
  const slotHtml: string[] = [];
  if (s.price !== undefined) {
    slotHtml.push(
      `<div id="apex_price" class="a-section a-spacing-none apex_on_twister_price"><div class="apex-core-price-identifier">` +
        `<span class="aok-offscreen apex-pricetopay-accessibility-label"> ${s.price} with 10 percent savings</span>` +
        `<span class="a-price a-text-price apex-pricetopay-value" data-a-size="s"><span class="a-offscreen"></span><span aria-hidden="true">${s.price}</span></span>` +
        (s.list === undefined
          ? ""
          : `<div class="a-section"><span class="apex-basisprice-feature"><span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${s.list}</span><span aria-hidden="true">${s.list}</span></span></span></div>`) +
        (s.unit === undefined
          ? ""
          : `<div class="a-section"><span class="aok-relative"><span class="a-size-mini aok-offscreen apex-priceperunit-accessibility-label">${s.unit} per count</span><span class="a-size-mini a-color-base">(<span class="a-price a-text-price apex-priceperunit-value"><span class="a-offscreen">${s.unit}</span><span>${s.unit}</span></span>/ count)</span></span></div>`) +
        `</div></div>`,
    );
  }
  if (s.caption !== undefined) {
    slotHtml.push(
      `<div><span class="buyingOptionTwisterSwatchCaption a-size-micro">${s.caption}</span></div>`,
    );
  }
  if (s.badge === true) {
    slotHtml.push(`<p><img src="https://m.media-amazon.com/images/I/FAKEBADGE01.png" alt=""></p>`);
  }
  if (s.note !== undefined) {
    slotHtml.push(`<p><span>${s.note}</span></p>`);
  }
  if (s.stock !== undefined) {
    slotHtml.push(
      `<div class="aok-hidden" data-rf-hidden="1"><span id="twisterAvailability" class="a-size-small">${s.stock}</span></div>`,
    );
  }
  if (s.delivery !== undefined) {
    slotHtml.push(
      `<span id="deliveryPromisePrefix"><div class="udm-delivery-block"><div class="udm-primary-delivery-message"><span class="a-text-bold">${s.delivery}</span></div></div></span>`,
    );
  }
  const slots =
    slotHtml.length === 0
      ? ""
      : `<hr class="a-divider-normal"><div class="a-section dimension-slot-info">${slotHtml.join("")}</div>`;
  const buttonClass = [
    "a-button a-button-toggle",
    s.selected === true ? "a-button-selected" : "",
    s.flaggedUnavailable === true ? "a-button-unavailable" : "",
    slotHtml.length > 0 ? "text-swatch-button-with-slots" : "text-swatch-button",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<li data-asin="${s.asin}" data-collapsed-view="true" data-csa-c-slot-id="twister-desktop-twister-swatch-${slot}" ` +
    `data-idxintoggleswatchlist="${s.index}" data-initiallyselected="${s.selected === true}" data-initiallyunavailable="${s.flaggedUnavailable === true}" ` +
    `class="swatch-list-item-text inline-twister-swatch a-declarative"${s.hidden === true ? ' data-rf-hidden="1"' : ""}>` +
    `<span class="a-list-item"><span id="${s.label}_${s.index}" class="${buttonClass}"><span class="a-button-inner">` +
    `<input name="${s.index}" role="radio" aria-checked="${s.selected === true}" class="a-button-input" type="submit">` +
    `<span class="a-button-text" aria-hidden="true"><div class="a-section text-swatch-container">${labelHtml}${slots}</div></span>` +
    `</span></span></span></li>`
  );
}

function plusRow(
  key: string,
  label: string,
  selectedText: string,
  lis: LiSpec[],
  hidden = false,
): string {
  return (
    `<div id="inline-twister-row-${key}" class="a-section a-spacing-none inline-twister-row"${hidden ? ' data-rf-hidden="1"' : ""}>` +
    `<div id="inline-twister-expander-header-${key}" aria-label="Selected ${label} is ${selectedText}. Tap to collapse." class="dimension-heading">` +
    `<div id="inline-twister-dim-title-${key}" class="dimension-text"><span class="a-size-base a-color-secondary"> ${label}: </span>` +
    `<span id="inline-twister-expanded-dimension-text-${key}" class="inline-twister-dim-title-value a-text-bold"> ${selectedText} </span></div></div>` +
    `<div id="inline-twister-expander-content-${key}" aria-label="There are ${lis.length} options."><div class="a-section">` +
    `<span id="dim-values-aria-label-${key}" style="display:none" data-rf-hidden="1"> Make a ${label} selection </span>` +
    `<ul class="a-unordered-list a-button-list dimension-values-list" role="radiogroup">${lis.map(swatchLi).join("")}` +
    `<li class="carousel-prevnext-disabled" data-rf-hidden="1"></li></ul></div></div></div>`
  );
}

function singletonHeader(key: string, label: string, value: string): string {
  return (
    `<div id="inline-twister-singleton-header-${key}" class="a-section inline-twister-singleton-header">` +
    `<span class="a-size-base a-color-secondary inline-twister-dim-title"> ${label}: </span>` +
    `<span id="inline-twister-expanded-dimension-text-${key}" class="inline-twister-dim-title-value-truncate a-text-bold"> ${value} </span></div>`
  );
}

const TWISTER = (rows: string): string =>
  `<div id="twister_feature_div"><div id="twister-plus-inline-twister"><div id="twister-plus-desktop-twister-container">${rows}</div></div></div>`;

// ---- a one-dimension family: values Small(0) Medium(1) Large(2); display order Small, Large, Medium

const SIZE_SPEC: DpxSpec = {
  dimensions: ["size_name"],
  variationValues: { size_name: ["Small", "Medium", "Large"] },
  labels: { size_name: "Size" },
  selected: { size_name: 1 },
  map: { "0": "B0FAKE0002", "1": "B0FAKE0001", "2": "B0FAKE0003" },
  displayData: { B0FAKE0002: ["Small"], B0FAKE0001: ["Medium"], B0FAKE0003: ["Large"] },
  total: 3,
  current: "B0FAKE0001",
  parent: "B0FAKE0000",
  combinationId: "1",
};

const SIZE_SORTED: SortedSpec[] = [
  { value: "Small", index: 0, asin: "B0FAKE0002", state: "AVAILABLE" },
  { value: "Large", index: 2, asin: "B0FAKE0003", state: "AVAILABLE" },
  { value: "Medium", index: 1, asin: "B0FAKE0001", state: "SELECTED" },
];

const SIZE_LIS: LiSpec[] = [
  {
    asin: "B0FAKE0002",
    index: 0,
    label: "Small",
    price: "$9.99",
    list: "$12.99",
    unit: "$0.40",
    caption: "Used",
    stock: "In Stock",
    delivery: "Tomorrow, Jan 1",
  },
  { asin: "B0FAKE0003", index: 2, label: "Large" },
  {
    asin: "B0FAKE0001",
    index: 1,
    label: "Medium",
    selected: true,
    price: "$11.50",
    delivery: "Jan 3 - 5",
    note: "with a membership",
    badge: true,
  },
];

function sizeFamily(
  over: { dpx?: Partial<DpxSpec>; sorted?: SortedSpec[]; lis?: LiSpec[]; extra?: string } = {},
): string {
  return page(
    dpxScript({ ...SIZE_SPEC, ...over.dpx }) +
      sortFilterState({ size_name: over.sorted ?? SIZE_SORTED }) +
      TWISTER(plusRow("size_name", "Size", "Medium", over.lis ?? SIZE_LIS)) +
      (over.extra ?? ""),
  );
}

const parse = (html: string) => parseVariants(capture(html));
const data = (html: string): VariantsData => parse(html).data;

describe("parseVariants: one dimension", () => {
  it("reads dimensions, display order, indexes, selection and the combination map", () => {
    const { data: d, meta, other_sections } = parse(sizeFamily());
    expect(d.parent_asin).toBe("B0FAKE0000");
    expect(d.current_asin).toBe("B0FAKE0001");
    expect(d.dimensions).toHaveLength(1);
    const size = d.dimensions[0];
    expect(size).toMatchObject({
      key: "size_name",
      label: "Size",
      display_type: "swatch",
      singleton: false,
      selected_value: "Medium",
    });
    // Display order is the swatch order; `index` is the canonical position used by the map ids.
    expect(size?.values.map((v) => [v.value, v.index, v.asin, v.selected, v.state])).toEqual([
      ["Small", 0, "B0FAKE0002", false, "available"],
      ["Large", 2, "B0FAKE0003", false, "available"],
      ["Medium", 1, "B0FAKE0001", true, "available"],
    ]);
    expect(size?.values[0]?.state_raw).toBe("AVAILABLE");
    expect(size?.values[0]?.swatch_kind).toBe("text");
    expect(d.combinations.map((c) => [c.asin, c.values, c.selected])).toEqual([
      ["B0FAKE0002", { size_name: "Small" }, false],
      ["B0FAKE0001", { size_name: "Medium" }, true],
      ["B0FAKE0003", { size_name: "Large" }, false],
    ]);
    expect(d.total_variations).toBe(3);
    expect(d.combinations_complete).toBe(true);
    expect(meta.warnings).toEqual([]);
    expect(meta.strategies).toMatchObject({
      dom_rows: "swatch-dom",
      dimension_keys: "blob-dimensions",
      combinations: "blob-dimension-to-asin-map",
      current_asin: "blob",
      parent_asin: "blob",
      "dimension_values.size_name": "blob-sort-filter",
      total_variations: "blob",
    });
    expect(other_sections).toEqual([]);
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("exposes per-variant price, availability and delivery only where a swatch shows them", () => {
    const d = data(sizeFamily());
    const byAsin = Object.fromEntries(d.combinations.map((c) => [c.asin, c]));
    expect(byAsin["B0FAKE0002"]).toMatchObject({
      price: { amount: 9.99, currency: "USD", raw: "$9.99" },
      list_price: { amount: 12.99, currency: "USD", raw: "$12.99" },
      unit_price: { amount: 0.4, currency: "USD", raw: "$0.40" },
      unit: "count",
      caption: "Used",
      availability: "In Stock",
      delivery: "Tomorrow, Jan 1",
    });
    expect(byAsin["B0FAKE0001"]?.price?.amount).toBe(11.5);
    // A price is never read without its qualifier.
    expect(byAsin["B0FAKE0001"]?.note).toBe("with a membership");
    expect(byAsin["B0FAKE0002"]?.note).toBeUndefined();
    // A badge picture inside a text swatch is not the swatch image.
    const medium = d.dimensions[0]?.values.find((v) => v.value === "Medium");
    expect(medium?.swatch_kind).toBe("text");
    expect(medium?.swatch?.image).toBeNull();
    expect(byAsin["B0FAKE0001"]?.delivery).toBe("Jan 3 - 5");
    expect(byAsin["B0FAKE0001"]?.availability).toBeUndefined();
    expect(byAsin["B0FAKE0003"]).toEqual({
      asin: "B0FAKE0003",
      values: { size_name: "Large" },
      selected: false,
    });
    // Large shows no offer and is not the current ASIN: the flow has to fetch it.
    expect(d.missing_offer_asins).toEqual(["B0FAKE0003"]);
  });

  it("keeps the swatch text as rendered, without screen-reader-only text or duplicate prices", () => {
    const d = data(sizeFamily());
    const small = d.dimensions[0]?.values[0];
    expect(small?.swatch?.text).toBe("Small $9.99 $12.99 ($0.40/ count) Used Tomorrow, Jan 1");
    expect(small?.swatch?.text).not.toContain("percent savings");
    // A swatch with a label only still reports its text.
    expect(d.dimensions[0]?.values[1]?.swatch).toEqual({ text: "Large", image: null });
  });

  it("records the hidden stock-note node as its own strategy", () => {
    expect(parse(sizeFamily()).meta.strategies["swatch_availability"]).toBe(
      "twister-availability-node",
    );
  });

  it("falls back to variationValues (re-ordered by the swatches) when the sort-filter state is absent", () => {
    const html = page(
      dpxScript(SIZE_SPEC) + TWISTER(plusRow("size_name", "Size", "Medium", SIZE_LIS)),
    );
    const { data: d, meta } = parse(html);
    expect(meta.strategies["dimension_values.size_name"]).toBe("blob-variation-values");
    expect(d.dimensions[0]?.values.map((v) => [v.value, v.index, v.selected])).toEqual([
      ["Small", 0, false],
      ["Large", 2, false],
      ["Medium", 1, true],
    ]);
    // The ASIN of each value comes from the swatch; state from the swatch slot.
    expect(d.dimensions[0]?.values.map((v) => v.asin)).toEqual([
      "B0FAKE0002",
      "B0FAKE0003",
      "B0FAKE0001",
    ]);
    expect(d.dimensions[0]?.values[0]?.state).toBe("available");
  });

  it("derives a missing default ASIN from the combination that keeps the other dimensions", () => {
    const sorted = SIZE_SORTED.map((s) => ({ ...s, asin: "" }));
    const html = page(dpxScript(SIZE_SPEC) + sortFilterState({ size_name: sorted }));
    const d = data(html);
    expect(d.dimensions[0]?.values.map((v) => v.asin)).toEqual([
      "B0FAKE0002",
      "B0FAKE0003",
      "B0FAKE0001",
    ]);
  });
});

// Tuple ids follow `dimensions` (color_name, size_name), NOT the key order of variationValues.
function twoDimFamily(over: Partial<DpxSpec> = {}): string {
  const spec: DpxSpec = {
    dimensions: ["color_name", "size_name"],
    variationValues: { size_name: ["S", "M", "L"], color_name: ["Red", "Blue"] },
    labels: { color_name: "Color", size_name: "Size" },
    selected: { color_name: 0, size_name: 1 },
    // (Red,L) and (Blue,M) do not exist: they are missing from the map.
    map: { "0_0": "B0FAKE0011", "0_1": "B0FAKE0012", "1_0": "B0FAKE0013", "1_2": "B0FAKE0014" },
    displayData: {
      B0FAKE0011: ["Red", "S"],
      B0FAKE0012: ["Red", "M"],
      B0FAKE0013: ["Blue", "S"],
      B0FAKE0014: ["Blue", "L"],
    },
    total: 4,
    current: "B0FAKE0012",
    parent: "B0FAKE0010",
    combinationId: "0_1",
    ...over,
  };
  return page(
    dpxScript(spec) +
      sortFilterState({
        color_name: [
          { value: "Red", index: 0, asin: "B0FAKE0012", state: "SELECTED" },
          { value: "Blue", index: 1, asin: "B0FAKE0013", state: "UNAVAILABLE" },
        ],
        size_name: [
          { value: "S", index: 0, asin: "B0FAKE0011", state: "AVAILABLE" },
          { value: "M", index: 1, asin: "B0FAKE0012", state: "SELECTED" },
          { value: "L", index: 2, asin: "B0FAKE0014", state: "UNAVAILABLE" },
        ],
      }) +
      TWISTER(
        plusRow("color_name", "Color", "Red", [
          { asin: "B0FAKE0012", index: 0, label: "Red", selected: true, price: "$5.00" },
          {
            asin: "B0FAKE0013",
            index: 1,
            label: "Blue",
            slot: "swatchUnavailable",
            flaggedUnavailable: true,
          },
        ]) +
          plusRow("size_name", "Size", "M", [
            { asin: "B0FAKE0011", index: 0, label: "S" },
            { asin: "B0FAKE0012", index: 1, label: "M", selected: true },
            {
              asin: "B0FAKE0014",
              index: 2,
              label: "L",
              slot: "swatchUnavailable",
              flaggedUnavailable: true,
            },
          ]),
      ),
  );
}

describe("parseVariants: two dimensions with an unavailable combination", () => {
  const html = twoDimFamily();

  it("decodes combination ids in the order of `dimensions` and omits the missing combinations", () => {
    const { data: d, meta } = parse(html);
    expect(d.dimensions.map((x) => x.key)).toEqual(["color_name", "size_name"]);
    expect(
      d.combinations.map((c) => [c.asin, c.values["color_name"], c.values["size_name"]]),
    ).toEqual([
      ["B0FAKE0011", "Red", "S"],
      ["B0FAKE0012", "Red", "M"],
      ["B0FAKE0013", "Blue", "S"],
      ["B0FAKE0014", "Blue", "L"],
    ]);
    expect(
      d.combinations.find((c) => c.values["color_name"] === "Red" && c.values["size_name"] === "L"),
    ).toBeUndefined();
    expect(d.total_variations).toBe(4);
    expect(d.combinations_complete).toBe(true);
    expect(meta.warnings).toEqual([]);
  });

  it("reports the page's availability wording per value", () => {
    const d = data(html);
    const blue = d.dimensions[0]?.values[1];
    expect(blue).toMatchObject({
      value: "Blue",
      state: "see_options",
      state_raw: "UNAVAILABLE",
      selected: false,
    });
    const large = d.dimensions[1]?.values[2];
    expect(large).toMatchObject({ value: "L", state: "see_options" });
    expect(d.dimensions[0]?.selected_value).toBe("Red");
    expect(d.dimensions[1]?.selected_value).toBe("M");
    expect(d.missing_offer_asins).toEqual(["B0FAKE0013", "B0FAKE0011", "B0FAKE0014"]);
  });

  it("flags a decode that disagrees with dimensionValuesDisplayData", () => {
    const bad = html.replace('"B0FAKE0014":["Blue","L"]', '"B0FAKE0014":["Red","L"]');
    expect(bad).not.toBe(html);
    const { meta } = parse(bad);
    expect(meta.warnings).toContain(
      "variants: dimensionToAsinMap and dimensionValuesDisplayData disagree (1 of 4 combinations)",
    );
  });

  it("flags a current combination id that maps to another ASIN", () => {
    const { meta } = parse(
      html.replace(
        '"currentDimensionCombinationId" : "0_1"',
        '"currentDimensionCombinationId" : "1_0"',
      ),
    );
    expect(meta.warnings.join("\n")).toContain(
      "currentDimensionCombinationId maps to a different ASIN",
    );
  });
});

describe("parseVariants: singleton dimension and image swatches", () => {
  const spec: DpxSpec = {
    dimensions: ["color_name", "pack_name"],
    variationValues: { color_name: ["Black"], pack_name: ["1", "2"] },
    labels: { color_name: "Color", pack_name: "Pack" },
    selected: { color_name: 0, pack_name: 0 },
    map: { "0_0": "B0FAKE0021", "0_1": "B0FAKE0022" },
    singletons: ["color_name"],
    total: 2,
    current: "B0FAKE0021",
  };
  const html = page(
    dpxScript(spec) +
      sortFilterState({
        color_name: [
          {
            value: "Black",
            index: 0,
            asin: "B0FAKE0021",
            state: "SELECTED",
            image: "https://m.media-amazon.com/images/I/FAKESWATCH1._SS64_.jpg",
          },
        ],
        pack_name: [
          { value: "1", index: 0, asin: "B0FAKE0021", state: "SELECTED" },
          { value: "2", index: 1, asin: "B0FAKE0022", state: "AVAILABLE" },
        ],
      }) +
      TWISTER(
        plusRow("pack_name", "Pack", "1", [
          { asin: "B0FAKE0021", index: 0, label: "1", selected: true },
          { asin: "B0FAKE0022", index: 1, label: "2" },
        ]) + singletonHeader("color_name", "Color", "Black"),
      ),
  );

  it("marks the singleton dimension and keeps its single selected value", () => {
    const d = data(html);
    const color = d.dimensions.find((x) => x.key === "color_name");
    expect(color).toMatchObject({
      singleton: true,
      display_type: "singleton",
      selected_value: "Black",
    });
    expect(color?.values).toHaveLength(1);
    expect(color?.values[0]?.swatch?.image).toBe(
      "https://m.media-amazon.com/images/I/FAKESWATCH1._SS64_.jpg",
    );
    expect(d.dimensions.find((x) => x.key === "pack_name")?.singleton).toBe(false);
    expect(d.combinations.map((c) => c.values)).toEqual([
      { color_name: "Black", pack_name: "1" },
      { color_name: "Black", pack_name: "2" },
    ]);
  });

  it("reads image swatches (label from alt) and rejects a non-Amazon swatch image", () => {
    const row = plusRow("color_name", "Color", "Red", [
      {
        asin: "B0FAKE0031",
        index: 0,
        label: "Red",
        selected: true,
        image: "https://images.example.com/placeholder.png",
        price: "$3.00",
      },
      {
        asin: "B0FAKE0032",
        index: 1,
        label: "Blue",
        image: "https://m.media-amazon.com/images/I/FAKESWATCH2._SS64_.jpg",
      },
    ]);
    const { data: d, meta } = parse(page(TWISTER(row)));
    const values = d.dimensions[0]?.values;
    expect(values?.map((v) => [v.value, v.swatch_kind, v.swatch?.image ?? null])).toEqual([
      ["Red", "image", null],
      ["Blue", "image", "https://m.media-amazon.com/images/I/FAKESWATCH2._SS64_.jpg"],
    ]);
    expect(values?.[0]?.swatch?.price?.amount).toBe(3);
    expect(meta.warnings.join("\n")).toContain("variants: dropped 1 URL(s)");
    expect(meta.warnings.join("\n")).toContain("images.example.com");
  });
});

describe("parseVariants: availability wording from the swatch DOM", () => {
  it("separates 'currently unavailable' from 'see available options'", () => {
    const row = plusRow("size_name", "Size", "S", [
      { asin: "B0FAKE0041", index: 0, label: "S", selected: true },
      {
        asin: "B0FAKE0042",
        index: 1,
        label: "M",
        slot: "swatchCurrentlyUnavailable",
        flaggedUnavailable: true,
      },
      {
        asin: "B0FAKE0043",
        index: 2,
        label: "L",
        slot: "swatchUnavailable",
        flaggedUnavailable: true,
      },
      { asin: "B0FAKE0044", index: 3, label: "XL", flaggedUnavailable: true },
    ]);
    const d = data(page(TWISTER(row)));
    expect(d.dimensions[0]?.values.map((v) => [v.value, v.state])).toEqual([
      ["S", "available"],
      ["M", "unavailable"],
      ["L", "see_options"],
      ["XL", "see_options"],
    ]);
  });

  it("maps unknown JSON state names to unknown rather than guessing", () => {
    const html = sizeFamily({
      sorted: SIZE_SORTED.map((s, i) => (i === 0 ? { ...s, state: "SOMETHING_NEW" } : s)),
    });
    const d = data(html);
    expect(d.dimensions[0]?.values[0]).toMatchObject({
      state: "unknown",
      state_raw: "SOMETHING_NEW",
    });
  });
});

describe("parseVariants: no variants", () => {
  it("returns empty dimensions, not an error", () => {
    const html = page(
      `<input type="hidden" id="ASIN" name="ASIN" value="B0FAKE0009"><div id="centerCol">Invented content</div>`,
    );
    const { data: d, meta, other_sections } = parse(html);
    expect(d).toEqual({
      parent_asin: null,
      current_asin: "B0FAKE0009",
      dimensions: [],
      combinations: [],
      total_variations: null,
      combinations_complete: true,
      missing_offer_asins: [],
    });
    expect(meta.strategies["current_asin"]).toBe("id");
    expect(meta.warnings).toEqual([]);
    expect(other_sections).toEqual([]);
  });

  it("falls back to the captured URL for the ASIN", () => {
    const { data: d, meta } = parse(page(""));
    expect(d.current_asin).toBe("B0FAKE0001");
    expect(meta.strategies["current_asin"]).toBe("text-anchor");
  });

  it("ignores template rows that are not rendered", () => {
    const html = page(
      TWISTER(
        plusRow(
          "ghost_name",
          "Ghost",
          "A",
          [{ asin: "B0FAKE0051", index: 0, label: "A", selected: true }],
          true,
        ),
      ),
    );
    expect(data(html).dimensions).toEqual([]);
  });

  it("throws layout_unrecognized for a page with no product markers", () => {
    const blank = capture("<!DOCTYPE html><html><head></head><body><p>hello</p></body></html>");
    expect(() => parseVariants(blank)).toThrow(RfError);
    try {
      parseVariants(blank);
    } catch (error) {
      expect((error as RfError).payload.code).toBe("layout_unrecognized");
    }
  });
});

describe("parseVariants: JSON and DOM disagreement", () => {
  it("warns when the swatches show different values than the JSON", () => {
    const lis = SIZE_LIS.map((l) => (l.label === "Large" ? { ...l, label: "Extra Large" } : l));
    const { meta } = parse(sizeFamily({ lis }));
    expect(meta.warnings).toContain(
      'variants: JSON and DOM disagree on values of "size_name" (json only: large; dom only: extra large)',
    );
  });

  it("warns when they disagree on the selected value", () => {
    const lis = SIZE_LIS.map((l) => ({ ...l, selected: l.label === "Small" }));
    const { meta } = parse(sizeFamily({ lis }));
    expect(meta.warnings).toContain(
      'variants: JSON and DOM disagree on the selected value of "size_name"',
    );
  });

  it("warns when a swatch ASIN is not in the combination map under its value", () => {
    const lis = SIZE_LIS.map((l) => (l.label === "Large" ? { ...l, asin: "B0FAKE0002" } : l));
    const { meta } = parse(sizeFamily({ lis }));
    expect(meta.warnings.join("\n")).toContain(
      "1 swatch ASIN(s) are not in the combination map under their value",
    );
  });

  it("files a swatch offer under the swatch's own ASIN and warns when the JSON ASIN differs", () => {
    const sorted = SIZE_SORTED.map((s) => (s.value === "Large" ? { ...s, asin: "B0FAKE0009" } : s));
    const lis = SIZE_LIS.map((l) => (l.label === "Large" ? { ...l, price: "$20.00" } : l));
    const { data: d, meta } = parse(sizeFamily({ sorted, lis }));
    expect(meta.warnings.join("\n")).toContain(
      "1 value(s) have a different default ASIN in the JSON than on their swatch (size_name=Large)",
    );
    const large = d.combinations.find((c) => c.asin === "B0FAKE0003");
    expect(large?.price?.amount).toBe(20);
    expect(d.combinations.find((c) => c.asin === "B0FAKE0009")).toBeUndefined();
    // The ASIN the JSON named never received the price.
    expect(d.missing_offer_asins).toContain("B0FAKE0009");
  });

  it("warns when the sort-filter state and variationValues disagree", () => {
    const sorted = SIZE_SORTED.map((s) => (s.value === "Large" ? { ...s, value: "Huge" } : s));
    const { meta } = parse(sizeFamily({ sorted }));
    expect(meta.warnings).toContain(
      'variants: sort-filter data and variationValues disagree on values of "size_name"',
    );
  });
});

describe("parseVariants: malformed blobs and DOM-only pages", () => {
  it("falls back to dimensionValuesDisplayData when the map is malformed JSON", () => {
    const { data: d, meta } = parse(
      sizeFamily({ dpx: { raw: { dimensionToAsinMap: '{"0":"B0FAKE0002",' } } }),
    );
    expect(meta.warnings).toContain('variants: "dimensionToAsinMap" blob is malformed JSON');
    expect(meta.strategies["combinations"]).toBe("blob-display-data");
    expect(d.combinations.map((c) => c.asin).sort()).toEqual([
      "B0FAKE0001",
      "B0FAKE0002",
      "B0FAKE0003",
    ]);
  });

  it("falls back to the swatch DOM when every JSON source is unusable", () => {
    const html = page(
      dpxScript({
        ...SIZE_SPEC,
        map: undefined,
        displayData: undefined,
        raw: { dimensions: "[oops", variationValues: "{oops" },
      }) + TWISTER(plusRow("size_name", "Size", "Medium", SIZE_LIS)),
    );
    const { data: d, meta } = parse(html);
    expect(meta.warnings).toEqual(
      expect.arrayContaining([
        'variants: "dimensions" blob is malformed JSON',
        'variants: "variationValues" blob is malformed JSON',
      ]),
    );
    expect(meta.strategies["dimension_keys"]).toBe("swatch-dom");
    expect(meta.strategies["dimension_values.size_name"]).toBe("swatch-dom");
    expect(meta.strategies["combinations"]).toBe("swatch-dom-single-dimension");
    expect(d.dimensions[0]).toMatchObject({
      key: "size_name",
      label: "Size",
      selected_value: "Medium",
    });
    expect(d.dimensions[0]?.values.map((v) => v.value)).toEqual(["Small", "Large", "Medium"]);
    expect(d.combinations.map((c) => [c.asin, c.values["size_name"]])).toEqual([
      ["B0FAKE0002", "Small"],
      ["B0FAKE0003", "Large"],
      ["B0FAKE0001", "Medium"],
    ]);
  });

  it("reports a malformed variant-looking a-state blob and unknown twister blobs", () => {
    const extra =
      `<script type="a-state" data-a-state='{"key":"inventedTwisterThing"}'>{"x":1}</script>` +
      `<script type="a-state" data-a-state='{"key":"brokenVariationState"}'>{"x":</script>` +
      `<script type="a-state" data-a-state='{"key":"unrelated-cart-state"}'>{"x":1}</script>`;
    const { meta } = parse(sizeFamily({ extra }));
    expect(meta.unknown_blobs).toEqual(["inventedTwisterThing", "brokenVariationState"]);
    expect(meta.warnings).toContain('variants: blob "brokenVariationState" is malformed JSON');
  });

  it("reads the legacy asinVariationValues blob", () => {
    const html = page(
      dpxScript({
        ...SIZE_SPEC,
        map: undefined,
        displayData: undefined,
        asinVariationValues: {
          B0FAKE0002: { size_name: "0" },
          B0FAKE0001: { size_name: "1" },
          B0FAKE0003: { size_name: "2" },
          NOTANASIN: { size_name: "0" },
          B0FAKE0009: { size_name: "7" },
        },
      }),
    );
    const { data: d, meta } = parse(html);
    expect(meta.strategies["combinations"]).toBe("blob-asin-variation-values");
    expect(d.combinations.map((c) => [c.asin, c.values["size_name"]])).toEqual([
      ["B0FAKE0002", "Small"],
      ["B0FAKE0001", "Medium"],
      ["B0FAKE0003", "Large"],
    ]);
  });
});

describe("parseVariants: families too large to inline", () => {
  it("reports a declared total with no combination map and keeps the per-value ASINs", () => {
    const { data: d, meta } = parse(twoDimFamily({ map: {}, displayData: undefined, total: 400 }));
    expect(d.combinations).toEqual([]);
    expect(d.total_variations).toBe(400);
    expect(d.combinations_complete).toBe(false);
    // The per-value default ASINs are all the page gives; the flow can navigate with them.
    expect(d.dimensions.flatMap((x) => x.values.map((v) => v.asin))).toEqual([
      "B0FAKE0012",
      "B0FAKE0013",
      "B0FAKE0011",
      "B0FAKE0012",
      "B0FAKE0014",
    ]);
    expect(meta.warnings.join("\n")).toContain(
      "declares 400 variants but inlines no combination map",
    );
    // Children seen only as per-value defaults still need their offers fetched.
    expect(d.missing_offer_asins).toEqual(["B0FAKE0013", "B0FAKE0011", "B0FAKE0014"]);
  });

  it("reports a partial map", () => {
    const { data: d, meta } = parse(
      twoDimFamily({
        map: { "0_0": "B0FAKE0011", "0_1": "B0FAKE0012" },
        displayData: undefined,
        total: 400,
      }),
    );
    expect(d.combinations).toHaveLength(2);
    expect(d.combinations_complete).toBe(false);
    expect(meta.warnings.join("\n")).toContain("lists 2 of 400 declared combinations");
  });
});

describe("parseVariants: classic twister markup", () => {
  it("reads swatches and dropdowns without any JSON", () => {
    const html = page(`
      <div id="twisterContainer">
        <div id="variation_size_name" class="a-section a-spacing-small twisterSwatchWrapper">
          <div class="a-row"><label class="a-form-label"> Size: </label><span class="selection">Medium</span></div>
          <ul class="a-unordered-list a-button-list">
            <li id="size_name_0" data-defaultasin="B0FAKE0061" title="Click to select Small" class="swatchAvailable"><span class="a-button-text">Small</span></li>
            <li id="size_name_1" data-defaultasin="B0FAKE0062" title="Click to select Medium" class="swatchSelect"><span class="a-button-text">Medium</span></li>
            <li id="size_name_2" data-defaultasin="B0FAKE0063" title="Click to select Large" class="swatchUnavailable"><span class="a-button-text">Large</span></li>
            <li id="size_name_3" data-defaultasin="B0FAKE0064" title="Click to select Huge" class="swatchCurrentlyUnavailable"><span class="a-button-text">Huge</span></li>
          </ul>
        </div>
        <div id="variation_color_name">
          <label class="a-form-label">Color:</label>
          <select name="dropdown_selected_color_name" id="native_dropdown_selected_color_name">
            <option value="-1" class="dropdownAvailable">Select</option>
            <option value="0,B0FAKE0071" class="dropdownAvailable" selected>Red</option>
            <option value="1,B0FAKE0072" class="dropdownUnavailable">Blue</option>
          </select>
        </div>
      </div>`);
    const { data: d, meta } = parse(html);
    expect(meta.strategies["dom_rows"]).toBe("classic-dom");
    expect(d.dimensions.map((x) => [x.key, x.label, x.display_type])).toEqual([
      ["size_name", "Size", "swatch"],
      ["color_name", "Color", "dropdown"],
    ]);
    expect(d.dimensions[0]?.values.map((v) => [v.value, v.asin, v.selected, v.state])).toEqual([
      ["Small", "B0FAKE0061", false, "available"],
      ["Medium", "B0FAKE0062", true, "available"],
      ["Large", "B0FAKE0063", false, "see_options"],
      ["Huge", "B0FAKE0064", false, "unavailable"],
    ]);
    expect(
      d.dimensions[1]?.values.map((v) => [v.value, v.index, v.asin, v.selected, v.state]),
    ).toEqual([
      ["Red", 0, "B0FAKE0071", true, "available"],
      ["Blue", 1, "B0FAKE0072", false, "see_options"],
    ]);
    // Two dimensions without a map: no combinations can be built from the DOM alone.
    expect(d.combinations).toEqual([]);
    expect(d.combinations_complete).toBe(false);
  });
});

describe("parseVariants: output", () => {
  it("is JSON-serializable and compact", () => {
    const result = parse(sizeFamily());
    const roundTrip = JSON.parse(JSON.stringify(result)) as { data: VariantsData };
    expect(roundTrip.data).toEqual(result.data);
    expect(JSON.stringify(result.data)).not.toContain("<");
  });

  it("reads hidden (collapsed) swatches as values but shows no swatch for them", () => {
    const lis = SIZE_LIS.map((l) => (l.label === "Large" ? { ...l, hidden: true } : l));
    const d = data(sizeFamily({ lis }));
    const large = d.dimensions[0]?.values.find((v) => v.value === "Large");
    expect(large).toMatchObject({ asin: "B0FAKE0003", index: 2, swatch: null });
  });
});
