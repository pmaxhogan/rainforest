import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import {
  SPONSORED_SIGNALS,
  type SearchPage,
  parseSearch,
  searchToken,
  sponsoredSignals,
} from "../../src/pages/search.ts";
import { parseDocument } from "../../src/index.ts";

// Synthetic markup that mirrors the real structure (ids, classes, data attributes, nesting)
// with invented content only.

const HOST = "https://www.example.com";
const IMG = "https://images.example.com/placeholder.png";

function cap(body: string, url = `${HOST}/s?k=fake+widget`): Capture {
  return {
    kind: "search",
    url,
    final_url: url,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>Fake store</title></head><body>
<header id="navbar-main"><form id="nav-search-bar-form"><select id="searchDropdownBox"><option value="search-alias=aps">All Departments</option><option value="search-alias=fake-dept" selected>Fake Department</option></select><input id="twotabsearchtextbox" value="fake widget"></form></header>
<div id="search">${body}</div>
<div id="navFooter">Footer text</div></body></html>`,
  };
}

interface CardOpts {
  asin: string;
  title: string;
  index: number;
  cls?: string;
  hidden?: boolean;
  href?: string;
  ariaTitle?: string | null;
  label?: string;
  badges?: string;
  reviews?: string;
  price?: string;
  delivery?: string;
  extra?: string;
  wrapStart?: string;
  wrapEnd?: string;
  cartAction?: string;
  titleExtra?: string;
  noAddToCart?: boolean;
}

const REVIEWS = `<div class="a-section a-spacing-none a-spacing-top-micro" data-cy="reviews-block">
  <div class="a-row a-size-small"><span class="a-size-small a-color-base" aria-hidden="true">4.4</span>
    <span class="a-declarative" data-action="a-popover"><a class="a-popover-trigger a-declarative" aria-label="4.4 out of 5 stars, rating details" href="javascript:void(0)" role="button"><i class="a-icon a-icon-star-mini a-star-mini-4-5" data-cy="reviews-ratings-slot" aria-hidden="true"><span class="a-icon-alt">4.4 out of 5 stars</span></i><i class="a-icon a-icon-popover"></i></a></span>
    <span class="rush-component" data-component-type="s-client-side-analytics"><div class="s-csa-instrumentation-wrapper"><a class="a-link-normal s-underline-text s-link-style" aria-label="1,234 ratings" href="/Fake-Widget/dp/B0FAKE0001/ref=sr_1_1#customerReviews"><span class="a-size-mini puis-normal-weight-text s-underline-text" aria-hidden="true">(1.2K)</span></a></div></span>
  </div>
  <div class="a-row a-size-base"><span class="a-size-base a-color-secondary">2K+ bought in past month</span></div>
</div>`;

const PRICE = `<div class="a-section a-spacing-none a-spacing-top-micro puis-price-instructions-style" data-cy="price-recipe">
  <div class="a-row a-size-base a-color-base"><div class="a-row"><span data-csa-c-price-to-pay="19.99">
    <span class="aok-offscreen" id="price-link">Price, product page</span>
    <a class="a-link-normal s-no-hover a-text-normal" aria-describedby="price-link" href="/Fake-Widget/dp/B0FAKE0001/ref=sr_1_1">
      <span class="a-price" data-a-size="xl" data-a-color="base"><span class="a-offscreen">$19.99</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">19<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span>
      <span class="a-offscreen">List: $24.99</span>
      <span><span class="a-size-base a-color-secondary">List:</span><span class="a-price a-text-price" data-a-size="b" data-a-strike="true" data-a-color="secondary"><span class="a-offscreen">$24.99</span><span aria-hidden="true">$24.99</span></span></span>
      <span class="a-size-base a-color-secondary">(<span class="a-price a-text-price" data-a-size="b" data-a-color="secondary"><span class="a-offscreen">$1.67</span><span aria-hidden="true">$1.67</span></span>/count)</span>
    </a></span></div><div class="a-row"></div></div>
  <div class="a-row a-size-base a-color-secondary"><span class="a-size-base s-highlighted-text-padding s-promotion-highlight-color aok-inline-block">5% back</span> <span class="a-color-base">with Fake Card</span></div>
</div>`;

const DELIVERY = `<div class="a-section a-spacing-none a-spacing-top-micro" data-cy="delivery-recipe">
  <div class="a-row a-size-base a-color-secondary s-align-children-center"><div class="a-section a-spacing-none a-padding-none udm-delivery-block" data-cy="delivery-block">
    <div class="a-row a-color-base udm-badge-block"><div class="a-column a-span12"><div class="i-icon-wrapper"><i class="a-icon-wrapper a-icon-prime-with-text a-text-bold"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i><span class="a-icon-text">Tomorrow</span></i></div></div></div>
    <div class="a-row a-color-base udm-primary-delivery-message"><div class="a-column a-span12">FREE delivery <span class="a-text-bold">Tomorrow, Jan 1</span></div></div>
  </div></div>
</div>`;

function addToCart(asin: string, action: string): string {
  return `<div class="a-section a-spacing-none a-spacing-top-mini"><div class="a-row"><div class="puis-atcb-container" data-cy="add-to-cart">
  <div class="a-section puis-atcb-add-container"><div class="a-section atc-faceout-container" data-asin="${asin}">
    <form class="a-spacing-none" method="post" action="${action}"><input type="hidden" name="asin" value="${asin}">
      <span class="a-button a-button-primary puis-atcb-button"><span class="a-button-inner"><input class="a-button-input" type="submit" aria-label="Add to cart"><span class="a-button-text" aria-hidden="true">Add to cart</span></span></span>
    </form></div></div>
  <div class="a-section puis-atcb-error-container aok-hidden" data-rf-hidden="1">Something went wrong</div>
</div></div></div>`;
}

function card(o: CardOpts): string {
  const href = o.href ?? `/Fake-Widget/dp/${o.asin}/ref=sr_1_${o.index}`;
  const aria = o.ariaTitle === null ? "" : ` aria-label="${o.ariaTitle ?? o.title}"`;
  const hidden = o.hidden === true ? ' data-rf-hidden="1"' : "";
  return `<div role="listitem" data-asin="${o.asin}" data-index="${o.index}" data-uuid="00000000-0000-0000-0000-00000000000${o.index % 10}" data-component-type="s-search-result" class="sg-col-4-of-24 s-result-item s-asin ${o.cls ?? ""}" data-cel-widget="search_result_${o.index}"${hidden}>
<div class="sg-col-inner"><div class="s-widget-container celwidget" cel_widget_id="MAIN-SEARCH_RESULTS-${o.index}" data-csa-c-item-id="amzn1.asin.1.${o.asin}">
${o.wrapStart ?? ""}
<span class="a-declarative" data-action="puis-card-container-declarative"><div class="puis-card-container s-card-container" data-cy="asin-faceout-container">
  ${o.badges ?? ""}
  <div class="s-product-image-container aok-relative" data-cy="image-container"><span class="rush-component" data-component-type="s-product-image"><a class="a-link-normal s-no-outline" aria-hidden="true" tabindex="-1" href="${href}"><img class="s-image" src="${IMG}" alt="${o.ariaTitle ?? o.title}"></a></span>
    <span class="rush-component copilot-compare-image-button-container"><div class="copilot-compare-data" role="button" aria-label="Compare" data-asin="${o.asin}"><div class="cp-text-inside-button-animated-hidden"><span class="a-color-base">Compare</span></div></div></span></div>
  <div class="a-section a-spacing-none s-title-instructions-style" data-cy="title-recipe">${o.label ?? ""}${o.titleExtra ?? ""}
    <span class="rush-component" data-component-type="s-client-side-analytics"><div class="s-csa-instrumentation-wrapper"><a class="a-link-normal s-line-clamp-3 s-link-style a-text-normal" href="${href}"><h2 class="a-size-base-plus a-spacing-none a-color-base a-text-normal"${aria}><span>${o.title}</span></h2></a></div></span>
  </div>
  ${o.reviews ?? REVIEWS}
  ${o.price ?? PRICE}
  ${o.delivery ?? DELIVERY}
  ${o.extra ?? ""}
  ${o.noAddToCart === true ? "" : addToCart(o.asin, o.cartAction ?? `/cart/add-to-cart?ref=sr_atc_rt_add_d_${o.index}&discoveredAsins.0=${o.asin}`)}
</div></span>
${o.wrapEnd ?? ""}
</div></div></div>`;
}

const LABEL = `<div class="a-row a-spacing-micro"><span class="a-declarative" data-action="a-popover" data-a-popover='{"name":"sp-info-popover-B0FAKE0002"}'><a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)" role="button"><span class="puis-label-popover-default"><span class="a-color-secondary">Sponsored</span></span><span class="puis-label-popover-hover"><span class="a-color-base">Sponsored</span></span><span class="aok-inline-block puis-sponsored-label-info-icon"></span></a></span><span class="a-declarative" data-s-safe-ajax-modal-trigger='{"ajaxUrl":"/af/sp-loom/feedback-form?pl=fake"}'><span aria-label="View Sponsored information or leave ad feedback"></span></span></div>`;

function fullAd(asin: string, index: number, hidden = false): string {
  return card({
    asin,
    index,
    title: "Fake Sponsored Gadget, Blue",
    ariaTitle: "Sponsored Ad - Fake Sponsored Gadget, Blue",
    cls: "AdHolder",
    hidden,
    href: `/sspa/click?ie=UTF8&spc=FAKE&url=%2Fdp%2F${asin}`,
    label: LABEL,
    cartAction: `/cart/add-to-cart?ref=sr_atc_rt_add_d_${index}_sspa&discoveredAsins.0=${asin}`,
    wrapStart: `<div class="rush-component" data-component-type="s-impression-counter" data-component-props='{"presenceCounterName":"sp_delivered","hiddenCounterName":"sp_hidden"}'>`,
    wrapEnd: "</div>",
  });
}

const INFO_BAR = `<span class="rush-component" data-component-type="s-result-info-bar"><div class="s-widget-container celwidget" cel_widget_id="UPPER-RESULT_INFO_BAR-0">
<h1 class="a-size-base s-desktop-toolbar a-text-normal"><div class="s-desktop-width-max sg-row">
  <div class="sg-col-14-of-20 sg-col s-breadcrumb"><div class="sg-col-inner"><h2 class="a-size-base a-spacing-small a-text-normal"><span>1-16 of over 3,000 results for</span><span> </span><span class="a-color-state a-text-bold">"fake widget"</span></h2></div></div>
  <div class="sg-col-6-of-20 sg-col s-desktop-sort-container"><div class="sg-col-inner"><div class="a-section a-text-right"><form class="aok-inline-block" method="get" action="/s"><span class="a-dropdown-container">
    <label class="a-native-dropdown" for="s-result-sort-select" aria-hidden="true">Sort by:</label>
    <select class="a-native-dropdown" name="s" id="s-result-sort-select" aria-label="Sort by:">
      <option data-url="/s?k=fake+widget&amp;s=relevanceblender&amp;ref=sr_st_relevanceblender" value="relevanceblender" selected data-rf-hidden="1">Featured</option>
      <option data-url="/s?k=fake+widget&amp;s=price-asc-rank&amp;ref=sr_st_price-asc-rank" value="price-asc-rank" data-rf-hidden="1">Price: Low to High</option>
      <option data-url="https://elsewhere.example.org/s?k=x" value="review-rank" data-rf-hidden="1">Avg. Customer Review</option>
    </select>
    <span class="a-button a-button-dropdown a-button-small" aria-hidden="true"><span class="a-button-inner"><span class="a-button-text" aria-hidden="true"><span class="a-dropdown-label">Sort by:</span><span class="a-dropdown-prompt">Featured</span></span></span></span>
  </span></form></div></div></div>
</div></h1></div></span>`;

function rail(extra = ""): string {
  return `<span class="rush-component" data-component-type="s-filters-panel-view"><div id="s-refinements" class="a-section a-spacing-none">
<a class="a-link-normal aok-offscreen" href="#search">Skip to main search results</a>
<div class="a-section a-spacing-none" id="brandsRefinements" role="group" aria-labelledby="p_123-title">
  <div class="a-section a-spacing-small" id="p_123-title" aria-level="2" role="heading"><span class="a-size-base a-color-base puis-bold-weight-text">Brands</span></div>
  <ul class="a-unordered-list a-nostyle a-vertical" id="filter-p_123" aria-labelledby="p_123-title">
    <span class="a-declarative" data-action="sf-select-refinement-picker">
      <span data-csa-c-content-id="p_123/Fakebrand"><li class="a-spacing-micro" id="p_123/Fakebrand"><span class="a-list-item"><a class="a-link-normal s-navigation-item" aria-current="true" aria-label="Remove Fakebrand filter to see more results" href="/s?k=fake+widget&amp;qid=1&amp;ref=sr_nr_p_123_1"><div class="a-checkbox"><label><input type="checkbox" checked><i class="a-icon a-icon-checkbox"></i></label></div><span class="a-size-base a-color-base a-text-bold">Fakebrand</span></a></span></li></span>
      <span data-csa-c-content-id="p_123/Otherbrand"><li class="a-spacing-micro" id="p_123/Otherbrand"><span class="a-list-item"><a class="a-link-normal s-navigation-item" aria-current="false" href="/s?k=fake+widget&amp;rh=p_123%3AOtherbrand&amp;ref=sr_nr_p_123_2"><span class="a-size-base a-color-base">Otherbrand</span> <span class="a-size-base a-color-secondary">(42)</span></a></span></li></span>
      <li class="a-spacing-micro"><span class="a-list-item"><div class="a-row a-expander-container"><div class="a-expander-content" data-rf-hidden="1"><ul><li id="p_123/Thirdbrand"><a class="a-link-normal s-navigation-item" href="/s?k=fake+widget&amp;rh=p_123%3AThirdbrand"><span class="a-size-base">Thirdbrand</span></a></li></ul></div><a class="a-expander-header s-expander-text" href="javascript:void(0)" role="button"><span class="a-expander-prompt">See more</span></a></div></span></li>
    </span>
  </ul>
</div>
<div class="a-section a-spacing-none" id="reviewsRefinements" role="group" aria-labelledby="p_72-title">
  <div class="a-section a-spacing-small" id="p_72-title" aria-level="2" role="heading"><span class="a-size-base">Customer Reviews</span></div>
  <ul class="a-unordered-list" id="filter-p_72" aria-labelledby="p_72-title"><li id="p_72/1"><span class="a-list-item"><div class="a-section"><a class="a-link-normal s-navigation-item" aria-current="false" aria-label="Apply 4 Stars &amp; Up filter to narrow results" href="/s?k=fake+widget&amp;rh=p_72%3A1"><i class="a-icon a-icon-star-medium a-star-medium-4"><span class="a-icon-alt">4 Stars</span></i><span class="a-size-small a-color-base">&amp; Up</span></a></div></span></li>
  <li id="p_72/2"><span class="a-list-item"><a class="a-link-normal" href="https://elsewhere.example.org/offsite">Offsite thing</a></span></li></ul>
</div>
<div class="a-section a-spacing-none" id="priceRefinements" role="group">
  <div class="a-section sf-refinements-panel sf-range-content" id="filter-p_36">
    <div class="a-section a-spacing-mini sf-refinement-heading"><span class="a-size-base puis-bold-weight-text">Price</span></div>
    <div class="a-section sf-filter-section"><div class="a-section sf-range-item" id="p_36/range-slider"><form class="sf-range-slider" method="get" action="/s" data-slider-props='{"lowerBoundParamName":"low-price","upperBoundParamName":"high-price"}'>
      <input type="hidden" name="k" value="fake widget">
      <div class="a-section a-spacing-mini sf-range-slider-row"><label class="a-form-label sf-range-slider-label sf-lower-bound-label"><span class="a-text-bold">$1</span></label><span class="sf-range-slider-label" aria-hidden="true"><span class="a-text-bold">to</span></span><label class="a-form-label sf-range-slider-label sf-upper-bound-label"><span class="a-text-bold">$90+</span></label></div>
      <div class="a-section a-spacing-mini sf-range-slider-row"><span class="a-button"><span class="a-button-inner"><input class="a-button-input" type="submit" aria-label="Go"><span class="a-button-text" aria-hidden="true">Go</span></span></span></div>
    </form></div></div>
  </div>
</div>
${extra}
</div></span>`;
}

function pagination(current: number, last: number): string {
  const prev =
    current > 1
      ? `<li><span class="a-list-item"><a class="s-pagination-item s-pagination-previous s-pagination-button" href="/s?k=fake+widget&amp;page=${current - 1}&amp;ref=sr_pg_${current}" aria-label="Go to previous page, page ${current - 1}">Previous</a></span></li>`
      : `<span class="s-pagination-item s-pagination-previous s-pagination-disabled" aria-disabled="true">Previous</span>`;
  const next =
    current < last
      ? `<li><span class="a-list-item"><a class="s-pagination-item s-pagination-next s-pagination-button" href="/s?k=fake+widget&amp;page=${current + 1}&amp;ref=sr_pg_${current}" aria-label="Go to next page, page ${current + 1}">Next</a></span></li>`
      : `<span class="s-pagination-item s-pagination-next s-pagination-disabled" aria-disabled="true">Next</span>`;
  const pages: string[] = [];
  for (let p = Math.max(1, current - 1); p <= last; p++) {
    pages.push(
      p === current
        ? `<li><span class="a-list-item"><span class="s-pagination-item s-pagination-selected" aria-current="page" aria-label="Page ${p}">${p}</span></span></li>`
        : `<li><span class="a-list-item"><a class="s-pagination-item s-pagination-button" href="/s?k=fake+widget&amp;page=${p}&amp;ref=sr_pg_${p}" aria-label="Go to page ${p}">${p}</a></span></li>`,
    );
  }
  return `<div class="a-section a-spacing-none s-result-item s-flex-full-width s-widget" data-index="90" data-cel-widget="search_result_90"><div class="s-widget-container celwidget" cel_widget_id="MAIN-PAGINATION-90"><div class="a-section a-text-center s-pagination-container" aria-label="pagination" role="navigation"><span class="s-pagination-strip"><ul class="a-unordered-list a-horizontal">${prev}${pages.join("")}${next}</ul></span></div></div></div>`;
}

function header(text: string, index: number): string {
  return `<div class="a-section a-spacing-none s-result-item s-flex-full-width s-widget" data-index="${index}" data-cel-widget="search_result_${index}"><span class="rush-component" data-component-type="s-messaging-widget-results-header"><div class="a-section a-spacing-none"><h2 class="a-size-medium-plus a-spacing-none a-color-base a-text-bold">${text}</h2></div></span></div>`;
}

function page(slot: string, opts: { railExtra?: string; top?: string; pag?: string } = {}): string {
  return `${INFO_BAR}<div class="s-desktop-width-max s-desktop-content sg-row"><div class="sg-col-4-of-24 sg-col">${rail(opts.railExtra)}</div>
<div class="sg-col-20-of-24 sg-col"><span class="rush-component" data-component-type="s-search-results"><div class="s-main-slot s-result-list s-search-results sg-row">${opts.top ?? ""}${slot}${opts.pag ?? pagination(2, 3)}</div></span></div></div>`;
}

function parse(html: string, url?: string): ReturnType<typeof parseSearch> {
  return parseSearch(cap(html, url));
}

function result(data: SearchPage, asin: string) {
  const r = data.results.find((x) => x.asin === asin);
  if (r === undefined) throw new Error(`no result ${asin}`);
  return r;
}

describe("sponsored signal registry", () => {
  it("has exactly the expected signals", () => {
    expect([...SPONSORED_SIGNALS]).toEqual([
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
    ]);
  });
});

describe("parseSearch: sponsored labeling", () => {
  const organic = card({ asin: "B0FAKE0001", title: "Fake Widget, Red", index: 3 });

  it("labels an organic card with no signals", () => {
    const { data } = parse(page(organic));
    const r = result(data, "B0FAKE0001");
    expect(r.kind).toBe("organic");
    expect(r.is_sponsored).toBe(false);
    expect(r.sponsored_signals).toEqual([]);
    expect(r.hidden_in_browser).toBe(false);
    expect(r.position).toBe(1);
  });

  // One case per signal, each firing alone (hardcoded, not derived from the export).
  const single: [string, CardOpts][] = [
    ["ad_holder_class", { asin: "B0FAKE0011", title: "Fake A", index: 4, cls: "AdHolder" }],
    [
      "sponsored_label_text",
      {
        asin: "B0FAKE0012",
        title: "Fake B",
        index: 5,
        label: '<div class="a-row"><span class="a-color-secondary">Sponsored</span></div>',
      },
    ],
    [
      "sponsored_label_class",
      {
        asin: "B0FAKE0013",
        title: "Fake C",
        index: 6,
        label:
          '<a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)"><span class="puis-sponsored-label-info-icon"></span></a>',
      },
    ],
    [
      "ad_feedback",
      {
        asin: "B0FAKE0014",
        title: "Fake D",
        index: 7,
        label: `<span class="a-declarative" data-s-safe-ajax-modal-trigger='{"ajaxUrl":"/af/sp-loom/feedback-form?pl=x"}'></span>`,
      },
    ],
    [
      "sponsored_click_url",
      {
        asin: "B0FAKE0015",
        title: "Fake E",
        index: 8,
        href: "/sspa/click?ie=UTF8&url=%2Fdp%2FB0FAKE0015",
      },
    ],
    [
      "aria_sponsored_ad",
      { asin: "B0FAKE0016", title: "Fake F", index: 9, ariaTitle: "Sponsored Ad - Fake F" },
    ],
    [
      "sp_impression_counter",
      {
        asin: "B0FAKE0017",
        title: "Fake G",
        index: 10,
        wrapStart: `<div data-component-type="s-impression-counter" data-component-props='{"presenceCounterName":"sp_delivered"}'>`,
        wrapEnd: "</div>",
      },
    ],
    [
      "sponsored_cart_ref",
      {
        asin: "B0FAKE0018",
        title: "Fake H",
        index: 11,
        cartAction: "/cart/add-to-cart?ref=sr_atc_rt_add_d_11_sspa",
      },
    ],
    [
      "ad_creative_data",
      {
        asin: "B0FAKE0019",
        title: "Fake I",
        index: 12,
        extra: "<div data-ad-creative-list='[]'></div>",
      },
    ],
    [
      "ad_widget_structure",
      {
        asin: "B0FAKE001A",
        title: "Fake J",
        index: 13,
        extra: '<div class="sbv-video-single-product"></div>',
      },
    ],
  ];

  it("covers every signal with a single-signal case", () => {
    expect(single.map(([s]) => s)).toEqual([...SPONSORED_SIGNALS]);
  });

  for (const [signal, opts] of single) {
    it(`flags a card on ${signal} alone`, () => {
      const { data } = parse(page(organic + card(opts)));
      const r = result(data, opts.asin);
      expect(r.is_sponsored).toBe(true);
      expect(r.sponsored_signals).toEqual([signal]);
      expect(result(data, "B0FAKE0001").is_sponsored).toBe(false);
    });
  }

  it("records every signal that fires and the label text", () => {
    const { data, other_sections } = parse(page(fullAd("B0FAKE0002", 4)));
    const r = result(data, "B0FAKE0002");
    expect(r.kind).toBe("sponsored");
    expect(r.sponsored_signals).toEqual([
      "ad_holder_class",
      "sponsored_label_text",
      "sponsored_label_class",
      "ad_feedback",
      "sponsored_click_url",
      "aria_sponsored_ad",
      "sp_impression_counter",
      "sponsored_cart_ref",
    ]);
    expect(r.sponsored_label).toBe("Sponsored");
    expect(r.title).toBe("Fake Sponsored Gadget, Blue");
    expect(r.url_path).toBe("/dp/B0FAKE0002");
    expect(r.notes).toBeUndefined();
    expect(other_sections.map((s) => s.text).join(" ")).not.toContain("Sponsored");
  });

  it("labels a 'Featured from Amazon brands' placement as sponsored", () => {
    const label = `<div class="a-row a-spacing-micro"><span class="a-declarative" data-action="a-popover"><a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)" role="button"><span class="puis-label-popover-default"><span class="a-size-micro a-color-secondary">Featured from Amazon brands</span></span></a></span></div>`;
    const { data } = parse(
      page(
        card({ asin: "B0FAKE0003", title: "Fake House Brand", index: 4, label, cls: "AdHolder" }),
      ),
    );
    const r = result(data, "B0FAKE0003");
    expect(r.is_sponsored).toBe(true);
    expect(r.sponsored_label).toBe("Featured from Amazon brands");
    expect(r.sponsored_signals).toEqual([
      "ad_holder_class",
      "sponsored_label_text",
      "sponsored_label_class",
    ]);
  });

  it("reports a sponsored card hidden by a content blocker, with the same fields", () => {
    const vis = parse(page(fullAd("B0FAKE0002", 4)));
    const hid = parse(page(fullAd("B0FAKE0002", 4, true) + organic));
    const a = result(vis.data, "B0FAKE0002");
    const b = result(hid.data, "B0FAKE0002");
    expect(b.hidden_in_browser).toBe(true);
    expect(b.position).toBeNull();
    expect(a.position).toBe(1);
    const { position: _p1, hidden_in_browser: _h1, ...restA } = a;
    const { position: _p2, hidden_in_browser: _h2, ...restB } = b;
    expect(restB).toEqual(restA);
    // The page's own hidden error container is not read inside the unmasked card.
    expect(JSON.stringify(b)).not.toContain("Something went wrong");
    expect(result(hid.data, "B0FAKE0001").position).toBe(1);
    expect(hid.data.hidden_skipped).toEqual({
      results: 0,
      widgets: 0,
      sponsored_results: 1,
      sponsored_widgets: 0,
    });
    // Hidden content is not visible text: it never counts as unparsed.
    expect(hid.meta.unparsed_text_chars).toBe(0);
  });

  it("skips a hidden template card with no sponsored signal", () => {
    const tmpl = card({ asin: "B0FAKE0009", title: "Template Card", index: 2, hidden: true });
    const { data } = parse(page(tmpl + organic));
    expect(data.results.map((r) => r.asin)).toEqual(["B0FAKE0001"]);
    expect(data.hidden_skipped.results).toBe(1);
  });

  it("exports the signal detector for raw elements", () => {
    const doc = parseDocument(
      `<div id="x" class="AdHolder"><a href="/sspa/click?x=1">Go</a></div>`,
    );
    const el = doc.querySelector("#x");
    expect(el).not.toBeNull();
    expect(sponsoredSignals(el as NonNullable<typeof el>)).toEqual([
      "ad_holder_class",
      "sponsored_click_url",
    ]);
  });
});

describe("parseSearch: result fields", () => {
  it("reads title, links, price, list and unit price, rating, counts, delivery and promotions", () => {
    const badges = `<div class="a-section a-spacing-none puis-status-badge-container"><div id="amazonBadges-capsule-view"><div class="a-section"><div class="a-section a-spacing-none rio-badge-component" id="BEST_SELLER"><div class="a-section rio-badge-supplementary-group" aria-label="Best Sellerin Fake Gadgets" role="group"><span class="rio-badge-label"><span class="a-size-small a-color-inverse a-nowrap" aria-label="Best Seller">Best Seller</span></span><span class="a-size-small rio-badge-supplementary-text rio-hidden" data-rf-hidden="1">in Fake Gadgets</span></div></div></div></div></div>`;
    const { data, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "Fake Widget, Red", index: 3, badges })),
    );
    const r = result(data, "B0FAKE0001");
    expect(r.title).toBe("Fake Widget, Red");
    expect(r.url_path).toBe("/dp/B0FAKE0001");
    expect(r.price).toEqual({ amount: 19.99, currency: "USD", raw: "$19.99" });
    expect(r.list_price).toEqual({ amount: 24.99, currency: "USD", raw: "$24.99" });
    expect(r.list_price_label).toBe("List");
    expect(r.unit_price?.amount.amount).toBe(1.67);
    expect(r.unit_price?.unit).toBe("count");
    expect(r.rating).toEqual({ value: 4.4, out_of: 5 });
    expect(r.review_count).toEqual({ value: 1234, approximate: false, raw: "1,234" });
    expect(r.bought_past_month).toEqual({
      value: 2000,
      approximate: true,
      raw: "2K+",
      text: "2K+ bought in past month",
    });
    expect(r.badges).toEqual([
      { type: "best_seller", text: "Best Seller", context: "in Fake Gadgets" },
    ]);
    expect(r.prime).toBe(true);
    expect(r.delivery_badge).toBe("Tomorrow");
    expect(r.delivery).toEqual(["FREE delivery Tomorrow, Jan 1"]);
    expect(r.promotions).toEqual(["5% back with Fake Card"]);
    expect(r.cta).toEqual(["Add to cart"]);
    expect(r.notes).toBeUndefined();
    expect(r.section).toBeUndefined();
    expect(meta.strategies["results.title"]).toBe("aria-label:1");
    expect(meta.strategies["results.asin"]).toBe("data-asin:1");
  });

  it("falls back for title, rating, review count and list price", () => {
    const reviews = `<div data-cy="reviews-block"><div class="a-row"><i class="a-icon a-star-mini-3-5"></i><span class="a-size-mini s-underline-text">(87)</span></div></div>`;
    const price = `<div data-cy="price-recipe"><div class="a-row"><span class="a-price" data-a-color="base"><span class="a-offscreen">$5.00</span></span> <span>Typical: $6.50</span></div></div>`;
    const { data, meta } = parse(
      page(
        card({
          asin: "B0FAKE0004",
          title: "Fallback Widget",
          index: 3,
          ariaTitle: null,
          reviews,
          price,
        }),
      ),
    );
    const r = result(data, "B0FAKE0004");
    expect(r.title).toBe("Fallback Widget");
    expect(r.rating).toEqual({ value: 3.5, out_of: 5 });
    expect(r.review_count?.value).toBe(87);
    expect(r.list_price?.amount).toBe(6.5);
    expect(meta.strategies["results.title"]).toBe("heading:1");
    expect(meta.strategies["results.rating"]).toBe("star-class:1");
    expect(meta.strategies["results.review_count"]).toBe("count-text:1");
    expect(meta.strategies["results.list_price"]).toBe("text-anchor:1");
  });

  it("falls back to the csa item id and image alt", () => {
    const html = `<div data-index="3" data-component-type="s-search-result" class="s-result-item"><div data-csa-c-item-id="amzn1.asin.1.B0FAKE0005"><img class="s-image" src="${IMG}" alt="Alt Only Widget"></div></div>`;
    const { data, meta } = parse(page(html));
    const r = result(data, "B0FAKE0005");
    expect(r.title).toBe("Alt Only Widget");
    expect(meta.strategies["results.asin"]).toBe("csa-item-id:1");
    expect(meta.strategies["results.title"]).toBe("img-alt:1");
  });

  it("handles a result with no price and a See options button", () => {
    const price = `<div data-cy="price-recipe"><div class="a-row a-size-base a-color-base"><div class="a-row"></div></div></div>`;
    const extra = `<div class="a-section puis-see-details-content"><span class="a-button a-button-base"><span class="a-button-inner"><a class="a-button-text" href="/Fake/dp/B0FAKE0006/ref=sr_1_3_so">See options</a></span></span></div>`;
    const { data } = parse(
      page(
        card({
          asin: "B0FAKE0006",
          title: "Fake Fruit, 1 Each",
          index: 3,
          price,
          extra,
          noAddToCart: true,
          delivery: "",
        }),
      ),
    );
    const r = result(data, "B0FAKE0006");
    expect(r.price).toBeUndefined();
    expect(r.see_options).toBe(true);
    expect(r.cta).toEqual(["See options"]);
  });

  it("parses a price range", () => {
    const price = `<div data-cy="price-recipe"><div class="a-row"><a class="a-link-normal" href="/dp/B0FAKE0007"><span class="a-price" data-a-color="base"><span class="a-offscreen">$10.99</span></span><span class="a-price-dash"> - </span><span class="a-price" data-a-color="base"><span class="a-offscreen">$24.99</span></span></a></div></div>`;
    const { data } = parse(
      page(card({ asin: "B0FAKE0007", title: "Fake Range", index: 3, price })),
    );
    const r = result(data, "B0FAKE0007");
    expect(r.price?.amount).toBe(10.99);
    expect(r.price_range?.low.amount).toBe(10.99);
    expect(r.price_range?.high.amount).toBe(24.99);
  });

  it("reads coupons, subscribe and save, savings badge and deal / choice badges", () => {
    const badges = `<div class="a-section puis-status-badge-container"><span aria-label="Amazon's Choice"><span class="rush-component" data-component-type="s-status-badge-component"><div class="a-section" data-csa-c-badge-text="Overall Pick"><span class="a-badge" id="B0FAKE0008-amazons-choice" data-a-badge-type="status"><span class="a-badge-label"><span class="a-badge-label-inner"><span class="a-badge-text">Overall Pick</span></span></span></span></div></span></span></div>`;
    // Real nesting: the deal badge sits in a display:contents wrapper that the capture pass
    // marks hidden although it renders.
    const price = `<div data-cy="price-recipe"><div class="a-row"><a class="a-link-normal" href="/deals"><span style="display: contents; --fake-bg: #000000;" data-rf-hidden="1"><span id="DEAL_B0FAKE0008" class="a-badge" data-a-badge-type="deal"><span class="a-badge-label"><span class="a-badge-label-inner a-text-ellipsis"><span class="a-badge-text">Limited time deal</span></span></span></span></span></a></div>
<div class="a-row"><a class="a-link-normal" href="/deals"><span data-rf-hidden="1"><span class="a-badge" data-a-badge-type="deal"><span class="a-badge-text">Truly hidden deal</span></span></span></a></div>
<div class="a-row"><a href="/dp/B0FAKE0008"><div class="a-section savings-badge-wrapper"><span class="a-size-extra-large apex-savings-percent">-21%</span> <span class="apex-savings-price"><span class="a-price" data-a-color="base"><span class="a-offscreen">$39.00</span></span></span></div></a></div>
<div class="a-row a-size-base a-color-secondary"><span class="rush-component"><div class="s-coupon-tile-container"><label class="s-coupon-checkbox-label"><span class="s-coupon-tile-text-content"><span class="a-size-base a-color-base a-text-normal">Coupon price</span><span class="a-color-base s-coupon-tile-price-content"><span class="a-price" data-a-color="base"><span class="a-offscreen">$35.10</span><span aria-hidden="true">$35.10</span></span></span></span></label><div class="s-coupon-tile-content-container aok-hidden" data-rf-hidden="1">Saving $3.90 at purchase</div></div></span></div>
<div class="a-row"><span class="rush-component" data-component-type="s-coupon-component"><span class="s-coupon-unclipped aok-block"><span class="s-coupon-highlight-color">Extra 15% off</span> <span class="a-color-base">when you subscribe</span></span></span></div></div>`;
    const { data } = parse(
      page(card({ asin: "B0FAKE0008", title: "Fake Deal", index: 3, badges, price })),
    );
    const r = result(data, "B0FAKE0008");
    expect(r.price?.amount).toBe(39);
    expect(r.savings_percent).toBe(21);
    expect(r.coupon).toBe("Coupon price $35.10");
    expect(r.coupon_price?.amount).toBe(35.1);
    expect(r.subscribe_and_save).toBe("Extra 15% off when you subscribe");
    expect(r.badges).toEqual([
      { type: "deal", text: "Limited time deal" },
      { type: "amazons_choice", text: "Overall Pick", context: "Amazon's Choice" },
    ]);
    expect(JSON.stringify(r)).not.toContain("Truly hidden deal");
    expect(r.promotions).toBeUndefined();
  });

  it("reads a grocery result: unit price per ounce, size chip, store markers, certifications", () => {
    const price = `<div data-cy="price-recipe"><div class="a-row"><a href="/dp/B0FAKE0021"><span class="a-price" data-a-color="base"><span class="a-offscreen">$4.99</span></span><span class="a-size-base a-color-secondary">(<span class="a-price a-text-price"><span class="a-offscreen">$0.31</span><span aria-hidden="true">$0.31</span></span>/ounce)</span></a></div></div>`;
    const titleExtra = `<div class="a-row a-color-base"><span class="a-size-base s-background-color-platinum a-padding-mini">16 Ounce (Pack of 2)</span></div><div class="a-row"><span class="a-size-base a-color-secondary title-differentiators">Organic, Sliced</span></div>`;
    const extra = `<div data-cy="certification-recipe"><div class="s-pc-faceout-container"><a class="a-link-normal s-pc-badge" data-cy="s-pc-faceout-badge" href="javascript:void(0)" role="button"><div class="s-pc-attribute-pill-text"><span class="a-size-base a-color-base">Small Business</span></div></a><a class="s-pc-badge" data-cy="s-pc-faceout-badge" href="javascript:void(0)"><span class="a-size-base">Organic</span></a><div class="a-section aok-hidden"><div alt="Climate Pledge Friendly" class="a-image-wrapper"></div></div></div></div>
<div class="a-section"><span class="a-button"><span class="a-button-inner"><span class="a-button-text">Add to delivery</span></span></span></div>`;
    const { data } = parse(
      page(
        card({
          asin: "B0FAKE0021",
          title: "Fake Berries from Whole Foods Market",
          index: 3,
          price,
          titleExtra,
          extra,
          noAddToCart: true,
        }),
      ),
    );
    const r = result(data, "B0FAKE0021");
    expect(r.unit_price).toEqual({
      amount: { amount: 0.31, currency: "USD", raw: "$0.31" },
      unit: "ounce",
      raw: "($0.31/ounce)",
    });
    expect(r.variant_label).toBe("16 Ounce (Pack of 2)");
    expect(r.subtitle).toBe("Organic, Sliced");
    expect(r.certifications).toEqual(["Small Business", "Organic"]);
    expect(r.small_business).toBe(true);
    expect(r.climate_pledge_friendly).toBe(true);
    expect(r.store_markers).toEqual(["Whole Foods Market", "Add to delivery"]);
    expect(r.cta).toEqual(["Add to delivery"]);
  });

  it("reads a renewed item with brand line, specs, variants, stock and more buying choices", () => {
    const titleExtra = `<div class="a-row"><div class="a-row a-color-secondary"><h2 class="a-size-mini s-line-clamp-1"><span class="a-size-medium a-color-base">Amazon Renewed</span></h2></div></div>`;
    const extra = `<div data-cy="secondary-offer-recipe"><div class="a-row a-size-base a-color-secondary"><span class="a-size-base a-color-secondary">More Buying Choices</span><br><span class="a-color-base">$90.00</span><span class="a-letter-space"></span><span class="a-declarative"><a class="a-link-normal s-link-style" href="/gp/offer-listing/B0FAKE0031/ref=sr_1_3_olp?keywords=fake">(12+ used &amp; new offers)</a></span></div></div>
<div data-cy="product-details-recipe"><div class="puisg-row s-product-specs-view"><div class="puisg-col"><span class="a-color-secondary">Memory</span><span>:</span><span class="a-text-bold">64 GB</span></div><div class="puisg-col"><span class="a-color-secondary">Color</span><span>:</span><span class="a-text-bold">Fake Gray</span></div></div></div>
<div class="a-section s-variation-options-container"><div class="s-variation-options-options-text aok-inline-block">Options:</div> <span class="a-truncate"><span class="a-truncate-full a-offscreen">3 sizes</span><span class="a-truncate-cut" aria-hidden="true">3 sizes</span></span></div>
<div class="a-row"><a class="a-link-normal" href="/dp/B0FAKE0031"><u>+2 other colors/patterns</u></a></div>`;
    const delivery = `<div data-cy="delivery-recipe"><div class="a-row"><div class="udm-delivery-block" data-cy="delivery-block"><div class="a-row udm-primary-delivery-message">FREE delivery <span class="a-text-bold">Thu, Jan 2</span></div></div></div><div class="a-row"><span class="a-size-base a-color-price">Only 3 left in stock - order soon.</span></div></div>`;
    const { data } = parse(
      page(
        card({
          asin: "B0FAKE0031",
          title: "Fake Phone 9, 64GB, Gray (Renewed)",
          index: 3,
          titleExtra,
          extra,
          delivery,
        }),
      ),
    );
    const r = result(data, "B0FAKE0031");
    expect(r.renewed).toBe(true);
    expect(r.brand).toBe("Amazon Renewed");
    expect(r.title).toBe("Fake Phone 9, 64GB, Gray (Renewed)");
    expect(r.specs).toEqual([
      { name: "Memory", value: "64 GB" },
      { name: "Color", value: "Fake Gray" },
    ]);
    expect(r.variant_hints).toEqual(["3 sizes", "+2 other colors/patterns"]);
    expect(r.stock_text).toBe("Only 3 left in stock - order soon.");
    expect(r.delivery).toEqual(["FREE delivery Thu, Jan 2"]);
    expect(r.prime).toBe(false);
    expect(r.more_buying_choices).toEqual({
      price: { amount: 90, currency: "USD", raw: "$90.00" },
      offers_text: "12+ used & new offers",
      offer_count: { value: 12, approximate: true, raw: "12+" },
      url_path: "/gp/offer-listing/B0FAKE0031",
    });
  });

  it("keeps unknown lines of a parsed block as notes and insight prompts", () => {
    const reviews = REVIEWS.replace(
      "</div>\n</div>",
      '</div>\n<div class="a-row"><span class="a-size-base">Fake new line</span></div></div>',
    );
    const extra = `<div class="a-section"><span class="a-declarative" data-product-insight-prompt-click='{"query":"x"}'><span class="a-size-small">Will it fit a fake box?</span></span></div>`;
    const { data } = parse(
      page(card({ asin: "B0FAKE0001", title: "Fake Widget", index: 3, reviews, extra })),
    );
    const r = result(data, "B0FAKE0001");
    expect(r.notes).toEqual(["Fake new line"]);
    expect(r.insight_prompts).toEqual(["Will it fit a fake box?"]);
  });

  it("assigns section headings and visible positions", () => {
    const slot =
      header("Results", 1) +
      card({ asin: "B0FAKE0001", title: "One", index: 2 }) +
      header("More results", 5) +
      card({ asin: "B0FAKE0002", title: "Two", index: 6 });
    const { data } = parse(page(slot));
    expect(data.results.map((r) => [r.asin, r.position, r.section, r.index])).toEqual([
      ["B0FAKE0001", 1, "Results", 2],
      ["B0FAKE0002", 2, "More results", 6],
    ]);
  });
});

describe("parseSearch: widgets", () => {
  const sbBanner = (hidden: boolean): string =>
    `<div class="s-result-item s-widget AdHolder s-flex-full-width" data-index="0" data-cel-widget="search_result_0"${hidden ? ' data-rf-hidden="1"' : ""}><div class="s-widget-container"><div class="celwidget"><div class="sb-desktop" id="CardInstanceFAKE" data-ad-creative-list="[]">
  <div class="headline"><a href="https://sponsored-ads.example.com/clk/?p=fake"><span class="a-size-medium">Fake brand headline</span></a><span class="a-color-secondary">Sponsored</span></div>
  <ol class="a-carousel"><li class="a-carousel-card"><div data-asin="B0FAKE0041" data-sbtc-carousel-item="true"><a href="https://sponsored-ads.example.com/clk/?p=item"><span class="a-truncate"><span class="a-truncate-full a-offscreen">Fake Brand Cable, 2-Pack</span><span class="a-truncate-cut">Fake Brand Cable, 2-Pack</span></span></a><span class="a-price" data-a-color="base"><span class="a-offscreen">$9.99</span></span></div></li></ol>
</div></div></div></div>`;

  it("reads a sponsored brand banner, visible or hidden by a content blocker", () => {
    for (const hidden of [false, true]) {
      const { data } = parse(
        page(card({ asin: "B0FAKE0001", title: "One", index: 3 }), { top: sbBanner(hidden) }),
      );
      const w = data.widgets[0];
      expect(w?.type).toBe("sponsored_brand");
      expect(w?.is_sponsored).toBe(true);
      expect(w?.hidden_in_browser).toBe(hidden);
      expect(w?.heading).toBe("Fake brand headline");
      expect(w?.sponsored_label).toBe("Sponsored");
      expect(w?.sponsored_signals).toContain("ad_holder_class");
      expect(w?.items.map((i) => [i.asin, i.title, i.price?.amount, i.is_sponsored])).toEqual([
        ["B0FAKE0041", "Fake Brand Cable, 2-Pack", 9.99, true],
      ]);
      // Off-site ad click URLs are not kept; the item's own link is not repeated as a shelf link.
      expect(JSON.stringify(w)).not.toContain("sponsored-ads.example.com");
      expect(w?.links).toEqual([]);
      expect(data.hidden_skipped.sponsored_widgets).toBe(hidden ? 1 : 0);
    }
  });

  it("reports a visible shelf wrapper whose sponsored carousel is hidden", () => {
    const shelf = `<div class="sg-col-20-of-24 s-result-item s-widget" data-index="33" data-cel-widget="search_result_33"><div class="sg-col-inner"><div class="s-widget-container template=SEARCH_RESULTS">
<span data-component-type="aspa-asin-ajax-lazy-loader" data-rf-hidden="1"></span>
<span data-component-type="s-searchgrid-carousel" data-rf-hidden="1"><div class="s-shopping-adviser-heading"><h2>Fake trending shelf</h2><a class="s-widget-sponsored-label-text" href="#">Sponsored</a></div>
<ol class="a-carousel"><li class="a-carousel-card"><span data-csa-c-item-id="amzn1.asin.1.B0FAKE0091"><div data-cy="title-recipe"><a class="a-text-normal" href="/sspa/click?url=%2Fdp%2FB0FAKE0091"><h2 aria-label="Sponsored Ad - Fake Shelf Item"><span>Fake Shelf Item</span></h2></a></div></span></li></ol></span>
</div></div></div>`;
    const { data, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + shelf),
    );
    const w = data.widgets.find((x) => x.index === 33);
    expect(w?.hidden_in_browser).toBe(true);
    expect(w?.is_sponsored).toBe(true);
    expect(w?.heading).toBe("Fake trending shelf");
    expect(w?.items.map((i) => i.title)).toEqual(["Fake Shelf Item"]);
    expect(data.hidden_skipped.sponsored_widgets).toBe(1);
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("reads a video ad widget", () => {
    const video = `<div class="s-result-item s-widget" data-index="20" data-cel-widget="search_result_20"><div class="s-widget-container template=VIDEO_SINGLE_PRODUCT"><span data-component-type="sbv-video-single-product"><div class="sbv-video-container"><video></video></div>
<div class="sbv-product" data-asin="B0FAKE0051"><a href="/dp/B0FAKE0051"><h2 class="a-size-base" aria-label="Sponsored Ad - Fake Video Gadget"><span>Fake Video Gadget</span></h2></a><span class="a-price" data-a-color="base"><span class="a-offscreen">$12.00</span></span></div>
<span class="sponsored-brand-label-info-desktop"><span class="a-color-secondary">Sponsored</span></span></span></div></div>`;
    const { data } = parse(page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + video));
    const w = data.widgets.find((x) => x.type === "sponsored_video");
    expect(w?.is_sponsored).toBe(true);
    expect(w?.items[0]?.title).toBe("Fake Video Gadget");
    expect(w?.sponsored_signals).toEqual(
      expect.arrayContaining(["sponsored_label_text", "ad_widget_structure", "aria_sponsored_ad"]),
    );
    // A widget's embedded product is never mistaken for a result card.
    expect(data.results.map((r) => r.asin)).toEqual(["B0FAKE0001"]);
  });

  it("reads related searches and narrow-your-search tiles as search tokens", () => {
    const related = `<div class="sg-col-20-of-24 s-result-item s-widget" data-index="70"><span data-component-type="text-reformulation-widget"><div class="a-section"><h2 class="a-size-medium-plus">Related searches</h2></div>
<a class="a-link-normal textref-link-wrapper" href="/s?k=fake+gizmo&amp;ref=rsl_sug_0_0"><div class="a-box"><span class="a-size-base">fake gizmo</span></div></a>
<a class="a-link-normal textref-link-wrapper" href="https://elsewhere.example.org/s?k=nope"><span>offsite</span></a></span></div>`;
    const tiles = `<div class="sg-col-20-of-24 s-result-item s-widget" data-index="1"><div class="s-widget-container template=SEARCH_TILES"><div class="a-section s-tiles-header" data-csa-c-widget-title="Narrow your search"><div class="a-section s-tiles-header-title"><span class="a-size-medium a-text-bold">Narrow your search</span></div></div>
<span data-component-type="s-tiles-carousel-component"><ol class="a-carousel"><li class="a-carousel-card s-tile"><span class="a-declarative" data-s-tile-lotl='{"tileIndex":0,"url":"/s?k=fake+widget+blue&amp;ref=sxts_lotl_0"}'><a class="a-link-normal" href="#"><img alt="Search for fake widget blue" src="${IMG}"><span class="a-truncate"><span class="a-truncate-full a-offscreen">Blue</span><span class="a-truncate-cut">Blue</span></span></a></span></li></ol>
<a class="a-button a-carousel-button a-carousel-goto-nextpage" href="#"><span class="a-icon-alt">Next page</span></a></span></div></div>`;
    const { data, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + related, { top: tiles }),
    );
    const rel = data.widgets.find((w) => w.type === "related_searches");
    expect(rel?.heading).toBe("Related searches");
    expect(rel?.links).toEqual([
      { text: "fake gizmo", token: "/s?k=fake+gizmo&ref=rsl_sug_0_0" },
      { text: "offsite" },
    ]);
    const nar = data.widgets.find((w) => w.type === "narrow_search");
    expect(nar?.heading).toBe("Narrow your search");
    expect(nar?.links).toEqual([{ text: "Blue", token: "/s?k=fake+widget+blue&ref=sxts_lotl_0" }]);
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("reads a sponsored product carousel, an editorial shelf and a help box", () => {
    const carousel = `<div class="sg-col-20-of-24 s-result-item s-widget" data-index="13"><div class="s-widget-container template=SHOPPING_ADVISER"><div class="s-shopping-adviser"><div class="s-shopping-adviser-heading"><h2 class="a-size-medium-plus" id="fake-heading">Shop fake widgets by type</h2>
<span class="a-declarative" data-action="multi-ad-feedback-form-trigger"><a class="a-link-normal s-widget-sponsored-label-text" aria-label="View Sponsored information or leave ad feedback" href="#" role="button">Sponsored</a></span></div>
<span data-component-type="s-searchgrid-carousel"><div class="a-carousel-container"><ol class="a-carousel"><li class="a-carousel-card"><div class="s-inner-result-item" data-uuid="s-searchgrid-carousel:0"><div class="a-section s-product-header"><span class="a-text-bold">fake shelf header</span></div>
<span data-csa-c-item-id="amzn1.asin.1.B0FAKE0061"><div data-cy="title-recipe"><a class="a-text-normal" href="/sspa/click?ie=UTF8&amp;url=%2Fdp%2FB0FAKE0061"><h2 aria-label="Sponsored Ad - Fake Carousel Item"><span>Fake Carousel Item</span></h2></a></div>${PRICE.replace(/B0FAKE0001/g, "B0FAKE0061")}</span></div></li></ol></div></span></div></div></div>`;
    const editorial = `<div class="s-result-item s-widget" data-index="40"><div class="s-widget-container template=EDITORIAL_RECOMMENDATIONS"><h2>Fake editorial picks</h2><div data-asin="B0FAKE0071"><a href="/dp/B0FAKE0071"><h3>Fake Editorial Item</h3></a></div><div class="a-row"><span>From the Fake Review Desk</span></div></div></div>`;
    const help = `<div class="a-section s-result-item s-widget" data-index="80"><div class="s-widget-container"><h2>Need help?</h2><span>Visit the <a href="/gp/help/customer/display.html">help section</a> or <a href="/gp/help/contact">contact us</a></span></div></div>`;
    const { data, other_sections } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + carousel + editorial + help),
    );
    const car = data.widgets.find((w) => w.type === "sponsored_carousel");
    expect(car?.heading).toBe("Shop fake widgets by type");
    expect(car?.is_sponsored).toBe(true);
    expect(
      car?.items.map((i) => [i.asin, i.title, i.header, i.price?.amount, i.sponsored_signals]),
    ).toEqual([
      [
        "B0FAKE0061",
        "Fake Carousel Item",
        "fake shelf header",
        19.99,
        ["sponsored_click_url", "aria_sponsored_ad"],
      ],
    ]);
    const ed = data.widgets.find((w) => w.type === "editorial");
    expect(ed?.is_sponsored).toBe(false);
    expect(ed?.heading).toBe("Fake editorial picks");
    expect(ed?.items.map((i) => i.asin)).toEqual(["B0FAKE0071"]);
    expect(ed?.text).toBe("From the Fake Review Desk");
    const h = data.widgets.find((w) => w.type === "help");
    expect(h?.links).toEqual([
      { text: "help section", href: "/gp/help/customer/display.html" },
      { text: "contact us", href: "/gp/help/contact" },
    ]);
    expect(h?.text).toBe("Visit the or");
    expect(other_sections).toEqual([]);
  });

  it("skips a hidden widget without sponsored signals", () => {
    const hiddenShelf = `<div class="s-result-item s-widget" data-index="30" data-rf-hidden="1"><h2>Fake hidden shelf</h2><div data-asin="B0FAKE0081"><a href="/dp/B0FAKE0081">Item</a></div></div>`;
    const { data } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + hiddenShelf),
    );
    expect(data.widgets.some((w) => w.heading === "Fake hidden shelf")).toBe(false);
    expect(data.hidden_skipped.widgets).toBe(1);
  });
});

describe("parseSearch: strategy fallbacks", () => {
  const bare = (inner: string, index: number): string =>
    `<div data-index="${index}" data-component-type="s-search-result" class="s-result-item">${inner}</div>`;

  it("falls back for asin, title, rating, review count, prices and prime", () => {
    const a = bare(
      `<a class="a-link-normal" href="/Fake/dp/B0FAKE00A1/ref=sr_1_1"><h2 class="a-size-base"><span>Dp Link Widget</span></h2></a>
<div data-cy="reviews-block"><div class="a-row"><a href="javascript:void(0)" aria-label="3.9 out of 5 stars, rating details"></a></div></div>
<div data-cy="price-recipe"><div class="a-row"><span data-csa-c-price-to-pay="7.25"></span></div><div class="a-row"><span data-strikethroughprice="1"><span class="a-price a-text-price"><span class="a-offscreen">$8.00</span></span></span></div></div>
<div data-cy="delivery-recipe"><div class="a-row"><span role="img" aria-label="Prime"></span> FREE delivery Fri, Jan 3</div></div>`,
      3,
    );
    const b = bare(
      `<div data-asin="B0FAKE00A2"><span class="a-truncate"><span class="a-truncate-full a-offscreen">Truncated Widget</span><span class="a-truncate-cut" aria-hidden="true">Truncated Wid...</span></span></div>
<div data-cy="reviews-block"><div class="a-row"><span>4.2</span><i class="a-icon a-star-mini-4"></i></div><div class="a-row"><span>(321)</span></div></div>
<div data-cy="price-recipe"><div class="a-row"><span class="a-price" data-a-color="base"><span class="a-offscreen">$3.00</span></span> <span>($0.25/ounce)</span></div></div>
<div data-cy="delivery-recipe"><div class="a-row">FREE delivery for Prime members</div></div>`,
      4,
    );
    const { data, meta } = parse(page(a + b));
    const ra = result(data, "B0FAKE00A1");
    expect(ra.title).toBe("Dp Link Widget");
    expect(ra.rating).toEqual({ value: 3.9, out_of: 5 });
    expect(ra.price?.amount).toBe(7.25);
    expect(ra.list_price?.amount).toBe(8);
    expect(ra.prime).toBe(true);
    const rb = result(data, "B0FAKE00A2");
    expect(rb.title).toBe("Truncated Widget");
    expect(rb.rating).toEqual({ value: 4.2, out_of: 5 });
    expect(rb.review_count?.value).toBe(321);
    expect(rb.unit_price).toEqual({
      amount: { amount: 0.25, currency: "USD", raw: "$0.25" },
      unit: "ounce",
      raw: "($0.25/ounce)",
    });
    expect(rb.prime).toBe(true);
    const s = meta.strategies;
    expect(s["results.asin"]).toBe("dp-link:1,descendant-data-asin:1");
    expect(s["results.title"]).toBe("heading:1,truncate-full:1");
    expect(s["results.rating"]).toBe("aria-label:1,rating-number:1");
    expect(s["results.review_count"]).toBe("text-anchor:1");
    expect(s["results.price"]).toBe("price-to-pay-attr:1,a-price:1");
    expect(s["results.list_price"]).toBe("strike-attr:1");
    expect(s["results.unit_price"]).toBe("text-anchor:1");
    expect(s["results.prime"]).toBe("aria-label:1,text-anchor:1");
  });

  it("detects a selected refinement by checkbox, bold label or a Remove label alone", () => {
    const group = (key: string, li: string): string =>
      `<div role="group"><div id="${key}-title" role="heading"><span>Group ${key}</span></div><ul id="filter-${key}" aria-labelledby="${key}-title">${li}</ul></div>`;
    const extra =
      group(
        "p_901",
        `<li><a class="s-navigation-item" href="/s?k=a&amp;rh=p_901"><input type="checkbox" checked><span>By checkbox</span></a></li>`,
      ) +
      group(
        "p_902",
        `<li><a class="s-navigation-item" href="/s?k=a&amp;rh=p_902"><span class="a-text-bold">By bold</span></a></li>`,
      ) +
      group(
        "p_903",
        `<li><a class="s-navigation-item" aria-label="Remove By remove filter" href="/s?k=a"><span>By remove</span></a></li>`,
      ) +
      group(
        "p_904",
        `<li><a class="s-navigation-item" href="/s?k=a&amp;rh=p_904"><span>Not selected</span></a></li>`,
      );
    const { data } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }), { railExtra: extra }),
    );
    const sel = (key: string) => data.refinements.find((g) => g.key === key)?.options[0]?.selected;
    expect([sel("p_901"), sel("p_902"), sel("p_903"), sel("p_904")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(data.refinements.find((g) => g.key === "p_903")?.options[0]?.label).toBe("By remove");
  });

  it("falls back for sort links, pagination, totals, query and widget headings", () => {
    const body = `<div class="s-main-slot">
<div data-index="1" class="s-result-item"><span>1-48 of 500 results</span></div>
${card({ asin: "B0FAKE0001", title: "One", index: 3 })}
<div data-index="5" class="s-result-item s-widget"><div role="region" aria-label="Fake region shelf"><div data-asin="B0FAKE00B1"><a href="/dp/B0FAKE00B1"><span>Region Item</span></a></div></div></div>
<div data-index="9" class="s-result-item"><div class="s-pagination-container" role="navigation" aria-label="pagination"><a class="s-pagination-item" href="/s?k=a&amp;page=1">1</a><a class="s-pagination-item s-pagination-next" href="/s?k=a&amp;page=3">Next</a></div></div>
</div>
<div class="sort-links"><a href="/s?k=a&amp;s=price-asc-rank&amp;ref=sr_st_price-asc-rank">Price: Low to High</a><a aria-current="true" href="/s?k=a&amp;s=review-rank&amp;ref=sr_st_review-rank">Avg. Customer Review</a></div>`;
    const { data, meta } = parse(body, `${HOST}/s?k=a&page=2`);
    expect(data.total_results_text).toBe("1-48 of 500 results");
    expect(meta.strategies.total_results_text).toBe("text-anchor");
    expect(data.result_range).toEqual({ first: 1, last: 48, total: 500, total_approximate: false });
    expect(data.query).toBe("fake widget");
    expect(meta.strategies.query).toBe("search-box");
    expect(data.sort_options).toEqual([
      {
        label: "Price: Low to High",
        value: "price-asc-rank",
        selected: false,
        token: "/s?k=a&s=price-asc-rank&ref=sr_st_price-asc-rank",
      },
      {
        label: "Avg. Customer Review",
        value: "review-rank",
        selected: true,
        token: "/s?k=a&s=review-rank&ref=sr_st_review-rank",
      },
    ]);
    expect(meta.strategies.sort_options).toBe("links");
    expect(data.pagination?.current_page).toBe(2);
    expect(data.pagination?.has_next).toBe(true);
    expect(meta.strategies.pagination).toBe("nav-aria");
    expect(meta.warnings).toContain(
      "pagination: no selected page item, current page taken from the URL",
    );
    const w = data.widgets.find((x) => x.index === 5);
    expect(w?.heading).toBe("Fake region shelf");
    expect(w?.items.map((i) => i.title)).toEqual(["Region Item"]);
    expect(meta.strategies["widgets.other.heading"]).toBe("aria-region:1");
  });

  it("finds a pagination container without strip or navigation role", () => {
    const pag = `<div data-index="9" class="s-result-item"><div class="s-pagination-container"><span class="s-pagination-item s-pagination-selected">4</span></div></div>`;
    const { data, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }), { pag }),
    );
    expect(data.pagination?.current_page).toBe(4);
    expect(data.pagination?.has_next).toBe(false);
    expect(meta.strategies.pagination).toBe("container-class");
  });
});

describe("parseSearch: page-level fields", () => {
  const one = card({ asin: "B0FAKE0001", title: "One", index: 3 });

  it("reads the info bar, query, department and sort options", () => {
    const { data, meta } = parse(page(one));
    expect(data.total_results_text).toBe("1-16 of over 3,000 results for");
    expect(data.result_range).toEqual({ first: 1, last: 16, total: 3000, total_approximate: true });
    expect(data.query).toBe("fake widget");
    expect(meta.strategies.query).toBe("info-bar-state");
    expect(data.department).toEqual({ label: "Fake Department", alias: "fake-dept" });
    expect(data.sort_options).toEqual([
      {
        label: "Featured",
        value: "relevanceblender",
        selected: true,
        token: "/s?k=fake+widget&s=relevanceblender&ref=sr_st_relevanceblender",
      },
      {
        label: "Price: Low to High",
        value: "price-asc-rank",
        selected: false,
        token: "/s?k=fake+widget&s=price-asc-rank&ref=sr_st_price-asc-rank",
      },
      { label: "Avg. Customer Review", value: "review-rank", selected: false },
    ]);
  });

  it("falls back to the URL for query and department", () => {
    const c = cap(`<div class="s-main-slot">${one}</div>`, `${HOST}/s?k=url+query&i=fake-alias`);
    c.html = c.html.replace(/<header[\s\S]*?<\/header>/, "");
    const { data, meta } = parseSearch(c);
    expect(data.query).toBe("url query");
    expect(data.department).toEqual({ alias: "fake-alias" });
    expect(meta.strategies.query).toBe("url");
  });

  it("groups refinements, with selected state, counts, collapsed options, tokens and a price range", () => {
    const { data } = parse(page(one));
    const brands = data.refinements.find((g) => g.key === "p_123");
    expect(brands?.heading).toBe("Brands");
    expect(brands?.options).toEqual([
      {
        label: "Fakebrand",
        selected: true,
        token: "/s?k=fake+widget&qid=1&ref=sr_nr_p_123_1",
        id: "p_123/Fakebrand",
      },
      {
        label: "Otherbrand",
        selected: false,
        count: 42,
        token: "/s?k=fake+widget&rh=p_123%3AOtherbrand&ref=sr_nr_p_123_2",
        id: "p_123/Otherbrand",
      },
      {
        label: "Thirdbrand",
        selected: false,
        token: "/s?k=fake+widget&rh=p_123%3AThirdbrand",
        id: "p_123/Thirdbrand",
        collapsed: true,
      },
    ]);
    const reviews = data.refinements.find((g) => g.key === "p_72");
    expect(reviews?.options).toEqual([
      {
        label: "4 Stars & Up",
        selected: false,
        token: "/s?k=fake+widget&rh=p_72%3A1",
        id: "p_72/1",
      },
      { label: "Offsite thing", selected: false, token: null, id: "p_72/2" },
    ]);
    const price = data.refinements.find((g) => g.key === "p_36");
    expect(price?.heading).toBe("Price");
    expect(price?.range).toEqual({
      low_label: "$1",
      high_label: "$90+",
      low_param: "low-price",
      high_param: "high-price",
    });
    expect(data.applied_filters).toEqual([
      { group: "Brands", label: "Fakebrand", token: "/s?k=fake+widget&qid=1&ref=sr_nr_p_123_1" },
    ]);
  });

  it("falls back to the rh URL parameter for applied filters", () => {
    const html = page(one)
      .replace(' aria-current="true"', "")
      .replace('<input type="checkbox" checked>', "")
      .replace('a-text-bold">Fakebrand', '">Fakebrand')
      .replace("Remove Fakebrand", "Apply Fakebrand");
    const { data, meta } = parse(html, `${HOST}/s?k=fake+widget&rh=p_123%3AFakebrand`);
    expect(data.applied_filters).toEqual([{ group: "p_123", label: "Fakebrand" }]);
    expect(meta.strategies.applied_filters).toBe("url");
  });

  it("reads pagination in the middle and on the last page", () => {
    const mid = parse(page(one, { pag: pagination(2, 3) })).data.pagination;
    expect(mid?.current_page).toBe(2);
    expect(mid?.last_visible_page).toBe(3);
    expect(mid?.has_next).toBe(true);
    expect(mid?.next_token).toBe("/s?k=fake+widget&page=3&ref=sr_pg_2");
    expect(mid?.prev_token).toBe("/s?k=fake+widget&page=1&ref=sr_pg_2");
    expect(mid?.pages.map((p) => [p.page, p.current, p.token !== undefined])).toEqual([
      [1, false, true],
      [2, true, false],
      [3, false, true],
    ]);
    const last = parse(page(one, { pag: pagination(3, 3) })).data.pagination;
    expect(last?.current_page).toBe(3);
    expect(last?.has_next).toBe(false);
    expect(last?.next_token).toBeNull();
    expect(last?.last_visible_page).toBe(3);
  });

  it("reads spelling corrections", () => {
    const top = `<div class="a-section s-result-item s-widget" data-index="0"><div class="a-section a-spacing-none"><div class="a-row"><span>Showing results for </span><a class="a-link-normal" href="/s?k=fake+widget&amp;ref=fix"><span class="a-text-bold">fake widget</span></a></div><div class="a-row"><span>Search instead for </span><a class="a-link-normal" href="/s?k=fake+wigdet&amp;spell=1"><span>fake wigdet</span></a></div></div></div>`;
    const { data, other_sections } = parse(page(one, { top }));
    expect(data.corrections).toEqual([
      {
        type: "showing_results_for",
        text: "Showing results for fake widget",
        query: "fake widget",
        token: "/s?k=fake+widget&ref=fix",
      },
      {
        type: "search_instead_for",
        text: "Search instead for fake wigdet",
        query: "fake wigdet",
        token: "/s?k=fake+wigdet&spell=1",
      },
    ]);
    expect(other_sections).toEqual([]);
  });

  it("returns an empty result list for a no-results page without throwing", () => {
    const top = `<div class="a-section s-result-item s-widget" data-index="0"><div class="a-row"><span>No results for </span><span class="a-color-state a-text-bold">fake zzz gizmo</span></div></div>`;
    const { data, meta } = parse(page("", { top, pag: "" }));
    expect(data.results).toEqual([]);
    expect(data.corrections[0]?.type).toBe("no_results");
    expect(data.corrections[0]?.query).toBe("fake zzz gizmo");
    expect(meta.warnings.some((w) => w.startsWith("results:"))).toBe(false);
  });
});

describe("parseSearch: lossless accounting and errors", () => {
  it("reports an unknown block in other_sections and counts nothing as unparsed", () => {
    const unknown = `<div class="s-result-item s-widget" data-index="50" data-cel-widget="search_result_50"><div id="fake-unknown-block"><span>A brand new block nobody parses yet. </span><a href="/fake/path">Fake link</a></div></div>`;
    const { data, other_sections, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + unknown),
    );
    const w = data.widgets.find((x) => x.index === 50);
    expect(w?.type).toBe("other");
    expect(w?.links).toEqual([{ text: "Fake link", href: "/fake/path" }]);
    expect(w?.text).toBe("A brand new block nobody parses yet.");
    expect(other_sections).toEqual([]);
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("leaves a long unknown widget remainder to other_sections", () => {
    const long = `Fake paragraph ${"lorem ipsum ".repeat(40)}`;
    const unknown = `<div class="s-result-item s-widget" data-index="50"><div id="fake-long-block"><p>${long}</p></div></div>`;
    const { other_sections, meta } = parse(
      page(card({ asin: "B0FAKE0001", title: "One", index: 3 }) + unknown),
    );
    expect(other_sections.map((s) => s.key)).toContain("fake-long-block");
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("counts loose unmarked text as unparsed", () => {
    const html = page(card({ asin: "B0FAKE0001", title: "One", index: 3 })).replace(
      '<div class="sg-col-20-of-24 sg-col">',
      '<div class="sg-col-20-of-24 sg-col"><span>loose text</span>',
    );
    const { meta } = parse(html);
    expect(meta.unparsed_text_chars).toBe("loose text".length);
  });

  it("throws layout_unrecognized when nothing is parseable", () => {
    const c: Capture = { ...cap(""), html: "<html><body><p>Hello</p></body></html>" };
    expect(() => parseSearch(c)).toThrow(RfError);
    try {
      parseSearch(c);
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("warns when the page has a layout but no result cards", () => {
    const { meta, data } = parse(page("", { pag: "" }));
    expect(data.results).toEqual([]);
    expect(meta.warnings).toContain("results: no result cards found");
  });
});

describe("searchToken", () => {
  it("accepts same-site /s URLs and returns path + query", () => {
    expect(searchToken("/s?k=a&rh=p_1%3A2", HOST)).toBe("/s?k=a&rh=p_1%3A2");
    expect(searchToken(`${HOST}/s/ref=x?k=a`, `${HOST}/s?k=b`)).toBe("/s/ref=x?k=a");
  });

  it("rejects other hosts, other paths and non-links", () => {
    expect(searchToken("https://elsewhere.example.org/s?k=a", HOST)).toBeUndefined();
    expect(searchToken("/dp/B0FAKE0001", HOST)).toBeUndefined();
    expect(searchToken("/stores/page/x", HOST)).toBeUndefined();
    expect(searchToken("#", HOST)).toBeUndefined();
    expect(searchToken("javascript:void(0)", HOST)).toBeUndefined();
    expect(searchToken(undefined, HOST)).toBeUndefined();
    expect(searchToken("/s?k=a", "not a url")).toBeUndefined();
  });
});
