import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import {
  classifyCharge,
  classifyStatus,
  findDates,
  parseCard,
  parseOrderDetails,
  READ_ONLY_LINK_RULES,
  readLinkKind,
  redactDigits,
  relativePath,
} from "../../src/pages/order-details.ts";
import type { OrderDetails } from "../../src/pages/order-details.ts";

const OID = "000-0000000-0000001";
const BULLETS = "\u2022\u2022\u2022\u2022";

// ---- synthetic page builder: Amazon's markup structure, invented content ----------------

interface ItemSpec {
  asin: string;
  title: string;
  seller?: string;
  price?: string;
  qty?: string;
  condition?: string;
  returnText?: string;
  extras?: Record<string, string>;
  buttons?: string[];
}

function item(i: ItemSpec): string {
  const href = `/dp/${i.asin}?ref_=ppx_hzod_title_dt_b_fed_asin_title_0_0`;
  const c = (name: string, inner = ""): string => `<div data-component="${name}">${inner}</div>`;
  const extra = (name: string): string =>
    c(
      name,
      i.extras?.[name] === undefined ? "" : `<span class="a-size-small">${i.extras[name]}</span>`,
    );
  const merchant =
    i.seller === undefined
      ? c("orderedMerchant")
      : c(
          "orderedMerchant",
          `<span class="a-size-small a-color-secondary">Sold by:<a class="a-link-normal" href="/gp/aag/main?ie=UTF8&seller=A0FAKESELL1">${i.seller}</a></span>`,
        );
  const price =
    i.price === undefined
      ? c("unitPrice")
      : c(
          "unitPrice",
          `<span class="a-price a-text-price" data-a-size="s"><span class="a-offscreen">${i.price}</span><span>${i.price}</span></span>`,
        );
  const buttons = (i.buttons ?? ["Buy it again"])
    .map(
      (b, n) =>
        `<span id="a-autoid-i${n}" class="a-button a-button-normal"><span class="a-button-inner"><a class="a-button-text" href="/gp/buyagain?ats=abc">${b}</a></span></span>`,
    )
    .join("");
  return `
  <div class="a-fixed-left-grid a-spacing-base"><div class="a-fixed-left-grid-inner">
    <div data-component="purchasedItemsLeftGrid"><div class="a-fixed-left-grid-col a-col-left">
      ${c("itemImage", `<div class="aok-relative"><a class="a-link-normal" href="${href}"><img src="https://images.example.com/placeholder.png"></a></div>`)}
    </div></div>
    <div data-component="purchasedItemsRightGrid"><div class="a-fixed-left-grid-col a-col-right">
      ${c("itemTitle", `<div class="a-row"><a class="a-link-normal" href="${href}">${i.title}</a></div>`)}
      ${extra("substitutionDetails")}
      ${merchant}
      ${c("itemCondition", i.condition === undefined ? "" : `<span>${i.condition}</span>`)}
      ${c("itemReturnEligibility", i.returnText === undefined ? "" : `<div class="a-row"><span class="a-size-small">${i.returnText}</span></div>`)}
      ${extra("serviceAppointmentStatus")}
      ${extra("associatedOrdersForService")}
      ${c("quantity", i.qty === undefined ? `<span class="a-size-small"></span>` : `<span class="a-size-small">${i.qty}</span>`)}
      ${price}
      ${extra("deliveryFrequency")}
      ${extra("healthBenefitAccountInformation")}
      ${extra("paidInInstallmentsInformation")}
      ${extra("customizedItemDetails")}
      ${extra("purchasedVariationDetails")}
      ${extra("giftcardsSender")}
      ${extra("giftCardShareableLink")}
      ${extra("giftMessage")}
      ${c("itemConnections", `<div class="a-row a-spacing-top-mini">${buttons}</div>`)}
      ${extra("giftCardDetails")}
    </div></div>
  </div></div>`;
}

interface ShipmentSpec {
  status?: string;
  detail?: string;
  help?: { label: string; text: string };
  items: ItemSpec[];
  buttons?: { label: string; href?: string }[];
}

function shipment(s: ShipmentSpec): string {
  const help =
    s.help === undefined
      ? ""
      : `<div class="a-row"><span class="a-declarative" data-action="a-popover" data-a-popover="${esc(JSON.stringify({ inlineContent: `<span>${s.help.text}</span>` }))}"><a class="a-popover-trigger a-declarative" href="javascript:void(0)" role="button"><span>${s.help.label}</span><i class="a-icon a-icon-popover"></i></a></span></div>`;
  const status =
    s.status === undefined
      ? ""
      : `<div data-component="shipmentStatus"><div id="shipment-top-row" class="a-row"><div class="a-section">
          <div class="a-row"><h4 class="a-color-base od-status-message"><span>${s.status}</span></h4></div>
          ${s.detail === undefined ? "" : `<div class="a-row od-status-message"><span>${s.detail}</span></div>`}
          ${help}
        </div></div></div>`;
  const buttons = (s.buttons ?? [])
    .map(
      (b, n) =>
        `<span id="a-autoid-s${n}" class="a-button a-button-normal"><span class="a-button-inner"><a class="a-button-text" href="${b.href ?? "/x"}">${b.label}</a></span></span>`,
    )
    .join("");
  return `
  <div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
    <div data-component="shipmentsLeftGrid"><div class="a-fixed-right-grid-col a-col-left">
      ${status}
      <div data-component="purchasedItems"><div class="a-row a-spacing-top-base">${s.items.map(item).join("")}</div></div>
    </div></div>
    <div data-component="shipmentsRightGrid"><div class="a-fixed-right-grid-col a-col-right">
      <div data-component="shipmentConnections"><div class="a-button-stack a-spacing-mini">${buttons}</div></div>
    </div></div>
  </div></div></div></div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function row(label: string, value: string, popover?: string): string {
  const lab =
    popover === undefined
      ? `<span class="a-size-base"><span>${label}</span></span>`
      : `<span class="a-declarative" data-action="a-popover" data-a-popover="${esc(JSON.stringify({ inlineContent: popover }))}"><a class="a-popover-trigger a-declarative" href="javascript:void(0)" role="button"><span class="a-size-base a-text-bold"><span>${label}</span></span></a></span>`;
  return `<li><span class="a-list-item"><div class="a-row od-line-item-row">
    <div class="a-column a-span7 od-line-item-row-label">${lab}</div>
    <div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">${value}</span></div>
  </div></span></li>`;
}

interface PageSpec {
  orderId?: string;
  placed?: string;
  addressLines?: string[];
  payment?: string[];
  rewardsLine?: string;
  totals?: string[];
  shipments?: ShipmentSpec[];
  cancelledText?: string;
  brand?: string;
  po?: string;
  extraBlock?: string;
  hiddenBlock?: string;
  invoiceHref?: string;
  afterMain?: string;
}

function paymentWidget(lines: string[], extra = ""): string {
  const instruments = lines
    .map(
      (l) => `<div aria-label="payment method"><div data-testid="payment-instrument">
        <div data-testid="payment-instrument-text-wrapper"><span data-testid="payment-instrument-message">${l}</span></div>
        <div data-testid="payment-instrument-feature-detail"><div data-testid="paragraph"><span data-testid="paragraph-fragment-0">Example benefit line</span></div></div>
      </div>${extra}</div>`,
    )
    .join("");
  return `<div data-component="viewPaymentPlanSummaryWidget"><h5 class="a-spacing-micro">Payment method</h5><div class="a-section"><div id="__next">
    <div aria-label="payment method list">${instruments}</div>
    <div data-testid="viewTransactionsButton"><button aria-label="View related transactions" role="button" type="button"><div data-testid="text">View related transactions</div></button></div>
  </div></div></div>`;
}

function page(spec: PageSpec = {}): string {
  const id = spec.orderId ?? OID;
  const placed = spec.placed ?? "March 3, 2026";
  const addr = (
    spec.addressLines ?? [
      "Alex Example",
      "1 Example Way<br>Exampleville, EX 00000",
      "United States",
    ]
  )
    .map((l) => `<li><span class="a-list-item">${l}</span></li>`)
    .join("");
  const totals = (
    spec.totals ?? [
      row("Item(s) Subtotal:", "$20.00"),
      row("Shipping &amp; Handling:", "$0.00"),
      row("Total before tax:", "$20.00"),
      row("Estimated tax to be collected:", "$1.00"),
      row("Grand Total:", "$21.00"),
    ]
  ).join("");
  const shipments = (
    spec.shipments ?? [
      {
        status: "Delivered March 4",
        detail: "Your package was left near the front door or porch.",
        items: [
          {
            asin: "B0FAKE0001",
            title: "Fake Widget Deluxe",
            seller: "Example Seller",
            price: "$20.00",
            returnText: "Return or replace items: Eligible through May 31, 2026",
          },
        ],
        buttons: [
          {
            label: "Track package",
            href: `/progress-tracker/package?orderId=${id}&_encoding=UTF8&shipmentId=FAKESHIP1&packageIndex=0`,
          },
          { label: "Return or replace items", href: `/spr/returns/cart?orderId=${id}&ref_=ppx_x` },
          { label: "Share gift receipt", href: `/gcx/-/ty/gr/${id}/shipment` },
          { label: "Leave seller feedback", href: `/hz/feedback?orderID=${id}` },
          {
            label: "Write a product review",
            href: "/review/review-your-purchases?asins=B0FAKE0001",
          },
        ],
      },
    ]
  )
    .map(shipment)
    .join("");
  return `<!DOCTYPE html><html><head><title>t</title></head><body>
  <div id="a-page">
    <header id="navbar-main"><div id="navbar">Navigation chrome text</div></header>
    <div class="a-container a-color-alternate-background" role="main">
      <div id="orderDetails" class="a-section dynamic-width">
        <div class="a-cardui-deck">
          <div class="a-teaser-describedby-collapsed a-hidden" data-rf-hidden="1">Brief content visible, double tap to read full content.</div>
          <div class="a-cardui"><div class="a-cardui-body">
            <div data-component="default">
              <div data-component="debugBanner"></div><div data-component="aapiDebug"></div>
              <div data-component="breadcrumb"><ul class="a-unordered-list a-horizontal od-breadcrumbs"><li class="od-breadcrumbs__crumb"><span class="a-list-item"><a class="a-link-normal" href="/gp/css/homepage.html/ref=x">Your Account</a></span></li><li class="od-breadcrumbs__crumb od-breadcrumbs__crumb--divider"><span class="a-list-item">\u203a</span></li><li class="od-breadcrumbs__crumb od-breadcrumbs__crumb--current"><span class="a-list-item"><span class="a-color-state">Order Details</span></span></li></ul></div>
              <div data-component="alerts"></div>
              <div data-component="title"><div data-component="titleLeftGrid"><div data-component="orderDetailsTitle"><h1>Order Details</h1></div></div><div data-component="titleRightGrid"><div data-component="brandLogo">${spec.brand === undefined ? "" : `<img alt="${spec.brand}" src="https://images.example.com/placeholder.png">`}</div></div></div>
              <div data-component="briefOrderInfoInvoice"><div class="a-section"><div class="a-row">
                <div data-component="briefOrderInfoInvoiceLeftGrid">
                  <div data-component="poNumber">${spec.po === undefined ? "" : `<span>PO number: ${spec.po}</span>`}</div>
                  <div data-component="orderDateLabel"><span>Order placed</span></div>
                  <div data-component="orderDate"><span>${placed}<i class="a-icon a-icon-text-separator" role="presentation"></i></span></div>
                  <div data-component="orderIdLabel"><span>Order #</span></div>
                  <div data-component="orderId"><span>${id}</span></div>
                  <div data-component="sharedOrderBuyer"></div>
                </div>
                <div data-component="briefOrderInfoInvoiceRightGrid"><div data-component="orderInvoice"><span id="a-autoid-0" class="a-button a-button-normal"><span class="a-button-inner"><a id="a-autoid-0-announce" class="a-button-text" href="${spec.invoiceHref ?? `/gp/css/summary/print.html?orderID=${id}&ref_=ppx_x`}">View invoice</a></span></span></div></div>
              </div></div></div>
              <div data-component="orderSummary"><div class="a-box-group"><div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
                <div class="a-fixed-right-grid-col a-col-left"><div class="a-row">
                  <div class="a-column a-span5"><div data-component="shippingAddress"><h5 class="a-spacing-micro">Ship to</h5><ul class="a-unordered-list a-nostyle a-vertical">${addr}</ul></div></div>
                  <div class="a-column a-span7 a-span-last"><div class="a-section a-spacing-base">${paymentWidget(spec.payment ?? [`Example Visa ${BULLETS} 0000`])}${spec.rewardsLine ?? ""}</div></div>
                </div></div>
                <div id="od-subtotals" class="a-fixed-right-grid-col a-col-right">
                  <div data-component="chargeSummary"><div class="a-column a-span12"><div class="a-row a-spacing-small"><h5>Order Summary</h5></div><ul class="a-unordered-list a-nostyle a-vertical">${totals}</ul></div></div>
                  <div data-component="tips"></div>
                </div>
              </div></div></div></div></div></div>
              <div data-component="orderCard"><div data-component="shipments"><div class="a-box-group">${shipments}</div></div></div>
              ${spec.extraBlock ?? ""}
              ${spec.hiddenBlock ?? ""}
            </div>
            <div data-component="cancelled">${spec.cancelledText === undefined ? "" : `<span>${spec.cancelledText}</span>`}</div>
          </div></div>
        </div>
      </div>
    </div>
    <div id="navFooter" role="contentinfo">Footer chrome</div>
  </div>${spec.afterMain ?? ""}</body></html>`;
}

function capture(html: string, extra: Partial<Capture> = {}): Capture {
  return {
    kind: "order_details",
    url: `https://www.example.com/gp/your-account/order-details?orderID=${OID}`,
    final_url: `https://www.example.com/gp/your-account/order-details?orderID=${OID}`,
    captured_at: "2000-01-01T00:00:00.000Z",
    html,
    ...extra,
  };
}

function parse(spec: PageSpec = {}) {
  return parseOrderDetails(capture(page(spec)));
}

// ---- tests -------------------------------------------------------------------------------

describe("parseOrderDetails: a single delivered shipment", () => {
  const r = parse();
  const d = r.data;

  it("reads the order header", () => {
    expect(d.order_id).toBe(OID);
    expect(d.placed).toEqual({ raw: "March 3, 2026", iso: "2026-03-03" });
    expect(r.meta.strategies["order_id"]).toBe("data-component");
    expect(r.meta.strategies["placed"]).toBe("data-component");
  });

  it("reads ship_to with the <br> split into separate lines", () => {
    expect(d.ship_to).toMatchObject({
      heading: "Ship to",
      name: "Alex Example",
      address_lines: ["1 Example Way", "Exampleville, EX 00000"],
      country: "United States",
    });
  });

  it("reads the payment instrument as brand plus last four only", () => {
    expect(d.payment.card_brand).toBe("Visa");
    expect(d.payment.last4).toBe("0000");
    expect(d.payment.methods).toHaveLength(1);
    expect(d.payment.methods[0]).toMatchObject({
      type: "card",
      card_name: "Example Visa",
      details: ["Example benefit line"],
    });
    expect(d.payment.actions).toEqual(["View related transactions"]);
  });

  it("reads totals as ordered typed lines", () => {
    expect(d.totals.map((t) => [t.label, t.type, t.amount?.amount])).toEqual([
      ["Item(s) Subtotal", "items_subtotal", 20],
      ["Shipping & Handling", "shipping", 0],
      ["Total before tax", "total_before_tax", 20],
      ["Estimated tax to be collected", "tax", 1],
      ["Grand Total", "grand_total", 21],
    ]);
  });

  it("reads the shipment status, date, tracking and the item", () => {
    expect(d.shipments).toHaveLength(1);
    const s = d.shipments[0];
    expect(s?.status).toMatchObject({
      raw: "Delivered March 4",
      kind: "delivered",
      detail: "Your package was left near the front door or porch.",
      date: { raw: "March 4", iso: "2026-03-04", year_inferred: true },
    });
    expect(s?.tracking?.path).toBe(
      `/progress-tracker/package?orderId=${OID}&shipmentId=FAKESHIP1&packageIndex=0`,
    );
    const it = s?.items[0];
    expect(it).toMatchObject({
      asin: "B0FAKE0001",
      title: "Fake Widget Deluxe",
      url_path: "/dp/B0FAKE0001",
      quantity: 1,
      seller: "Example Seller",
      seller_id: "A0FAKESELL1",
      price: { amount: 20, currency: "USD", raw: "$20.00" },
    });
    expect(it?.return_window).toEqual({
      text: "Return or replace items: Eligible through May 31, 2026",
      eligible: true,
      through: { raw: "May 31, 2026", iso: "2026-05-31" },
    });
  });

  it("emits read-only links by allowlist and mutating buttons as labels without hrefs", () => {
    const s = d.shipments[0];
    expect(s?.links.map((l) => [l.label, l.kind])).toEqual([["Track package", "tracking"]]);
    expect(s?.actions.map((a) => [a.label, a.intent])).toEqual([
      ["Return or replace items", "return"],
      ["Share gift receipt", "gift_receipt"],
      ["Leave seller feedback", "feedback"],
      ["Write a product review", "review"],
    ]);
    expect(s?.items[0]?.actions).toEqual([{ label: "Buy it again", intent: "buy_again" }]);
    expect(d.links).toEqual([
      { label: "View invoice", kind: "invoice", path: `/gp/css/summary/print.html?orderID=${OID}` },
    ]);
    const json = JSON.stringify(d);
    for (const bad of ["/spr/returns/cart", "/review/", "/hz/feedback", "/gcx/", "/gp/buyagain"]) {
      expect(json).not.toContain(bad);
    }
  });

  it("does not double-count the offscreen and visible price", () => {
    expect(d.shipments[0]?.items[0]?.price?.amount).toBe(20);
    expect(JSON.stringify(r.other_sections)).not.toContain("$20.00");
  });

  it("accounts for everything it read: nothing left over, chrome excluded", () => {
    expect(r.other_sections).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.meta.warnings).toEqual([]);
    expect(d.order_types).toEqual([]);
    expect(d.status).toEqual({
      summary: "Delivered March 4",
      kinds: ["delivered"],
    });
    expect(d.returns_and_refunds).toEqual([]);
  });

  it("is JSON-serializable and free of HTML", () => {
    const json = JSON.stringify(r);
    expect(JSON.parse(json)).toEqual(r);
    expect(json).not.toMatch(/<\/?(div|span|a)\b/);
  });
});

describe("parseOrderDetails: multi-shipment order with a refund", () => {
  const popover = `<div class="a-row od-line-item-row"><div class="a-column a-span9 od-line-item-row-label"><span class="a-size-base"><span>Item(s) refund</span></span></div><div class="a-column a-span3 od-line-item-row-content"><span class="a-size-base">$9.50</span></div></div><div class="a-row od-line-item-row"><div class="a-column a-span9 od-line-item-row-label"><span>Refund Total</span></div><div class="a-column a-span3 od-line-item-row-content"><span>$9.50</span></div></div>`;
  const r = parse({
    shipments: [
      {
        status: "Delivered March 4",
        items: [
          {
            asin: "B0FAKE0001",
            title: "Fake Widget One",
            seller: "Example Seller",
            price: "$10.00",
          },
          {
            asin: "B0FAKE0002",
            title: "Fake Widget Two",
            seller: "Example Seller",
            price: "$5.00",
            qty: "2",
          },
        ],
      },
      {
        status: "Refunded",
        detail: "Your return is in transit. Your refund of $9.50 has been issued on March 8.",
        help: {
          label: "When will I get my refund?",
          text: "A refund will appear on your statement within 7 days.",
        },
        items: [
          {
            asin: "B0FAKE0003",
            title: "Fake Widget Three",
            seller: "Other Example",
            price: "$9.50",
          },
        ],
        buttons: [
          {
            label: "View return/refund status",
            href: `/spr/returns/prep?ingress=yo&orderId=${OID}&contractId=FAKECONTRACT&rmaId=FAKERMA1`,
          },
          { label: "Return or replace items", href: "/spr/returns/prep?ingress=yo" },
        ],
      },
    ],
    totals: [
      row("Item(s) Subtotal:", "$20.00"),
      row("Grand Total:", "$21.00"),
      row("Refund Total", "$9.50", popover),
    ],
  });

  it("keeps shipment order and per-shipment items", () => {
    expect(r.data.shipments.map((s) => s.items.map((i) => i.asin))).toEqual([
      ["B0FAKE0001", "B0FAKE0002"],
      ["B0FAKE0003"],
    ]);
    expect(r.data.status.kinds).toEqual(["delivered", "refunded"]);
    expect(r.data.shipments[0]?.items[1]?.quantity).toBe(2);
  });

  it("types the refund total line and parses its popover breakdown", () => {
    const line = r.data.totals.find((t) => t.type === "refund_total");
    expect(line?.amount?.amount).toBe(9.5);
    expect(line?.breakdown?.map((b) => [b.label, b.type, b.amount?.amount])).toEqual([
      ["Item(s) refund", "refund", 9.5],
    ]);
  });

  it("builds returns_and_refunds from the shipment status and the order refund line", () => {
    expect(r.data.returns_and_refunds).toHaveLength(2);
    const [ship, order] = r.data.returns_and_refunds;
    expect(ship).toMatchObject({
      scope: "shipment",
      shipment_index: 1,
      status: "Refunded",
      asins: ["B0FAKE0003"],
      amounts: [{ amount: 9.5 }],
      help_text: "A refund will appear on your statement within 7 days.",
      status_path: `/spr/returns/prep?ingress=yo&orderId=${OID}&contractId=FAKECONTRACT&rmaId=FAKERMA1`,
    });
    expect(ship?.dates[0]).toMatchObject({ raw: "March 8", iso: "2026-03-08" });
    expect(order).toMatchObject({ scope: "order", refund_total: { amount: 9.5 } });
  });

  it("inherits the refunded state onto the item and keeps the help link label", () => {
    const refunded = r.data.shipments[1];
    expect(refunded?.items[0]?.status).toBe("Refunded");
    expect(refunded?.status?.help_label).toBe("When will I get my refund?");
    expect(r.data.shipments[0]?.items[0]?.status).toBeUndefined();
  });

  it("exposes the return-status page as a read-only link only when an rmaId is present", () => {
    const links = refundedLinks(r.data);
    expect(links).toEqual([["View return/refund status", "return_status"]]);
    expect(refundedActions(r.data)).toEqual(["Return or replace items"]);
  });
});

function refundedLinks(d: OrderDetails): [string, string][] {
  return (d.shipments[1]?.links ?? []).map((l) => [l.label, l.kind]);
}
function refundedActions(d: OrderDetails): string[] {
  return (d.shipments[1]?.actions ?? []).map((a) => a.label);
}

describe("parseOrderDetails: cancelled item", () => {
  const r = parse({
    shipments: [
      {
        status: "Cancelled",
        detail: "This item was cancelled on March 5. You were not charged.",
        items: [{ asin: "B0FAKE0004", title: "Fake Cancelled Widget", price: "$12.00" }],
        buttons: [
          {
            label: "Cancel items",
            href: `/progress-tracker/package/preship/cancel-items?orderID=${OID}`,
          },
        ],
      },
    ],
    cancelledText: "Your order was cancelled.",
  });

  it("classifies the shipment and inherits the item status", () => {
    expect(r.data.shipments[0]?.status?.kind).toBe("cancelled");
    expect(r.data.shipments[0]?.items[0]?.status).toBe("Cancelled");
    expect(r.data.cancellation).toBe("Your order was cancelled.");
  });

  it("records the cancellation in returns_and_refunds and never links the cancel flow", () => {
    expect(r.data.returns_and_refunds.map((e) => [e.scope, e.status])).toEqual([
      ["shipment", "Cancelled"],
      ["order", "Cancelled"],
    ]);
    expect(r.data.shipments[0]?.links).toEqual([]);
    expect(r.data.shipments[0]?.actions).toEqual([{ label: "Cancel items", intent: "cancel" }]);
    expect(JSON.stringify(r.data)).not.toContain("cancel-items");
  });
});

describe("parseOrderDetails: promotions, gift card, rewards and tax lines", () => {
  const r = parse({
    totals: [
      row("Item(s) Subtotal:", "$50.00"),
      row("Shipping &amp; Handling:", "$6.00"),
      row("Free Shipping:", "-$6.00"),
      row("Subscribe &amp; Save:", "-$2.50"),
      row("Promotion Applied:", "-$1.00"),
      row("Total before tax:", "$46.50"),
      row("Estimated tax to be collected:", "$3.00"),
      row("Gift Card Amount:", "-$10.00"),
      row("Rewards Points:", "-$5.00"),
      row("Grand Total:", "$34.50"),
      row("Shipping Fee Waiver:", "FREE"),
    ],
    payment: ["Example Gift Card", `Example Visa ${BULLETS} 0000`],
    rewardsLine: "",
  });

  it("types every line", () => {
    expect(r.data.totals.map((t) => t.type)).toEqual([
      "items_subtotal",
      "shipping",
      "promotion",
      "promotion",
      "promotion",
      "total_before_tax",
      "tax",
      "gift_card",
      "rewards",
      "grand_total",
      "shipping",
    ]);
    expect(r.data.totals[2]?.amount?.amount).toBe(-6);
    expect(r.data.totals[7]?.amount?.amount).toBe(-10);
  });

  it("keeps a non-money value as raw text with no amount", () => {
    const last = r.data.totals[r.data.totals.length - 1];
    expect(last?.raw).toBe("FREE");
    expect(last?.amount).toBeUndefined();
  });

  it("lists gift card and card instruments, brand/last4 only from the card", () => {
    expect(r.data.payment.methods.map((m) => m.type)).toEqual(["gift_card", "card"]);
    expect(r.data.payment.methods[0]?.last4).toBeUndefined();
    expect(r.data.payment.last4).toBe("0000");
  });
});

describe("parseOrderDetails: card digits can never leak", () => {
  const PAN = "4111111111111111";

  it("reduces a full number in the payment line to its last four", () => {
    const r = parse({ payment: [`Example Visa ${PAN}`] });
    expect(r.data.payment.last4).toBe("1111");
    expect(JSON.stringify(r)).not.toContain(PAN);
    expect(JSON.stringify(r.data.payment)).not.toMatch(/\d{5,}/);
  });

  it("handles spaced, dashed and 'ending in' forms", () => {
    expect(parseCard("Example Visa ending in 0000")).toMatchObject({
      last4: "0000",
      card_brand: "Visa",
    });
    expect(parseCard("Example Mastercard 5555-5555-5555-4444").last4).toBe("4444");
    expect(parseCard("Example American Express 3782 822463 10005").last4).toBe("0005");
    expect(parseCard("Example Visa ending in 41111111").last4).toBeUndefined();
    expect(parseCard("Example Discover xxxx 1234")).toMatchObject({
      last4: "1234",
      card_brand: "Discover",
    });
  });

  it("last4 is always exactly four digits or absent, whatever the input", () => {
    const inputs = [
      `Visa ${BULLETS} 0000`,
      "Visa ending in 12",
      "Visa 123456789",
      "Visa 1234567890123456789012",
      "Visa ending in 0000000000",
      "",
      "Gift Card Balance",
      "Example Visa ending in 0000 and 99999",
    ];
    for (const raw of inputs) {
      const l = parseCard(raw).last4;
      expect(l === undefined || /^\d{4}$/.test(l)).toBe(true);
    }
  });

  it("redacts long digit runs in free payment text but leaves money alone", () => {
    expect(redactDigits("pay 123456789 now")).toBe("pay [redacted] now");
    expect(redactDigits("$12345.67 applied")).toBe("$12345.67 applied");
    expect(redactDigits(`${BULLETS} 0000`)).toBe(`${BULLETS} 0000`);
  });

  it("redacts digits in feature detail lines too", () => {
    const r = parseOrderDetails(
      capture(page().replace("Example benefit line", "Card 4111 1111 1111 1111 example")),
    );
    const json = JSON.stringify(r);
    expect(json).not.toContain("4111 1111 1111 1111");
    expect(JSON.stringify(r.data.payment)).not.toMatch(/\d{5,}/);
  });
});

describe("parseOrderDetails: order type markers, gift info and extras", () => {
  const r = parse({
    brand: "Example Fresh Market",
    po: "PO-0000",
    shipments: [
      {
        status: "Arriving Tuesday, March 18",
        items: [
          {
            asin: "B0FAKE0005",
            title: "Fake Subscribed Widget",
            seller: "Example Seller",
            price: "$8.00",
            condition: "Condition: Used - Like New",
            extras: {
              deliveryFrequency: "Auto-delivered: Example cadence two",
              purchasedVariationDetails: "Color: Fake Blue",
              giftMessage: "Happy example day",
              giftcardsSender: "From: Alex Example",
              giftCardDetails: "Claim code ABCD-EFGHIJ-KLMN",
              giftCardShareableLink: "Share link",
              substitutionDetails: "Substituted for Fake Widget Original",
            },
          },
        ],
      },
    ],
  });

  it("detects markers", () => {
    expect(r.data.order_types).toEqual(["subscribe_and_save", "gift", "business"]);
    expect(r.data.brand).toBe("Example Fresh Market");
    expect(r.data.po_number).toBe("PO-0000");
  });

  it("keeps item extras and gift info, redacting claim codes and never a share href", () => {
    const it = r.data.shipments[0]?.items[0];
    expect(it?.condition).toBe("Used - Like New");
    expect(it?.extras).toMatchObject({
      delivery_frequency: "Auto-delivered: Example cadence two",
      variation: "Color: Fake Blue",
      substitution: "Substituted for Fake Widget Original",
    });
    expect(it?.gift).toEqual({
      message: "Happy example day",
      sender: "From: Alex Example",
      details: "Claim code [redacted]",
      shareable_link_shown: true,
    });
    expect(JSON.stringify(r)).not.toContain("ABCD-EFGHIJ-KLMN");
  });

  it("parses an arrival date with a weekday and no year via the order date", () => {
    expect(r.data.shipments[0]?.status).toMatchObject({
      kind: "arriving",
      date: { raw: "March 18", iso: "2026-03-18", year_inferred: true },
    });
  });

  it("detects digital orders from the id prefix", () => {
    const d = parse({ orderId: "D01-0000000-0000001" }).data;
    expect(d.order_types).toContain("digital");
  });
});

describe("parseOrderDetails: quantity strategies", () => {
  it("falls back to the image overlay, then a Qty: text anchor, then 1", () => {
    const base = page();
    const overlay = base
      .replace(
        /<div data-component="quantity">.*?<\/div>/s,
        `<div data-component="quantity"></div>`,
      )
      .replace(
        `<div data-component="itemImage">`,
        `<div data-component="itemImage"><span class="od-item-view-qty"><span>3</span></span>`,
      );
    const a = parseOrderDetails(capture(overlay));
    expect(a.data.shipments[0]?.items[0]?.quantity).toBe(3);
    expect(a.meta.strategies["shipments.quantity"]).toBe("class");

    const anchor = base
      .replace(
        /<div data-component="quantity">.*?<\/div>/s,
        `<div data-component="quantity"></div>`,
      )
      .replace(
        `<div data-component="itemCondition">`,
        `<div data-component="itemCondition"><span>Qty: 4</span>`,
      );
    expect(parseOrderDetails(capture(anchor)).data.shipments[0]?.items[0]?.quantity).toBe(4);

    const none = base.replace(
      /<div data-component="quantity">.*?<\/div>/s,
      `<div data-component="quantity"></div>`,
    );
    expect(parseOrderDetails(capture(none)).data.shipments[0]?.items[0]?.quantity).toBe(1);
  });
});

describe("parseOrderDetails: strategy fallbacks", () => {
  it("order id from the label text, then from the URL", () => {
    const noId = page().replace(
      /<div data-component="orderId">.*?<\/div>/s,
      `<div data-component="orderId"></div>`,
    );
    const withLabel = noId.replace(
      `<div data-component="orderIdLabel"><span>Order #</span></div>`,
      `<div data-component="orderIdLabel"><span>Order # ${OID}</span></div>`,
    );
    const a = parseOrderDetails(capture(withLabel));
    expect(a.data.order_id).toBe(OID);
    expect(a.meta.strategies["order_id"]).toBe("text-anchor");

    const b = parseOrderDetails(capture(noId));
    expect(b.data.order_id).toBe(OID);
    expect(b.meta.strategies["order_id"]).toBe("url");
  });

  it("placed date from the 'Order placed' text anchor", () => {
    const html = page().replace(`data-component="orderDate"`, `data-component="renamedDate"`);
    const r = parseOrderDetails(capture(html));
    expect(r.data.placed?.iso).toBe("2026-03-03");
    expect(r.meta.strategies["placed"]).toBe("text-anchor");
  });

  it("ship_to by heading label when the component is renamed", () => {
    const html = page().replace(`data-component="shippingAddress"`, `data-component="shipToBox"`);
    const r = parseOrderDetails(capture(html));
    expect(r.data.ship_to?.name).toBe("Alex Example");
    expect(r.meta.strategies["ship_to"]).toBe("label");
  });

  it("payment by 'Payment method' heading when the widget component is renamed", () => {
    const html = page().replace(
      `data-component="viewPaymentPlanSummaryWidget"`,
      `data-component="somethingElse"`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.data.payment.last4).toBe("0000");
    expect(["aria-label", "label"]).toContain(r.meta.strategies["payment"]);
  });

  it("totals from #od-subtotals rows when chargeSummary is renamed", () => {
    const html = page().replace(`data-component="chargeSummary"`, `data-component="other"`);
    const r = parseOrderDetails(capture(html));
    expect(r.data.totals.at(-1)).toMatchObject({ type: "grand_total" });
    expect(r.meta.strategies["totals"]).toBe("id");
  });

  it("legacy .shipment box layout", () => {
    const legacy = `<div class="a-box shipment"><div class="a-box-inner">
      <div class="a-row shipment-top-row"><span class="a-size-medium a-text-bold">Delivered Mar 4</span></div>
      <div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
        <div class="a-fixed-left-grid-col a-col-left"><a href="/dp/B0FAKE0006"><img src="https://images.example.com/placeholder.png"></a></div>
        <div class="a-fixed-left-grid-col a-col-right">
          <div class="a-row"><a class="a-link-normal" href="/gp/product/B0FAKE0006?ref_=x">Fake Legacy Widget</a></div>
          <div class="a-row"><span class="a-size-small a-color-secondary">Sold by: Example Seller</span></div>
          <div class="a-row"><span class="a-size-small a-color-price">$7.00</span></div>
        </div>
      </div></div></div></div>`;
    const html = page().replace(
      /<div data-component="orderCard">.*?<div data-component="cancelled">/s,
      `<div data-component="orderCard">${legacy}</div></div><div data-component="cancelled">`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.meta.strategies["shipments"]).toBe("class");
    expect(r.data.shipments[0]?.items[0]).toMatchObject({
      asin: "B0FAKE0006",
      title: "Fake Legacy Widget",
      price: { amount: 7 },
    });
    expect(r.data.shipments[0]?.status?.kind).toBe("delivered");
  });
});

describe("parseOrderDetails: hidden content and lossless accounting", () => {
  it("skips elements marked hidden, including a fake shipment and a template", () => {
    const hidden = `<div data-rf-hidden="1"><div data-component="shipments"><div class="a-box">${item({ asin: "B0FAKE0099", title: "Hidden Widget", price: "$99.00" })}</div></div></div><template><div>Template Widget</div></template>`;
    const r = parse({ hiddenBlock: hidden });
    const json = JSON.stringify(r);
    expect(json).not.toContain("Hidden Widget");
    expect(json).not.toContain("Template Widget");
    expect(json).not.toContain("B0FAKE0099");
    expect(r.data.shipments).toHaveLength(1);
  });

  it("returns an unknown visible block in other_sections and counts it", () => {
    const r = parse({
      extraBlock: `<div id="mysteryBlock" data-component="mystery"><h3>Mystery Heading</h3><p>Totally unknown fake content</p></div>`,
    });
    expect(r.other_sections).toHaveLength(1);
    expect(r.other_sections[0]?.text).toContain("Totally unknown fake content");
    expect(r.other_sections[0]?.heading).toBe("Mystery Heading");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("keeps a recommendation carousel out of the typed data", () => {
    const r = parse({
      extraBlock: `<div data-component="personalization"><div class="a-carousel-container"><h3>Products related to your order</h3><a href="/dp/B0FAKE0888">Fake Sponsored Thing</a></div></div>`,
    });
    expect(r.data.shipments).toHaveLength(1);
    expect(r.other_sections.map((s) => s.text).join(" ")).toContain("Fake Sponsored Thing");
  });

  it("collects unclaimed buttons as labels only (and leaves the carousel alone)", () => {
    const r = parse({
      extraBlock: `<div data-component="changeShippingAddressConnection"><span class="a-button"><span class="a-button-inner"><button type="button" class="a-button-text">Change shipping address</button></span></span></div>
      <div data-component="personalization"><div class="a-carousel-container"><span class="a-button"><a class="a-button-text" href="/x">Next page</a></span></div></div>`,
    });
    expect(r.data.actions).toEqual([{ label: "Change shipping address", intent: "other" }]);
  });
});

describe("parseOrderDetails: remaining fallbacks", () => {
  it("shipments by text-anchor when no known shipment structure exists", () => {
    const html = page().replace(
      /<div data-component="orderCard">.*?<div data-component="cancelled">/s,
      `<div data-component="orderCard"><div class="a-row"><a class="a-link-normal" href="/dp/B0FAKE0007?ref_=x">Fake Anchor Widget</a></div></div></div><div data-component="cancelled">`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.meta.strategies["shipments"]).toBe("text-anchor");
    expect(r.data.shipments[0]?.items.map((i) => [i.asin, i.title])).toEqual([
      ["B0FAKE0007", "Fake Anchor Widget"],
    ]);
  });

  it("totals by text-anchor when neither chargeSummary nor #od-subtotals exists", () => {
    const html = page()
      .replace(`data-component="chargeSummary"`, `data-component="other"`)
      .replace(`id="od-subtotals"`, `id="other-subtotals"`);
    const r = parseOrderDetails(capture(html));
    expect(r.meta.strategies["totals"]).toBe("text-anchor");
    expect(r.data.totals.at(-1)?.type).toBe("grand_total");
  });

  it("payment by 'Payment method' heading with a plain text block", () => {
    const html = page().replace(
      /<div data-component="viewPaymentPlanSummaryWidget">.*?<\/div><\/div><\/div>\s*<\/div>/s,
      `<div class="a-section"><h5>Payment method</h5><div><span>Example Visa ending in 0000</span></div><div><span>Fake extra payment line</span></div></div>`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.meta.strategies["payment"]).toBe("label");
    expect(r.data.payment).toMatchObject({ last4: "0000", card_brand: "Visa" });
    expect(r.data.payment.other_lines).toEqual(["Fake extra payment line"]);
  });

  it("keeps any other visible payment line instead of dropping it", () => {
    const html = page().replace(
      `<div data-testid="viewTransactionsButton">`,
      `<div data-testid="unmodelled"><span>Fake unmodelled payment note</span></div><div data-testid="viewTransactionsButton">`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.data.payment.other_lines).toEqual(["Fake unmodelled payment note"]);
    expect(page()).not.toContain("unmodelled");
    expect(parse().data.payment.other_lines).toEqual([]);
  });

  it("asin from the image link, then a data-asin ancestor, then any product link in the item", () => {
    const titleOnly = (href: string): string =>
      page().replace(
        /<a class="a-link-normal" href="\/dp\/B0FAKE0001[^"]*">Fake Widget Deluxe/,
        `<a class="a-link-normal" href="${href}">Fake Widget Deluxe`,
      );
    const a = parseOrderDetails(capture(titleOnly("/x")));
    expect(a.data.shipments[0]?.items[0]?.asin).toBe("B0FAKE0001");
    expect(a.meta.strategies["shipments.asin"]).toBe("image-link");

    const noImage = titleOnly("/x").replace(
      /<a class="a-link-normal" href="\/dp\/B0FAKE0001[^"]*"><img/,
      `<a class="a-link-normal" href="/y"><img`,
    );
    const withData = noImage.replace(
      `<div class="a-fixed-left-grid a-spacing-base">`,
      `<div class="a-fixed-left-grid a-spacing-base" data-asin="B0FAKE0008">`,
    );
    const b = parseOrderDetails(capture(withData));
    expect(b.data.shipments[0]?.items[0]?.asin).toBe("B0FAKE0008");
    expect(b.meta.strategies["shipments.asin"]).toBe("data-attr");

    const withLink = noImage.replace(
      `<div data-component="itemCondition">`,
      `<div data-component="itemCondition"><a href="/gp/product/B0FAKE0009">Fake related link</a>`,
    );
    const c = parseOrderDetails(capture(withLink));
    expect(c.data.shipments[0]?.items[0]?.asin).toBe("B0FAKE0009");
    expect(c.meta.strategies["shipments.asin"]).toBe("text-anchor");
  });

  it("carrier and tracking id from the status text", () => {
    const a = parse({
      shipments: [
        {
          status: "Shipped",
          detail: "Shipped with Example Carrier. Tracking ID: 0FAKETRACK123",
          items: [{ asin: "B0FAKE0001", title: "Fake", price: "$1.00" }],
        },
      ],
    });
    expect(a.data.shipments[0]?.tracking).toEqual({
      path: "",
      carrier: "Example Carrier",
      tracking_id: "0FAKETRACK123",
    });
    const b = parse({
      shipments: [
        {
          status: "Shipped",
          detail: "Carrier: Example Express Tracking number: 0FAKETRACK456",
          items: [{ asin: "B0FAKE0001", title: "Fake", price: "$1.00" }],
        },
      ],
    });
    expect(b.data.shipments[0]?.tracking).toMatchObject({
      carrier: "Example Express",
      tracking_id: "0FAKETRACK456",
    });
  });

  it("order types come from the brand logo and page chrome, not from item titles", () => {
    const titled = parse({
      shipments: [
        {
          status: "Delivered March 4",
          items: [{ asin: "B0FAKE0001", title: "Amazon Fresh Whole Foods Widget", price: "$1.00" }],
        },
      ],
    });
    expect(titled.data.order_types).toEqual([]);
    expect(parse({ brand: "Amazon Fresh" }).data.order_types).toEqual(["fresh"]);
    expect(parse({ brand: "Whole Foods Market" }).data.order_types).toEqual(["whole_foods"]);
  });

  it("no parsed item title leaks into other_sections", () => {
    const r = parse({ extraBlock: `<div data-component="mystery"><p>Fake unknown note</p></div>` });
    const rest = r.other_sections.map((s) => s.text).join(" ");
    for (const s of r.data.shipments)
      for (const it of s.items) expect(rest).not.toContain(it.title);
  });

  it("read-only rule kinds are a fixed list", () => {
    expect(READ_ONLY_LINK_RULES.map((r) => r.kind)).toEqual([
      "tracking",
      "invoice",
      "return_status",
      "order_details",
      "seller",
    ]);
    expect(readLinkKind("/gp/your-account/ship-track?orderId=X")).toBe("tracking");
    expect(readLinkKind("/gp/your-account/ship-track/cancel?orderId=X")).toBeUndefined();
    expect(readLinkKind("/gp/css/shiptrack?orderId=X")).toBe("tracking");
    expect(readLinkKind("/gp/css/shiptrack/edit")).toBeUndefined();
  });
});

describe("parseOrderDetails: failures", () => {
  it("throws layout_unrecognized for the 'unable to load' banner page", () => {
    const html = `<!DOCTYPE html><html><body><div role="main"><div id="orderDetails"><div data-component="breadcrumb"><span>Order Details</span></div>
      <div data-component="errorbanner"><div class="a-box a-alert a-alert-info"><div class="a-box-inner a-alert-container"><h4 class="a-alert-heading">We're unable to load your order details</h4><div class="a-alert-content">Please try again later<div class="a-row"><span class="a-button"><a class="a-button-text" href="/gp/your-account/order-history">Go to Your Orders</a></span></div></div></div></div></div>
      </div></div></body></html>`;
    try {
      parseOrderDetails(capture(html));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RfError);
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
      expect((e as RfError).payload.details).toMatchObject({ reason: "error_banner" });
    }
  });

  it("throws on a page with no order content at all", () => {
    expect(() =>
      parseOrderDetails(
        capture("<html><body><div role='main'>hello</div></body></html>", {
          url: "https://www.example.com/x",
          final_url: "https://www.example.com/x",
        }),
      ),
    ).toThrow(RfError);
  });

  it("returns a partial result with a warning when shipments are missing", () => {
    const html = page().replace(
      /<div data-component="orderCard">.*?<div data-component="cancelled">/s,
      `<div data-component="orderCard"></div></div><div data-component="cancelled">`,
    );
    const r = parseOrderDetails(capture(html));
    expect(r.data.shipments).toEqual([]);
    expect(r.meta.warnings.some((w) => w.includes("shipments"))).toBe(true);
    expect(r.data.order_id).toBe(OID);
  });
});

describe("helpers", () => {
  it("findDates: explicit year, inferred year, rollover and invalid days", () => {
    expect(findDates("Eligible through May 31, 2026")[0]).toEqual({
      raw: "May 31, 2026",
      iso: "2026-05-31",
    });
    expect(findDates("Delivered Mar 4", "2026-03-03")[0]).toEqual({
      raw: "Mar 4",
      iso: "2026-03-04",
      year_inferred: true,
    });
    expect(findDates("Arriving January 3", "2026-12-20")[0]?.iso).toBe("2027-01-03");
    expect(findDates("Arriving March 18")[0]).toEqual({ raw: "March 18" });
    expect(findDates("February 30, 2026")[0]).toEqual({ raw: "February 30, 2026" });
    expect(findDates("Mar 18 - Mar 20", "2026-03-03").map((d) => d.iso)).toEqual([
      "2026-03-18",
      "2026-03-20",
    ]);
    expect(findDates("Smart 12 items")).toEqual([]);
  });

  it("classifyCharge: hardcoded label table", () => {
    const table: [string, string][] = [
      ["Item(s) Subtotal:", "items_subtotal"],
      ["Shipping & Handling:", "shipping"],
      ["Total before tax:", "total_before_tax"],
      ["Estimated tax to be collected:", "tax"],
      ["Grand Total:", "grand_total"],
      ["Order Total:", "grand_total"],
      ["Refund Total", "refund_total"],
      ["Item(s) refund", "refund"],
      ["Tax refund", "refund"],
      ["Rewards Points:", "rewards"],
      ["Gift Card Amount:", "gift_card"],
      ["Promotion Applied:", "promotion"],
      ["Free Shipping:", "promotion"],
      ["Your Coupon Savings:", "promotion"],
      ["Import Fees Deposit:", "fees"],
      ["Driver tip:", "tip"],
      ["Something Else:", "other"],
    ];
    for (const [label, type] of table)
      expect([label, classifyCharge(label)]).toEqual([label, type]);
  });

  it("classifyStatus: hardcoded status table", () => {
    const table: [string, string][] = [
      ["Delivered March 4", "delivered"],
      ["Arriving Tuesday", "arriving"],
      ["Now arriving", "arriving"],
      ["Shipped", "shipped"],
      ["Not yet shipped", "preparing"],
      ["Preparing for shipment", "preparing"],
      ["Cancelled", "cancelled"],
      ["Refunded", "refunded"],
      ["Return complete", "returned"],
      ["Replacement shipped", "replaced"],
      ["Delayed", "delayed"],
      ["Something odd", "unknown"],
    ];
    for (const [s, k] of table) expect([s, classifyStatus(s)]).toEqual([s, k]);
  });

  it("read-only link allowlist: hardcoded expected list", () => {
    const table: [string, string | undefined][] = [
      ["/progress-tracker/package?orderId=X&shipmentId=Y", "tracking"],
      ["/progress-tracker/package/preship/cancel-items?orderID=X", undefined],
      ["/progress-tracker/package/actions/preship/change-shipping-address/address", undefined],
      ["/gp/css/summary/print.html?orderID=X", "invoice"],
      ["/spr/returns/prep?ingress=yo&orderId=X&rmaId=R", "return_status"],
      ["/spr/returns/prep?ingress=yo&orderId=X", undefined],
      ["/spr/returns/cart?orderId=X", undefined],
      ["/review/review-your-purchases?asins=B0FAKE0001", undefined],
      ["/hz/feedback?orderID=X", undefined],
      ["/gcx/-/ty/gr/X/shipment", undefined],
      ["/gp/buyagain?ats=abc", undefined],
      ["/gp/aag/main?ie=UTF8&seller=A1", "seller"],
      ["/gp/subscribe-and-save/manage", undefined],
      ["/gp/your-account/order-details?orderID=X", "order_details"],
    ];
    for (const [path, kind] of table) expect([path, readLinkKind(path)]).toEqual([path, kind]);
  });

  it("relativePath strips origin and tracking params, rejects off-site and javascript hrefs", () => {
    expect(relativePath("https://www.example.com/x?a=1&ref_=zz&_encoding=UTF8")).toBeUndefined();
    expect(relativePath("/gp/css/homepage.html/ref=ppx_x")).toBe("/gp/css/homepage.html");
    expect(relativePath("/progress-tracker/package?orderId=A&ref_=q&pd_rd_w=z")).toBe(
      "/progress-tracker/package?orderId=A",
    );
    expect(relativePath("javascript:void(0)")).toBeUndefined();
    expect(relativePath("#")).toBeUndefined();
    expect(relativePath(undefined)).toBeUndefined();
  });
});
