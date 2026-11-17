import { searchable, type Product } from "../catalog.ts";
import { esc, priceHtml } from "../util.ts";
import { layout } from "./layout.ts";

/**
 * `/s?k=...`: organic cards, one sponsored card carrying the sponsored signals the search
 * parser detects, a carousel widget, brand refinements and pagination.
 */

const PAGE_SIZE = 4;
/** The product promoted in the sponsored card on every result page. */
const SPONSORED_ASIN = "B0FAKE0002";

function slug(p: Product): string {
  return p.title
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function stars(rating: number): string {
  const whole = Math.floor(rating);
  return `a-star-mini-${whole}${rating - whole >= 0.5 ? "-5" : ""}`;
}

function card(p: Product, index: number, sponsored: boolean): string {
  const href = sponsored
    ? `/sspa/click?ie=UTF8&amp;spc=FAKE&amp;url=%2Fdp%2F${p.asin}`
    : `/${slug(p)}/dp/${p.asin}/ref=sr_1_${index}`;
  const label = sponsored ? `Sponsored Ad - ${p.title}` : p.title;
  const sponsoredLabel = sponsored
    ? `<div class="a-row a-spacing-micro"><span class="a-declarative" data-action="a-popover" data-a-popover='{"name":"sp-info-popover-${p.asin}"}'><a class="puis-label-popover puis-sponsored-label-text" href="javascript:void(0)" role="button"><span class="puis-label-popover-default"><span class="a-color-secondary">Sponsored</span></span></a></span><span class="a-declarative" data-s-safe-ajax-modal-trigger='{"ajaxUrl":"/af/sp-loom/feedback-form?pl=fake"}'><span aria-label="View Sponsored information or leave ad feedback"></span></span></div>`
    : "";
  const price = p.featured
    ? `<div class="a-section a-spacing-none a-spacing-top-micro puis-price-instructions-style" data-cy="price-recipe"><div class="a-row a-size-base a-color-base"><div class="a-row"><span data-csa-c-price-to-pay="${(p.featured.priceCents / 100).toFixed(2)}"><a class="a-link-normal s-no-hover a-text-normal" href="${href}">${priceHtml(p.featured.priceCents)}</a></span></div></div></div>`
    : "";
  const prime = p.featured?.prime
    ? `<div class="a-section a-spacing-none a-spacing-top-micro" data-cy="delivery-recipe"><div class="a-row a-size-base a-color-secondary s-align-children-center"><div class="a-section a-spacing-none a-padding-none udm-delivery-block" data-cy="delivery-block"><div class="a-row a-color-base udm-badge-block"><div class="a-column a-span12"><div class="i-icon-wrapper"><i class="a-icon-wrapper a-icon-prime-with-text a-text-bold"><i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i><span class="a-icon-text">Tomorrow</span></i></div></div></div><div class="a-row a-color-base udm-primary-delivery-message"><div class="a-column a-span12">FREE delivery <span class="a-text-bold">Tomorrow</span></div></div></div></div></div>`
    : "";
  const inner = `<span class="a-declarative" data-action="puis-card-container-declarative"><div class="puis-card-container s-card-container" data-cy="asin-faceout-container">
<div class="s-product-image-container aok-relative" data-cy="image-container"><span class="rush-component" data-component-type="s-product-image"><a class="a-link-normal s-no-outline" aria-hidden="true" tabindex="-1" href="${href}"><img class="s-image" src="https://images.example.com/placeholder.png" alt="${esc(label)}"></a></span></div>
<div class="a-section a-spacing-none s-title-instructions-style" data-cy="title-recipe">${sponsoredLabel}<span class="rush-component" data-component-type="s-client-side-analytics"><div class="s-csa-instrumentation-wrapper"><a class="a-link-normal s-line-clamp-3 s-link-style a-text-normal" href="${href}"><h2 class="a-size-base-plus a-spacing-none a-color-base a-text-normal" aria-label="${esc(label)}"><span>${esc(p.title)}</span></h2></a></div></span></div>
<div class="a-section a-spacing-none a-spacing-top-micro" data-cy="reviews-block"><div class="a-row a-size-small"><span class="a-size-small a-color-base" aria-hidden="true">${p.rating.toFixed(1)}</span><span class="a-declarative" data-action="a-popover"><a class="a-popover-trigger a-declarative" aria-label="${p.rating.toFixed(1)} out of 5 stars, rating details" href="javascript:void(0)" role="button"><i class="a-icon a-icon-star-mini ${stars(p.rating)}" aria-hidden="true"><span class="a-icon-alt">${p.rating.toFixed(1)} out of 5 stars</span></i></a></span><span class="rush-component" data-component-type="s-client-side-analytics"><div class="s-csa-instrumentation-wrapper"><a class="a-link-normal s-underline-text s-link-style" aria-label="${p.reviews.toLocaleString("en-US")} ratings" href="/dp/${p.asin}#customerReviews"><span class="a-size-mini puis-normal-weight-text s-underline-text" aria-hidden="true">(${p.reviews.toLocaleString("en-US")})</span></a></div></span></div></div>
${price}${prime}</div></span>`;
  const wrapped = sponsored
    ? `<div class="rush-component" data-component-type="s-impression-counter" data-component-props='{"presenceCounterName":"sp_delivered","hiddenCounterName":"sp_hidden"}'>${inner}</div>`
    : inner;
  return `<div role="listitem" data-asin="${p.asin}" data-index="${index}" data-uuid="00000000-0000-0000-0000-00000000000${index % 10}" data-component-type="s-search-result" class="sg-col-4-of-24 s-result-item s-asin${sponsored ? " AdHolder" : ""}" data-cel-widget="search_result_${index}"><div class="sg-col-inner"><div class="s-widget-container celwidget" cel_widget_id="MAIN-SEARCH_RESULTS-${index}" data-csa-c-item-id="amzn1.asin.1.${p.asin}">${wrapped}</div></div></div>`;
}

function carousel(items: Product[], index: number): string {
  const cards = items
    .map(
      (p, i) =>
        `<li class="a-carousel-card"><div class="s-inner-result-item" data-uuid="s-searchgrid-carousel:${i}"><span data-csa-c-item-id="amzn1.asin.1.${p.asin}"><div data-cy="title-recipe"><a class="a-text-normal" href="/dp/${p.asin}"><h2 aria-label="${esc(p.title)}"><span>${esc(p.title)}</span></h2></a></div>${
          p.featured ? `<div data-cy="price-recipe">${priceHtml(p.featured.priceCents)}</div>` : ""
        }</span></div></li>`,
    )
    .join("");
  return `<div class="sg-col-20-of-24 s-result-item s-widget" data-index="${index}"><div class="s-widget-container template=SHOPPING_ADVISER"><div class="s-shopping-adviser"><div class="s-shopping-adviser-heading"><h2 class="a-size-medium-plus" id="mock-carousel-heading">Shop example goods by type</h2></div><span data-component-type="s-searchgrid-carousel"><div class="a-carousel-container"><ol class="a-carousel">${cards}</ol></div></span></div></div></div>`;
}

function refinements(query: string, brands: string[], selected: string | null): string {
  const q = encodeURIComponent(query);
  const options = brands
    .map((b, i) => {
      const id = `p_123/${b.replace(/\s+/g, "")}`;
      const on = b === selected;
      const href = on
        ? `/s?k=${q}&amp;ref=sr_nr_p_123_${i + 1}`
        : `/s?k=${q}&amp;rh=p_123%3A${encodeURIComponent(b)}&amp;ref=sr_nr_p_123_${i + 1}`;
      return `<span data-csa-c-content-id="${esc(id)}"><li class="a-spacing-micro" id="${esc(id)}"><span class="a-list-item"><a class="a-link-normal s-navigation-item" aria-current="${on}" ${on ? `aria-label="Remove ${esc(b)} filter to see more results" ` : ""}href="${href}"><div class="a-checkbox"><label><input type="checkbox"${on ? " checked" : ""}><i class="a-icon a-icon-checkbox"></i></label></div><span class="a-size-base a-color-base${on ? " a-text-bold" : ""}">${esc(b)}</span></a></span></li></span>`;
    })
    .join("");
  return `<span class="rush-component" data-component-type="s-filters-panel-view"><div id="s-refinements" class="a-section a-spacing-none"><div class="a-section a-spacing-none" id="brandsRefinements" role="group" aria-labelledby="p_123-title"><div class="a-section a-spacing-small" id="p_123-title" aria-level="2" role="heading"><span class="a-size-base a-color-base puis-bold-weight-text">Brands</span></div><ul class="a-unordered-list a-nostyle a-vertical" id="filter-p_123" aria-labelledby="p_123-title"><span class="a-declarative" data-action="sf-select-refinement-picker">${options}</span></ul></div></div></span>`;
}

function pagination(query: string, page: number, pages: number, rh: string | null): string {
  const base = `/s?k=${encodeURIComponent(query)}${rh ? `&amp;rh=${encodeURIComponent(rh)}` : ""}`;
  const link = (n: number, text: string, cls: string, aria: string): string =>
    `<li><span class="a-list-item"><a class="s-pagination-item ${cls} s-pagination-button" href="${base}&amp;page=${n}&amp;ref=sr_pg_${n}" aria-label="${aria}">${text}</a></span></li>`;
  let items =
    page > 1
      ? link(page - 1, "Previous", "s-pagination-previous", `Go to previous page, page ${page - 1}`)
      : `<li><span class="a-list-item"><span class="s-pagination-item s-pagination-previous s-pagination-disabled" aria-disabled="true">Previous</span></span></li>`;
  for (let n = 1; n <= pages; n++) {
    items +=
      n === page
        ? `<li><span class="a-list-item"><span class="s-pagination-item s-pagination-selected" aria-current="page" aria-label="Page ${n}">${n}</span></span></li>`
        : link(n, String(n), "", `Go to page ${n}`);
  }
  items +=
    page < pages
      ? link(page + 1, "Next", "s-pagination-next", `Go to next page, page ${page + 1}`)
      : `<li><span class="a-list-item"><span class="s-pagination-item s-pagination-next s-pagination-disabled" aria-disabled="true">Next</span></span></li>`;
  return `<div class="a-section a-spacing-none s-result-item s-flex-full-width s-widget" data-index="90" data-cel-widget="search_result_90"><div class="s-widget-container celwidget" cel_widget_id="MAIN-PAGINATION-90"><div class="a-section a-text-center s-pagination-container" aria-label="pagination" role="navigation"><span class="s-pagination-strip"><ul class="a-unordered-list a-horizontal">${items}</ul></span></div></div></div>`;
}

export function renderSearch(url: URL): string {
  const query = (url.searchParams.get("k") ?? "").slice(0, 100);
  const rh = url.searchParams.get("rh");
  const brand = rh && rh.startsWith("p_123:") ? rh.slice("p_123:".length) : null;
  const all = searchable();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = all.filter((p) =>
    terms.some((t) => `${p.title} ${p.brand}`.toLowerCase().includes(t)),
  );
  if (matches.length === 0) matches = all;
  const brands = [...new Set(matches.map((p) => p.brand))].sort();
  if (brand) matches = matches.filter((p) => p.brand === brand);
  const organic = matches.filter((p) => p.asin !== SPONSORED_ASIN);
  const pages = Math.max(1, Math.ceil(organic.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(url.searchParams.get("page")) || 1), pages);
  const shown = organic.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sponsored = all.find((p) => p.asin === SPONSORED_ASIN)!;
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = first + shown.length - 1;
  const cards =
    card(sponsored, 2, true) +
    shown.map((p, i) => card(p, 3 + i, false)).join("") +
    carousel(all.slice(0, 2), 13) +
    pagination(query, page, pages, rh);
  const infoBar = `<span class="rush-component" data-component-type="s-result-info-bar"><div class="s-widget-container celwidget" cel_widget_id="UPPER-RESULT_INFO_BAR-0"><h1 class="a-size-base s-desktop-toolbar a-text-normal"><div class="s-desktop-width-max sg-row"><div class="sg-col-14-of-20 sg-col s-breadcrumb"><div class="sg-col-inner"><h2 class="a-size-base a-spacing-small a-text-normal"><span>${first}-${last} of ${organic.length} results for</span><span> </span><span class="a-color-state a-text-bold">"${esc(query)}"</span></h2></div></div></div></h1></div></span>`;
  return layout({
    title: `Example storefront : ${query}`,
    query,
    body: `<div id="search">${infoBar}<div class="s-desktop-width-max s-desktop-content sg-row"><div class="sg-col-4-of-24 sg-col">${refinements(query, brands, brand)}</div><div class="sg-col-20-of-24 sg-col"><span class="rush-component" data-component-type="s-search-results"><div class="s-main-slot s-result-list s-search-results sg-row">${cards}</div></span></div></div></div>`,
  });
}
