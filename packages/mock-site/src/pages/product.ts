import {
  PLATFORM_SELLER,
  PLATFORM_SHIPPER,
  product as lookup,
  VARIANT_COLORS,
  VARIANT_SIZES,
  variationChildren,
  type Offer,
  type Product,
} from "../catalog.ts";
import type { Session } from "../state.ts";
import { esc, money, priceHtml } from "../util.ts";
import { renderAod } from "./aod.ts";
import { layout } from "./layout.ts";

/**
 * `/dp/<ASIN>`: one product page per catalog scenario. The buy box follows the real
 * accordion structure (one active row, the others collapsed), with the add-to-cart form
 * posting to `/gp/product/handle-buy-box/...` and a Buy Now button next to it that the
 * tests assert is never pressed.
 */

const H = 'data-rf-hidden="1"';

export function deliveryDate(now: Date, days: number): string {
  const d = new Date(now.getTime() + days * 86_400_000);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function stars(rating: number): string {
  const whole = Math.floor(rating);
  return `a-star-mini-${whole}${rating - whole >= 0.5 ? "-5" : ""}`;
}

function offerFeatures(o: Offer): string {
  const feature = (id: string, label: string, value: string): string =>
    `<div${id ? ` id="${id}"` : ""} class="offer-display-feature"><div class="offer-display-feature-label"><span>${label}</span></div><div class="offer-display-feature-text">${value}</div></div>`;
  const seller = o.sellerId
    ? `<a id="sellerProfileTriggerId" class="offer-display-feature-text-message" href="/sp?ie=UTF8&amp;seller=${o.sellerId}">${esc(o.seller)}</a>`
    : `<span class="offer-display-feature-text-message">${esc(o.seller)}</span>`;
  return `<div id="offerDisplayFeatures_desktop"><div id="offer-display-features"><div class="a-expander-content">${
    feature(
      "fulfillerInfoFeature_feature_div",
      "Ships from",
      `<span class="offer-display-feature-text-message">${esc(o.shipsFrom)}</span>`,
    ) +
    feature("merchantInfoFeature_feature_div", "Sold by", seller) +
    feature(
      "",
      "Returns",
      `<span class="offer-display-feature-text-message">Returnable within 30 days of receipt</span>`,
    )
  }</div></div></div>`;
}

function quantitySelect(p: Product): string {
  const max = p.limit ?? 10;
  let options = "";
  for (let n = 1; n <= max; n++)
    options += `<option value="${n}"${n === 1 ? " selected" : ""}>${n}</option>`;
  return `<div id="selectQuantity"><span class="a-dropdown-container"><label for="quantity">Quantity:</label><select id="quantity" name="quantity">${options}</select></span></div>`;
}

interface RowOptions {
  rowId: string;
  rowName: string;
  caption: string;
  active: boolean;
  priceCents: number;
  /** The row's own add-to-cart form fields (the subscription row adds its own). */
  extraFields?: string;
  extraContent?: string;
}

function buyButtons(p: Product): string {
  const buyNowLabel = p.scenario === "preorder" ? "Pre-order now" : "Buy Now";
  return `<div id="addToCart_feature_div"><span class="a-button a-button-primary"><span class="a-button-inner"><input id="add-to-cart-button" name="submit.add-to-cart" value="Add to cart" type="submit" aria-labelledby="submit.add-to-cart-announce"><span id="submit.add-to-cart-announce" class="a-button-text">Add to cart</span></span></span></div>
<div id="buyNow_feature_div"><span class="a-button"><span class="a-button-inner"><input id="buy-now-button" name="submit.buy-now" type="submit" aria-labelledby="submit.buy-now-announce"><span id="submit.buy-now-announce" class="a-button-text">${buyNowLabel}</span></span></span></div>`;
}

function row(p: Product, o: Offer, now: Date, r: RowOptions): string {
  const content = `<div class="a-accordion-inner accordion-row-content"${r.active ? "" : ` style="display:none" ${H}`}>
<form id="addToCart" method="post" action="/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance" data-mock-ajax>
<input type="hidden" id="ASIN" name="ASIN" value="${p.asin}"><input type="hidden" name="items[0.base][asin]" value="${p.asin}"><input type="hidden" name="items[0.base][offerListingId]" value="${o.olid}"><input type="hidden" id="offerListingID" name="offerListingID" value="${o.olid}"><input type="hidden" id="merchantID" name="merchantID" value="${o.sellerId ?? "ATVPDKIKX0DER"}">${r.extraFields ?? ""}
<div id="desktop_qualifiedBuyBox">${r.extraContent ?? ""}
<div id="deliveryBlockMessage"><div id="mir-layout-DELIVERY_BLOCK"><div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span>${
    o.shippingCents === 0 ? "FREE delivery" : `${money(o.shippingCents)} delivery`
  } <span class="a-text-bold">${deliveryDate(now, 2)}</span></span></div></div></div>
<div id="contextualIngressPt"><div id="contextualIngressPtLabel_deliveryShortLine"><span>Deliver to Alex - </span><span>Exampleville 00000</span></div></div>
<div id="availability" class="a-section"><span class="a-color-success primary-availability-message">${
    p.scenario === "preorder"
      ? `This item will be released on ${esc(p.releaseDate ?? "")}.`
      : "In Stock"
  }</span></div>
${p.limit ? `<div class="a-section"><span>Limit ${p.limit} per customer</span></div>` : ""}
${quantitySelect(p)}
${o.prime ? `<div id="shippingMessageInsideBuyBox_feature_div"><span id="priceBadging_feature_div"><i class="a-icon a-icon-prime a-icon-wrapper" role="img" aria-label="prime"><span class="a-icon-text">Two-Day</span></i></span></div>` : ""}
${buyButtons(p)}
${offerFeatures(o)}
${p.planAsin ? warranty(p.planAsin) : ""}
</div></form></div>`;
  return `<div id="${r.rowId}" class="a-box${r.active ? " a-accordion-active" : ""}" data-a-accordion-row-name="${r.rowName}"><div class="a-box-inner a-accordion-row-container">
<div class="a-accordion-row a-declarative accordion-header" data-action="a-accordion" role="button"><h5><div class="a-column a-span12 accordion-caption"><span class="a-text-bold">${r.caption}</span></div>
<div id="apex_offerDisplay_desktop"><div id="corePrice_feature_div">${priceHtml(r.priceCents, "aok-align-center reinventPriceAccordionT2")}</div></div></h5></div>
${content}</div></div>`;
}

function warranty(planAsin: string): string {
  const plan = lookup(planAsin);
  if (!plan?.featured) return "";
  return `<div id="warranty_feature_div"><div class="a-section"><span class="a-text-bold">Add a protection plan:</span> <span>${esc(plan.title)} for ${money(plan.featured.priceCents)}</span></div></div>`;
}

/** The protection plan offer shown after adding a product that has one. */
export function renderPlanUpsell(planAsin: string): string {
  const plan = lookup(planAsin);
  if (!plan?.featured) return "";
  return `<div id="attach-warranty-pane" class="a-popover-wrapper" role="dialog"><h4 id="attach-warranty-header">Add a protection plan</h4><p>${esc(plan.title)} for ${money(plan.featured.priceCents)}</p>
<form id="attach-warranty-form" method="post" action="/cart/add-to-cart/ref=dp_attach_warranty" data-mock-ajax><input type="hidden" name="items[0.base][asin]" value="${plan.asin}" style="display:none" ${H}><input type="hidden" name="items[0.base][offerListingId]" value="${plan.featured.olid}" style="display:none" ${H}><span class="a-button a-button-primary" id="attachSiAddCoverage"><span class="a-button-inner"><input class="a-button-input" type="submit" name="submit.addCoverage" aria-labelledby="attachSiAddCoverage-announce"><span id="attachSiAddCoverage-announce" class="a-button-text">Add Protection</span></span></span></form>
<span class="a-button" id="attachSiNoCoverage"><span class="a-button-inner"><a href="#" class="a-button-text" data-mock-close id="attachSiNoCoverage-announce">No thanks</a></span></span></div>`;
}

function buyBox(p: Product, now: Date): string {
  const o = p.featured;
  if (p.scenario === "unavailable" || (!o && p.others.length === 0)) {
    return `<div id="desktop_buybox"><div id="buybox"><div id="outOfStock"><span class="a-color-price">Currently unavailable.</span><span>We don't know when or if this item will be back in stock.</span></div></div></div>`;
  }
  if (!o) {
    return `<div id="desktop_buybox"><div id="buybox"><div id="unqualifiedBuyBox"><span class="a-button"><span class="a-button-inner"><a id="buybox-see-all-buying-choices" class="a-button-text" href="/gp/offer-listing/${p.asin}/ref=dp_olp">See All Buying Options</a></span></span></div></div></div>`;
  }
  let rows: string;
  if (p.scenario === "used_only") {
    rows = row(p, o, now, {
      rowId: "usedAccordionRow",
      rowName: "usedAccordionRow",
      caption: o.condition,
      active: true,
      priceCents: o.priceCents,
    });
  } else if (p.snsPercent !== undefined) {
    const sns = Math.round((o.priceCents * (100 - p.snsPercent)) / 100);
    const snsFields = `<input type="hidden" id="snsOfferListingId" name="snsOfferListingId" value="${o.olid}"><input type="hidden" name="items[0.base][additionalParameters][recurringDelivery][frequency][value]" value="1"><input type="hidden" name="items[0.base][additionalParameters][recurringDelivery][frequency][unit]" value="M">`;
    const snsContent = `<div id="snsUpsellMessage_feature_div"><span>Save ${p.snsPercent}% now on recurring deliveries.</span></div><div id="replenishment-sns-frequency-popover">Deliver every: <a id="replenishment-sns-frequency-trigger" class="a-link-normal" href="#">1 month (Most common)</a></div>`;
    rows =
      row(p, o, now, {
        rowId: "newAccordionRow_0",
        rowName: "newAccordionRow",
        caption: "One-time purchase:",
        active: false,
        priceCents: o.priceCents,
      }) +
      // The subscription row is the DEFAULT selection: adding without choosing subscribes.
      row(p, o, now, {
        rowId: "snsAccordionRowMiddle",
        rowName: "snsAccordionRowMiddle",
        caption: "Subscribe &amp; Save:",
        active: true,
        priceCents: sns,
        extraFields: snsFields,
        extraContent: snsContent,
      });
  } else {
    rows = row(p, o, now, {
      rowId: "newAccordionRow_0",
      rowName: "newAccordionRow",
      caption: "Buy New",
      active: true,
      priceCents: o.priceCents,
    });
  }
  return `<div id="desktop_buybox"><div id="buybox"><div id="buyBoxAccordion" class="a-box-group a-accordion" role="group">${rows}</div></div></div>`;
}

function coupon(p: Product, session: Session): string {
  if (!p.couponCents) return "";
  const clipped = session.clippedCoupons.includes(p.asin);
  const text = clipped
    ? `${money(p.couponCents)} coupon applied`
    : `Apply ${money(p.couponCents)} coupon`;
  return `<div id="promoPriceBlockMessage_feature_div"><div id="reinvent_price_desktop_newAccordionRow"><span class="promoPriceBlockMessage"><div><form method="post" action="/gp/coupon/clip" data-mock-ajax><input type="hidden" name="asin" value="${p.asin}" style="display:none" ${H}><span><i id="badgepctchFAKE01" class="a-icon a-icon-addon newCouponBadge">Coupon:</i><label id="couponTextpctchFAKE01" class="a-color-success couponLabelText" for="checkboxpctchFAKE01">${text}</label><input type="checkbox" id="checkboxpctchFAKE01" name="clipCoupon"${clipped ? " checked" : ""} onchange="this.form.requestSubmit()"></span></form></div></span></div></div>`;
}

function twister(p: Product): { dom: string; script: string } {
  const v = p.variation;
  if (!v) return { dom: "", script: "" };
  const children = variationChildren(v.parent);
  const colorIdx = (c: string): number =>
    VARIANT_COLORS.indexOf(c as (typeof VARIANT_COLORS)[number]);
  const sizeIdx = (s: string): number => VARIANT_SIZES.indexOf(s as (typeof VARIANT_SIZES)[number]);
  const map: Record<string, string> = {};
  const display: Record<string, string[]> = {};
  for (const c of children) {
    map[`${colorIdx(c.variation!.color)}_${sizeIdx(c.variation!.size)}`] = c.asin;
    display[c.asin] = [c.variation!.color, c.variation!.size];
  }
  const find = (color: string, size: string): Product | undefined =>
    children.find((c) => c.variation!.color === color && c.variation!.size === size);
  const swatchRow = (
    key: string,
    label: string,
    values: readonly string[],
    current: string,
    pick: (value: string) => Product | undefined,
  ): string => {
    const lis = values
      .map((value, i) => {
        const target = pick(value);
        const fallback = children.find(
          (c) => (key === "color_name" ? c.variation!.color : c.variation!.size) === value,
        );
        const selected = value === current;
        const available = target !== undefined;
        const asin = (target ?? fallback)?.asin ?? "";
        return `<li data-asin="${asin}" data-collapsed-view="true" data-csa-c-slot-id="twister-desktop-twister-swatch-${available ? "swatchAvailable" : "swatchUnavailable"}" data-idxintoggleswatchlist="${i}" data-initiallyselected="${selected}" data-initiallyunavailable="${!available}" class="swatch-list-item-text inline-twister-swatch a-declarative"><span class="a-list-item"><span id="${esc(value)}_${i}" class="a-button a-button-toggle${selected ? " a-button-selected" : ""}${available ? "" : " a-button-unavailable"} text-swatch-button"><span class="a-button-inner"><input name="${i}" role="radio" aria-checked="${selected}" class="a-button-input" type="submit"><span class="a-button-text" aria-hidden="true"><div class="a-section text-swatch-container"><div class="a-section a-spacing-none swatch-title-text-container"><span class="a-size-base swatch-title-text-display swatch-title-text">${esc(value)}</span></div></div></span></span></span></span></li>`;
      })
      .join("");
    return `<div id="inline-twister-row-${key}" class="a-section a-spacing-none inline-twister-row"><div id="inline-twister-expander-header-${key}" aria-label="Selected ${label} is ${esc(current)}. Tap to collapse." class="dimension-heading"><div id="inline-twister-dim-title-${key}" class="dimension-text"><span class="a-size-base a-color-secondary">${label}: </span><span id="inline-twister-expanded-dimension-text-${key}" class="inline-twister-dim-title-value a-text-bold">${esc(current)}</span></div></div><div id="inline-twister-expander-content-${key}" aria-label="There are ${values.length} options."><div class="a-section"><ul class="a-unordered-list a-button-list dimension-values-list" role="radiogroup">${lis}</ul></div></div></div>`;
  };
  const dom = `<div id="twister_feature_div"><div id="twister-plus-inline-twister"><div id="twister-plus-desktop-twister-container">${
    swatchRow(
      "color_name",
      "Color",
      VARIANT_COLORS,
      v.color,
      (c) => find(c, v.size) ?? children.find((x) => x.variation!.color === c),
    ) + swatchRow("size_name", "Size", VARIANT_SIZES, v.size, (s) => find(v.color, s))
  }</div></div></div>`;
  const data = {
    currentAsin: p.asin,
    landingAsin: p.asin,
    parentAsin: v.parent,
    dimensionToAsinMap: map,
    variationValues: { color_name: VARIANT_COLORS, size_name: VARIANT_SIZES },
    selectedVariationValues: { color_name: colorIdx(v.color), size_name: sizeIdx(v.size) },
    currentDimensionCombinationId: `${colorIdx(v.color)}_${sizeIdx(v.size)}`,
    num_total_variations: children.length,
    dimensions: ["color_name", "size_name"],
    dimensionsDisplayType: ["swatch", "swatch"],
    dimensionValuesDisplayData: display,
    variationDisplayLabels: { color_name: "Color", size_name: "Size" },
    singletonDimensionKeys: [],
  };
  const script = `<script type="text/javascript">P.register('twister-js-init-dpx-data', function() { var dataToReturn = ${JSON.stringify(data)}; return dataToReturn; });</script>`;
  return { dom, script };
}

function addToListForm(p: Product, session: Session): string {
  const options = session.lists
    .map((l) => `<option value="${l.id}"${l.isDefault ? " selected" : ""}>${esc(l.name)}</option>`)
    .join("");
  return `<div id="wishlistButtonStack"><form id="addToWishlist" method="post" action="/hz/wishlist/additem" data-mock-ajax><input type="hidden" name="asin" value="${p.asin}" style="display:none" ${H}><select id="add-to-wishlist-list" name="listId" aria-label="List">${options}</select><span class="a-button"><span class="a-button-inner"><input id="add-to-wishlist-button-submit" class="a-button-input" type="submit" name="submit.add-to-registry.wishlist" aria-labelledby="add-to-wishlist-button-announce"><span id="add-to-wishlist-button-announce" class="a-button-text">Add to List</span></span></span></form></div>`;
}

export function renderProduct(p: Product, session: Session, now: Date, withOffers = false): string {
  const o = p.featured;
  const { dom: twisterDom, script } = twister(p);
  const otherSellers =
    p.others.length > 0
      ? `<div id="olpLinkWidget_feature_div"><div id="dynamic-aod-ingress-box"><a id="aod-ingress-link" class="a-link-normal" href="/gp/offer-listing/${p.asin}/ref=dp_olp_NEW"><span>New &amp; Used (${p.others.length}) from</span> ${priceHtml(Math.min(...p.others.map((x) => x.priceCents)))}</a></div></div>`
      : "";
  const center = `<div id="title_feature_div" data-feature-name="title"><div id="titleSection"><h1 id="title"><span id="productTitle">${esc(p.title)}</span></h1></div></div>
<div id="bylineInfo_feature_div"><a id="bylineInfo" class="a-link-normal" href="/stores/${encodeURIComponent(p.brand)}/page/FAKE-0001">Visit the ${esc(p.brand)} Store</a></div>
<div id="averageCustomerReviews_feature_div"><div id="averageCustomerReviews" data-asin="${p.asin}"><span id="acrPopover" title="${p.rating.toFixed(1)} out of 5 stars"><a href="#customerReviews"><span>${p.rating.toFixed(1)}</span> <i class="a-icon a-icon-star-mini ${stars(p.rating)}"><span class="a-icon-alt">${p.rating.toFixed(1)} out of 5 stars</span></i></a></span> <a id="acrCustomerReviewLink" href="#customerReviews"><span id="acrCustomerReviewText" aria-label="${p.reviews.toLocaleString("en-US")} Reviews">(${p.reviews.toLocaleString("en-US")})</span></a></div></div>
${o && p.scenario !== "unavailable" ? `<div id="apex_desktop"><div id="corePriceDisplay_desktop_feature_div">${priceHtml(o.priceCents, "aok-align-center priceToPay")}</div></div>` : ""}
${coupon(p, session)}${twisterDom}
<div id="featurebullets_feature_div"><div id="feature-bullets"><h3>About this item</h3><ul>${p.bullets
    .map((b) => `<li><span class="a-list-item">${esc(b)}</span></li>`)
    .join("")}</ul></div></div>`;
  return layout({
    title: `Example storefront: ${p.title}`,
    canonical: `https://www.amazon.com/dp/${p.asin}`,
    body: `<div id="dp" class="mock_store en_US"><div id="dp-container"><div id="ppd"><div id="leftCol"><img id="landingImage" alt="${esc(p.title)}" src="https://images.example.com/placeholder.png"></div><div id="centerCol">${center}</div><div id="rightCol">${buyBox(p, now)}${otherSellers}${addToListForm(p, session)}</div></div>${withOffers ? `<div id="aod-panel-root">${renderAod(p, now)}</div>` : ""}</div></div>`,
    tail: script,
  });
}

export { PLATFORM_SELLER, PLATFORM_SHIPPER };
