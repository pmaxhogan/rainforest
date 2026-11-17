import { PLATFORM_SHIPPER, type Offer, type Product } from "../catalog.ts";
import { esc, money, priceHtml } from "../util.ts";
import { deliveryDate } from "./product.ts";

/**
 * `/gp/product/ajax/aodAjaxMain/...?asin=`: the all-offers panel fragment. The featured
 * offer is the pinned offer; it is also repeated in a sticky pinned container that must
 * never be targeted. Every offer carries its own add-to-cart form.
 */

function conditionCode(o: Offer): "new" | "used" | "ren" {
  if (o.condition === "New") return "new";
  if (o.condition === "Renewed") return "ren";
  return "used";
}

function detailRow(id: string, label: string, value: string): string {
  return `<div id="${id}" class="a-section a-spacing-none a-spacing-top-micro aod-clear-float" role="listitem"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner"><div class="a-fixed-left-grid-col aod-padding-right-10 a-col-left"><span class="a-size-small a-color-tertiary">${label}</span></div><div class="a-fixed-left-grid-col a-col-right">${value}</div></div></div></div>`;
}

function sellerValue(o: Offer): string {
  if (!o.sellerId) return `<span class="a-size-small a-color-base">${esc(o.seller)}</span>`;
  const fba = o.shipsFrom === PLATFORM_SHIPPER ? "&amp;isAmazonFulfilled=1" : "";
  return `<a class="a-size-small a-link-normal" role="link" href="/gp/aag/main?ie=UTF8&amp;seller=${o.sellerId}${fba}">${esc(o.seller)}</a>`;
}

function rows(o: Offer): string {
  return (
    detailRow(
      "aod-offer-shipsFrom",
      "Ships from",
      `<span class="a-size-small a-color-base">${esc(o.shipsFrom)}</span>`,
    ) + detailRow("aod-offer-soldBy", "Sold by", sellerValue(o))
  );
}

function cardInner(p: Product, o: Offer, index: number, now: Date, sticky: boolean): string {
  const maxQty = p.limit ?? 30;
  const action = JSON.stringify({
    refTag: `aod_dpdsk_${conditionCode(o)}`,
    asin: p.asin,
    oid: o.olid,
    maxQty,
    minQty: 1,
    offerIndex: index,
    isStickyPinnedOffer: sticky,
  });
  const date = deliveryDate(now, 2).replace(/, \d{4}$/, "");
  const delivery = `<div class="a-row aod-delivery-promise"><div class="a-column a-span12 aod-delivery-promise-column"><span class="a-size-base a-color-base"><div id="unified-delivery-message-${index}" class="a-section aod-unified-delivery"><div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE" class="a-spacing-base"><span data-csa-c-delivery-price="${o.shippingCents === 0 ? "FREE" : money(o.shippingCents)}" data-csa-c-delivery-time="${date}" data-csa-c-delivery-condition="" data-csa-c-delivery-cutoff="" data-csa-c-delivery-benefit-program-id="${o.prime ? "prime" : "paid_shipping"}">${o.shippingCents === 0 ? "FREE delivery" : `${money(o.shippingCents)} delivery`} <span class="a-text-bold">${date}</span></span></div></div></div></span></div></div>`;
  return `<div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><div class="a-fixed-right-grid-col a-col-left"><div id="aod-offer-heading" class="a-section a-spacing-none a-padding-none aod-clear-float"><span class="a-size-base a-text-bold">${esc(o.condition)}</span></div></div>
<div class="a-fixed-right-grid-col aod-atc-inline-msg-column a-col-right"><div id="aod-offer-added-to-cart-${index}" class="a-box a-alert-inline aod-visibility-hidden"><div class="a-alert-content">Added</div></div><div id="aod-offer-not-added-to-cart-${index}" class="a-box a-alert-inline aok-hidden" role="alert"><div class="a-alert-content">Not added</div></div></div></div></div>
<div id="aod-offer-price" class="a-section a-spacing-none aod-clear-float"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner"><div class="a-fixed-left-grid-col a-col-left"><span id="aod-price-${index}"><div class="a-section a-spacing-none apex-core-price-identifier" data-csa-c-buying-option-type="${conditionCode(o) === "new" ? "NEW" : conditionCode(o) === "ren" ? "RENEWED_TIER_2" : "USED"}" data-csa-c-price-to-pay="${(o.priceCents / 100).toFixed(2)}"><div class="a-section a-spacing-none aok-align-center aok-relative"><span class="aok-offscreen apex-pricetopay-accessibility-label">${money(o.priceCents)}</span>${priceHtml(o.priceCents, "aok-align-center apex-pricetopay-value")}</div></div></span></div>
<div class="a-fixed-left-grid-col a-col-right"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><div class="a-fixed-right-grid-col aod-padding-right-10 a-col-left">${
    o.prime
      ? `<span class="a-size-base a-color-base"><i class="a-icon a-icon-prime" role="img" aria-label="prime"></i>Two-Day</span>`
      : ""
  }<div id="aod_ship_charge_row" class="a-row aod-ship-charge">${o.shippingCents === 0 ? "" : `+ ${money(o.shippingCents)} shipping`}</div>${delivery}</div>
<div class="a-fixed-right-grid-col aod-atc-column a-col-right"><form method="post" action="/cart/add-to-cart/ref=aod_dpdsk_${conditionCode(o)}_${index}" class="AodAddToCart" data-mock-ajax><input type="hidden" name="items[0.base][asin]" value="${p.asin}"><input type="hidden" name="items[0.base][offerListingId]" value="${o.olid}"><input type="hidden" name="items[0.base][quantity]" value="1"><input type="hidden" name="clientName" value="MockAod">
<span class="a-declarative" data-action="aod-atc-action" data-aod-atc-action='${esc(action)}'><span class="a-button a-button-primary"><span class="a-button-inner"><input class="a-button-input" name="submit.addToCart" type="submit" aria-label="Add to Cart from seller ${esc(o.seller)} and price ${money(o.priceCents)}"><span class="a-button-text" aria-hidden="true">Add to Cart</span></span></span></span></form></div></div></div></div></div></div></div>`;
}

function card(p: Product, o: Offer, index: number, now: Date): string {
  return `<div id="aod-offer" class="a-section a-spacing-none a-padding-small aod-information-block aod-clear-float" role="listitem">${cardInner(p, o, index, now, false)}<div class="a-section" role="list">${rows(o)}</div></div><hr class="a-spacing-none a-divider-normal aod-offer-block-divider" aria-hidden="true">`;
}

function productBlock(p: Product): string {
  return `<div id="pinned-image-id" class="offer-image-block"><img id="aod-asin-image-id" alt="" src="https://images.example.com/placeholder.png"></div><div id="aod-asin-block-asin" class="a-section"><div id="aod-asin-title" class="a-row"><h5 id="aod-asin-title-text">${esc(p.title)}</h5></div></div>`;
}

export function renderAod(p: Product, now: Date): string {
  const o = p.featured;
  const pinned = o
    ? `<div id="aod-pinned-offer" class="a-section a-spacing-none aod-pinned-offer"><div class="a-section asin-container-padding aod-clear-float"><div class="a-fixed-left-grid pinned-offer-inner"><div class="a-fixed-left-grid-inner">${productBlock(p)}<div id="pinned-de-id" class="pinned-offer-block a-col-right">${cardInner(p, o, 0, now, false)}</div></div></div>
<div id="aod-pinned-offer-additional-content" class="a-section aod-hide" role="list">${rows(o)}<div class="a-section aod-offer-divider"></div></div></div></div>`
    : `<div id="aod-pinned-offer" class="a-section aod-pinned-offer"><div class="a-section asin-container-padding">${productBlock(p)}<div class="a-row"><span>No featured offers available</span></div></div></div>`;
  // The sticky duplicate of the pinned offer: a flow must never target this one. As on the
  // real site it comes FIRST in the panel and is not rendered until the panel is scrolled
  // (the stylesheet hides its content), so the first add control in document order is one
  // that never becomes visible. A flow that waits on "the first control" waits forever.
  const sticky = o
    ? `<div id="aod-sticky-pinned-container" class="a-section aod-sticky-pinned-container"><div id="aod-sticky-pinned-offer" class="a-section aod-sticky-pinned-offer" style="top: -200px;"><div class="a-section aod-information-block">${cardInner(p, o, 0, now, true)}</div></div></div>`
    : "";
  const cards = p.others.map((x, i) => card(p, x, i + 1, now)).join("");
  return `<span class="a-declarative" data-action="aod-close-on-esc-action"><div id="all-offers-display-scroller" class="a-scroller"><div id="aod-container" class="a-section a-spacing-none a-padding-none">${sticky}${pinned}
<div id="aod-filter" class="a-section aod-filter-block-container"><div class="a-row"><div id="aod-message-component" class="a-column a-span9"><h2 id="aod-filter-offer-count-string">${p.others.length > 0 ? "Other sellers on Example storefront" : "No other sellers"}</h2></div></div></div>
<div id="aod-offer-list" class="a-section"><input type="hidden" id="aod-total-offer-count" name="" value="${p.others.length}"><input type="hidden" id="aod-total-offer-count-string" name="" value="${p.others.length} other options">${cards}</div>
</div></div></span>`;
}
