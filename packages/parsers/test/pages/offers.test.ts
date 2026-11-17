import { describe, expect, it } from "vitest";
import { OFFER_FLAGS, RfError } from "@rainforest/core";
import type { Capture, OfferFlag } from "@rainforest/core";
import { parseDocument, q } from "../../src/index.ts";
import {
  AOD_NEXT_PAGE_TEMPLATE,
  REQUEST_TIME_FLAGS,
  computeOfferFlags,
  computeStaticOfferFlags,
  conditionFromCode,
  conditionFromText,
  deliveryDaysFrom,
  isAmazonName,
  isMultipackAmbiguous,
  isOfferOutOfStock,
  multipackCounts,
  normalizeAodVisibility,
  offerFlagContext,
  parseDeliveryDate,
  parseOffers,
} from "../../src/pages/offers.ts";
import type { Offer, OfferFlagContext } from "../../src/pages/offers.ts";

// ---- synthetic markup builders (structure mirrors the real panel; all content is invented)

const CAPTURED_AT = "2030-03-01T12:00:00.000Z";

interface CardOpts {
  i: number;
  heading?: string | null;
  code?: string;
  ref?: string;
  price?: string | null;
  savings?: string;
  basisLabel?: string;
  basis?: string;
  unit?: { price: string; unit: string };
  fee?: string;
  promo?: string;
  badge?: string;
  prime?: { epoch?: number; badge?: string } | null;
  program?: string;
  shipRow?: string;
  deliveryPrice?: string;
  deliveryTime?: string;
  deliveryText?: string;
  deliveryCondition?: string;
  secondary?: { time: string; text: string };
  noDelivery?: boolean;
  stock?: string;
  olid?: string | null;
  jsonOid?: string | null;
  asin?: string;
  maxQty?: number;
  minQty?: number;
  qtyOptions?: number;
  sticky?: boolean;
  conditionNote?: string;
  shipsFrom?: string | null;
  soldBy?: string | null;
  soldByLink?: boolean;
  sellerId?: string;
  ratingLine?: string;
  ratingClass?: string;
  extraRows?: { label: string; value: string }[];
  extraBlock?: string;
  cardAttrs?: string;
}

function money(p: string): string {
  const [whole, frac] = p.replace("$", "").split(".");
  return `<span class="a-price aok-align-center apex-pricetopay-value"><span class="a-offscreen"></span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span><span class="a-price-fraction">${frac ?? "00"}</span></span></span>`;
}

function row(id: string, label: string, valueHtml: string): string {
  return `<div id="${id}" class="a-section a-spacing-none a-spacing-top-micro aod-clear-float" role="listitem"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner"><div class="a-fixed-left-grid-col aod-padding-right-10 a-col-left"><span class="a-size-small a-color-tertiary">${label}</span></div><div class="a-fixed-left-grid-col a-col-right">${valueHtml}</div></div></div></div>`;
}

function priceBlock(o: CardOpts): string {
  if (o.price === null) return `<span id="aod-price-${o.i}"></span>`;
  const p = o.price ?? "$20.00";
  const savings =
    o.savings === undefined
      ? ""
      : `<span class="apex-savings-container"><span class="a-size-medium a-color-price apex-savings-percentage" aria-hidden="true">${o.savings}</span></span>`;
  const basis =
    o.basis === undefined
      ? ""
      : `<div class="a-section a-spacing-small aok-align-center centralizedApexBasisPriceCSS"><span class="apex-basisprice-feature"><span class="aok-relative"><span class="a-size-small aok-offscreen apex-basisprice-offscreen-label">${o.basisLabel ?? "Typical price:"} ${o.basis}</span><span class="a-size-small a-color-secondary aok-align-center" aria-hidden="true"><span class="apex-basisprice-label">${o.basisLabel ?? "Typical price:"}</span><span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${o.basis}</span><span aria-hidden="true">${o.basis}</span></span></span></span></span></div>`;
  const unit =
    o.unit === undefined
      ? ""
      : `<div class="a-section a-spacing-none aok-align-center centralizedApexPricePerUnitCSS"><span class="aok-relative"><span class="a-size-mini aok-offscreen apex-priceperunit-accessibility-label">${o.unit.price} per ${o.unit.unit}</span><span class="a-size-mini a-color-base aok-align-center" aria-hidden="true">(<span class="a-price a-text-price apex-priceperunit-value"><span class="a-offscreen">${o.unit.price}</span><span aria-hidden="true">${o.unit.price}</span></span> / ${o.unit.unit})</span></span></div>`;
  const code = o.code === undefined ? "" : ` data-csa-c-buying-option-type="${o.code}"`;
  return `<span id="aod-price-${o.i}"><div class="a-section a-spacing-none apex-core-price-identifier"${code} data-csa-c-price-to-pay="${p.replace("$", "")}"><div class="a-section a-spacing-none aok-align-center aok-relative"><span class="aok-offscreen apex-pricetopay-accessibility-label">${p}</span>${savings}${money(p)}</div>${basis}${unit}</div></span>`;
}

function delivery(o: CardOpts): string {
  if (o.noDelivery === true) return "";
  const time = o.deliveryTime ?? "Tuesday, March 3";
  const priceAttr = o.deliveryPrice ?? "FREE";
  const programAttr =
    o.program === undefined ? "" : ` data-csa-c-delivery-benefit-program-id="${o.program}"`;
  const text = o.deliveryText ?? `${priceAttr === "FREE" ? "FREE" : priceAttr} delivery`;
  const secondary =
    o.secondary === undefined
      ? ""
      : `<div id="mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE" class="a-spacing-base"><span data-csa-c-delivery-price="fastest" data-csa-c-delivery-time="${o.secondary.time}">${o.secondary.text} <span class="a-text-bold">${o.secondary.time}</span></span></div>`;
  return `<div class="a-row aod-delivery-promise"><div class="a-column a-span12 aod-delivery-promise-column"><span class="a-size-base a-color-base"><div id="unified-delivery-message-${o.i}" class="a-section aod-unified-delivery"><div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE" class="a-spacing-base"><span data-csa-c-delivery-price="${priceAttr}" data-csa-c-delivery-time="${time}" data-csa-c-delivery-condition="${o.deliveryCondition ?? ""}" data-csa-c-delivery-cutoff=""${programAttr}>${text} <span class="a-text-bold">${time}</span>${o.deliveryCondition === undefined ? "" : ` ${o.deliveryCondition}`}</span></div>${secondary}</div></div></span></div><span class="a-size-base aod-delivery-more aok-hidden">... <a class="a-link-normal aod-delivery-morelink" href="#">More</a></span></div>`;
}

function atc(o: CardOpts): string {
  const asin = o.asin ?? "B0FAKE0001";
  const olid = o.olid === undefined ? `FAKEOLID%2B${String(o.i).padStart(4, "0")}` : o.olid;
  const json: Record<string, unknown> = {
    refTag: "aod_dpdsk_fake",
    asin,
    maxQty: Object.hasOwn(o, "maxQty") ? o.maxQty : 30,
    minQty: o.minQty ?? 1,
    offerIndex: o.i,
    isStickyPinnedOffer: o.sticky === true,
  };
  const jsonOid = o.jsonOid === undefined ? olid : o.jsonOid;
  if (jsonOid !== null) json.oid = jsonOid;
  const olidInput =
    olid === null
      ? ""
      : `<input type="hidden" name="items[0.base][offerListingId]" value="${olid}">`;
  const opts = Array.from(
    { length: o.qtyOptions ?? 0 },
    (_, k) =>
      `<span class="a-declarative" data-action="select-aod-qty-option" data-select-aod-qty-option='{"qty":${k + 1},"offerIndex":${o.i}}'><div class="a-row a-spacing-none"><span id="aod-offer-qty-option-${o.i}-${k + 1}" class="a-size-base aod-qty-option">${k + 1}</span></div></span>`,
  ).join("");
  return `<div class="a-fixed-right-grid-col aod-atc-column a-col-right"><form method="post" action="/cart/add-to-cart/ref=aod_dpdsk_${o.ref ?? "new"}_${o.i}" class="AodAddToCart"><input type="hidden" name="anti-csrftoken-a2z" value="FAKECSRFTOKENVALUE0001"><input type="hidden" name="items[0.base][asin]" value="${asin}">${olidInput}<input type="hidden" name="items[0.base][quantity]"><input type="hidden" name="clientName" value="FakeClient"><span class="a-declarative" data-action="aod-atc-action" data-aod-atc-action='${JSON.stringify(json)}'><span class="a-button a-button-primary"><span class="a-button-inner"><input class="a-button-input" name="submit.addToCart" type="submit" aria-label="Add to Cart from seller ${o.soldBy ?? "Example Outlet"}${o.price === null ? "" : ` and price ${o.price ?? "$20.00"}`}"><span class="a-button-text" aria-hidden="true">Add to Cart</span></span></span></span><form method="get" action="/gp/cart/view.html/ref=aod_fake_cart" class="a-spacing-none"><span class="a-button aod-view-cart-btn aok-hidden"><span class="a-button-text">View Cart</span></span></form></form><div id="aod-offer-qty-component-${o.i}" class="a-section aod-qty-container aok-hidden"><span class="a-button-text">Qty: 1</span><div id="aod-qty-dropdown-scroller">${opts}</div></div></div>`;
}

function cardInner(o: CardOpts): string {
  const heading =
    o.heading === null
      ? ""
      : `<div id="aod-offer-heading" class="a-section a-spacing-none a-padding-none aod-clear-float"><span class="a-size-base a-text-bold">${o.heading ?? "New"}</span></div>`;
  const prime =
    o.prime === undefined || o.prime === null
      ? ""
      : `<span class="a-size-base a-color-base"><i class="a-icon a-icon-prime" role="img" aria-label="prime"${o.prime.epoch === undefined ? "" : ` data-csa-c-delivery-promise-date="${o.prime.epoch}"`}></i>${o.prime.badge ?? ""}</span>`;
  const stock =
    o.stock === undefined ? "" : `<div id="aod-offer-availability" class="a-row">${o.stock}</div>`;
  return `<div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><div class="a-fixed-right-grid-col a-col-left">${heading}</div><div class="a-fixed-right-grid-col aod-atc-inline-msg-column a-col-right"><div id="aod-offer-added-to-cart-${o.i}" class="a-box a-alert-inline aod-visibility-hidden"><div class="a-alert-content">Added</div></div><div id="aod-offer-not-added-to-cart-${o.i}" class="a-box a-alert-inline aok-hidden" role="alert"><div class="a-alert-content">Not added</div></div></div></div></div>
  <div id="aod-offer-price" class="a-section a-spacing-none aod-clear-float"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner"><div class="a-fixed-left-grid-col a-col-left">${priceBlock(o)}</div><div class="a-fixed-left-grid-col a-col-right"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><div class="a-fixed-right-grid-col aod-padding-right-10 a-col-left"><div id="aod-bottlingDepositFee-${o.i}" class="a-row">${o.fee ?? ""}</div><div class="a-row"><div id="aod-offer-promotion-${o.i}" class="a-section">${o.promo ?? ""}</div></div>${o.badge === undefined ? "" : `<div id="aod-offer-mario-${o.i}" class="a-section"><span>${o.badge}</span></div>`}${prime}<div id="aod_ship_charge_row" class="a-row aod-ship-charge">${o.shipRow ?? ""}</div>${delivery(o)}${stock}</div>${atc(o)}</div></div></div></div></div></div>`;
}

function detailRowsHtml(o: CardOpts): string {
  const out: string[] = [];
  if (o.conditionNote !== undefined) {
    out.push(
      `<div id="aod-condition-container" class="a-section a-spacing-none aod-clear-float" role="listitem"><div class="a-fixed-left-grid expandable-text-section"><div class="a-fixed-left-grid-inner"><div id="condition-text-block-title" class="a-fixed-left-grid-col a-col-left"><span id="condition-text-block-title-text" class="a-size-small a-color-tertiary" role="heading">Condition</span></div><div class="a-fixed-left-grid-col a-col-right"><span class="a-size-small expandable-text"><span class="expandable-expanded-text">${o.conditionNote}</span></span></div></div></div></div>`,
    );
  }
  if (o.shipsFrom !== null) {
    out.push(
      row(
        "aod-offer-shipsFrom",
        "Ships from",
        `<span class="a-size-small a-color-base">${o.shipsFrom ?? "Amazon.com"}</span>`,
      ),
    );
  }
  if (o.soldBy !== null) {
    const name = o.soldBy ?? "Example Outlet";
    const link =
      o.soldByLink === false
        ? `<span class="a-size-small a-color-base">${name}</span>`
        : `<a class="a-size-small a-link-normal" role="link" href="/gp/aag/main?ie=UTF8&amp;seller=${o.sellerId ?? "AFAKESELLER01"}&amp;isAmazonFulfilled=1">${name}</a>`;
    const rating =
      o.ratingLine === undefined
        ? ""
        : `<div id="aod-offer-seller-rating" class="a-section"><i class="a-icon a-icon-star-mini ${o.ratingClass ?? "a-star-mini-4-5"} aod-seller-rating-count-class"><span class="a-icon-alt">Seller rating is 4.5 out of 5 stars</span></i><span id="seller-rating-count-{iter}" class="a-size-small a-color-base"><span>${o.ratingLine}<br></span></span></div>`;
    out.push(row("aod-offer-soldBy", "Sold by", link + rating));
  }
  for (const r of o.extraRows ?? []) {
    out.push(row(`aod-offer-${r.label.replace(/\W/g, "")}`, r.label, `<span>${r.value}</span>`));
  }
  return out.join("");
}

function card(o: CardOpts): string {
  return `<div id="aod-offer" class="a-section a-spacing-none a-padding-small aod-information-block aod-clear-float" role="listitem"${o.cardAttrs ?? ""}>${cardInner(o)}<div class="a-row aod-clear-float"></div><div class="a-section" role="list">${detailRowsHtml(o)}</div>${o.extraBlock ?? ""}<div class="a-section aod-offer-divider aod-clear-float"></div></div><hr class="a-spacing-none a-divider-normal aod-offer-block-divider" aria-hidden="true">`;
}

function pinnedHtml(o: CardOpts | "message" | null): string {
  if (o === null) return "";
  const header = `<div id="pinned-image-id" class="offer-image-block"><img id="aod-asin-image-id" alt="" src="https://images.example.com/placeholder.png"></div>`;
  const product = `<div id="aod-asin-block-asin" class="a-section"><div id="aod-asin-title" class="a-row"><h5 id="aod-asin-title-text">Invented Widget Deluxe, Pack of 2</h5></div><div id="aod-asin-reviews" class="a-row"><span><i id="aod-asin-reviews-star" class="a-icon a-icon-star a-star-4-5"><span class="a-icon-alt">4.5 out of 5 stars</span></i></span><span id="aod-asin-reviews-block"><span id="aod-asin-reviews-count-title">1,234 ratings</span></span></div></div>`;
  if (o === "message") {
    return `<div id="aod-pinned-offer" class="a-section aod-pinned-offer"><div class="a-section asin-container-padding">${header}<div id="pinned-de-id">${product}<div class="a-row"><span>No featured offers available</span></div></div></div></div>`;
  }
  const details = `${o.shipsFrom === null ? "" : row("aod-offer-shipsFrom", "Ships from", `<span class="a-size-small a-color-base">${o.shipsFrom ?? "Amazon.com"}</span>`)}${o.soldBy === null ? "" : row("aod-offer-soldBy", "Sold by", `<span class="a-size-small a-color-base">${o.soldBy ?? "Amazon.com"}</span>`)}${row("aod-offer-customerServiceIdentifier", "Customer service", `<span class="a-size-small a-color-base">Amazon.com</span>`)}`;
  return `<div id="aod-pinned-offer" class="a-section a-spacing-none aod-pinned-offer"><div class="a-section asin-container-padding aod-clear-float"><div class="a-fixed-left-grid pinned-offer-inner"><div class="a-fixed-left-grid-inner">${header}<div id="pinned-de-id" class="pinned-offer-block a-col-right">${product}${cardInner(o)}</div></div></div><div id="aod-pinned-offer-main-content-show-more" class="a-section"><span class="a-declarative" data-action="aod-pinned-offer-show-more"><a id="aod-pinned-offer-show-more-link" href="#">See more</a></span></div><div id="aod-pinned-offer-additional-content" class="a-section aod-hide" role="list">${details}<div class="a-section aod-offer-divider"></div></div><div id="aod-pinned-offer-main-content-show-less" class="a-section"><a id="aod-pinned-offer-show-less-link" class="aod-hide" href="#">See less</a></div></div><hr class="aod-offer-block-divider" aria-hidden="true"></div>`;
}

interface PanelOpts {
  pinned?: CardOpts | "message" | null;
  offers?: CardOpts[];
  collapsed?: CardOpts[];
  total?: number;
  totalText?: string;
  filters?: boolean;
  sticky?: boolean;
  extraList?: string;
  extraContainer?: string;
}

function filtersHtml(): string {
  const box = (id: string, label: string, json: string, checked = false, sub = false): string =>
    `<div class="a-row ${sub ? "aod-filter-subfilter" : "aod-filter-parent-filter"}"><div class="a-column checkbox-container"><span class="a-declarative" data-action="aod-toggle-filter-checkbox" data-aod-toggle-filter-checkbox='${json}'><div class="a-row" role="checkbox" aria-checked="${checked}" aria-label="${label}"><div class="a-column a-span9"><span class="a-size-base a-color-base" aria-hidden="true">${label === "Prime" ? '<i class="a-icon a-icon-prime" role="img" aria-label="Prime"></i>' : label}${label === "Used" ? " (3)" : ""}</span></div><div id="${id}" class="a-column a-span3 aod-filter-checkbox"><div class="a-checkbox"><label><input type="checkbox" name="" value=""><i class="a-icon a-icon-checkbox"></i><span class="a-label a-checkbox-label"></span></label></div></div></div></span></div></div>`;
  return `<div id="aod-filter" class="a-section aod-filter-block-container"><div class="a-row"><div id="aod-message-component" class="a-column a-span9"><h2 id="aod-filter-offer-count-string">Other sellers on Amazon</h2><p id="aod-sort-details-string">sorted by price + delivery</p></div></div><span class="a-declarative" data-action="aod-filter-container-hover"><div id="aod-filter-component" class="a-section"><div id="aod-show-filter-button" role="button" aria-label="Filter"><span id="aod-filter-string" class="a-button-text">Filter</span></div><div id="aod-filter-list" class="a-section aod-filter-list-container"><div class="a-row"><h1 class="a-size-base a-text-bold">Filter by</h1><a class="a-link-normal" href="#">Clear all</a></div><div role="group" aria-labelledby="Delivery-group-label"><div class="a-row"><h5 id="Delivery-group-label" aria-hidden="true">Delivery</h5></div>${box("primeEligible", "Prime", '{"refMarker":"aod_f_fake1","checkboxID":"primeEligible","parentID":""}', true)}${box("freeShipping", "Free delivery", '{"refMarker":"aod_f_fake2","checkboxID":"freeShipping","parentID":""}')}</div><div role="group" aria-labelledby="Condition-group-label"><div class="a-row"><h5 id="Condition-group-label" aria-hidden="true">Condition</h5></div>${box("new", "Renewed", '{"refMarker":"aod_f_fake3","checkboxID":"new","parentID":""}')}${box("used", "Used", '{"refMarker":"aod_f_fake4","checkboxID":"used","parentID":""}')}${box("usedVeryGood", "Very Good", '{"refMarker":"aod_f_fake5","checkboxID":"usedVeryGood","parentID":"used"}', false, true)}</div></div></div></span><div id="aod-filter-swatch-box" class="aod-hide"><div id="aod-filter-swatch-container-top" role="group" aria-label="Active Filters"><span class="a-declarative" data-aod-toggle-filter-checkbox='{"checkboxID":"primeEligible","parentID":""}'><div id="aod-swatch-id-primeEligible" class="aod-filter-swatch aod-hide"><span>Prime</span></div></span></div></div></div>`;
}

function panel(o: PanelOpts): string {
  const offers = o.offers ?? [];
  const collapsed = o.collapsed ?? [];
  const total = o.total ?? offers.length + collapsed.length;
  const sticky =
    o.sticky === true
      ? `<div id="aod-sticky-pinned-container" class="a-section aod-sticky-pinned-container"><div id="aod-sticky-pinned-offer" class="a-section aod-sticky-pinned-offer"><div class="a-section aod-information-block">${card({ i: 0, sticky: true, heading: "New", price: "$99.99", soldBy: "Sticky Duplicate" })}</div></div></div>`
      : "";
  const see =
    collapsed.length === 0
      ? ""
      : `<div id="aod-see-more-options-link" class="a-section aod-see-more-container"><span class="a-declarative" data-action="aod-show-other-offers"><span id="aod-oas-see-more-offer-desktop" class="a-button-text" aria-label="See ${collapsed.length} more options">See ${collapsed.length} more options</span></span></div>`;
  return `<script type="a-state" data-a-state='{"key":"aod-assets"}'>{}</script><span class="a-declarative" data-action="aod-close-on-esc-action"><div id="aod-close" class="a-section"><span role="button" aria-label="Close"><i class="a-icon aod-close-button"></i></span></div><div id="all-offers-display-scroller" class="a-scroller"><div id="aod-container" class="a-section a-spacing-none a-padding-none"><form method="post" action="" class="aod-hide a-spacing-none"></form>${sticky}${pinnedHtml(o.pinned === undefined ? { i: 0 } : o.pinned)}${o.filters === true ? filtersHtml() : ""}<div id="aod-offer-list" class="a-section"><input type="hidden" id="aod-total-offer-count" name="" value="${total}"><input type="hidden" id="aod-total-offer-count-string" name="" value="${o.totalText ?? `${total} other options`}"><input type="hidden" id="aod-atc-csrf-token" name="" value="FAKECSRFTOKENVALUE0002"><input type="hidden" id="aod-atc-ajax-endpoint" name="" value="data.example.com/fake/cart/items">${offers.map(card).join("")}${see}<div id="aod-retail-other-offers-content" class="a-section aod-oas-other-offers-hide">${collapsed.map(card).join("")}</div>${o.extraList ?? ""}</div>${o.extraContainer ?? ""}<div id="aod-retail-footer" class="a-section aod-hide"><a id="aod-retail-show-more-offers" class="a-link-normal aod-hide" href="#">Show more</a><span id="aod-retail-end-of-results" class="aod-hide">End of results</span></div></div></div></span>`;
}

interface PageOpts {
  title?: string;
  sns?: { active?: boolean } | null;
  oneTimeActive?: boolean;
  coupon?: "clip" | "sns" | null;
  basisLabel?: string;
  basis?: string;
  protection?: boolean;
  addon?: boolean;
  availability?: string;
  seeAll?: boolean;
  noAtc?: boolean;
  noAccordion?: boolean;
  unavailable?: boolean;
  extraBuybox?: string;
}

function productPage(o: PageOpts = {}): string {
  const basis =
    o.basis === undefined
      ? ""
      : `<span class="apex-basisprice-feature"><span class="a-size-small aok-offscreen apex-basisprice-offscreen-label">${o.basisLabel ?? "Typical price:"} ${o.basis}</span><span aria-hidden="true"><span class="apex-basisprice-label">${o.basisLabel ?? "Typical price:"}</span><span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">${o.basis}</span><span aria-hidden="true">${o.basis}</span></span></span></span>`;
  const coupon =
    o.coupon === "clip"
      ? `<div><span><i id="badgepctchFAKE01" class="a-icon a-icon-addon newCouponBadge">Coupon:</i><label id="couponTextpctchFAKE01" class="a-color-success couponLabelText" for="checkboxpctchFAKE01">Apply $2.00 coupon</label><input type="checkbox" id="checkboxpctchFAKE01" name="fakeCouponClip"><span class="a-declarative" data-action="a-modal"><a href="#">Terms</a></span></span></div>`
      : o.coupon === "sns"
        ? `<div><span><i id="badgepctchFAKE02" class="a-icon a-icon-addon newCouponBadge">Coupon:</i><span id="couponTextpctchFAKE02" class="a-color-success couponLabelText">Save 10%: Coupon available when you select <span class="a-text-bold">Subscribe &amp; Save</span>. | <a href="#">Shop items</a></span></span></div>`
        : "";
  const promo = `<div id="promoPriceBlockMessage_feature_div"><div id="reinvent_price_desktop_newAccordionRow"><span class="promoPriceBlockMessage">${coupon}<div><span><label id="greenBadgepctchFAKE03"><span class="a-text-bold">3% back</span></label><span id="promoMessagepctchFAKE03">with an invented card <a href="#">Terms</a></span></span></div></span></div></div>`;
  const oneTimeActive = o.oneTimeActive ?? o.sns?.active !== true;
  const atcButtons =
    o.noAtc === true
      ? ""
      : `<div id="addToCart_feature_div"><span class="a-button"><input id="add-to-cart-button" name="submit.add-to-cart" type="submit" value="Add to Cart"><span id="submit.add-to-cart-announce" class="a-button-text">Add to cart</span></span></div><div id="buyNow_feature_div"><span class="a-button"><input id="buy-now-button" name="submit.buy-now" type="submit"><span class="a-button-text">Buy Now</span></span></div>`;
  const form = (olid: string): string =>
    `<form id="addToCart" method="post" action="/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance"><input type="hidden" name="anti-csrftoken-a2z" value="FAKECSRFTOKENVALUE0003"><input type="hidden" name="items[0.base][asin]" value="B0FAKE0001"><input type="hidden" name="items[0.base][offerListingId]" value="${olid}"><input type="hidden" id="ASIN" name="ASIN" value="B0FAKE0001"><input type="hidden" id="offerListingID" name="offerListingID" value="${olid}"><input type="hidden" id="merchantID" name="merchantID" value="AFAKEMERCH01"><div id="availability" class="a-section"><span class="a-size-base primary-availability-message">${o.availability ?? "In Stock"}</span></div><div id="deliveryBlock_feature_div"><div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span>FREE delivery <span class="a-text-bold">Tuesday, March 3</span></span></div></div></div><div id="cipInsideDeliveryBlock_feature_div"><span id="contextualIngressPtLabel">Deliver to Alex - Exampleville 00000</span></div><div id="selectQuantity"><label>Quantity:</label><select id="quantity" name="quantity" data-rf-hidden="1"><option value="1">1</option><option value="2">2</option><option value="12">12</option></select></div>${atcButtons}<div id="offerDisplayFeatures_desktop"><div id="fulfillerInfoFeature_feature_div" data-rf-hidden="1"><span class="offer-display-feature-text-message">Amazon.com</span></div><div id="merchantInfoFeature_feature_div" data-rf-hidden="1"><span class="offer-display-feature-text-message">Amazon.com</span></div><a href="#">See more</a></div></form>`;
  const oneTimeRow = `<div id="newAccordionRow_0" class="a-box${oneTimeActive ? " a-accordion-active" : ""}" data-a-accordion-row-name="newAccordionRow"><div class="a-box-inner"><div class="a-accordion-row a-declarative accordion-header" data-action="a-accordion" role="button"><h5><div class="a-column a-span12 accordion-caption"><span class="a-text-bold">One-time purchase:</span></div></h5><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$20.00</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">20<span class="a-price-decimal">.</span></span><span class="a-price-fraction">00</span></span></span><span class="a-size-small aok-offscreen apex-priceperunit-accessibility-label">$10.00 per count</span></div></div><div class="a-accordion-inner accordion-row-content"${oneTimeActive ? "" : ' data-rf-hidden="1"'}>${form("FAKEBBOLID0001")}</div></div></div>`;
  const snsRow =
    o.sns === null || o.sns === undefined
      ? ""
      : `<div id="snsAccordionRowMiddle" class="a-box${o.sns.active === true ? " a-accordion-active" : ""}" data-a-accordion-row-name="snsAccordionRowMiddle"><div class="a-box-inner"><div class="a-accordion-row a-declarative accordion-header" data-action="a-accordion" role="button"><div id="snsCaptionAndDiscountPillAbbreviated_feature_div"><span id="sns-caption-and-icon"><span class="a-text-bold">Subscribe &amp; Save</span></span></div><div id="corePrice_feature_div"><span id="subscriptionPrice"><span id="sns-base-price" class="aok-hidden" data-rf-hidden="1"><span class="aok-offscreen apex-pricetopay-accessibility-label">$19.00 with 5 percent savings</span><span class="a-price"><span class="a-offscreen">$19.00</span></span></span><span id="sns-tiered-price"><span class="a-price"><span class="a-offscreen">$17.00</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">17<span class="a-price-decimal">.</span></span><span class="a-price-fraction">00</span></span></span></span></span></div><span id="accordion-header-sns-delivery-link" class="a-text-bold">First delivery on Mar 9</span></div><div class="a-accordion-inner accordion-row-content"${o.sns.active === true ? "" : ' data-rf-hidden="1"'}><form id="addToCart" method="post" action="/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance"><input type="hidden" name="items[0.base][offerListingId]" value="FAKESNSOLID01"><input type="hidden" id="snsOfferListingId" name="snsOfferListingId" value="FAKESNSOLID01"><div id="snsUpsellMessage_feature_div"><span class="sns-delivery-buybox-upsell-message">You have unlocked extra savings.</span><h1 data-rf-hidden="1">You've unlocked 15% savings</h1></div><div id="replenishment-sns-frequency-popover">Deliver every: <a id="replenishment-sns-frequency-trigger" class="a-link-normal">1 month (Most common)</a></div><div id="a-popover-replenishmentsnsFrequencyPopover" data-rf-hidden="1"><div id="snsFrequencyAccordionRow-0" class="a-box"><span class="a-heading-text">2 weeks</span></div><div id="snsFrequencyAccordionRow-1" class="a-box"><span class="a-heading-text">1 month (Most common)</span></div></div><span id="rcx-subscribe-submit-button" class="a-button"><button id="rcx-subscribe-submit-button-announce" type="button">Subscribe</button></span></form></div></div></div>`;
  const accordion =
    o.noAccordion === true
      ? `<div id="singleBuybox">${form("FAKEBBOLID0002")}</div>`
      : `<div id="buyBoxAccordion" class="a-box-group a-accordion" role="group">${oneTimeRow}${snsRow}</div>`;
  const seeAll =
    o.seeAll === true
      ? `<div id="buybox-see-all-buying-choices"><span class="a-button"><a id="buybox-see-all-buying-choices-announce" href="#">See All Buying Options</a></span></div>`
      : "";
  const unavailable =
    o.unavailable === true
      ? `<div id="outOfStock"><span class="a-color-price">Currently unavailable.</span></div>`
      : "";
  const protection =
    o.protection === true
      ? `<div id="mbb_feature_div"><div id="abbWrapper"><span>Add a protection plan:</span><label><input type="checkbox"> 2-Year Invented Protection Plan for $9.99</label></div></div>`
      : "";
  const addon =
    o.addon === true
      ? `<div id="addOnItem_feature_div"><span>Add-on Item: ships with orders over $25</span></div>`
      : `<div id="addOnItem_feature_div"></div>`;
  return `<!DOCTYPE html><html><head><title>Example product</title></head><body><header id="navbar">Chrome nav</header><div id="dp"><div id="centerCol"><span id="productTitle">${o.title ?? "Invented Widget Deluxe, Pack of 2"}</span><div id="corePriceDisplay_desktop_feature_div"><span id="apex-pricetopay-accessibility-label" class="aok-offscreen">$20.00</span><span class="a-price priceToPay apex-pricetopay-value"><span class="a-offscreen">$20.00</span></span>${basis}</div>${promo}</div><div id="rightCol"><div id="desktop_buybox"><div id="buybox">${unavailable}${seeAll}${accordion}${protection}${addon}${o.extraBuybox ?? ""}</div></div></div></div></body></html>`;
}

function capture(page: string, aod?: string): Capture {
  const c: Capture = {
    kind: "offers",
    url: "https://www.example.com/dp/B0FAKE0001",
    final_url: "https://www.example.com/dp/B0FAKE0001?th=1",
    captured_at: CAPTURED_AT,
    html: page,
  };
  if (aod !== undefined) c.fragments = { aod };
  return c;
}

const thirdParty = (i: number, extra: Partial<CardOpts> = {}): CardOpts => ({
  i,
  heading: "New",
  code: "NEW",
  price: "$21.00",
  shipsFrom: "Example Outlet",
  soldBy: "Example Outlet",
  sellerId: `AFAKESELLER0${i}`,
  ratingLine: "(1,234 ratings) 91% positive over last 12 months",
  ...extra,
});

// ---- tests

describe("parseOffers: pinned offer plus list", () => {
  const aod = panel({
    pinned: {
      i: 0,
      price: "$20.00",
      code: "NEW",
      basis: "$22.00",
      savings: "-9%",
      unit: { price: "$10.00", unit: "count" },
      prime: { epoch: 1898884799, badge: "One-Day" },
      program: "prime",
      deliveryTime: "Tomorrow, March 2",
      promo: '<span class="a-text-bold">3% back</span> with an invented card <a href="#">Terms</a>',
      maxQty: 30,
    },
    offers: [
      thirdParty(1),
      thirdParty(2, { heading: "Used - Very Good", code: "USED", ref: "used" }),
    ],
    collapsed: [thirdParty(3, { price: "$23.50" })],
    total: 25,
    filters: true,
    sticky: true,
  });
  const result = parseOffers(capture(productPage(), aod));
  const d = result.data;
  const pinned = d.pinned_offer as Offer;

  it("reads the pinned offer", () => {
    expect(pinned).not.toBeNull();
    expect(pinned.pinned).toBe(true);
    expect(pinned.source).toBe("aod");
    expect(pinned.price).toEqual({ amount: 20, currency: "USD", raw: "$20.00" });
    expect(pinned.typical_price?.amount).toBe(22);
    expect(pinned.basis_price?.label).toBe("Typical price");
    expect(pinned.savings_percent).toBe(9);
    expect(pinned.savings?.amount).toBe(2);
    expect(pinned.unit_price).toMatchObject({ unit: "count", price: { amount: 10 } });
    expect(pinned.condition).toBe("new");
    expect(pinned.condition_code).toBe("NEW");
    expect(pinned.seller).toMatchObject({ name: "Amazon.com", is_amazon: true, seller_id: null });
    expect(pinned.ships_from).toBe("Amazon.com");
    expect(pinned.fulfillment).toBe("amazon");
    expect(pinned.prime).toBe(true);
    expect(pinned.prime_badge).toBe("One-Day");
    expect(pinned.customer_service).toBe("Amazon.com");
    expect(pinned.shipping).toMatchObject({ free: true });
    expect(pinned.total?.amount).toBe(20);
    expect(pinned.delivery?.options[0]).toMatchObject({
      slot: "PRIMARY_DELIVERY_MESSAGE_LARGE",
      date_raw: "Tomorrow, March 2",
      relative: "tomorrow",
      earliest_iso: "2030-03-02",
      latest_iso: "2030-03-02",
      price: "FREE",
    });
    expect(pinned.delivery?.promise_epoch_s).toBe(1898884799);
    expect(pinned.max_quantity).toBe(30);
    expect(pinned.min_quantity).toBe(1);
    expect(pinned.promotions).toEqual(["3% back with an invented card"]);
    // Product-page availability belongs to the featured offer.
    expect(pinned.stock_text).toBe("In Stock");
    expect(pinned.out_of_stock).toBe(false);
  });

  it("keeps add-to-cart identifiers only in internal", () => {
    expect(pinned.internal).toEqual({
      asin: "B0FAKE0001",
      offer_listing_id: "FAKEOLID%2B0000",
      seller_id: null,
      condition: "new",
      price: { amount: 20, currency: "USD", raw: "$20.00" },
    });
    const copy = JSON.parse(JSON.stringify(d)) as {
      pinned_offer: { internal?: unknown };
      offers: { internal?: unknown }[];
    };
    delete copy.pinned_offer.internal;
    for (const o of copy.offers) delete o.internal;
    const visibleJson = JSON.stringify(copy) + JSON.stringify(result.other_sections);
    expect(visibleJson).not.toContain("FAKEOLID");
    expect(JSON.stringify(result)).not.toContain("FAKECSRFTOKENVALUE");
    expect(JSON.stringify(result)).not.toContain("FAKEBBOLID");
  });

  it("lists every other offer in order, collapsed ones included, sticky duplicate skipped", () => {
    expect(d.offers.map((o) => o.index)).toEqual([1, 2, 3]);
    expect(d.offers.map((o) => o.collapsed)).toEqual([false, false, true]);
    expect(d.offers.map((o) => o.seller.name)).not.toContain("Sticky Duplicate");
    expect(d.offers[2]?.price?.amount).toBe(23.5);
    const used = d.offers[1] as Offer;
    expect(used.condition).toBe("used");
    expect(used.condition_label).toBe("Used - Very Good");
    expect(used.sub_condition).toBe("Very Good");
  });

  it("reads a third-party seller", () => {
    const o = d.offers[0] as Offer;
    expect(o.seller).toEqual({
      name: "Example Outlet",
      seller_id: "AFAKESELLER01",
      is_amazon: false,
      new_seller: false,
      rating_stars: 4.5,
      rating_percent: 91,
      rating_count: 1234,
      rating_raw: "(1,234 ratings) 91% positive over last 12 months",
    });
    expect(o.fulfillment).toBe("merchant");
    expect(o.internal.seller_id).toBe("AFAKESELLER01");
  });

  it("reads counts, heading and pagination", () => {
    expect(d.total_offer_count).toBe(25);
    expect(d.total_offer_count_text).toBe("25 other options");
    expect(d.heading).toBe("Other sellers on Amazon");
    expect(d.sort_text).toBe("sorted by price + delivery");
    expect(d.pagination).toEqual({
      loaded: 3,
      total: 25,
      has_more: true,
      next_page: 1,
      page_size: 10,
      url_template: AOD_NEXT_PAGE_TEMPLATE,
    });
    expect(AOD_NEXT_PAGE_TEMPLATE).toContain("{asin}");
    expect(AOD_NEXT_PAGE_TEMPLATE).toContain("{page}");
    expect(AOD_NEXT_PAGE_TEMPLATE).not.toMatch(/B0[A-Z0-9]{8}/);
    expect(d.no_offers).toBe(false);
    expect(d.no_featured_offer).toBe(false);
  });

  it("reads the product header", () => {
    expect(d.product).toEqual({
      asin: "B0FAKE0001",
      title: "Invented Widget Deluxe, Pack of 2",
      rating: 4.5,
      rating_count: 1234,
      image_url: "https://images.example.com/placeholder.png",
    });
  });

  it("reads filters with id, label, group, parent, checked, count and loaded matches", () => {
    expect(d.filters).toEqual([
      {
        id: "primeEligible",
        label: "Prime",
        group: "Delivery",
        parent: null,
        checked: true,
        loaded_match_count: 1,
      },
      {
        id: "freeShipping",
        label: "Free delivery",
        group: "Delivery",
        parent: null,
        checked: false,
        loaded_match_count: 4,
      },
      // The id says "new" but the label says "Renewed": the label wins.
      {
        id: "new",
        label: "Renewed",
        group: "Condition",
        parent: null,
        checked: false,
        loaded_match_count: 0,
      },
      {
        id: "used",
        label: "Used",
        group: "Condition",
        parent: null,
        checked: false,
        count: 3,
        loaded_match_count: 1,
      },
      {
        id: "usedVeryGood",
        label: "Very Good",
        group: "Condition",
        parent: "used",
        checked: false,
        loaded_match_count: 1,
      },
    ]);
  });

  it("records strategies and accounts for every visible character", () => {
    expect(result.meta.strategies["offer.price"]).toBe("id");
    expect(result.meta.strategies["offer.condition"]).toBe("id");
    expect(result.meta.strategies["offer.offer_listing_id"]).toBe("id");
    expect(result.meta.strategies["aod"]).toBe("fragment");
    expect(Number.isInteger(result.meta.unparsed_text_chars)).toBe(true);
    // Hidden alerts and the sticky duplicate never surface.
    const all = JSON.stringify(result);
    expect(all).not.toContain("Not added");
    expect(all).not.toContain("Sticky Duplicate");
  });
});

describe("parseOffers: no featured offer", () => {
  it("handles a pinned area with a message instead of an offer", () => {
    const r = parseOffers(
      capture(
        productPage({ seeAll: true, noAtc: true }),
        panel({ pinned: "message", offers: [thirdParty(1)] }),
      ),
    );
    expect(r.data.pinned_offer).toBeNull();
    expect(r.data.no_featured_offer).toBe(true);
    expect(r.data.buybox.state).toBe("no_featured_offer");
    expect(r.data.buybox.no_featured_offer_text).toBe("See All Buying Options");
    expect(r.data.offers[0]?.flags).toContain("no_featured_offer");
    expect(r.meta.warnings.some((w) => w.includes("pinned offer"))).toBe(true);
  });

  it("handles a pinned offer whose price is suppressed", () => {
    const r = parseOffers(
      capture(productPage(), panel({ pinned: { i: 0, price: null }, offers: [] })),
    );
    const p = r.data.pinned_offer as Offer;
    expect(p.price).toBeNull();
    expect(r.data.no_featured_offer).toBe(true);
    expect(p.flags).toContain("no_featured_offer");
    expect(p.total).toBeUndefined();
    expect(r.meta.warnings.some((w) => w.includes("no price"))).toBe(true);
  });

  it("falls back to the label and offscreen strategies for price", () => {
    const html = panel({ pinned: null, offers: [thirdParty(1, { price: "$31.00" })] })
      .replace(
        /<span class="a-price aok-align-center apex-pricetopay-value">.*?<\/span><\/span><\/span>/,
        "",
      )
      .replace(/data-csa-c-price-to-pay="[^"]*"/, "");
    const r = parseOffers(capture(productPage(), html));
    expect(r.data.offers[0]?.price?.amount).toBe(31);
    expect(r.meta.strategies["offer.price"]).toBe("label");
  });
});

describe("parseOffers: conditions", () => {
  const r = parseOffers(
    capture(
      productPage(),
      panel({
        pinned: null,
        offers: [
          thirdParty(1, {
            heading: "Used - Acceptable",
            conditionNote: "Invented scuff on the lid.",
          }),
          thirdParty(2, { heading: "Refurbished - Excellent", code: "RENEWED_TIER_2", ref: "ren" }),
          thirdParty(3, { heading: "Collectible - Like New", code: "COLLECTIBLE" }),
          thirdParty(4, { heading: null, code: "RENEWED_TIER_4" }),
          thirdParty(5, { heading: null, code: undefined, ref: "used" }),
        ],
      }),
    ),
  );
  const o = r.data.offers;

  it("maps headings to condition and sub-condition", () => {
    expect(o.map((x) => x.condition)).toEqual([
      "used",
      "renewed",
      "collectible",
      "renewed",
      "used",
    ]);
    expect(o[0]?.sub_condition).toBe("Acceptable");
    expect(o[0]?.condition_note).toBe("Invented scuff on the lid.");
    expect(o[1]?.sub_condition).toBe("Excellent");
    expect(o[1]?.condition_code).toBe("RENEWED_TIER_2");
    expect(o[2]?.sub_condition).toBe("Like New");
  });

  it("flags every non-new condition", () => {
    for (const x of o) expect(x.flags).toContain("used_or_renewed");
  });

  it("condition helpers", () => {
    expect(conditionFromText("New")).toBe("new");
    expect(conditionFromText("Refurbished - Good")).toBe("renewed");
    expect(conditionFromText("Renewed Premium")).toBe("renewed");
    expect(conditionFromText("Collectible - Good")).toBe("collectible");
    expect(conditionFromText("Something else")).toBeNull();
    expect(conditionFromText(null)).toBeNull();
    expect(conditionFromCode("USED_VERY_GOOD")).toBe("used");
    expect(conditionFromCode("NEW")).toBe("new");
    expect(conditionFromCode("REFURBISHED")).toBe("renewed");
    expect(conditionFromCode("OTHER")).toBeNull();
    expect(conditionFromCode(undefined)).toBeNull();
  });
});

describe("parseOffers: fulfillment, shipping, Prime, quantity, stock", () => {
  const r = parseOffers(
    capture(
      productPage(),
      panel({
        pinned: null,
        offers: [
          thirdParty(1, { shipsFrom: "Amazon.com", prime: {}, program: "prime" }),
          thirdParty(2, {
            shipsFrom: "Amazon",
            soldBy: "Amazon Warehouse",
            soldByLink: false,
            prime: {},
          }),
          thirdParty(3, {
            deliveryPrice: "$5.99",
            deliveryText: "$5.99 delivery",
            program: "paid_shipping",
            shipRow: "+ $5.99 shipping",
          }),
          thirdParty(4, { deliveryCondition: "for Prime members", prime: {}, maxQty: 3 }),
          thirdParty(5, {
            noDelivery: true,
            stock: "Only 2 left in stock - order soon.",
            maxQty: 2,
          }),
          thirdParty(6, { stock: "Currently unavailable." }),
          thirdParty(7, {
            stock: "Temporarily out of stock. Order now and we'll deliver when available.",
          }),
          thirdParty(8, {
            minQty: 2,
            extraRows: [{ label: "Note", value: "Limit 4 per customer" }],
          }),
          thirdParty(9, { olid: null, jsonOid: "FAKEOLIDJSON09" }),
          thirdParty(10, { olid: null, jsonOid: null }),
          thirdParty(11, { maxQty: undefined, qtyOptions: 6 }),
        ],
      }),
    ),
  );
  const o = r.data.offers;

  it("Amazon vs FBA vs merchant", () => {
    expect(o[0]?.fulfillment).toBe("fba");
    expect(o[0]?.flags).toContain("third_party_seller");
    expect(o[0]?.flags).not.toContain("merchant_fulfilled");
    expect(o[1]?.fulfillment).toBe("amazon");
    expect(o[1]?.seller.is_amazon).toBe(true);
    expect(o[1]?.flags).not.toContain("third_party_seller");
    expect(o[2]?.fulfillment).toBe("merchant");
    expect(o[2]?.flags).toEqual(
      expect.arrayContaining(["third_party_seller", "merchant_fulfilled"]),
    );
  });

  it("shipping fee vs free, totals", () => {
    expect(o[0]?.shipping).toMatchObject({ free: true });
    expect(o[0]?.flags).not.toContain("shipping_fee");
    expect(o[2]?.shipping).toMatchObject({
      free: false,
      amount: { amount: 5.99 },
      raw: "+ $5.99 shipping",
    });
    expect(o[2]?.total?.amount).toBe(26.99);
    expect(o[2]?.flags).toContain("shipping_fee");
    expect(o[3]?.shipping).toMatchObject({ free: true, condition: "for Prime members" });
    expect(o[3]?.delivery?.options[0]?.condition).toBe("for Prime members");
  });

  it("Prime from the icon, from the program attribute, and non-Prime", () => {
    expect(o[0]?.prime).toBe(true);
    expect(o[2]?.prime).toBe(false);
    expect(o[2]?.flags).toContain("not_prime");
    // No delivery block and no icon: unknown, which fails closed.
    expect(o[4]?.prime).toBeNull();
    expect(o[4]?.flags).toContain("not_prime");
    expect(o[4]?.flags).toContain("shipping_fee");
  });

  it("quantity limits, minimums and stock", () => {
    expect(o[3]?.max_quantity).toBe(3);
    expect(o[3]?.flags).toContain("quantity_limit");
    expect(o[4]?.stock_text).toBe("Only 2 left in stock - order soon.");
    expect(o[4]?.stock_count).toBe(2);
    // A low cap explained by stock is not a per-customer limit.
    expect(o[4]?.flags).not.toContain("quantity_limit");
    expect(o[7]?.min_quantity).toBe(2);
    expect(o[7]?.quantity_limit).toBe(4);
    expect(o[7]?.flags).toEqual(expect.arrayContaining(["minimum_quantity", "quantity_limit"]));
    expect(o[7]?.details).toEqual([{ label: "Note", value: "Limit 4 per customer" }]);
    expect(o[10]?.max_quantity).toBe(6);
  });

  it("out of stock and backorder", () => {
    expect(o[5]?.out_of_stock).toBe(true);
    expect(isOfferOutOfStock(o[5] as Offer)).toBe(true);
    expect(o[6]?.out_of_stock).toBe(false);
    expect(o[6]?.flags).toContain("preorder_or_backorder");
  });

  it("offer listing id falls back to the atc JSON; none at all means out of stock", () => {
    expect(o[8]?.internal.offer_listing_id).toBe("FAKEOLIDJSON09");
    expect(o[8]?.out_of_stock).toBe(false);
    expect(o[9]?.internal.offer_listing_id).toBeNull();
    expect(o[9]?.out_of_stock).toBe(true);
    expect(r.meta.warnings.some((w) => w.includes("no add-to-cart identifier"))).toBe(true);
  });
});

describe("parseOffers: seller details", () => {
  it("reads new-seller badges, stars from the alt text and the name from the button label", () => {
    const html = panel({
      pinned: null,
      offers: [
        thirdParty(1, { ratingLine: "Just launched", ratingClass: "a-star-mini" }),
        thirdParty(2, { soldBy: null, shipsFrom: null }),
      ],
    });
    const r = parseOffers(capture(productPage(), html));
    const [a, b] = r.data.offers as [Offer, Offer];
    expect(a.seller.new_seller).toBe(true);
    expect(a.seller.rating_stars).toBe(4.5);
    expect(b.seller.name).toBe("Example Outlet");
    expect(r.meta.strategies["offer.seller.name"]).toBe("data-attr");
    expect(b.fulfillment).toBeNull();
    expect(b.flags).toContain("merchant_fulfilled");
  });

  it("isAmazonName", () => {
    for (const n of ["Amazon.com", "Amazon", "Amazon Warehouse", "Amazon.com Services LLC"]) {
      expect(isAmazonName(n)).toBe(true);
    }
    for (const n of ["Amazonia Gadgets", "Example Outlet", "", null])
      expect(isAmazonName(n)).toBe(false);
  });
});

describe("parseOffers: no offers", () => {
  it("reports the empty state", () => {
    const r = parseOffers(
      capture(
        productPage(),
        panel({
          pinned: null,
          offers: [],
          total: 0,
          totalText: "Currently, there are no other sellers matching your location.",
        }),
      ),
    );
    expect(r.data.no_offers).toBe(true);
    expect(r.data.offers).toEqual([]);
    expect(r.data.pinned_offer).toBeNull();
    expect(r.data.total_offer_count).toBe(0);
    expect(r.data.no_offers_text).toBe(
      "Currently, there are no other sellers matching your location.",
    );
    expect(r.data.pagination).toMatchObject({ loaded: 0, total: 0, has_more: false });
  });
});

describe("parseOffers: hidden templates", () => {
  it("skips marked, class-hidden and template offers", () => {
    const hiddenMarked = card(thirdParty(7, { soldBy: "Hidden Marked Seller" })).replace(
      'role="listitem"',
      'role="listitem" data-rf-hidden="1"',
    );
    const hiddenClass = card(thirdParty(8, { soldBy: "Hidden Class Seller" })).replace(
      'class="a-section a-spacing-none a-padding-small aod-information-block',
      'class="a-section aok-hidden a-spacing-none a-padding-small aod-information-block',
    );
    const tmpl = `<template>${card(thirdParty(9, { soldBy: "Template Seller" }))}</template>`;
    const r = parseOffers(
      capture(
        productPage(),
        panel({
          pinned: null,
          offers: [thirdParty(1)],
          extraList: hiddenMarked + hiddenClass + tmpl,
        }),
      ),
    );
    expect(r.data.offers.map((o) => o.seller.name)).toEqual(["Example Outlet"]);
    const all = JSON.stringify(r);
    for (const s of ["Hidden Marked Seller", "Hidden Class Seller", "Template Seller"])
      expect(all).not.toContain(s);
  });

  it("normalizeAodVisibility hides class-hidden nodes but reveals collapsed content", () => {
    const doc = parseDocument(
      `<div id="aod-container"><div id="a" class="aok-hidden">x</div><div id="aod-pinned-offer-additional-content" class="aod-hide" data-rf-hidden="1">y</div><div id="aod-retail-other-offers-content" class="aod-oas-other-offers-hide">z</div><div id="aod-sticky-pinned-container">s</div></div>`,
    );
    normalizeAodVisibility(doc);
    expect(q(doc, "#a")).toBeUndefined();
    expect(q(doc, "#aod-pinned-offer-additional-content")).toBeDefined();
    expect(q(doc, "#aod-retail-other-offers-content")).toBeDefined();
    expect(q(doc, "#aod-sticky-pinned-container")).toBeUndefined();
  });
});

describe("parseOffers: lossless accounting", () => {
  it("surfaces unknown blocks from the panel and the buy box", () => {
    const r = parseOffers(
      capture(
        productPage({
          extraBuybox: '<div id="inventedBuyboxWidget">Invented buy box notice</div>',
        }),
        panel({
          pinned: null,
          offers: [
            thirdParty(1, {
              extraBlock: '<div id="aod-offer-inventedNotice">Invented panel notice</div>',
            }),
          ],
          extraContainer: '<div id="aod-invented-footer-note">Invented footer note</div>',
        }),
      ),
    );
    const byKey = new Map(r.other_sections.map((s) => [s.key, s.text]));
    expect(byKey.get("aod:aod-offer-inventedNotice")).toBe("Invented panel notice");
    expect(byKey.get("aod:aod-invented-footer-note")).toBe("Invented footer note");
    expect(byKey.get("buybox:inventedBuyboxWidget")).toBe("Invented buy box notice");
    // Typed fields are not repeated as sections.
    expect([...byKey.values()].join(" ")).not.toContain("Example Outlet");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("counts loose text that is in no block as unparsed", () => {
    const r = parseOffers(
      capture(
        productPage(),
        panel({
          pinned: null,
          offers: [thirdParty(1)],
          extraContainer: "<span>loose words</span>",
        }),
      ),
    );
    expect(r.meta.unparsed_text_chars).toBe("loose words".length);
  });
});

describe("parseOffers: product page", () => {
  it("purchase types with Subscribe & Save not selected", () => {
    const r = parseOffers(
      capture(productPage({ sns: { active: false }, coupon: "sns" }), panel({})),
    );
    const [one, sns] = r.data.purchase_types;
    expect(one).toMatchObject({
      kind: "one_time",
      label: "One-time purchase:",
      default: true,
      price: { amount: 20 },
    });
    expect(one?.unit_price).toMatchObject({ unit: "count", price: { amount: 10 } });
    expect(sns).toMatchObject({
      kind: "subscribe_and_save",
      label: "Subscribe & Save",
      default: false,
      price: { amount: 17 },
      selected_frequency: "1 month (Most common)",
      frequencies: ["2 weeks", "1 month (Most common)"],
      first_delivery: "First delivery on Mar 9",
    });
    expect(sns?.tiers).toEqual([
      {
        kind: "base",
        price: { amount: 19, currency: "USD", raw: "$19.00" },
        percent: 5,
        raw: "$19.00 with 5 percent savings",
      },
      { kind: "tiered", price: { amount: 17, currency: "USD", raw: "$17.00" }, percent: 15 },
    ]);
    expect(r.data.pinned_offer?.flags).not.toContain("subscribe_and_save_default");
    expect(r.data.coupons).toEqual([
      {
        text: "Save 10%: Coupon available when you select Subscribe & Save.",
        badge: "Coupon:",
        percent: 10,
        clippable: false,
        requires_subscribe_and_save: true,
        location: "price-block",
      },
    ]);
    expect(r.data.promotions).toEqual(["3% back with an invented card"]);
  });

  it("Subscribe & Save selected by default flags the pinned offer only", () => {
    const r = parseOffers(
      capture(productPage({ sns: { active: true } }), panel({ offers: [thirdParty(1)] })),
    );
    expect(r.data.purchase_types.map((p) => [p.kind, p.default])).toEqual([
      ["one_time", false],
      ["subscribe_and_save", true],
    ]);
    expect(r.data.pinned_offer?.flags).toContain("subscribe_and_save_default");
    expect(r.data.offers[0]?.flags).not.toContain("subscribe_and_save_default");
  });

  it("clippable coupon (unverified markup)", () => {
    const r = parseOffers(capture(productPage({ coupon: "clip" }), panel({})));
    expect(r.data.coupons).toEqual([
      {
        text: "Apply $2.00 coupon",
        badge: "Coupon:",
        amount: { amount: 2, currency: "USD", raw: "$2.00" },
        clippable: true,
        requires_subscribe_and_save: false,
        location: "price-block",
      },
    ]);
  });

  it("typical price, list price, featured price and buy-box details", () => {
    const typical = parseOffers(capture(productPage({ basis: "$26.00" }), panel({})));
    expect(typical.data.typical_price?.amount).toBe(26);
    expect(typical.data.featured_price?.amount).toBe(20);
    expect(typical.data.buybox).toMatchObject({
      state: "featured",
      availability_text: "In Stock",
      add_to_cart_present: true,
      deliver_to: "Deliver to Alex - Exampleville 00000",
      max_quantity: 12,
    });
    expect(typical.data.buybox.rows).toEqual([
      {
        name: "newAccordionRow",
        caption: "One-time purchase:",
        active: true,
        price: { amount: 20, currency: "USD", raw: "$20.00" },
      },
    ]);
    const list = parseOffers(
      capture(productPage({ basis: "$40.00", basisLabel: "List Price:" }), panel({})),
    );
    expect(list.data.list_price?.amount).toBe(40);
    expect(list.data.typical_price).toBeUndefined();
  });

  it("protection plan and add-on signals flag every offer", () => {
    const r = parseOffers(
      capture(productPage({ protection: true, addon: true }), panel({ offers: [thirdParty(1)] })),
    );
    expect(r.data.buybox.protection_plan_text).toContain("protection plan");
    expect(r.data.buybox.addon_text).toContain("Add-on Item");
    for (const o of [r.data.pinned_offer as Offer, ...r.data.offers]) {
      expect(o.flags).toEqual(
        expect.arrayContaining(["protection_plan_prompt", "addon_or_bundle_upsell"]),
      );
    }
  });

  it("unavailable buy box", () => {
    const r = parseOffers(capture(productPage({ unavailable: true, noAtc: true }), panel({})));
    expect(r.data.buybox.state).toBe("unavailable");
  });
});

describe("parseOffers: fallbacks", () => {
  it("reads the featured offer from the buy box when the panel is missing", () => {
    const r = parseOffers(capture(productPage({ availability: "Only 3 left in stock." })));
    const p = r.data.pinned_offer as Offer;
    expect(p.source).toBe("buybox");
    expect(p.price?.amount).toBe(20);
    expect(p.seller).toMatchObject({ name: "Amazon.com", is_amazon: true });
    expect(p.fulfillment).toBe("amazon");
    expect(p.internal).toMatchObject({
      asin: "B0FAKE0001",
      offer_listing_id: "FAKEBBOLID0001",
      condition: "new",
    });
    expect(p.stock_count).toBe(3);
    expect(p.max_quantity).toBe(12);
    expect(p.delivery?.options[0]?.latest_iso).toBe("2030-03-03");
    expect(r.data.offers).toEqual([]);
    expect(r.meta.strategies["pinned_offer"]).toBe("page-buybox");
    expect(r.meta.warnings.some((w) => w.includes("all-offers panel missing"))).toBe(true);
  });

  it("single-offer buy box without an accordion is a one-time purchase", () => {
    const r = parseOffers(capture(productPage({ noAccordion: true })));
    expect(r.data.purchase_types).toEqual([
      { kind: "one_time", label: "One-time purchase", default: true },
    ]);
  });

  it("reads a panel already open inside the page", () => {
    const page = productPage().replace("</body>", `${panel({ offers: [thirdParty(1)] })}</body>`);
    const r = parseOffers(capture(page));
    expect(r.meta.strategies["aod"]).toBe("in-page");
    expect(r.data.offers).toHaveLength(1);
  });

  it("throws layout_unrecognized when nothing is parseable", () => {
    expect(() => parseOffers(capture("<html><body><p>nothing</p></body></html>"))).toThrow(RfError);
    try {
      parseOffers(capture("<html><body><p>nothing</p></body></html>"));
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });
});

describe("parseDeliveryDate", () => {
  it.each([
    ["Wednesday, March 4", { earliest_iso: "2030-03-04", latest_iso: "2030-03-04" }],
    ["March 4 - 7", { earliest_iso: "2030-03-04", latest_iso: "2030-03-07" }],
    ["Mar 30 - Apr 2", { earliest_iso: "2030-03-30", latest_iso: "2030-04-02" }],
    [
      "Tomorrow, March 2",
      { earliest_iso: "2030-03-02", latest_iso: "2030-03-02", relative: "tomorrow" },
    ],
    ["Today 4 PM - 8 PM", { relative: "today" }],
    ["Overnight 7 AM - 11 AM", { relative: "overnight" }],
    ["no date here", {}],
  ])("%s", (raw, expected) => {
    expect(parseDeliveryDate(raw, CAPTURED_AT)).toEqual(expected);
  });

  it("rolls the year forward and across a year boundary", () => {
    expect(parseDeliveryDate("Jan 3", "2030-12-28T00:00:00Z")).toEqual({
      earliest_iso: "2031-01-03",
      latest_iso: "2031-01-03",
    });
    expect(parseDeliveryDate("Dec 30 - Jan 2", "2030-12-20T00:00:00Z")).toEqual({
      earliest_iso: "2030-12-30",
      latest_iso: "2031-01-02",
    });
    expect(parseDeliveryDate("Feb 30", CAPTURED_AT)).toEqual({});
    expect(parseDeliveryDate("March 4", undefined)).toEqual({});
  });
});

describe("multipack heuristic", () => {
  it("finds pack markers", () => {
    expect(multipackCounts("Invented Soap, Pack of 6")).toEqual([6]);
    expect(multipackCounts("Invented Batteries 24 Count")).toEqual([24]);
    expect(multipackCounts("Invented Cable 2-Pack")).toEqual([2]);
    expect(multipackCounts("Invented Pens (12 x 1)")).toEqual([12]);
    expect(multipackCounts("Set of 3 Invented Bowls, 3 Pcs")).toEqual([3]);
    expect(multipackCounts("Pack of 2, 24 Count")).toEqual([2, 24]);
    expect(multipackCounts("Invented Widget, 1 Count")).toEqual([]);
    expect(multipackCounts(null)).toEqual([]);
  });

  it("fires only on a contradiction or a missing cross-check", () => {
    const base = cleanOffer();
    expect(isMultipackAmbiguous(base, "Invented Widget")).toBe(false);
    expect(isMultipackAmbiguous(base, "Invented Widget, 2 Count")).toBe(false);
    expect(isMultipackAmbiguous(base, "Invented Widget, 3 Count")).toBe(true);
    expect(isMultipackAmbiguous(base, "Pack of 2, 24 Count")).toBe(true);
    expect(
      isMultipackAmbiguous({ ...base, unit_price: undefined }, "Invented Widget, Pack of 2"),
    ).toBe(true);
    const perOunce = {
      ...base,
      unit_price: { price: { amount: 1, currency: "USD", raw: "$1.00" }, unit: "Ounce", raw: "" },
    };
    expect(isMultipackAmbiguous(perOunce, "Invented Soup, Pack of 6")).toBe(false);
  });
});

// ---- flags

/** A clean offer: no flag fires for it in CLEAN_CONTEXT. */
function cleanOffer(): Offer {
  return {
    index: 0,
    pinned: true,
    collapsed: false,
    source: "aod",
    price: { amount: 20, currency: "USD", raw: "$20.00" },
    typical_price: { amount: 20, currency: "USD", raw: "$20.00" },
    unit_price: {
      price: { amount: 10, currency: "USD", raw: "$10.00" },
      unit: "count",
      raw: "$10.00 per count",
    },
    shipping: { free: true, raw: "FREE delivery" },
    total: { amount: 20, currency: "USD", raw: "$20.00" },
    condition: "new",
    seller: { name: "Amazon.com", seller_id: null, new_seller: false, is_amazon: true },
    ships_from: "Amazon.com",
    fulfillment: "amazon",
    prime: true,
    delivery: {
      lines: ["FREE delivery Tuesday, March 3"],
      options: [
        {
          slot: "PRIMARY_DELIVERY_MESSAGE_LARGE",
          raw: "FREE delivery Tuesday, March 3",
          date_raw: "Tuesday, March 3",
          earliest_iso: "2030-03-03",
          latest_iso: "2030-03-03",
          price: "FREE",
          fastest: false,
        },
      ],
    },
    max_quantity: 30,
    min_quantity: 1,
    promotions: [],
    badges: [],
    fees: [],
    details: [],
    flags: [],
    out_of_stock: false,
    internal: {
      asin: "B0FAKE0001",
      offer_listing_id: "FAKEOLID0001",
      seller_id: null,
      condition: "new",
      price: null,
    },
  };
}

const CLEAN_CONTEXT: OfferFlagContext = {
  now: "2030-03-01T12:00:00.000Z",
  utc_offset_minutes: 0,
  title: "Invented Widget, 2 Count",
  requested_quantity: 1,
};

function withDelivery(o: Offer, latest: string): Offer {
  const opt = {
    ...(o.delivery?.options[0] as NonNullable<Offer["delivery"]>["options"][number]),
    latest_iso: latest,
  };
  return { ...o, delivery: { lines: [opt.raw], options: [opt] } };
}

/**
 * Every flag computeOfferFlags can produce, written out by hand. Security relevant: removing
 * a flag from the core list or from the function must fail one of the tests below.
 */
const EXPECTED_FLAGS = [
  "used_or_renewed",
  "no_featured_offer",
  "price_above_typical",
  "not_prime",
  "shipping_fee",
  "slow_delivery",
  "minimum_quantity",
  "quantity_limit",
  "multipack_ambiguity",
  "quantity_above_stock",
  "subscribe_and_save_default",
  "preorder_or_backorder",
  "addon_or_bundle_upsell",
  "protection_plan_prompt",
  "third_party_seller",
  "merchant_fulfilled",
] as const;

/** One mutation per flag that should make exactly that flag fire. */
const SINGLE_FLAG_CASES: Record<(typeof EXPECTED_FLAGS)[number], [Offer, OfferFlagContext]> = {
  used_or_renewed: [{ ...cleanOffer(), condition: "used" }, CLEAN_CONTEXT],
  no_featured_offer: [cleanOffer(), { ...CLEAN_CONTEXT, no_featured_offer: true }],
  price_above_typical: [
    { ...cleanOffer(), typical_price: { amount: 15, currency: "USD", raw: "$15.00" } },
    CLEAN_CONTEXT,
  ],
  not_prime: [{ ...cleanOffer(), prime: false }, CLEAN_CONTEXT],
  shipping_fee: [
    {
      ...cleanOffer(),
      shipping: {
        free: false,
        amount: { amount: 4.99, currency: "USD", raw: "$4.99" },
        raw: "$4.99 delivery",
      },
    },
    CLEAN_CONTEXT,
  ],
  slow_delivery: [withDelivery(cleanOffer(), "2030-03-09"), CLEAN_CONTEXT],
  minimum_quantity: [
    { ...cleanOffer(), min_quantity: 3 },
    { ...CLEAN_CONTEXT, requested_quantity: 3 },
  ],
  quantity_limit: [{ ...cleanOffer(), quantity_limit: 5 }, CLEAN_CONTEXT],
  multipack_ambiguity: [cleanOffer(), { ...CLEAN_CONTEXT, title: "Invented Widget, Pack of 6" }],
  quantity_above_stock: [
    { ...cleanOffer(), stock_count: 40, stock_text: "Only 40 left in stock" },
    { ...CLEAN_CONTEXT, requested_quantity: 41 },
  ],
  subscribe_and_save_default: [
    cleanOffer(),
    { ...CLEAN_CONTEXT, subscribe_and_save_default: true },
  ],
  preorder_or_backorder: [{ ...cleanOffer(), stock_text: "Pre-order now." }, CLEAN_CONTEXT],
  addon_or_bundle_upsell: [cleanOffer(), { ...CLEAN_CONTEXT, addon_or_bundle_upsell: true }],
  protection_plan_prompt: [cleanOffer(), { ...CLEAN_CONTEXT, protection_plan_prompt: true }],
  third_party_seller: [
    {
      ...cleanOffer(),
      seller: {
        name: "Example Outlet",
        seller_id: "AFAKESELLER01",
        new_seller: false,
        is_amazon: false,
      },
      fulfillment: "fba",
    },
    CLEAN_CONTEXT,
  ],
  merchant_fulfilled: [{ ...cleanOffer(), fulfillment: "merchant" }, CLEAN_CONTEXT],
};

describe("computeOfferFlags", () => {
  it("the hardcoded list matches the core OFFER_FLAGS exactly", () => {
    expect([...OFFER_FLAGS]).toEqual([...EXPECTED_FLAGS]);
    for (const f of EXPECTED_FLAGS)
      expect((OFFER_FLAGS as readonly string[]).includes(f)).toBe(true);
    expect(Object.keys(SINGLE_FLAG_CASES).sort()).toEqual([...EXPECTED_FLAGS].sort());
  });

  it("a clean offer has no flags", () => {
    expect(computeOfferFlags(cleanOffer(), CLEAN_CONTEXT)).toEqual([]);
    expect(computeStaticOfferFlags(cleanOffer(), CLEAN_CONTEXT)).toEqual([]);
  });

  for (const flag of EXPECTED_FLAGS) {
    it(`${flag} fires alone`, () => {
      const [offer, ctx] = SINGLE_FLAG_CASES[flag];
      expect(computeOfferFlags(offer, ctx)).toEqual([flag]);
    });
  }

  it("returns flags in OFFER_FLAGS order", () => {
    const o: Offer = { ...cleanOffer(), condition: "used", fulfillment: "merchant", prime: false };
    expect(computeOfferFlags(o, CLEAN_CONTEXT)).toEqual([
      "used_or_renewed",
      "not_prime",
      "merchant_fulfilled",
    ]);
  });

  it("the static subset leaves out exactly the request-time flags", () => {
    expect([...REQUEST_TIME_FLAGS]).toEqual(["slow_delivery", "quantity_above_stock"]);
    const [slow, slowCtx] = SINGLE_FLAG_CASES.slow_delivery;
    expect(computeStaticOfferFlags(slow, slowCtx)).toEqual([]);
    const [stock, stockCtx] = SINGLE_FLAG_CASES.quantity_above_stock;
    expect(computeStaticOfferFlags(stock, stockCtx)).toEqual([]);
    for (const flag of EXPECTED_FLAGS) {
      if (REQUEST_TIME_FLAGS.includes(flag)) continue;
      const [offer, ctx] = SINGLE_FLAG_CASES[flag];
      expect(computeStaticOfferFlags(offer, ctx)).toEqual([flag]);
    }
  });

  it("missing inputs fail closed", () => {
    const unknown: Offer = {
      ...cleanOffer(),
      condition: null,
      prime: null,
      shipping: undefined,
      fulfillment: null,
      delivery: undefined,
      seller: { name: null, seller_id: null, new_seller: false, is_amazon: false },
    };
    expect(computeOfferFlags(unknown, CLEAN_CONTEXT)).toEqual([
      "used_or_renewed",
      "not_prime",
      "shipping_fee",
      "slow_delivery",
      "third_party_seller",
      "merchant_fulfilled",
    ]);
    // Unparseable clock: slow_delivery fires.
    expect(computeOfferFlags(cleanOffer(), { ...CLEAN_CONTEXT, now: "not a date" })).toEqual([
      "slow_delivery",
    ]);
  });

  it("a suppressed pinned price is a missing featured offer", () => {
    expect(
      computeOfferFlags(
        { ...cleanOffer(), price: null },
        { ...CLEAN_CONTEXT, title: "Invented Widget" },
      ),
    ).toEqual(["no_featured_offer"]);
  });
});

describe("slow_delivery boundary", () => {
  const now = "2030-03-01T12:00:00.000Z";
  const ctx: OfferFlagContext = { ...CLEAN_CONTEXT, now };

  it("5 days is not slow, 6 days is", () => {
    expect(computeOfferFlags(withDelivery(cleanOffer(), "2030-03-06"), ctx)).toEqual([]);
    expect(computeOfferFlags(withDelivery(cleanOffer(), "2030-03-07"), ctx)).toEqual([
      "slow_delivery",
    ]);
    expect(deliveryDaysFrom(withDelivery(cleanOffer(), "2030-03-06"), now, 0)).toBe(5);
  });

  it("the threshold is a parameter", () => {
    expect(
      computeOfferFlags(withDelivery(cleanOffer(), "2030-03-04"), {
        ...ctx,
        slow_delivery_days: 2,
      }),
    ).toEqual(["slow_delivery"]);
  });

  it("uses the page-local calendar date of now", () => {
    const early = "2030-03-01T03:00:00.000Z";
    const offer = withDelivery(cleanOffer(), "2030-03-06");
    // UTC: Mar 1 -> 5 days. US Central (-360): still Feb 28 -> 6 days.
    expect(computeOfferFlags(offer, { ...ctx, now: early, utc_offset_minutes: 0 })).toEqual([]);
    expect(computeOfferFlags(offer, { ...ctx, now: early, utc_offset_minutes: -360 })).toEqual([
      "slow_delivery",
    ]);
    // No offset given: the westernmost US zone, which fails toward flagging.
    const noOffset: OfferFlagContext = { now: early, title: CLEAN_CONTEXT.title ?? null };
    expect(computeOfferFlags(offer, noOffset)).toEqual(["slow_delivery"]);
    expect(
      computeOfferFlags(offer, { ...noOffset, now: new Date("2030-03-01T18:00:00Z") }),
    ).toEqual([]);
  });

  it("uses the fastest option, relative promises and the epoch fallback", () => {
    const two: Offer = {
      ...cleanOffer(),
      delivery: {
        lines: ["a", "b"],
        options: [
          {
            slot: "PRIMARY_DELIVERY_MESSAGE_LARGE",
            raw: "a",
            latest_iso: "2030-03-20",
            fastest: false,
          },
          {
            slot: "SECONDARY_DELIVERY_MESSAGE_LARGE",
            raw: "b",
            latest_iso: "2030-03-02",
            fastest: true,
          },
        ],
      },
    };
    expect(computeOfferFlags(two, ctx)).toEqual([]);
    const tomorrow: Offer = {
      ...cleanOffer(),
      delivery: {
        lines: ["t"],
        options: [{ slot: null, raw: "t", relative: "tomorrow", fastest: false }],
      },
    };
    expect(computeOfferFlags(tomorrow, ctx)).toEqual([]);
    const epochOnly: Offer = {
      ...cleanOffer(),
      delivery: {
        lines: [],
        options: [],
        promise_epoch_s: Date.parse("2030-03-12T05:59:59Z") / 1000,
      },
    };
    expect(computeOfferFlags(epochOnly, ctx)).toEqual(["slow_delivery"]);
    expect(deliveryDaysFrom(epochOnly, now, -360)).toBe(10);
  });
});

describe("price_above_typical threshold", () => {
  const typical = { amount: 100, currency: "USD", raw: "$100.00" };
  const at = (amount: number, ctx: Partial<OfferFlagContext> = {}): OfferFlag[] =>
    computeOfferFlags(
      {
        ...cleanOffer(),
        price: { amount, currency: "USD", raw: `$${amount}` },
        typical_price: typical,
        unit_price: undefined,
      },
      { ...CLEAN_CONTEXT, title: "Invented Widget", ...ctx },
    );

  it("24% over is fine, exactly 25% is fine, 26% over flags", () => {
    expect(at(124)).toEqual([]);
    expect(at(125)).toEqual([]);
    expect(at(126)).toEqual(["price_above_typical"]);
  });

  it("the threshold is a parameter and the context typical price wins", () => {
    expect(at(111, { price_above_typical_threshold: 0.1 })).toEqual(["price_above_typical"]);
    expect(at(126, { typical_price: { amount: 120, currency: "USD", raw: "$120.00" } })).toEqual(
      [],
    );
  });

  it("no typical price means no flag; a different currency fails closed", () => {
    expect(
      computeOfferFlags(
        {
          ...cleanOffer(),
          typical_price: undefined,
          price: { amount: 999, currency: "USD", raw: "$999" },
        },
        CLEAN_CONTEXT,
      ),
    ).not.toContain("price_above_typical");
    expect(at(50, { typical_price: { amount: 100, currency: "CAD", raw: "CA$100" } })).toEqual([
      "price_above_typical",
    ]);
  });

  it("a List Price label never feeds the flag", () => {
    const html = panel({
      pinned: { i: 0, price: "$90.00", basis: "$50.00", basisLabel: "List Price:" },
    });
    const p = parseOffers(capture(productPage({ title: "Invented Widget" }), html)).data
      .pinned_offer as Offer;
    expect(p.list_price?.amount).toBe(50);
    expect(p.typical_price).toBeUndefined();
    expect(p.flags).not.toContain("price_above_typical");
  });
});

describe("offerFlagContext", () => {
  it("builds the full context from a parse result", () => {
    const r = parseOffers(
      capture(
        productPage({ sns: { active: true }, protection: true }),
        panel({ offers: [thirdParty(1, { deliveryTime: "March 20 - 22" })] }),
      ),
    );
    const o = r.data.offers[0] as Offer;
    const ctx = offerFlagContext(r.data, o, {
      now: CAPTURED_AT,
      requested_quantity: 2,
      utc_offset_minutes: 0,
    });
    expect(ctx).toMatchObject({
      now: CAPTURED_AT,
      requested_quantity: 2,
      utc_offset_minutes: 0,
      no_featured_offer: false,
      subscribe_and_save_default: false,
      protection_plan_prompt: true,
      addon_or_bundle_upsell: false,
    });
    expect(computeOfferFlags(o, ctx)).toContain("slow_delivery");
    expect(o.flags).not.toContain("slow_delivery");
  });
});
