import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { FAKE } from "@rainforest/core";
import { expectLosslessCoverage } from "../../src/testing.ts";
import { parseCart } from "../../src/pages/cart.ts";
import type { CartItem } from "../../src/pages/cart.ts";

const HOST = FAKE.host;
const ID1 = "11111111-aaaa-4bbb-8ccc-000000000001";
const ID2 = "22222222-aaaa-4bbb-8ccc-000000000002";
const ID3 = "33333333-aaaa-4bbb-8ccc-000000000003";
const ID4 = "44444444-aaaa-4bbb-8ccc-000000000004";

function cap(body: string): Capture {
  return {
    kind: "cart",
    url: `${HOST}/gp/cart/view.html`,
    final_url: `${HOST}/gp/cart/view.html`,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>Fake cart</title></head><body><div id=a-page><header id=navbar-main>Chrome nav text</header>${body}<footer id=navFooter>Footer chrome</footer></div></body></html>`,
  };
}

interface ItemOpts {
  id?: string;
  asin?: string;
  list?: "active" | "saved";
  title?: string;
  priceHtml?: string;
  attrs?: string;
  tail?: string;
  controls?: string;
  extra?: string;
}

const PRICE_A = `<span class="a-price apex-price-to-pay-value" data-a-size="l"><span class="a-offscreen">$19.99</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">19<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span>`;

function item(o: ItemOpts = {}): string {
  const id = o.id ?? ID1;
  const asin = o.asin ?? "B0FAKE0001";
  const list = o.list ?? "active";
  const title = o.title ?? "Fake Widget Deluxe Edition";
  const prefix = list === "saved" ? "sc-saved" : "sc-item";
  return `
<div id="${prefix}-${id}" class="a-row sc-list-item sc-list-item-border" role="listitem"
  data-asin="${asin}" data-itemid="${id}" data-itemtype="${list}" data-quantity="2" data-price="19.99"
  data-giftable="0" data-giftwrapped="0" data-outofstock="0" data-isprimeasin="0"
  data-csa-c-item-id="amzn1.asin.${asin}" data-producttitle="Fallback title"
  data-encoded-offering="SECRETOFFERTOKEN" data-best-offer-id="SECRETBESTOFFER" ${o.attrs ?? ""}>
  <div class="sc-list-item-removed-msg" data-rf-hidden="1"><span>was removed from Shopping Cart.</span></div>
  <div class="sc-list-item-content">
    <div class="a-spacing-mini sc-item-content-group sc-image-wrap">
      <a class="a-link-normal sc-product-link" href="/gp/product/${asin}/ref=ox_sc_title_1?smid=A0FAKESELL01&amp;psc=1" tabindex="-1"><img alt="" class="sc-product-image" src="${FAKE.imageUrl}"></a>
    </div>
    <div class="sc-item-content-group">
      <ul data-feature-id="sc-item-content-list" class="a-unordered-list">
        <li class="sc-item-product-title-cont"><span class="a-list-item">
          <a class="a-link-normal sc-product-link sc-product-title" href="/gp/product/${asin}/ref=ox_sc_title_1?smid=A0FAKESELL01&amp;psc=1">
            <span class="a-size-base-plus"><h3 class="a-text-normal"><span class="a-truncate sc-grid-item-product-title"><span class="a-truncate-full a-offscreen">${title}</span><span class="a-truncate-cut">${title.slice(0, 12)}...</span></span></h3></span>
            <span class="aok-hidden" data-rf-hidden="1">Opens in a new tab</span>
          </a></span></li>
        <div class="sc-item-price-block"><span data-feature-id="sc-item-price">${o.priceHtml ?? PRICE_A}</span></div>
        <div class="sc-grid-content-tail responsive-grid">${o.tail ?? ""}</div>
      </ul>
      <div class="a-row sc-action-links">${o.controls ?? ""}</div>
    </div>
    ${o.extra ?? ""}
  </div>
</div>`;
}

const DELETE = (id: string) =>
  `<span data-action="delete" class="sc-action-delete"><span class="a-declarative" data-action="sc-item-action" data-sc-item-action='{"action":"delete","itemID":"${id}","itemType":"active"}'><input name="submit.delete.${id}" value="Delete" data-action="delete" type="submit"></span></span>`;
const SAVE = (id: string) =>
  `<span data-action="save-for-later" class="sc-action-save-for-later"><input name="submit.save-for-later.${id}" value="Save for later" data-action="save-for-later" type="submit"></span>`;

/** Wrap parts in the main content root the parser looks for. */
function pc(...parts: string[]): string {
  return `<div id=sc-page-content role=main>${parts.join("")}</div>`;
}

function activeInner(items: string, count = 1, extra = ""): string {
  return `<div id=sc-retail-cart-container><div id=sc-cart-column>
    <div id=sc-active-cart data-cart-total-item-count="${count}" data-name="Active Cart"><div class="a-cardui-body">
      <div class="a-row sc-cart-header"><h2 id=sc-active-items-header>Shopping Cart</h2></div>
      ${extra}
      <form id=activeCartViewForm><div class="sc-list-body" role="list">${items}</div></form>
    </div></div>
  </div></div>`;
}

function activeCart(items: string, count = 1, extra = ""): string {
  return pc(activeInner(items, count, extra));
}

function savedCart(items: string, declared = 1): string {
  return `<div id=sc-secondary-list><div class="a-cardui-body">
    <div class="a-row sc-list-head"><h3>Your Items</h3></div>
    <ul id=sc-secondary-list-tab><li id=sc-saved-cart-caption><a role=tab><div id=sc-saved-cart-list-caption-text data-saved-item-quantity="${declared}">Saved for later</div></a></li></ul>
    <div id=sc-saved-cart data-listtype="saved-for-later"><form id=savedCartViewForm><input type=hidden name="anti-csrftoken-a2z" value="SECRETCSRF" data-rf-hidden="1"><div id=sc-saved-cart-items class="sc-list-body">${items}</div></form></div>
  </div></div>`;
}

const SELLER_LINE = `<li data-csa-c-content-id="seller" role="presentation"><span class="a-list-item"><span class="a-size-small a-color-secondary sc-seller">Sold by: <a href="/gp/help/seller">Example Seller Co</a></span></span></li>`;
const SHIPS_LINE = `<li data-csa-c-content-id="seller" role="presentation"><span class="a-list-item"><span class="a-size-small a-color-secondary sc-seller">Shipped from: <a href="/gp/help/seller">Example Warehouse</a></span></span></li>`;

function one(html: string, which: "active_items" | "saved_items" = "active_items"): CartItem {
  const r = parseCart(cap(html));
  const it = r.data[which][0];
  if (it === undefined) throw new Error(`no ${which}`);
  return it;
}

describe("parseCart: active line item (all fields)", () => {
  const tail = `
    <div data-csa-c-content-id="product-insights-badge" class="a-section"><span class="a-size-small">50+ bought in past month</span></div>
    <li role="presentation"><span class="a-list-item"><span data-csa-c-content-id="availability" class="a-size-small a-color-success sc-product-availability">In Stock</span></span></li>
    ${SELLER_LINE}${SHIPS_LINE}
    <li class="sc-delivery-messaging" role="presentation"><span class="a-list-item"><i class="a-icon a-icon-prime" role="img" aria-label="prime"></i><span>FREE delivery Friday, March 7, 2031</span>
      <span class="sc-free-returns"><span id="cart-return-policy-separator">&amp;</span><a class="sc-free-return" href="/returns">FREE Returns</a></span></span></li>
    <li class="sc-item-condition"><span class="a-list-item">Condition: Used - Good</span></li>
    <li class="sc-subscribe-and-save"><span class="a-list-item">Subscribe &amp; Save: Delivery every 2 months</span></li>
    <ul id="sc-product-variation-list" class="a-unordered-list">
      <li class="sc-product-variation"><span class="a-list-item"><span class="a-size-small a-text-bold">Color:</span><span class="a-size-small">Fake Red</span></span></li>
      <li class="sc-product-variation"><span class="a-list-item"><span class="a-size-small a-text-bold">Size:</span><span class="a-size-small">Large</span></span></li>
    </ul>
    <li class="sc-gift-option"><label><input type="checkbox" name="giftOption"> This is a gift</label></li>`;
  const priceHtml = `${PRICE_A}<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$24.99</span><span aria-hidden="true">$24.99</span></span><span class="a-color-price">Save 20%</span><span class="a-size-small">$1.00 / count</span>`;
  const controls = `<span class="sc-action-quantity"><select name="quantity" class="a-native-dropdown"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select><span class="a-dropdown-prompt">Qty: 2</span></span>${DELETE(ID1)}${SAVE(ID1)}`;
  const html = activeCart(
    item({
      tail,
      priceHtml,
      controls,
      extra: `<div class="sc-item-check"><input type="checkbox" name="activeItems" checked></div>`,
    }).replace('data-giftable="0"', 'data-giftable="1"'),
  );
  const r = parseCart(cap(html));
  const line = r.data.active_items[0] as CartItem;

  it("identifies the line and links", () => {
    expect(r.data.active_count).toBe(1);
    expect(line.item_id).toBe(ID1);
    expect(line.list).toBe("active");
    expect(line.asin).toBe("B0FAKE0001");
    expect(line.asin).toMatch(FAKE.asinPattern);
    expect(line.url_path).toBe("/gp/product/B0FAKE0001/ref=ox_sc_title_1");
    expect(line.seller_id).toBe("A0FAKESELL01");
    expect(line.image_url).toBe(FAKE.imageUrl);
    expect(line.group).toBeNull();
  });

  it("reads the full title once, not the truncated twin", () => {
    expect(line.title).toBe("Fake Widget Deluxe Edition");
  });

  it("reads price, list price, savings and notes without double counting offscreen text", () => {
    expect(line.price).toEqual({ amount: 19.99, currency: "USD", raw: "$19.99" });
    expect(line.list_price?.amount).toBe(24.99);
    expect(line.savings).toBe("Save 20%");
    expect(line.price_notes).toEqual(["$1.00 / count"]);
  });

  it("reads variants as name/value pairs", () => {
    expect(line.variant).toEqual([
      { name: "Color", value: "Fake Red" },
      { name: "Size", value: "Large" },
    ]);
  });

  it("reads quantity dropdown", () => {
    expect(line.quantity).toBe(2);
    expect(line.quantity_control).toBe("dropdown");
    expect(line.quantity_options).toEqual([1, 2, 3]);
    expect(line.quantity_open_ended).toBe(false);
    expect(line.max_quantity).toBe(3);
  });

  it("reads seller, fulfillment, condition, delivery, returns, prime", () => {
    expect(line.seller).toBe("Example Seller Co");
    expect(line.ships_from).toBe("Example Warehouse");
    expect(line.fulfillment).toEqual([
      "Sold by: Example Seller Co",
      "Shipped from: Example Warehouse",
    ]);
    expect(line.condition).toBe("Used - Good");
    expect(line.delivery).toEqual(["FREE delivery Friday, March 7, 2031"]);
    expect(line.delivery_dates).toEqual(["2031-03-07"]);
    expect(line.returns).toBe("FREE Returns");
    expect(line.is_prime).toBe(true);
  });

  it("reads stock, badges, gift, subscribe and selection", () => {
    expect(line.in_stock).toBe(true);
    expect(line.stock_text).toBe("In Stock");
    expect(line.badges).toEqual(["50+ bought in past month"]);
    expect(line.gift_option).toBe(true);
    expect(line.gift_wrapped).toBe(false);
    expect(line.subscribe_and_save).toBe(true);
    expect(line.subscribe_hints).toEqual(["Subscribe & Save: Delivery every 2 months"]);
    expect(line.selected).toBe(true);
  });

  it("lists the controls the line offers", () => {
    expect(line.actions).toEqual(expect.arrayContaining(["delete", "save-for-later"]));
  });

  it("never emits offer or form tokens and is JSON-serializable", () => {
    const json = JSON.stringify(r);
    expect(JSON.parse(json)).toEqual(r);
    for (const secret of ["SECRETOFFERTOKEN", "SECRETBESTOFFER", "SECRETCSRF"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("records strategies", () => {
    expect(r.meta.strategies["items"]).toBe("data-itemid");
    expect(r.meta.strategies["item.item_id"]).toBe("data-attr");
    expect(r.meta.strategies["item.title"]).toBe("full-title");
    expect(r.meta.strategies["item.quantity"]).toBe("select");
    expect(r.meta.strategies["item.price"]).toBe("price-element");
  });

  it("accounts for the line completely", () => {
    expect(r.data.active_items[0]?.details).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });
});

describe("parseCart: quantity control variants", () => {
  it("reads a dropdown with an open-ended 10+ option", () => {
    const sel = `<select name="quantity"><option value="1">1</option><option value="9">9</option><option value="10">10+</option></select>`;
    const it = one(
      activeCart(item({ controls: `<span class="sc-action-quantity">${sel}</span>` })),
    );
    expect(it.quantity_control).toBe("dropdown");
    expect(it.quantity_open_ended).toBe(true);
    expect(it.max_quantity).toBeNull();
    expect(it.quantity_options).toEqual([1, 9, 10]);
    expect(it.quantity).toBe(1);
  });

  it("reads a text input used for quantities of 10 and above", () => {
    const input = `<input type="text" name="quantityBox" value="12" max="30" aria-label="Update quantity for Fake Widget">`;
    const r = parseCart(
      cap(activeCart(item({ controls: `<span class="sc-action-quantity">${input}</span>` }))),
    );
    const it = r.data.active_items[0] as CartItem;
    expect(it.quantity).toBe(12);
    expect(it.quantity_control).toBe("text");
    expect(it.max_quantity).toBe(30);
    expect(r.meta.strategies["item.quantity"]).toBe("text-input");
    expect(r.data.active_quantity_total).toBe(12);
  });

  it("reads a stepper", () => {
    const stepper = `<div class="sc-action-quantity" data-max="5"><button aria-label="Decrease">-</button><span data-a-selector="value">3</span><button aria-label="Increase">+</button></div>`;
    const r = parseCart(cap(activeCart(item({ controls: stepper }))));
    const it = r.data.active_items[0] as CartItem;
    expect(it.quantity).toBe(3);
    expect(it.quantity_control).toBe("stepper");
    expect(it.max_quantity).toBe(5);
    expect(r.meta.strategies["item.quantity"]).toBe("stepper");
  });

  it("reads the dropdown prompt label when no native control is present", () => {
    const prompt = `<span class="a-dropdown-prompt">Qty: 7</span>`;
    const r = parseCart(cap(activeCart(item({ controls: prompt }))));
    expect(r.data.active_items[0]?.quantity).toBe(7);
    expect(r.meta.strategies["item.quantity"]).toBe("label");
  });

  it("falls back to data-quantity", () => {
    const r = parseCart(cap(activeCart(item({}))));
    expect(r.data.active_items[0]?.quantity).toBe(2);
    expect(r.data.active_items[0]?.quantity_control).toBe("none");
    expect(r.meta.strategies["item.quantity"]).toBe("data-attr");
  });

  it("totals quantities across lines", () => {
    const r = parseCart(
      cap(activeCart(item({ id: ID1 }) + item({ id: ID2, asin: "B0FAKE0002", attrs: "" }), 2)),
    );
    expect(r.data.active_quantity_total).toBe(4);
  });
});

describe("parseCart: price and notices", () => {
  it("surfaces a price change notice with its amounts and a bare .sc-price", () => {
    const tail = `<li><span class="a-list-item"><div class="a-box a-alert-inline a-alert-inline-info" role="alert"><div class="a-box-inner a-alert-container"><div class="a-alert-content">The price of this item has changed from <span class="sc-price">$12.00</span> to <span class="sc-price">$15.50</span>.</div></div></div></span></li>`;
    const priceHtml = `<div class="sc-badge-price-to-pay"><p class="a-spacing-small"><span class="sc-price sc-white-space-nowrap">$1,015.50</span></p></div>`;
    const it = one(activeCart(item({ tail, priceHtml })));
    expect(it.price).toEqual({ amount: 1015.5, currency: "USD", raw: "$1,015.50" });
    expect(it.notices).toHaveLength(1);
    expect(it.notices[0]?.kind).toBe("price_change");
    expect(it.notices[0]?.amounts?.map((m) => m.amount)).toEqual([12, 15.5]);
  });

  it("falls back to the data-price attribute when no price element exists", () => {
    const r = parseCart(cap(activeCart(item({ priceHtml: "" }))));
    const it = r.data.active_items[0] as CartItem;
    expect(it.price).toEqual({ amount: 19.99, currency: "USD", raw: "19.99" });
    expect(r.meta.strategies["item.price"]).toBe("data-attr");
  });

  it("marks an unavailable item", () => {
    const tail = `<li><span class="a-list-item"><span data-csa-c-content-id="availability" class="a-size-small a-color-price sc-product-availability">Currently unavailable</span></span></li>`;
    const it = one(
      activeCart(
        item({ tail, attrs: 'data-outofstock="1" data-unavailable-item="1"', priceHtml: "" }),
      ),
    );
    expect(it.in_stock).toBe(false);
    expect(it.offer_unavailable).toBe(true);
    expect(it.stock_text).toBe("Currently unavailable");
  });

  it("turns an unknown unavailable message into a notice, not a detail", () => {
    const tail = `<li><span class="a-list-item">This item is no longer available</span></li>`;
    const it = one(activeCart(item({ tail })));
    expect(it.notices.map((n) => n.kind)).toEqual(["unavailable"]);
    expect(it.details).toEqual([]);
  });

  it("reports low stock as count and notice", () => {
    const tail = `<li><span class="a-list-item"><span data-csa-c-content-id="availability" class="a-size-small sc-product-availability"><span class="a-color-price sc-product-scarcity">Only 3 left in stock - order soon.</span></span></span></li>`;
    const it = one(activeCart(item({ tail })));
    expect(it.low_stock_count).toBe(3);
    expect(it.notices.map((n) => n.kind)).toEqual(["low_stock"]);
    expect(it.in_stock).toBe(true);
  });
});

describe("parseCart: identifiers and selectors fallbacks", () => {
  it("derives item_id from the element id", () => {
    const html = activeCart(item({}).replace(` data-itemid="${ID1}"`, ""));
    const r = parseCart(cap(html));
    expect(r.data.active_items[0]?.item_id).toBe(ID1);
    expect(r.meta.strategies["item.item_id"]).toBe("element-id");
    expect(r.meta.strategies["items"]).toBe("sc-list-item");
  });

  it("derives item_id from the action JSON, then from an input name", () => {
    const base = item({ controls: DELETE(ID1) }).replace(` data-itemid="${ID1}"`, "");
    const noId = base.replace(`id="sc-item-${ID1}"`, "");
    const r = parseCart(cap(activeCart(noId)));
    expect(r.data.active_items[0]?.item_id).toBe(ID1);
    expect(r.meta.strategies["item.item_id"]).toBe("action-json");

    const noJson = noId.replace(/data-sc-item-action='[^']*'/, "");
    const r2 = parseCart(cap(activeCart(noJson)));
    expect(r2.data.active_items[0]?.item_id).toBe(ID1);
    expect(r2.meta.strategies["item.item_id"]).toBe("input-name");
  });

  it("derives asin from the csa item id and the product link", () => {
    const noAsin = item({}).replace(' data-asin="B0FAKE0001"', "");
    const r = parseCart(cap(activeCart(noAsin)));
    expect(r.data.active_items[0]?.asin).toBe("B0FAKE0001");
    expect(r.meta.strategies["item.asin"]).toBe("csa-item-id");
    const noCsa = noAsin.replace(' data-csa-c-item-id="amzn1.asin.B0FAKE0001"', "");
    const r2 = parseCart(cap(activeCart(noCsa)));
    expect(r2.data.active_items[0]?.asin).toBe("B0FAKE0001");
    expect(r2.meta.strategies["item.asin"]).toBe("link");
  });

  it("falls back to the title link text and the data-producttitle attribute", () => {
    const noFull = item({}).replace(/<span class="a-truncate-full a-offscreen">[^<]*<\/span>/, "");
    const it = one(activeCart(noFull));
    expect(it.title).toBe("Fake Widget ...");
    const bare = item({})
      .replace(/<span class="a-truncate-full a-offscreen">[^<]*<\/span>/, "")
      .replace(/<span class="a-truncate-cut">[^<]*<\/span>/, "");
    expect(one(activeCart(bare)).title).toBe("Fallback title");
  });

  it("finds lines by list-body children when classes and ids are gone", () => {
    const html = `<div id=sc-page-content><div id=sc-active-cart><div class="sc-list-body"><div data-asin="B0FAKE0003" data-itemid="${ID3}" data-quantity="1"><span>Plain line</span></div></div></div></div>`;
    const r = parseCart(cap(html));
    expect(r.data.active_items[0]?.item_id).toBe(ID3);
    expect(r.meta.strategies["items"]).toBe("data-itemid");
    const html2 = html.replace(` data-itemid="${ID3}"`, "");
    const r2 = parseCart(cap(html2));
    expect(r2.meta.strategies["items"]).toBe("list-body");
    expect(r2.data.active_items).toHaveLength(0);
    expect(r2.meta.warnings.join("\n")).toContain("without item_id");
  });
});

describe("parseCart: saved for later, empty and hidden", () => {
  it("parses a saved-only cart", () => {
    const empty = `<div id=sc-page-content role=main><div id=sc-retail-cart-container><div id=sc-active-cart data-cart-total-item-count="0" data-name="Active Cart"><div class="a-cardui-body"><h3 class="sc-your-amazon-cart-is-empty">Your Amazon Cart is empty</h3><div class="sc-empty-cart" data-name="Empty Cart"><p>Check your Saved for later items below or <a href="/">continue shopping</a>.</p></div></div></div>${savedCart(item({ list: "saved", controls: '<span data-action="delete-saved"><input name="submit.delete-saved.' + ID1 + '" data-action="delete-saved" value="Delete" type="submit"></span><div data-action="move-to-cart"><input name="submit.move-to-cart.' + ID1 + '" data-action="move-to-cart" value="Move to cart" type="submit"></div>' }))}</div></div>`;
    const r = parseCart(cap(empty));
    expect(r.data.is_empty).toBe(true);
    expect(r.data.empty_message).toBe("Your Amazon Cart is empty");
    expect(r.data.active_count).toBe(0);
    expect(r.data.active_items).toEqual([]);
    expect(r.data.saved_count).toBe(1);
    expect(r.data.saved_declared_count).toBe(1);
    const it = r.data.saved_items[0] as CartItem;
    expect(it.list).toBe("saved");
    expect(it.item_id).toBe(ID1);
    expect(it.selected).toBeNull();
    expect(it.actions).toEqual(expect.arrayContaining(["delete-saved", "move-to-cart"]));
    expect(r.meta.strategies["is_empty"]).toBe("empty-marker");
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("classifies saved lines by container when data-itemtype is missing", () => {
    const noType = item({ list: "saved" }).replace(' data-itemtype="saved"', "");
    const r = parseCart(cap(`<div id=sc-page-content>${savedCart(noType)}</div>`));
    expect(r.data.saved_count).toBe(1);
    expect(r.data.active_count).toBe(0);
  });

  it("parses a completely empty cart", () => {
    const r = parseCart(
      cap(
        `<div id=sc-page-content><div id=sc-active-cart data-cart-total-item-count="0"><h3 class="sc-your-amazon-cart-is-empty">Your Amazon Cart is empty</h3><div class="sc-empty-cart" data-name="Empty Cart"></div></div></div>`,
      ),
    );
    expect(r.data.is_empty).toBe(true);
    expect(r.data.saved_items).toEqual([]);
    expect(r.data.active_quantity_total).toBe(0);
    expect(r.data.subtotal).toBeNull();
    expect(r.data.checkout_available).toBe(false);
  });

  it("falls back to the item-count attribute for emptiness", () => {
    const r = parseCart(
      cap(
        `<div id=sc-page-content><div id=sc-active-cart data-cart-total-item-count="0"></div></div>`,
      ),
    );
    expect(r.data.is_empty).toBe(true);
    expect(r.meta.strategies["is_empty"]).toBe("data-attr");
  });

  it("warns when the saved caption disagrees with the parsed lines", () => {
    const r = parseCart(
      cap(`<div id=sc-page-content>${savedCart(item({ list: "saved" }), 3)}</div>`),
    );
    expect(r.data.saved_declared_count).toBe(3);
    expect(r.meta.warnings.join("\n")).toContain("declares 3");
  });

  it("reads the declared saved count from the label when the attribute is missing", () => {
    const html = `<div id=sc-page-content><div id=sc-secondary-list><ul id=sc-secondary-list-tab><li>Saved for later (4 items)</li></ul><div id=sc-saved-cart></div></div></div>`;
    const r = parseCart(cap(html));
    expect(r.data.saved_declared_count).toBe(4);
    expect(r.meta.strategies["saved_declared_count"]).toBe("label");
  });

  it("skips hidden template rows and hidden skeletons", () => {
    const hiddenRow = item({ id: ID2, asin: "B0FAKE0002", title: "Hidden Template Row" }).replace(
      'class="a-row sc-list-item sc-list-item-border"',
      'class="a-row sc-list-item sc-list-item-border" data-rf-hidden="1"',
    );
    const skeleton = `<div id="sc-optimistic-cart-skeleton" data-rf-hidden="1"><h2>Skeleton Heading</h2>${item({ id: ID3, asin: "B0FAKE0003" })}</div>`;
    const r = parseCart(cap(activeCart(item({}) + hiddenRow + skeleton)));
    expect(r.data.active_items.map((i) => i.item_id)).toEqual([ID1]);
    expect(JSON.stringify(r)).not.toContain("Hidden Template Row");
    expect(JSON.stringify(r)).not.toContain("Skeleton Heading");
  });

  it("skips duplicate ids with a warning", () => {
    const r = parseCart(cap(activeCart(item({}) + item({}), 2)));
    expect(r.data.active_count).toBe(1);
    expect(r.meta.warnings.join("\n")).toContain("duplicate");
  });
});

describe("parseCart: page level", () => {
  it("reads the subtotal by id", () => {
    const sub = `<div class="sc-subtotal"><span id="sc-subtotal-label-activecart">Subtotal (3 items):</span> <span id="sc-subtotal-amount-activecart" class="a-size-medium sc-price"><span class="a-size-medium sc-price">$1,234.50</span></span></div>`;
    const r = parseCart(cap(activeCart(item({}), 1, sub)));
    expect(r.data.subtotal).toEqual({
      amount: 1234.5,
      currency: "USD",
      raw: "$1,234.50",
      item_count: 3,
    });
    expect(r.meta.strategies["subtotal"]).toBe("id");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("reads the subtotal by text anchor in the buy box", () => {
    const box = `<div id=sc-buy-box><div class="a-cardui-body"><span>Subtotal (1 item): <b>$19.99</b></span></div></div>`;
    const r = parseCart(cap(pc(activeInner(item({})), box)));
    expect(r.data.subtotal).toEqual({
      amount: 19.99,
      currency: "USD",
      raw: "$19.99",
      item_count: 1,
    });
    expect(r.meta.strategies["subtotal"]).toBe("text-anchor");
  });

  it("reports cart-level notices and checkout presence without reading checkout values", () => {
    const banner = `<div id="cart-important-message-box"><div class="a-box a-alert-inline">Some items changed since you added them</div></div>`;
    const buy = `<div id=sc-buy-box><div class="a-alert-content">Your order qualifies for FREE Shipping</div><input type="submit" name="proceedToRetailCheckout" value="SECRETCHECKOUTVALUE"></div>`;
    const r = parseCart(cap(pc(banner, activeInner(item({})), buy)));
    expect(r.data.checkout_available).toBe(true);
    expect(r.data.notices.map((n) => n.kind).sort()).toEqual(["free_shipping", "important"]);
    expect(JSON.stringify(r)).not.toContain("SECRETCHECKOUTVALUE");
  });

  it("does not report checkout when the control is hidden", () => {
    const buy = `<div id=sc-buy-box data-rf-hidden="1"><input type="submit" name="proceedToRetailCheckout"></div>`;
    const r = parseCart(cap(pc(activeInner(item({})), buy)));
    expect(r.data.checkout_available).toBe(false);
  });

  it("groups lines from separate carts", () => {
    const fresh = `<div id="sc-fresh-cart"><h2>Example Grocery Cart</h2><div class="sc-list-body">${item({ id: ID4, asin: "B0FAKE0004" })}</div></div>`;
    const r = parseCart(cap(pc(activeInner(item({}), 2), fresh)));
    const groups = r.data.active_items.map((i) => i.group);
    expect(groups).toEqual([null, "Example Grocery Cart"]);
    expect(r.data.groups).toEqual(["Example Grocery Cart"]);
  });

  it("throws layout_unrecognized when nothing cart-like is present", () => {
    expect(() => parseCart(cap("<div>Totally unrelated page</div>"))).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "layout_unrecognized" }),
      }),
    );
  });
});

describe("parseCart: lossless accounting", () => {
  it("emits an unknown promo block in other_sections", () => {
    const promo = `<div id="sc-new-promo"><h2>Fake Promo Heading</h2><p>Invented promo copy for tests</p></div>`;
    const capture = cap(pc(promo, activeInner(item({}))));
    const r = parseCart(capture);
    const sec = r.other_sections.find((s) => s.key === "sc-new-promo");
    expect(sec).toBeDefined();
    expect(sec?.heading).toBe("Fake Promo Heading");
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.data.active_count).toBe(1);
  });

  it("keeps an unknown line inside an item in its details", () => {
    const tail = `<li><span class="a-list-item">Invented mystery line for the cart</span></li>`;
    const r = parseCart(cap(activeCart(item({ tail }))));
    expect(r.data.active_items[0]?.details).toEqual(["Invented mystery line for the cart"]);
    expect(r.other_sections).toEqual([]);
  });

  it("meets the shared coverage helper", () => {
    const capture = cap(
      pc(activeInner(item({})), savedCart(item({ id: ID2, asin: "B0FAKE0002", list: "saved" }))),
    );
    const r = parseCart(capture);
    // Only chrome (header, footer) lies outside the main root, and chrome is excluded.
    expect(expectLosslessCoverage(r, capture, 0.99)).toBe(1);
  });
});
