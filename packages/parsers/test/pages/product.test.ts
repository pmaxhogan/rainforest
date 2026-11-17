/**
 * Unit tests for the product page parser. Every page here is hand-written: the structure
 * (ids, classes, data attributes, nesting, hidden markers) follows real detail pages, the
 * content is invented.
 */
import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import { parseDocument, visibleTextChars } from "../../src/index.ts";
import {
  cleanText,
  deriveFulfillment,
  isoDate,
  parseAspect,
  parseProduct,
  parseRanks,
  parseShipsSold,
} from "../../src/pages/product.ts";
import type { ProductPage } from "../../src/pages/product.ts";

const H = 'data-rf-hidden="1"';

function capture(html: string, url = "https://www.example.com/dp/B0FAKE0001"): Capture {
  return {
    kind: "product",
    url,
    final_url: url,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>Fake page title</title></head><body>${html}</body></html>`,
  };
}

interface Parts {
  above?: string;
  left?: string;
  center?: string;
  right?: string;
  below?: string;
  scripts?: string;
  dpClass?: string;
}

function page(p: Parts): string {
  return `
<header id="navbar-main"><div id="nav-subnav" data-category="fake-store">Chrome text</div></header>
<div id="dp" class="${p.dpClass ?? "ce en_US"}">
  <div id="dp-container">
    <div id="above-dp-container">${p.above ?? ""}</div>
    <div id="ppd">
      <div id="leftCol">${p.left ?? ""}</div>
      <div id="centerCol">${p.center ?? ""}</div>
      <div id="rightCol">${p.right ?? ""}</div>
    </div>
    ${p.below ?? ""}
  </div>
</div>
<footer id="navFooter">Footer chrome</footer>
${p.scripts ?? ""}`;
}

/** An `.a-price` with offscreen text plus the split whole / fraction markup. */
function price(amount: string, cls = "priceToPay"): string {
  const [whole, fraction] = amount.split(".");
  return `<span class="a-price aok-align-center ${cls}"><span class="a-offscreen">$${amount}</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span><span class="a-price-fraction">${fraction}</span></span></span>`;
}

const TITLE = `
<div id="title_feature_div" data-feature-name="title"><div id="titleSection"><h1 id="title"><span id="productTitle">Fake Widget Deluxe, 2-Pack</span></h1>
  <div class="a-section dp-title-differentiators"><span>For Example Phones and Tablets</span></div></div></div>
<div id="bylineInfo_feature_div"><a id="bylineInfo" class="a-link-normal" href="/stores/ExampleBrand/page/FAKE-0001?ref=x">Visit the ExampleBrand Store</a></div>
<div id="averageCustomerReviews_feature_div"><div id="averageCustomerReviews" data-asin="B0FAKE0001">
  <span id="acrPopover" title="4.5 out of 5 stars"><a><span>4.5</span><i class="a-icon a-icon-star-mini a-star-mini-4-5"><span class="a-icon-alt">4.5 out of 5 stars</span></i></a></span>
  <a id="acrCustomerReviewLink" href="#averageCustomerReviewsAnchor"><span id="acrCustomerReviewText" aria-label="1,234 Reviews">(1,234)</span></a>
</div></div>`;

const CRUMBS = `<div id="desktop-breadcrumbs_feature_div"><div id="wayfinding-breadcrumbs_feature_div"><ul>
  <li><a class="a-link-normal" href="/fake-dept/b/ref=dp_bc_1">Fake Department</a></li><li>&rsaquo;</li>
  <li><a class="a-link-normal" href="/fake-sub/b/ref=dp_bc_2?node=1">Fake Subcategory</a></li></ul></div></div>`;

interface OfferOpts {
  price?: string;
  merchantId?: string;
  odf?: { label: string; value: string; sellerHref?: string }[];
  stock?: string;
  atc?: boolean;
  buyNow?: boolean;
  buyNowLabel?: string;
  quantity?: number;
  extra?: string;
  delivery?: string;
}

/** The inside of an accordion row (or of #desktop_qualifiedBuyBox). */
function offerContent(o: OfferOpts): string {
  const odf = (o.odf ?? [])
    .map(
      (f) => `<div class="offer-display-feature" ${H}>
  <div class="offer-display-feature-label"><span>${f.label}</span></div>
  <div class="offer-display-feature-text">${
    f.sellerHref === undefined
      ? `<span class="offer-display-feature-text-message">${f.value}</span>`
      : `<a id="sellerProfileTriggerId" class="offer-display-feature-text-message" href="${f.sellerHref}">${f.value}</a>`
  }
    <div class="a-popover-preload"><span class="offer-display-feature-text-message">${f.value} (popover copy)</span></div></div></div>`,
    )
    .join("");
  const qty =
    o.quantity === undefined
      ? ""
      : `<div id="selectQuantity"><span class="a-dropdown-container"><label>Quantity:</label><select id="quantity" name="quantity">${Array.from(
          { length: o.quantity },
          (_, i) => `<option value="${i + 1}" ${i === 0 ? "selected" : ""} ${H}>${i + 1}</option>`,
        ).join(
          "",
        )}</select><span class="a-button-dropdown"><span class="a-dropdown-prompt">1</span></span></span></div>`;
  return `<form id="addToCart">
  <input type="hidden" id="ASIN" name="ASIN" value="B0FAKE0001" ${H}>
  ${o.merchantId === undefined ? "" : `<input type="hidden" id="merchantID" name="merchantID" value="${o.merchantId}" ${H}>`}
  <input type="hidden" name="items[0.base][customerVisiblePrice][amount]" value="99.99" ${H}>
  <div id="desktop_qualifiedBuyBox">
    <div id="deliveryBlockMessage"><div id="mir-layout-DELIVERY_BLOCK">
      <div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE"><span>${
        o.delivery ??
        'FREE delivery <span class="a-text-bold">Tuesday, January 4, 2000</span>. Order within <span id="ftCountdown">3 hrs 5 mins</span>'
      }</span></div>
      <div id="mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_LARGE"><span>Or fastest delivery <span class="a-text-bold">Tomorrow</span></span></div>
    </div></div>
    <div id="contextualIngressPt"><div id="contextualIngressPtLabel_deliveryShortLine"><span>Deliver to Alex -</span><span>Exampleville 00000&#8204;</span></div></div>
    <div id="availability"><span class="a-color-success">${o.stock ?? "In Stock"}</span></div>
    ${qty}
    ${o.extra ?? ""}
    ${o.atc === false ? "" : '<div id="addToCart_feature_div"><span class="a-button"><input id="add-to-cart-button" name="submit.add-to-cart" value="Add to cart" type="submit"><span id="submit.add-to-cart-announce">Add to cart</span></span></div>'}
    ${o.buyNow === false ? "" : `<div id="buyNow_feature_div"><span class="a-button"><input id="buy-now-button" name="submit.buy-now" type="submit"><span id="submit.buy-now-announce">${o.buyNowLabel ?? "Buy Now"}</span></span></div>`}
    <div id="offerDisplayFeatures_desktop"><div id="offer-display-features"><div class="a-expander-content">${odf}</div>
      <div class="a-expander-header"><a href="javascript:void(0)"><span class="a-expander-prompt">See more</span></a></div></div></div>
  </div>
</form>`;
}

interface RowOpts {
  id: string;
  caption: string;
  active: boolean;
  price?: string;
  header?: string;
  content?: string;
}

function row(r: RowOpts): string {
  return `<div id="${r.id}" class="a-box ${r.active ? "a-accordion-active" : ""}"><div class="a-box-inner a-accordion-row-container">
  <div class="a-accordion-row"><h5>
    <div id="newAccordionCaption_feature_div"><div class="a-column accordion-caption"><span class="a-text-bold">${r.caption}</span></div></div>
    <div id="apex_offerDisplay_desktop"><div id="corePrice_feature_div">${r.price === undefined ? "" : price(r.price, "reinventPriceAccordionT2")}</div></div>
    ${r.header ?? ""}
  </h5></div>
  <div class="a-accordion-inner accordion-row-content" ${r.active ? "" : H}>${r.content ?? ""}</div>
</div></div>`;
}

function accordion(rows: string[], after = ""): string {
  return `<div id="desktop_buybox"><div id="buybox"><div id="buyBoxAccordion" class="a-box-group a-accordion">${rows.join("")}</div>${after}</div></div>`;
}

function apex(inner: string): string {
  return `<div id="apex_desktop"><div id="corePriceDisplay_desktop_feature_div">${inner}</div></div>`;
}

const AMAZON = [
  { label: "Ships from", value: "Amazon" },
  { label: "Sold by", value: "Amazon.com" },
  { label: "Returns", value: "FREE refund/replacement until Feb 1, 2000" },
  { label: "Payment", value: "Secure transaction" },
];

function standard(
  o: OfferOpts & {
    rowPrice?: string;
    center?: string;
    apexExtra?: string;
    below?: string;
    scripts?: string;
  } = {},
): string {
  const p = o.price ?? "24.99";
  return page({
    above: CRUMBS,
    center: TITLE + apex(price(p) + (o.apexExtra ?? "")) + (o.center ?? ""),
    right: accordion([
      row({
        id: "newAccordionRow_0",
        caption: "Buy New",
        active: true,
        price: o.rowPrice ?? p,
        content: offerContent({ odf: AMAZON, merchantId: "A0FAKEMERCHANT1", quantity: 5, ...o }),
      }),
    ]),
    below: o.below ?? "",
    scripts: o.scripts ?? "",
  });
}

function parse(html: string, url?: string): ReturnType<typeof parseProduct> {
  return parseProduct(capture(html, url));
}

function data(html: string): ProductPage {
  return parse(html).data;
}

describe("parseProduct: featured offer", () => {
  it("parses identity, the featured offer and accounts for the page", () => {
    const r = parse(
      standard({
        scripts: `<script>var x = {"mediaAsin":"B0FAKE0001","parentAsin":"X0FAKE0001"};</script>`,
      }),
    );
    const d = r.data;
    expect(d.asin).toBe("B0FAKE0001");
    expect(d.title).toBe("Fake Widget Deluxe, 2-Pack");
    expect(d.title_differentiators).toBe("For Example Phones and Tablets");
    expect(d.byline).toEqual({
      text: "Visit the ExampleBrand Store",
      kind: "store",
      name: "ExampleBrand",
      store_path: "/stores/ExampleBrand/page/FAKE-0001",
    });
    expect(d.breadcrumbs.map((b) => b.text)).toEqual(["Fake Department", "Fake Subcategory"]);
    expect(d.breadcrumbs[1]?.path).toBe("/fake-sub/b/ref=dp_bc_2");
    expect(d.department).toBe("Fake Department");
    expect(d.product_type.product_group).toBe("ce");
    expect(d.buy_box.state).toBe("featured_offer");
    expect(d.buy_box.selected_option).toBe("Buy New");
    const o = d.featured_offer;
    expect(o?.price).toEqual({ amount: 24.99, currency: "USD", raw: "$24.99" });
    expect(o?.seller).toEqual({ name: "Amazon.com", id: "A0FAKEMERCHANT1" });
    expect(o?.ships_from).toBe("Amazon");
    expect(o?.fulfillment).toBe("amazon");
    expect(o?.returns).toBe("FREE refund/replacement until Feb 1, 2000");
    expect(o?.offer_features).toEqual([{ label: "Payment", value: "Secure transaction" }]);
    expect(o?.condition).toEqual({ kind: "new", text: "Buy New" });
    expect(o?.stock_text).toBe("In Stock");
    expect(o?.delivery_location).toBe("Deliver to Alex - Exampleville 00000");
    expect(o?.delivery[0]).toEqual({
      kind: "primary",
      text: "FREE delivery Tuesday, January 4, 2000. Order within 3 hrs 5 mins",
      free: true,
      date: "Tuesday, January 4, 2000",
      date_iso: "2000-01-04",
      cutoff: "3 hrs 5 mins",
    });
    expect(o?.delivery[1]?.kind).toBe("secondary");
    expect(o?.quantity_options).toEqual({ count: 5, min: 1, max: 5, selected: "1" });
    expect(o?.add_to_cart_present).toBe(true);
    expect(o?.buy_now_present).toBe(true);
    expect(d.purchase_options).toEqual([
      {
        kind: "new",
        caption: "Buy New",
        selected: true,
        row_id: "newAccordionRow_0",
        price: { amount: 24.99, currency: "USD", raw: "$24.99" },
      },
    ]);
    expect(d.parent_asin).toBe("X0FAKE0001");
    expect(d.rating?.value).toBe(4.5);
    expect(d.rating?.count).toBe(1234);
    expect(r.meta.strategies["featured_offer.price"]).toBe("selected-row");
    expect(r.meta.strategies["featured_offer.seller"]).toBe("odf-collapsed");
    expect(r.meta.strategies["buy_box.state"]).toBe("price + buy button");
    expect(r.meta.unparsed_text_chars).toBe(0);
    // Popover copies of the offer rows are never read.
    expect(JSON.stringify(d)).not.toContain("popover copy");
    expect(JSON.stringify(r)).not.toContain("Chrome text");
  });

  it("falls back to the qualified buy box when there is no accordion", () => {
    const html = page({
      center: TITLE,
      right: `<div id="desktop_buybox"><div id="buybox">${offerContent({
        odf: [{ label: "Shipper / Seller", value: "Amazon.com" }],
        merchantId: "A0FAKEMERCHANT1",
      }).replace(
        '<div id="desktop_qualifiedBuyBox">',
        `<div id="desktop_qualifiedBuyBox"><div id="corePrice_feature_div">${price("9.50", "apex-pricetopay-value")}</div>`,
      )}</div></div>`,
    });
    const r = parse(html);
    expect(r.meta.strategies["buy_box.scope"]).toBe("qualified-buybox");
    expect(r.meta.strategies["featured_offer.price"]).toBe("qualified-buybox");
    expect(r.data.featured_offer?.price?.amount).toBe(9.5);
    expect(r.data.featured_offer?.ships_from).toBe("Amazon.com");
    expect(r.data.featured_offer?.fulfillment).toBe("amazon");
    expect(r.data.featured_offer?.condition?.kind).toBe("new");
    expect(r.meta.strategies["featured_offer.condition"]).toBe("default-new");
  });

  it("uses the center column, then legacy ids, for the price", () => {
    const center = parse(
      page({
        center: TITLE + apex(price("7.25")),
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(center.meta.strategies["featured_offer.price"]).toBe("apex-center");
    expect(center.data.featured_offer?.price?.amount).toBe(7.25);
    const legacy = parse(
      page({
        center: TITLE + `<span id="priceblock_ourprice">$3.10</span>`,
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(legacy.meta.strategies["featured_offer.price"]).toBe("legacy-id");
    expect(legacy.data.featured_offer?.price?.amount).toBe(3.1);
  });

  it("ignores a hidden duplicate price template and the rewards banner", () => {
    const d = data(
      page({
        center:
          TITLE +
          `<div id="apex_desktop"><div id="mapleAdvertisement_feature_div"><span>Pay ${price("0.00", "x")} at checkout</span></div>
           <div id="corePriceDisplay_desktop_feature_div" ${H}>${price("1.00")}</div>
           <div id="corePriceDisplay_desktop_feature_div">${price("19.00")}</div></div>`,
        right: `<div id="buybox"><div id="apex_offerDisplay_desktop" ${H}>${price("2.00")}</div>${offerContent({})}</div>`,
      }),
    );
    expect(d.featured_offer?.price?.amount).toBe(19);
    expect(d.featured_offer?.rewards_text).toBe("Pay $0.00 at checkout");
    expect(JSON.stringify(d)).not.toContain("99.99");
  });
});

describe("parseProduct: buy box states", () => {
  it("no featured offer: see all buying options without a price", () => {
    const d = data(
      page({
        center: TITLE,
        right: `<div id="buybox"><div id="unqualifiedBuyBox"><span class="a-button"><a id="buybox-see-all-buying-choices" href="/gp/offer-listing/B0FAKE0001/ref=dp_olp"><span class="a-button-text">See All Buying Options</span></a></span></div></div>`,
      }),
    );
    expect(d.buy_box.state).toBe("no_featured_offer");
    expect(d.featured_offer).toBeUndefined();
    expect(d.other_sellers[0]).toEqual({
      text: "See All Buying Options",
      path: "/gp/offer-listing/B0FAKE0001/ref=dp_olp",
    });
  });

  it("see all buying options with a price but no buy button", () => {
    const d = data(
      page({
        center: TITLE + apex(price("40.00")),
        right: `<div id="buybox"><span id="buybox-see-all-buying-choices"><a href="/gp/offer-listing/B0FAKE0001"><span>See All Buying Options</span></a></span></div>`,
      }),
    );
    expect(d.buy_box.state).toBe("see_all_buying_options");
  });

  it("no featured offers text wins", () => {
    const d = data(
      page({
        center: TITLE + apex(price("40.00")),
        right: `<div id="buybox"><span>No featured offers available</span></div>`,
      }),
    );
    expect(d.buy_box.state).toBe("no_featured_offer");
  });

  it("currently unavailable", () => {
    const d = data(
      page({
        center: TITLE,
        right: `<div id="buybox"><div id="outOfStock"><span class="a-color-price">Currently unavailable.</span><span>We don't know when or if this item will be back in stock.</span></div></div>`,
      }),
    );
    expect(d.buy_box.state).toBe("unavailable");
    expect(d.featured_offer).toBeUndefined();
  });

  it("temporarily out of stock but orderable", () => {
    const d = data(
      standard({ stock: "Temporarily out of stock. Order now and we'll deliver when available." }),
    );
    expect(d.buy_box.state).toBe("out_of_stock_orderable");
    expect(d.featured_offer?.stock_text).toMatch(/^Temporarily out of stock/);
  });

  it("temporarily out of stock without a buy button is unavailable", () => {
    const d = data(
      page({
        center: TITLE,
        right: `<div id="buybox"><div id="availability"><span>Temporarily out of stock.</span></div></div>`,
      }),
    );
    expect(d.buy_box.state).toBe("unavailable");
  });

  it("pre-order", () => {
    const d = data(
      standard({
        buyNowLabel: "Pre-order now",
        stock: "This item will be released on March 3, 2000.",
      }),
    );
    expect(d.buy_box.state).toBe("preorder");
  });

  it("used only and renewed", () => {
    const used = data(
      page({
        center: TITLE,
        right: accordion([
          row({
            id: "usedAccordionRow",
            caption: "Used - Like New",
            active: true,
            price: "11.00",
            content: offerContent({ odf: [{ label: "Condition", value: "Used - Like New" }] }),
          }),
        ]),
      }),
    );
    expect(used.buy_box.state).toBe("used_only");
    expect(used.featured_offer?.condition).toEqual({ kind: "used", text: "Used - Like New" });
    const renewed = data(
      page({
        center: TITLE,
        right: accordion([
          row({
            id: "newAccordionRow_0",
            caption: "Refurbished - Excellent",
            active: true,
            price: "150.00",
            content: offerContent({}),
          }),
        ]),
      }),
    );
    expect(renewed.buy_box.state).toBe("renewed");
    expect(renewed.product_type.markers).toContain("renewed");
  });

  it("unknown when nothing decisive is present, and throws when nothing parses", () => {
    const d = data(page({ center: TITLE }));
    expect(d.buy_box.state).toBe("unknown");
    expect(() => parse("<div>nothing here</div>", "https://www.example.com/nothing")).toThrow(
      RfError,
    );
  });

  it("price without a buy button is still a featured offer, with a warning", () => {
    const r = parse(
      page({ center: TITLE + apex(price("5.00")), right: `<div id="buybox"></div>` }),
    );
    expect(r.data.buy_box.state).toBe("featured_offer");
    expect(r.meta.warnings.join(" ")).toMatch(/without an add-to-cart/);
  });
});

describe("parseProduct: sellers and fulfillment", () => {
  it("third-party seller fulfilled by Amazon vs merchant-fulfilled", () => {
    const fba = data(
      standard({
        odf: [
          { label: "Ships from", value: "Amazon" },
          {
            label: "Sold by",
            value: "Example Goods LLC",
            sellerHref: "/sp?ie=UTF8&seller=A0FAKESELLER01&asin=B0FAKE0001",
          },
        ],
        merchantId: "A0FAKESELLER01",
      }),
    );
    expect(fba.featured_offer?.fulfillment).toBe("fba");
    expect(fba.featured_offer?.seller).toEqual({
      name: "Example Goods LLC",
      id: "A0FAKESELLER01",
      path: "/sp",
    });
    const mf = data(
      standard({
        odf: [{ label: "Shipper / Seller", value: "Example Outlet" }],
        merchantId: "A0FAKESELLER02",
      }),
    );
    expect(mf.featured_offer?.fulfillment).toBe("merchant");
    expect(mf.featured_offer?.ships_from).toBe("Example Outlet");
  });

  it("summarizes non-selected rows: price, unit price, delivery lines, badge, seller", () => {
    const used = row({
      id: "usedAccordionRow",
      caption: "Used - Good",
      active: false,
      price: "6.00",
      header: `<div id="apex_accordion_header_below_price_desktop">
        <span id="priceBadging_feature_div"><i class="a-icon-prime"><span>Two-Day</span></i></span>
        <div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_MEDIUM"><span>FREE delivery <b>January 9</b></span></div>
        <div id="mir-layout-DELIVERY_BLOCK-slot-SECONDARY_DELIVERY_MESSAGE_MEDIUM"><span>Or fastest delivery January 7</span></div></div>
        <div id="sfsb_accordion_head"><span>Ships from:</span> <span>Amazon</span> <span>Sold by:</span> <span>Example Resale</span></div>`,
    }).replace(
      '<div id="corePrice_feature_div">',
      `<div id="corePrice_feature_div"><span class="right-of-price-stack"><span class="aok-relative"><span class="aok-offscreen apex-priceperunit-accessibility-label">$3.00 per count</span></span></span>`,
    );
    const d = data(
      page({
        center: TITLE,
        right: accordion([
          row({
            id: "newAccordionRow_0",
            caption: "Buy New",
            active: true,
            price: "9.00",
            content: offerContent({}),
          }),
          used,
        ]),
      }),
    );
    expect(d.purchase_options[1]).toEqual({
      kind: "used",
      caption: "Used - Good",
      selected: false,
      row_id: "usedAccordionRow",
      price: { amount: 6, currency: "USD", raw: "$6.00" },
      unit_price: {
        price: { amount: 3, currency: "USD", raw: "$3.00" },
        raw: "$3.00 per count",
        unit: "count",
      },
      delivery: "FREE delivery January 9 | Or fastest delivery January 7",
      badge: "Two-Day",
      ships_from: "Amazon",
      sold_by: "Example Resale",
    });
  });

  it("reads ships-from / sold-by from the accordion header and legacy text", () => {
    const d = data(
      page({
        center: TITLE,
        right: accordion([
          row({
            id: "newAccordionRow_0",
            caption: "Buy New",
            active: true,
            price: "8.00",
            header: `<div id="shipFromSoldByAbbreviatedODF_feature_div"><div id="sfsb_accordion_head"><span>Ships from:</span> <span>Example Depot</span> <span>Sold by:</span> <span>Example Depot</span></div></div>`,
            content: offerContent({}),
          }),
        ]),
      }),
    );
    expect(d.featured_offer?.ships_from).toBe("Example Depot");
    expect(d.featured_offer?.fulfillment).toBe("merchant");
    const legacy = data(
      page({
        center: TITLE + apex(price("8.00")),
        right: `<div id="buybox"><div id="merchant-info">Ships from and sold by Amazon.com.</div>${offerContent({})}</div>`,
      }),
    );
    expect(legacy.featured_offer?.seller?.name).toBe("Amazon.com");
    expect(legacy.featured_offer?.fulfillment).toBe("amazon");
  });

  it("derives fulfillment and parses ships-from text", () => {
    expect(deriveFulfillment("Amazon", "Amazon.com")).toBe("amazon");
    expect(deriveFulfillment("Amazon", "Example Co")).toBe("fba");
    expect(deriveFulfillment("Example Co", "Example Co")).toBe("merchant");
    expect(deriveFulfillment(undefined, undefined, "ATVPDKIKX0DER")).toBe("amazon");
    expect(deriveFulfillment(undefined, undefined)).toBeUndefined();
    expect(parseShipsSold("Sold by Example Co and Fulfilled by Amazon.")).toEqual({
      ships_from: "Amazon",
      sold_by: "Example Co",
    });
  });
});

describe("parseProduct: pricing details", () => {
  it("subscribe & save selected by default", () => {
    const sns = row({
      id: "snsAccordionRowMiddle",
      caption: "Subscribe &amp; Save",
      active: true,
      header: `<div id="snsCaptionAndDiscountPillAbbreviated_feature_div"><span id="sns-caption-and-icon"><span class="a-text-bold">Subscribe &amp; Save</span></span></div>
        <div id="deliveryDateLabel_feature_div"><span id="accordion-header-sns-delivery-link">First delivery on Jan 9</span></div>`,
      content: offerContent({
        extra: `<div id="snsUpsellMessage_feature_div" ${H}><span>Save 5% now and 15% when you receive 5 or more products in one delivery.</span></div>
          <input type="hidden" name="items[0.base][additionalParameters][recurringDelivery][frequency][value]" value="2" ${H}>
          <input type="hidden" name="items[0.base][additionalParameters][recurringDelivery][frequency][unit]" value="M" ${H}>
          <select name="sns-frequency" ${H}><option>Every 2 weeks</option><option>Every month</option></select>`,
      }),
    }).replace(
      '<div id="corePrice_feature_div"></div>',
      `<div id="corePrice_feature_div"><span id="subscriptionPrice"><span id="sns-base-price" ${H}>${price("30.00")}</span><span id="sns-tiered-price">${price("28.50", "reinventPriceAccordionT2")}</span></span></div>`,
    );
    const oneTime = row({
      id: "newAccordionRow_0",
      caption: "One-time purchase",
      active: false,
      price: "30.00",
    });
    const d = data(page({ center: TITLE, right: accordion([oneTime, sns]) }));
    const s = d.featured_offer?.subscribe_and_save;
    expect(s?.default_selected).toBe(true);
    expect(s?.price?.amount).toBe(28.5);
    expect(s?.discount_percents).toEqual([5, 15]);
    expect(s?.discount_text[0]).toMatch(/^Save 5% now/);
    expect(s?.default_frequency).toEqual({ value: "2", unit: "M" });
    expect(s?.frequency_options).toEqual(["Every 2 weeks", "Every month"]);
    expect(s?.first_delivery).toBe("First delivery on Jan 9");
    expect(d.featured_offer?.price?.amount).toBe(28.5);
    expect(d.purchase_options.map((p) => [p.kind, p.selected])).toEqual([
      ["one_time", false],
      ["subscribe_and_save", true],
    ]);
    expect(d.product_type.markers).toContain("subscribe_and_save");
  });

  it("clippable coupon, conditional coupon and promotions", () => {
    const promo = (inner: string): string =>
      `<div id="promoPriceBlockMessage_feature_div"><div>${inner}</div></div>`;
    const clip = data(
      standard({
        center: promo(
          `<i class="a-icon newCouponBadge">Coupon:</i><span><input type="checkbox" id="checkboxpctch1"><label id="couponTextpctch1" class="couponLabelText">Apply $2 coupon <a href="#">Terms</a></label></span>`,
        ),
      }),
    );
    expect(clip.featured_offer?.coupon).toEqual({
      text: "Coupon: Apply $2 coupon",
      clippable: true,
    });
    const cond = data(
      standard({
        center: promo(
          `<span class="couponLabelText">Save 10%: Coupon available when you select Subscribe &amp; Save. <a href="/promotion/x">Shop items</a> |</span>
           <label id="greenBadgepctch9">Prime Savings</label><span id="promoMessagepctch9">Save 5% on 2 select item(s) <a href="#">Terms</a></span>`,
        ),
      }),
    );
    expect(cond.featured_offer?.coupon).toEqual({
      text: "Save 10%: Coupon available when you select Subscribe & Save.",
      clippable: false,
      condition: "when you select Subscribe & Save.",
    });
    expect(cond.featured_offer?.promotions).toEqual([
      { text: "Save 5% on 2 select item(s)", badge: "Prime Savings" },
    ]);
  });

  it("lightning deal with countdown and claimed percentage", () => {
    const d = data(
      standard({
        center: `<div id="dealBadge_feature_div"><span>Lightning Deal</span><span id="deal_expiry_timer_1">Ends in 02:10:05</span><span>40% claimed</span></div>`,
      }),
    );
    expect(d.featured_offer?.deal).toEqual({
      type: "Lightning Deal",
      raw: "Lightning Deal Ends in 02:10:05 40% claimed",
      countdown: "Ends in 02:10:05",
      claimed: "40% claimed",
    });
  });

  it("limited time deal found by text anchor", () => {
    const d = data(standard({ extra: `<span class="deal-label">Limited time deal</span>` }));
    expect(d.featured_offer?.deal?.type).toBe("Limited time deal");
  });

  it("typical price and list price strikethrough, with savings", () => {
    const basis = (label: string, amount: string): string =>
      `<span class="a-size-small aok-offscreen">${label} $${amount}</span><span class="a-size-small a-color-secondary basisPrice">${label} <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">$${amount}</span><span aria-hidden="true">$${amount}</span></span></span>`;
    const typical = parse(
      page({
        center:
          TITLE +
          apex(
            `<span id="apex-pricetopay-accessibility-label" class="aok-offscreen">$80.00 with 20 percent savings</span><span class="savingsPercentage">-20%</span>${price("80.00")}${basis("Typical price:", "100.00")}`,
          ),
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(typical.data.featured_offer?.typical_price).toEqual({
      amount: 100,
      currency: "USD",
      raw: "$100.00",
      label: "Typical price:",
    });
    expect(typical.data.featured_offer?.savings).toEqual({ percent: 20, raw: "-20%" });
    const list = parse(
      page({
        center: TITLE + apex(`${price("15.00")}${basis("List Price:", "20.00")}`),
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(list.data.featured_offer?.list_price?.amount).toBe(20);
    expect(list.data.featured_offer?.list_price?.label).toBe("List Price:");
    expect(list.data.featured_offer?.typical_price).toBeUndefined();
    // Every amount in the price block is typed, so the block is consumed whole.
    expect(list.other_sections.map((s) => s.text).join(" ")).not.toContain("$20.00");
  });

  it("savings from the accessibility label and a You Save line", () => {
    const label = data(
      page({
        center:
          TITLE +
          apex(
            `<span id="apex-pricetopay-accessibility-label" class="aok-offscreen">$8.00 with 11 percent savings</span>${price("8.00")}`,
          ),
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(label.featured_offer?.savings).toEqual({ percent: 11, raw: "with 11 percent savings" });
    const yousave = data(
      page({
        center:
          TITLE + apex(price("8.00")) + `<table><tr><td>You Save: $2.00 (20%)</td></tr></table>`,
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(yousave.featured_offer?.savings).toBeUndefined();
  });

  it("unit price from the accessibility label and from the value stack", () => {
    const a11y = data(
      standard({
        apexExtra: `<span class="right-of-price-stack"><span class="aok-relative"><span class="aok-offscreen apex-priceperunit-accessibility-label">$0.50 per Fl Oz</span></span></span>`,
      }),
    );
    expect(a11y.featured_offer?.unit_price).toEqual({
      price: { amount: 0.5, currency: "USD", raw: "$0.50" },
      raw: "$0.50 per Fl Oz",
      unit: "Fl Oz",
    });
    const stack = data(
      page({
        center:
          TITLE +
          apex(
            `${price("6.00")}<span class="a-size-small">(${price("1.50", "a-text-price apex-priceperunit-value")} / count)</span>`,
          ),
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(stack.featured_offer?.unit_price?.price.amount).toBe(1.5);
    expect(stack.featured_offer?.unit_price?.unit).toBe("count");
  });

  it("multipack: variant summary with a count dimension and a singleton", () => {
    const d = data(
      standard({
        center: `<div id="twister_feature_div"><div id="twister-plus-inline-twister">
          <div id="inline-twister-row-number_of_items"><div id="inline-twister-expander-header-number_of_items"><div id="inline-twister-dim-title-number_of_items"><span>Number of Items:</span> <span id="inline-twister-expanded-dimension-text-number_of_items">4</span></div></div>
            <div id="inline-twister-expander-content-number_of_items" aria-label="There are 3 options."><ul><li data-asin="B0FAKE0002">1</li><li data-asin="B0FAKE0001">4</li><li data-asin="B0FAKE0003">8</li></ul></div></div>
          <div id="inline-twister-row-size_name"><div id="inline-twister-expander-header-size_name"><div id="inline-twister-dim-title-size_name"><span>Size:</span> <span id="inline-twister-expanded-dimension-text-size_name">Small</span></div></div>
            <div id="inline-twister-expander-content-size_name"><ul><li data-asin="B0FAKE0004"><span id="size_name_0" class="a-button-toggle">Small</span></li><li data-asin="B0FAKE0005"><span id="size_name_1" class="a-button-toggle">Large</span></li></ul></div></div>
          <div id="inline-twister-singleton-header-color_name">Color: Example Blue</div>
        </div></div>`,
        scripts: `<script>var d = {"parentAsin":"X0FAKE0009"};</script>`,
      }),
    );
    expect(d.variant_summary).toEqual({
      parent_asin: "X0FAKE0009",
      dimensions: [
        { name: "number_of_items", label: "Number of Items", selected: "4", option_count: 3 },
        { name: "size_name", label: "Size", selected: "Small", option_count: 2 },
        { name: "color_name", option_count: 1, label: "Color", selected: "Example Blue" },
      ],
    });
    expect(d.product_type.markers).toContain("variations");
  });

  it("legacy twister rows", () => {
    const d = data(
      standard({
        center: `<div id="twister"><div id="variation_style_name"><label>Style:</label><span class="selection">Classic</span><ul><li>Classic</li><li>Modern</li></ul></div></div>`,
      }),
    );
    expect(d.variant_summary?.dimensions).toEqual([
      { name: "style_name", label: "Style", selected: "Classic", option_count: 2 },
    ]);
  });

  it("quantity limit and minimum", () => {
    const d = data(
      standard({
        extra: `<div class="a-section"><span>Limit 2 per customer</span></div><div><span>Minimum order quantity: 3</span></div>`,
      }),
    );
    expect(d.featured_offer?.limits_text).toEqual([
      "Limit 2 per customer",
      "Minimum order quantity: 3",
    ]);
  });

  it("protection plan and trade-in add-ons", () => {
    const d = data(
      standard({
        extra: `<div id="mbb_feature_div"><div id="abbWrapper"><span>Add a protection plan:</span>
          <div class="a-checkbox"><label><input type="checkbox" id="mbb-offeringID-1" name="offeringID.1" value="tok"><a id="mbbPopoverLink" href="#">3-Year Example Protection</a> for <span class="a-color-price">$12.99</span></label></div>
          <div class="a-checkbox"><label><input type="checkbox" id="mbb-offeringID-2" name="offeringID.2" value="tok2"><a href="#">Example Monthly Protect</a> for <span class="a-color-price">$1.99/month</span></label></div>
        </div></div>`,
        center: `<div id="tradeInButton"><span>Trade-in and save up to $50.00</span></div>`,
      }),
    );
    expect(d.featured_offer?.add_ons).toEqual([
      {
        kind: "protection_plan",
        title: "3-Year Example Protection",
        price: { amount: 12.99, currency: "USD", raw: "$12.99" },
        price_text: "$12.99",
      },
      {
        kind: "protection_plan",
        title: "Example Monthly Protect",
        price: { amount: 1.99, currency: "USD", raw: "$1.99" },
        price_text: "$1.99/month",
      },
      {
        kind: "trade_in",
        title: "Trade-in and save up to $50.00",
        price: { amount: 50, currency: "USD", raw: "$50.00" },
      },
    ]);
  });

  it("installments, points, gift options, prime badge and other sellers", () => {
    const d = data(
      standard({
        apexExtra: `<div id="paymentOptions_PriceblockMessaging_feature_div"><span>Or $5.00/mo (6 mo) at 0% APR.</span></div>`,
        extra: `<div id="pointsInsideBuyBox_feature_div"><span>You Earn: 12 pts</span></div>
          <div id="shippingMessageInsideBuyBox_feature_div"><span id="priceBadging_feature_div"><i class="a-icon-wrapper a-icon-prime-with-text"><span class="a-icon-text">Two-Day</span></i></span></div>
          <div id="gift-wrap"><label>Add a gift receipt for easy returns</label></div>`,
        odf: [...AMAZON, { label: "Gift options", value: "Available at checkout" }],
        below: `<div id="olpLinkWidget_feature_div"><div id="dynamic-aod-ingress-box"><div class="a-section"><span class="daodi-header-font">Other sellers on Amazon</span></div><a id="aod-ingress-link" href="/gp/offer-listing/B0FAKE0001/ref=dp_olp_NEW"><span>New (4) from</span> ${price("21.00", "x")}</a></div></div>`,
      }),
    );
    const o = d.featured_offer;
    expect(o?.installments).toBe("Or $5.00/mo (6 mo) at 0% APR.");
    expect(o?.points).toBe("You Earn: 12 pts");
    expect(o?.prime).toEqual({ eligible: true, text: "Two-Day" });
    expect(o?.gift).toEqual(["Available at checkout", "Add a gift receipt for easy returns"]);
    expect(d.other_sellers).toEqual([
      {
        text: "Other sellers on Amazon New (4) from $21.00",
        count: 4,
        from_price: { amount: 21, currency: "USD", raw: "$21.00" },
        path: "/gp/offer-listing/B0FAKE0001/ref=dp_olp_NEW",
      },
    ]);
  });

  it("prime from a 'for Prime members' delivery line", () => {
    const d = data(
      standard({
        delivery: 'FREE delivery <span class="a-text-bold">January 9 - 11</span> for Prime members',
      }),
    );
    expect(d.featured_offer?.prime).toEqual({ eligible: true, text: "for Prime members" });
    expect(d.featured_offer?.delivery[0]?.date_iso).toBeUndefined();
  });
});

describe("parseProduct: notices", () => {
  it("frequently returned, newer model, last purchased and badges", () => {
    const d = data(
      standard({
        center: `<div id="acBadge_feature_div"><span>Amazon's Choice</span></div>
          <div id="zeitgeistBadge_feature_div"><a href="/gp/bestsellers/fake/1/ref=zg"><span>#1 Best Seller</span> <span>in Fake Widgets</span></a></div>
          <div id="socialProofingAsinFaceout_feature_div"><span>2K+ bought</span> <span>in past month</span></div>
          <div id="buyingOptionRipersInlineBadge_feature_div"><div class="a-alert"><p><span>Frequently returned item</span></p></div></div>
          <div id="instantOrderUpdate_feature_div"><span>You purchased this item on January 2, 2000.</span> <a href="/gp/your-account/order-details?orderID=000-0000000-0000001">View order</a></div>
          <div id="newerVersion_feature_div"><div id="newerVersionFeature"><h2>There is a newer version of this item:</h2><a href="/Fake-Widget-2/dp/B0FAKE0042/ref=dp_ob">Fake Widget Deluxe 2</a><span class="a-color-price">$30.00</span></div></div>
          <div id="climatePledgeFriendlyATF_feature_div"><span>Example certified</span></div>
          <div class="a-section"><span>WARNING: This product can expose you to chemicals. See www.p65warnings.example.com</span></div>`,
      }),
    );
    const byType = Object.fromEntries(d.notices.map((n) => [n.type, n]));
    expect(byType.amazons_choice?.text).toBe("Amazon's Choice");
    expect(byType.best_seller).toEqual({
      type: "best_seller",
      text: "#1 Best Seller in Fake Widgets",
      path: "/gp/bestsellers/fake/1/ref=zg",
    });
    expect(byType.bought_in_past_month?.text).toBe("2K+ bought in past month");
    expect(byType.frequently_returned?.text).toBe("Frequently returned item");
    expect(byType.last_purchased?.text).toBe(
      "You purchased this item on January 2, 2000. View order",
    );
    expect(byType.newer_model).toMatchObject({
      asin: "B0FAKE0042",
      path: "/Fake-Widget-2/dp/B0FAKE0042/ref=dp_ob",
    });
    expect(byType.climate_pledge_friendly?.text).toBe("Example certified");
    expect(byType.prop65_warning?.text).toMatch(/^WARNING/);
  });

  it("last purchased found by text anchor", () => {
    const d = data(
      standard({
        center: `<div class="a-box"><span>Last purchased this on Jan 3, 2000</span></div>`,
      }),
    );
    expect(d.notices.find((n) => n.type === "last_purchased")?.text).toBe(
      "Last purchased this on Jan 3, 2000",
    );
  });
});

describe("parseProduct: sponsored and related widgets", () => {
  const card = (asin: string, title: string, amount: string): string =>
    `<li class="a-carousel-card"><div data-asin="${asin}"><a href="/x/dp/${asin}/ref=sspa"><div class="a-truncate-full">${title}</div></a>
     <a aria-label="4.1 out of 5 stars, 321 ratings" href="/product-reviews/${asin}"><i><span class="a-icon-alt">4.1 out of 5 stars</span></i></a>${price(amount, "x")}</div></li>`;

  it("emits visible and blocked sponsored carousels, skips hidden templates", () => {
    const r = parse(
      standard({
        below: `
<div id="sims-sponsoredProducts_feature_div_0" data-feature-name="sims-sponsoredProducts"><div class="a-carousel-container" ${H}>
  <h2 class="a-carousel-heading">Products related to this item</h2><span class="sp_detail_sponsored_label">Sponsored</span>
  <ol class="a-carousel">${card("B0FAKE0101", "Example Blocked Gadget", "10.00")}</ol></div></div>
<div id="sims-carousel_feature_div_1" data-feature-name="sims-carousel"><div class="a-carousel-container">
  <h2 class="a-carousel-heading">Featured picks</h2><span class="sp_detail_thematic_sponsored_label">Sponsored</span>
  <ol class="a-carousel">${card("B0FAKE0102", "Example Visible Ad Gadget", "11.00")}</ol></div></div>
<div id="sims-template_feature_div" data-feature-name="sims-template" ${H}><div class="a-carousel-container"><h2 class="a-carousel-heading">Template heading</h2>
  <ol class="a-carousel">${card("B0FAKE0103", "Template Gadget", "12.00")}</ol></div></div>
<div id="CardInstanceFAKE1"><div class="a-carousel-container"><h2 class="a-carousel-heading">Customers who viewed this item also viewed</h2>
  <ol class="a-carousel">${card("B0FAKE0104", "Example Related Gadget", "13.00").replace("</div></li>", "<div><span>-10%</span> <span>List: $14.44</span></div></div></li>")}</ol></div></div>
<div id="sims-productBundle_feature_div_0" data-feature-name="sims-productBundle"><div id="CardInstanceFAKE2"><h2>Frequently bought together</h2>
  <div id="ProductTitle-1"><span>This item:</span> <span>Fake Widget Deluxe, 2-Pack</span></div><div id="ProductSpecs-1">${price("24.99", "x")} <span>3 pts</span> +</div>
  <div id="ProductTitle-2"><a href="/y/dp/B0FAKE0105/ref=fbt">Example Companion</a></div><div id="ProductSpecs-2">${price("5.00", "x")}</div>
  <div class="total"><span>Total price:</span> <span>$29.99</span></div></div></div>`,
      }),
    );
    const d = r.data;
    expect(
      d.sponsored_blocks.map((b) => [b.key, b.heading, b.hidden_in_browser, b.items.length]),
    ).toEqual([
      ["sims-sponsoredProducts_feature_div_0", "Products related to this item", true, 1],
      ["sims-carousel_feature_div_1", "Featured picks", false, 1],
    ]);
    expect(d.sponsored_blocks[0]?.items[0]).toEqual({
      asin: "B0FAKE0101",
      title: "Example Blocked Gadget",
      price: { amount: 10, currency: "USD", raw: "$10.00" },
      rating: 4.1,
      rating_count: 321,
    });
    expect(d.related.map((w) => [w.key, w.heading, w.kind])).toEqual([
      ["CardInstanceFAKE1", "Customers who viewed this item also viewed", "carousel"],
      ["sims-productBundle_feature_div_0", "Frequently bought together", "bundle"],
    ]);
    expect(d.related[0]?.items[0]?.details).toBe("-10% List: $14.44");
    expect(d.related[1]?.footer).toBe("Total price: $29.99");
    expect(d.related[1]?.items).toEqual([
      {
        asin: "B0FAKE0001",
        title: "Fake Widget Deluxe, 2-Pack",
        price: { amount: 24.99, currency: "USD", raw: "$24.99" },
        details: "3 pts",
      },
      {
        asin: "B0FAKE0105",
        title: "Example Companion",
        price: { amount: 5, currency: "USD", raw: "$5.00" },
      },
    ]);
    expect(JSON.stringify(d)).not.toContain("Template Gadget");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("a display-ad placeholder with only its label is a sponsored block without items", () => {
    const d = data(
      standard({
        below: `<div id="ad-endcap-1-dramabot_feature_div" data-feature-name="ad-endcap-1-dramabot"><span id="ad-feedback-text-ad-endcap-1">Sponsored</span></div>`,
      }),
    );
    expect(d.sponsored_blocks).toEqual([
      {
        key: "ad-endcap-1-dramabot_feature_div",
        heading: null,
        is_sponsored: true,
        hidden_in_browser: true,
        items: [],
      },
    ]);
  });

  it("corrects an offscreen price that lost its decimal point", () => {
    const d = data(
      standard({
        below: `<div id="CardInstanceFAKE3"><div class="a-carousel-container"><h2 class="a-carousel-heading">Explore more</h2><ol class="a-carousel">
          <li class="a-carousel-card"><a href="/z/dp/B0FAKE0106/ref=x"><div class="a-truncate-full">Example Snack</div></a><span class="a-price"><span class="a-offscreen">$1005</span><span><span class="a-price-symbol">$</span><span class="a-price-whole">10</span><span class="a-price-fraction">05</span></span></span></li></ol></div></div>`,
      }),
    );
    expect(d.related[0]?.items[0]?.price).toEqual({
      amount: 10.05,
      currency: "USD",
      raw: "$10.05",
    });
  });
});

describe("parseProduct: content", () => {
  const REVIEWS = `<div id="customer-reviews_feature_div" data-feature-name="customer-reviews"><div id="reviewsMedley">
  <div id="averageCustomerReviewsAnchor"><h2>Customer reviews</h2><span aria-label="4.5 out of 5 stars, 1,234 ratings" role="img">4.5</span><span>(1,234)</span>
    <a aria-label="5 stars represent 70% of ratings" href="/product-reviews/B0FAKE0001/ref=acr_5"><span>5 star</span><span>70%</span></a>
    <a aria-label="4 stars represent 20% of ratings" href="/product-reviews/B0FAKE0001/ref=acr_4"><span>4 star</span><span>20%</span></a>
    <a aria-label="3 stars represent 6% of ratings" href="/product-reviews/B0FAKE0001/ref=acr_3"><span>3 star</span><span>6%</span></a>
    <a aria-label="2 stars represent 4% of ratings" href="/product-reviews/B0FAKE0001/ref=acr_2"><span>2 star</span><span>4%</span></a>
    <button aria-label="1 star represents 0% of ratings" role="link"><span>1 star</span><span>0%</span></button></div>
  <div class="cm_cr_grid_center_right"><div><h3>Customers say</h3><div><span>Buyers find the fake widget sturdy and easy to use.</span></div>
    <div><span>AI Generated from the text of customer reviews</span><div role="tablist" aria-label="Select to learn more">
      <div role="tab" aria-label="Positive aspect, sturdiness, 120 mentions"><button>sturdiness</button></div>
      <div role="tab" aria-label="Mixed aspect, size, 15 mentions"><button>size</button></div></div></div></div></div>
  <div id="cm-cr-dp-review-list"><div id="R0FAKEREVIEW1" data-hook="review"><span class="a-profile-name">Alex Example</span><span data-hook="review-body">Invented review text.</span></div></div>
</div></div>`;

  it("rating histogram, AI summary, bullets, description, A+, specs and more", () => {
    const r = parse(
      standard({
        center: `<div id="nile-inline-insights_feature_div"><h3>Top highlights</h3><ul><li>Invented highlight one</li><li>Invented highlight two</li></ul><span>Summarized from product information</span></div>
          <div id="featurebullets_feature_div"><div id="feature-bullets"><h3>About this item</h3><ul><li><span class="a-list-item">Invented bullet A</span></li><li><span class="a-list-item">Invented bullet B</span></li></ul>
            <div class="a-expander-header"><a href="javascript:void(0)"><span class="a-expander-prompt">See more</span></a></div></div></div>`,
        below: `
<div id="productOverview_feature_div"><table><tr><td><span>Brand</span></td><td><span>ExampleBrand</span></td></tr><tr><td><span>Color</span></td><td><span>Example Blue</span></td></tr></table></div>
<div id="productDescription_feature_div"><h2>Product Description</h2><div id="productDescription"><p><span>An invented description.</span></p></div></div>
<div id="aplus_feature_div"><h2>From the manufacturer</h2><div class="aplus-module module-1"><h3>Example Heading</h3><p>Invented A+ copy.</p></div><div class="aplus-module module-2"><p>More invented copy.</p></div></div>
<div id="productDetails_feature_div"><div id="prodDetails"><h2>Product information</h2>
  <div class="a-expander-container"><a class="a-expander-header"><span class="a-expander-prompt">Item details</span></a>
    <div class="a-expander-content" ${H}><table class="a-keyvalue prodDetTable"><tr><th>Brand</th><td>ExampleBrand</td></tr>
      <tr><th>Best Sellers Rank</th><td><span><ul><li><span>#1,234 in Fake Goods (<a href="/gp/bestsellers/fake/ref=zg">See Top 100 in Fake Goods</a>)</span></li><li><span>#5 in <a href="/gp/bestsellers/fake/2/ref=zg">Fake Widgets</a></span></li></ul></span></td></tr>
      <tr><th>Customer Reviews</th><td><div id="averageCustomerReviews"><span class="a-icon-alt">4.5 out of 5 stars</span><span id="acrCustomerReviewText">(1,234)</span></div></td></tr></table></div></div>
  <div id="productDetails_techSpec_section_1_wrap"><h3>Technical Details</h3><table id="productDetails_techSpec_section_1"><tr><th>Weight &#8206;</th><td>&#8206;1 fake pound</td></tr></table></div>
</div></div>
<div id="importantInformation_feature_div"><div id="important-information"><h2>Important information</h2><div class="a-section content"><span class="a-text-bold">Ingredients</span><p>Invented ingredient list.</p><span class="a-text-bold">Directions</span><p>Invented directions.</p></div></div></div>
<div id="postPurchaseWhatsInTheBox_MP_feature_div"><h2>What's in the box</h2><ul><li><span>1 x Fake Widget</span></li><li><span>1 x Example Cable</span></li></ul></div>
<div id="productDocuments_feature_div"><h2>Product guides and documents</h2><a href="/images/I/fakemanual.pdf?x=1">User Manual (PDF)</a><a href="/somewhere">Contact us</a></div>
${REVIEWS}`,
        scripts: `<script>P.when('A').execute(function(A){ var data = {'colorImages': { 'initial': A.$.parseJSON('[{"hiRes":"https://images.example.com/placeholder.png","large":"https://images.example.com/placeholder.png","alt":"Example\\'s widget"},{"hiRes":null,"large":"https://images.example.com/placeholder.png"}]')}};});</script>
          <script>var v = {"totalVideoCount":3};</script>
          <div id="rufus-price-ingress-bb" data-ingress-position="buybox" data-query-text="Price history"></div>`,
      }),
    );
    const d = r.data;
    expect(d.rating?.histogram).toEqual([
      { star: 5, percent: 70 },
      { star: 4, percent: 20 },
      { star: 3, percent: 6 },
      { star: 2, percent: 4 },
      { star: 1, percent: 0 },
    ]);
    expect(d.rating?.review_summary_ai).toEqual({
      text: "Buyers find the fake widget sturdy and easy to use.",
      aspects: [
        { name: "sturdiness", sentiment: "positive", mentions: 120 },
        { name: "size", sentiment: "mixed", mentions: 15 },
      ],
      note: "AI Generated from the text of customer reviews",
    });
    expect(d.highlights).toEqual(["Invented highlight one", "Invented highlight two"]);
    expect(d.bullets).toEqual(["Invented bullet A", "Invented bullet B"]);
    expect(d.description).toBe("An invented description.");
    expect(d.aplus_text).toEqual([
      { heading: "Example Heading", text: "Example Heading Invented A+ copy." },
      { heading: "From the manufacturer", text: "More invented copy." },
    ]);
    expect(d.overview).toEqual([
      { label: "Brand", value: "ExampleBrand" },
      { label: "Color", value: "Example Blue" },
    ]);
    expect(d.spec_tables[0]).toEqual({
      heading: "Item details",
      collapsed: true,
      source: "prodDetails-expander",
      rows: [
        { label: "Brand", value: "ExampleBrand" },
        {
          label: "Best Sellers Rank",
          value: "#1,234 in Fake Goods ( See Top 100 in Fake Goods ) #5 in Fake Widgets",
        },
        { label: "Customer Reviews", value: "4.5 out of 5 stars (1,234)" },
      ],
    });
    expect(d.spec_tables[1]).toEqual({
      heading: "Technical Details",
      collapsed: false,
      source: "prodDetails-table",
      rows: [{ label: "Weight", value: "1 fake pound" }],
    });
    expect(d.best_seller_ranks).toEqual([
      { rank: 1234, category: "Fake Goods", raw: "#1,234 in Fake Goods" },
      {
        rank: 5,
        category: "Fake Widgets",
        raw: "#5 in Fake Widgets",
        path: "/gp/bestsellers/fake/2/ref=zg",
      },
    ]);
    expect(d.important_information).toEqual([
      { heading: "Ingredients", text: "Invented ingredient list." },
      { heading: "Directions", text: "Invented directions." },
    ]);
    expect(d.whats_in_the_box).toEqual(["1 x Fake Widget", "1 x Example Cable"]);
    expect(d.documents).toEqual([{ text: "User Manual (PDF)", path: "/images/I/fakemanual.pdf" }]);
    expect(d.media_counts).toEqual({ images: 2, videos: 3 });
    expect(d.price_history_ingress).toEqual({ positions: ["buybox"], query_text: "Price history" });
    // The individual reviews belong to the reviews parser: they stay in other_sections.
    expect(r.other_sections.some((s) => s.text.includes("Invented review text."))).toBe(true);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("detail bullets, collapsed bullets and highlights, disclaimers", () => {
    const d = data(
      standard({
        center: `<div id="voyagerNorthstarATF"><div class="a-expander-container"><a class="a-expander-header"><span class="a-expander-prompt">Top highlights</span></a>
          <div class="a-expander-content" ${H}><div id="afs-insights"><button class="afs-insights-pill">Invented pill</button><span>Summarized from product information</span></div>
          <div id="feature-bullets"><h3>About this item</h3><ul><li><span>Collapsed bullet</span></li></ul></div></div></div></div>`,
        below: `<div id="detailBulletsWrapper_feature_div"><h2>Product details</h2><div id="detailBullets_feature_div"><ul>
            <li><span class="a-list-item"><span class="a-text-bold">Publisher &#8207; : &#8206;</span><span>Example Press</span></span></li>
            <li><span class="a-list-item"><span class="a-text-bold">Best Sellers Rank:</span> #42 in Fake Books (<a href="/gp/bestsellers/books">See Top 100</a>) <ul><li><span>#3 in Example Topics</span></li></ul></span></li></ul></div></div>
          <div id="storeDisclaimer_feature_div"><span>Disclaimer: Invented store disclaimer text.</span></div>`,
      }),
    );
    expect(d.bullets).toEqual(["Collapsed bullet"]);
    expect(d.highlights).toEqual(["Invented pill"]);
    expect(d.spec_tables.find((t) => t.source === "detail-bullets")?.rows[0]).toEqual({
      label: "Publisher",
      value: "Example Press",
    });
    expect(d.best_seller_ranks.map((b) => [b.rank, b.category])).toEqual([
      [42, "Fake Books"],
      [3, "Example Topics"],
    ]);
    expect(d.important_information).toEqual([
      { heading: "Disclaimer", text: "Disclaimer: Invented store disclaimer text." },
    ]);
  });

  it("book contributors byline and external ratings", () => {
    const d = data(
      page({
        dpClass: "book en_US",
        center: `<div id="title_feature_div"><span id="productTitle">An Invented Book</span></div>
          <div id="bylineInfo"><span class="author"><a class="a-link-normal" href="/Alex-Example/e/FAKE">Alex Example</a><span class="contribution"><span>(Author)</span></span></span>,
            <span class="author"><a class="a-link-normal" href="/Sam-Example/e/FAKE2">Sam Example</a><span class="contribution"><span>(Illustrator)</span></span></span></div>
          <div id="goodreadsRatingsWidget_feature_div"><span>3.9 on Goodreads</span> <span>100 ratings</span></div>
          <div id="bookDescription_feature_div"><div class="a-expander-content"><span>An invented blurb.</span></div><a class="a-expander-header"><span class="a-expander-prompt">Read more</span></a></div>`,
        right: `<div id="buybox">${offerContent({})}</div>`,
      }),
    );
    expect(d.byline?.kind).toBe("contributors");
    expect(d.byline?.contributors).toEqual([
      { name: "Alex Example", role: "Author", path: "/Alex-Example/e/FAKE" },
      { name: "Sam Example", role: "Illustrator", path: "/Sam-Example/e/FAKE2" },
    ]);
    expect(d.rating?.external).toEqual([
      { source: "Goodreads", text: "3.9 on Goodreads 100 ratings" },
    ]);
    expect(d.description).toBe("An invented blurb.");
    expect(d.product_type.markers).toContain("book");
  });

  it("an unknown block inside the buy box lands in other_sections", () => {
    const r = parse(
      standard({
        extra: `<div id="fakeNewWidget_feature_div" data-feature-name="fakeNewWidget"><span>Invented new buy-box message</span></div>`,
      }),
    );
    const s = r.other_sections.find((x) => x.key === "fakeNewWidget_feature_div");
    expect(s?.text).toBe("Invented new buy-box message");
    expect(r.meta.unparsed_text_chars).toBe(0);
    const total = visibleTextChars(parseDocument(capture(standard()).html), {
      root: parseDocument(capture(standard()).html).querySelector("#dp") ?? undefined,
    });
    expect(total).toBeGreaterThan(0);
  });
});

describe("parseProduct: grocery", () => {
  it("parses store, tabs, estimated price per unit, weight and nutrition", () => {
    const html = page({
      dpClass: "grocery en_US",
      above: CRUMBS,
      center: `<div id="title_feature_div"><span id="productTitle">Example Fruit, 1 Each</span></div>
        <div id="bylineInfo_feature_div"><a id="bylineInfo" href="/s/ref=bl">Brand: Example Farms</a></div>
        <div id="nutritionalInfoAndIngredients_feature_div" data-feature-name="nutritionalInfoAndIngredients"><div>
          <div id="dietary-shopping-title"><span>Diet type</span></div>
          <div id="nic-diet-type-logos-wrapper"><div class="nic-diet-type-logo"><span>Vegan</span></div><div class="nic-diet-type-logo"><span>Example Diet</span></div></div>
          <div id="nic-nutrition-summary-title"><span>Nutrition summary</span></div>
          <div id="nic-nutrition-summary-serving"><span>1.0 servings per container | 1.0 piece</span></div>
          <table id="nic-nutrition-summary-nutrient-content"><tr><td>90</td><td>2g</td></tr><tr><td>Calories</td><td>Protein</td></tr></table>
          <div class="a-expander-container"><a class="a-expander-header"><span class="a-expander-prompt">Nutrition facts</span></a>
            <div class="a-expander-content" ${H}><table id="nic-nutrition-facts-nutrients-content"><tr id="nic-nutrition-facts-energy"><td class="a-text-left">Calories</td><td class="a-text-right">90</td></tr>
              <tr id="nic-nutrition-facts-nutrients"><td><table id="nic-nutrition-facts"><tr><td class="a-text-right">1%</td><td class="a-text-left"><span class="a-text-bold">Total Fat</span><span class="nutrientAmountText">0.5g</span></td></tr></table></td></tr></table>
              <div id="nic-ingredients-content"><span>Example fruit</span></div></div></div>
        </div></div>`,
      right: `<div id="desktop_buybox"><div id="buybox"><div id="offerDisplayGroup"><ul id="offerDisplayGroupTabSet">
          <li class="a-tab-heading a-active"><a href="#"><span>Delivery</span></a></li><li class="a-tab-heading"><a href="#"><span>Pickup</span></a></li></ul>
        <div id="desktop_almBuyBox"><div id="addToCart">
          <div id="almDesktopSingleOfferPriceWrapper"><div id="corePrice_feature_div"><div class="a-section">est. ${price("0.30", "x")}/each <span class="a-size-small">(<span>$0.99</span>/lb)</span></div></div></div>
          <div id="almLogoAndDeliveryMessage_feature_div"><img id="almLogo" alt="Example Whole Foods Market logo" src="https://images.example.com/placeholder.png">
            <div id="alm-delivery-message"><span>FREE delivery <span class="a-text-bold">Tomorrow 8 AM - 10 AM</span> on orders over $25.</span></div></div>
          <div id="almAvailability_feature_div"><div id="availability-string"><span>In Stock</span></div></div>
          <div id="almAddToCart_feature_div"><div class="pvw-replace"><span class="a-text-bold">About 0.40 lb. Final cost by weight.</span></div>
            <div class="atc-faceout-container" data-asin="B0FAKE0001"><span><input id="add-to-cart-button-grocery" type="submit"><span>Add to cart</span></span></div></div>
          <div id="oasisLabel_feature_div"><span>SNAP EBT eligible</span></div>
          <div id="almShipsFromSoldBy_feature_div"><div id="fresh-merchant-info"><table><tr><td><span>Ships from</span></td><td><span>Example Store 0001</span></td></tr><tr><td><span>Sold by</span></td><td><span>Example Store 0001</span></td></tr></table></div></div>
        </div></div></div></div></div>`,
    });
    const r = parse(html);
    const d = r.data;
    expect(d.grocery).toEqual({
      store: "whole_foods",
      tabs: [
        { label: "Delivery", selected: true },
        { label: "Pickup", selected: false },
      ],
      weight_text: "About 0.40 lb. Final cost by weight.",
      snap_ebt: true,
      delivery_window: "Tomorrow 8 AM - 10 AM",
    });
    expect(d.featured_offer?.price).toEqual({ amount: 0.3, currency: "USD", raw: "$0.30" });
    expect(d.featured_offer?.price_is_estimate).toBe(true);
    expect(d.featured_offer?.price_per).toBe("each");
    expect(d.featured_offer?.unit_price).toEqual({
      price: { amount: 0.99, currency: "USD", raw: "$0.99" },
      raw: "($0.99/lb)",
      unit: "lb",
    });
    expect(d.featured_offer?.delivery[0]?.date).toBe("Tomorrow 8 AM - 10 AM");
    expect(d.featured_offer?.seller?.name).toBe("Example Store 0001");
    expect(d.featured_offer?.stock_text).toBe("In Stock");
    expect(d.byline).toMatchObject({ kind: "brand", name: "Example Farms" });
    expect(d.nutrition).toEqual({
      diet_types: ["Vegan", "Example Diet"],
      serving: "1.0 servings per container | 1.0 piece",
      summary: [
        { label: "Calories", value: "90" },
        { label: "Protein", value: "2g" },
      ],
      facts: [
        { name: "Calories", amount: "90" },
        { name: "Total Fat", amount: "0.5g", daily_value: "1%" },
      ],
      ingredients: "Example fruit",
      collapsed: true,
    });
    expect(d.product_type.markers).toContain("grocery");
    expect(d.notices.find((n) => n.type === "snap_ebt")).toBeDefined();
    expect(r.meta.unparsed_text_chars).toBe(0);
  });
});

describe("parseProduct: identity fallbacks", () => {
  it("ASIN from canonical link or URL, title from meta", () => {
    const viaCanonical = parse(
      `<link rel="canonical" href="https://www.example.com/Fake/dp/B0FAKE0007"><meta name="title" content="Meta Fake Title"><div id="dp"><div id="buybox">${price("1.00")}</div></div>`,
      "https://www.example.com/other",
    );
    expect(viaCanonical.data.asin).toBe("B0FAKE0007");
    expect(viaCanonical.meta.strategies.asin).toBe("label");
    expect(viaCanonical.data.title).toBe("Meta Fake Title");
    const viaUrl = parse(
      `<div id="dp"><span>x</span></div>`,
      "https://www.example.com/gp/product/B0FAKE0008?th=1",
    );
    expect(viaUrl.data.asin).toBe("B0FAKE0008");
    expect(viaUrl.meta.strategies.asin).toBe("text-anchor");
    expect(viaUrl.data.title).toBe("Fake page title");
    expect(viaUrl.meta.warnings.some((w) => w.startsWith("byline"))).toBe(false);
  });
});

describe("product helpers", () => {
  it("isoDate, cleanText, parseRanks, parseAspect", () => {
    expect(isoDate("until Jan 31, 2001")).toBe("2001-01-31");
    expect(isoDate("Tomorrow, January 4")).toBeUndefined();
    expect(isoDate("Foo 4, 2001")).toBeUndefined();
    expect(isoDate(undefined)).toBeUndefined();
    expect(cleanText(" A\u200e : \u200f B ")).toBe("A : B");
    expect(parseRanks("Best Sellers Rank: #10 in Fakes (See Top 100) #2 in Sub Fakes")).toEqual([
      { rank: 10, category: "Fakes", raw: "#10 in Fakes" },
      { rank: 2, category: "Sub Fakes", raw: "#2 in Sub Fakes" },
    ]);
    expect(parseAspect("Negative aspect, noise")).toEqual({ name: "noise", sentiment: "negative" });
    expect(parseAspect("Something else")).toBeUndefined();
  });
});
