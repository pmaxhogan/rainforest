import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { parseInvoice } from "../../src/pages/invoice.ts";

const OID = "000-0000000-0000001";
const BULLETS = "\u2022\u2022\u2022\u2022";

function row(label: string, value: string): string {
  return `<li><span class="a-list-item"><div class="a-row od-line-item-row">
    <div class="a-column a-span7 od-line-item-row-label"><span class="a-size-base"><span>${label}</span></span></div>
    <div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">${value}</span></div>
  </div></span></li>`;
}

interface Item {
  asin: string;
  title: string;
  seller?: string;
  price: string;
  qty?: string;
  condition?: string;
  frequency?: string;
}

function item(i: Item): string {
  const href = `/dp/${i.asin}?ref_=ppx_printOD_title_dt_b_fed_asin_title_0_0`;
  return `<div class="a-fixed-left-grid a-spacing-base"><div class="a-fixed-left-grid-inner">
    <div data-component="purchasedItemsLeftGrid"><div class="a-fixed-left-grid-col a-col-left"><div data-component="itemImage"><a href="${href}"><img src="https://images.example.com/placeholder.png"></a></div></div></div>
    <div data-component="purchasedItemsRightGrid"><div class="a-fixed-left-grid-col a-col-right">
      <div data-component="itemTitle"><div class="a-row"><a class="a-link-normal" href="${href}">${i.title}</a></div></div>
      <div data-component="orderedMerchant">${i.seller === undefined ? "" : `<span class="a-size-small a-color-secondary">Sold by:<a class="a-link-normal" href="/gp/aag/main?ie=UTF8&seller=A0FAKESELL1">${i.seller}</a></span>`}</div>
      <div data-component="supplierOfRecord"><span class="a-size-small a-color-secondary">Supplied by: Other</span></div>
      <div data-component="itemCondition">${i.condition === undefined ? "" : `<span>${i.condition}</span>`}</div>
      <div data-component="quantity">${i.qty === undefined ? "" : `<span>${i.qty}</span>`}</div>
      <div data-component="unitPrice"><span class="a-price a-text-price"><span class="a-offscreen">${i.price}</span><span>${i.price}</span></span></div>
      <div data-component="deliveryFrequency">${i.frequency === undefined ? "" : `<span class="a-size-small">${i.frequency}</span>`}</div>
    </div></div>
  </div></div>`;
}

function shipment(status: string | undefined, items: Item[]): string {
  const st =
    status === undefined
      ? ""
      : `<div data-component="shipmentStatus"><div id="shipment-top-row" class="a-row"><div class="a-section"><div class="a-row"><h4 class="a-color-base od-status-message"><span>${status}</span></h4></div></div></div></div>`;
  return `<div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
    <div data-component="shipmentsLeftGrid"><div class="a-fixed-right-grid-col a-col-left">${st}<div data-component="purchasedItems">${items.map(item).join("")}</div></div></div>
  </div></div></div></div>`;
}

interface Spec {
  totals?: string[];
  shipments?: string[];
  extra?: string;
  payment?: string;
}

function page(spec: Spec = {}): string {
  const totals = (
    spec.totals ?? [
      row("Item(s) Subtotal:", "$30.00"),
      row("Shipping &amp; Handling:", "$4.00"),
      row("Subscribe &amp; Save:", "-$3.00"),
      row("Total before tax:", "$31.00"),
      row("Estimated tax to be collected:", "$2.00"),
      row("Gift Card Amount:", "-$5.00"),
      row("Grand Total:", "$28.00"),
    ]
  ).join("");
  const shipments = (
    spec.shipments ?? [
      shipment("Delivered March 4", [
        {
          asin: "B0FAKE0001",
          title: "Fake Widget Deluxe",
          seller: "Example Seller",
          price: "$10.00",
          qty: "2",
          condition: "Condition: New",
        },
        {
          asin: "B0FAKE0002",
          title: "Fake Widget Plus",
          seller: "Example Seller",
          price: "$10.00",
          frequency: "Auto-delivered: Example cadence",
        },
      ]),
    ]
  ).join("");
  return `<!DOCTYPE html><html><head><title>t</title></head><body><div id="a-page">
    <div class="a-container a-color-alternate-background" role="main">
      <div id="orderDetails" class="a-section dynamic-width"><div class="a-cardui-deck"><div class="a-cardui"><div class="a-cardui-body"><div data-component="default">
        <div data-component="title"><div data-component="titleLeftGrid"><div data-component="printODTitle"><h1>Order Summary</h1></div></div>
          <div data-component="titleRightGrid"><span id="a-autoid-0" class="a-button a-button-primary printOD-hide-print"><span class="a-button-inner"><span id="a-autoid-0-announce" class="a-button-text">Print</span></span></span></div></div>
        <div data-component="briefOrderInfoInvoice">
          <div data-component="orderDateLabel"><span>Order placed</span></div><div data-component="orderDate"><span>March 3, 2026</span></div>
          <div data-component="orderIdLabel"><span>Order #</span></div><div data-component="orderId"><span>${OID}</span></div>
        </div>
        <div data-component="orderSummary"><div class="a-box-group"><div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
          <div class="a-fixed-right-grid-col a-col-left"><div class="a-row">
            <div class="a-column a-span5"><div data-component="shippingAddress"><h5>Ship to</h5><ul><li><span class="a-list-item">Alex Example</span></li><li><span class="a-list-item">1 Example Way<br>Exampleville, EX 00000</span></li><li><span class="a-list-item">United States</span></li></ul></div></div>
            <div class="a-column a-span7 a-span-last">${spec.payment ?? `<div data-component="viewPaymentPlanSummaryWidget"><h5>Payment method</h5><div aria-label="payment method list"><div aria-label="payment method"><span data-testid="payment-instrument-message">Example Visa ${BULLETS} 0000</span></div></div></div>`}</div>
          </div></div>
          <div id="od-subtotals" class="a-fixed-right-grid-col a-col-right"><div data-component="chargeSummary"><div class="a-row"><h5>Order Summary</h5></div><ul>${totals}</ul></div></div>
        </div></div></div></div></div></div>
        <div data-component="orderCard"><div data-component="shipments"><div class="a-box-group">${shipments}</div></div></div>
        ${spec.extra ?? ""}
      </div></div></div></div></div>
    </div></div></body></html>`;
}

function cap(html: string): Capture {
  return {
    kind: "invoice",
    url: `https://www.example.com/gp/css/summary/print.html?orderID=${OID}`,
    final_url: `https://www.example.com/gp/css/summary/print.html?orderID=${OID}`,
    captured_at: "2000-01-01T00:00:00.000Z",
    html,
  };
}

describe("parseInvoice: print layout", () => {
  const r = parseInvoice(cap(page()));
  const d = r.data;

  it("reads id, placed date and order total", () => {
    expect(d.order_id).toBe(OID);
    expect(d.placed).toEqual({ raw: "March 3, 2026", iso: "2026-03-03" });
    expect(d.order_total).toMatchObject({ amount: 28, currency: "USD" });
    expect(r.meta.strategies["order_total"]).toBe("charge-line");
  });

  it("reads the charge breakdown as ordered typed lines", () => {
    expect(d.charge_breakdown.map((l) => [l.type, l.amount?.amount])).toEqual([
      ["items_subtotal", 30],
      ["shipping", 4],
      ["promotion", -3],
      ["total_before_tax", 31],
      ["tax", 2],
      ["gift_card", -5],
      ["grand_total", 28],
    ]);
    expect(d.refunds).toEqual([]);
  });

  it("reads shipment blocks with items, status date, supplier and ship-to", () => {
    expect(d.shipments).toHaveLength(1);
    const s = d.shipments[0];
    expect(s?.status?.kind).toBe("delivered");
    expect(s?.shipped_on).toMatchObject({ iso: "2026-03-04" });
    expect(s?.shipping_address).toMatchObject({
      name: "Alex Example",
      address_lines: ["1 Example Way", "Exampleville, EX 00000"],
    });
    expect(s?.items.map((i) => [i.asin, i.quantity, i.price?.amount, i.condition])).toEqual([
      ["B0FAKE0001", 2, 10, "New"],
      ["B0FAKE0002", 1, 10, undefined],
    ]);
    expect(s?.items[0]?.extras["supplier_of_record"]).toBe("Supplied by: Other");
    expect(d.order_types).toEqual(["subscribe_and_save"]);
  });

  it("reads payment as brand and last four, and the Print button as a label", () => {
    expect(d.payment).toMatchObject({ card_brand: "Visa", last4: "0000" });
    expect(d.actions).toEqual([{ label: "Print", intent: "other" }]);
  });

  it("accounts for everything: no leftovers, no HTML, JSON-clean", () => {
    expect(r.other_sections).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("parseInvoice: multi-shipment, refunds and anchors the print layout may add", () => {
  const extra = `
    <div id="billing"><h5>Billing address</h5><ul><li>Alex Example</li><li>2 Example Way<br>Exampleville, EX 00001</li><li>United States</li></ul></div>
    <div id="tx"><h5>Credit Card transactions</h5>
      <div>Example Visa ending in 0000: March 4, 2026: $28.00</div>
      <div>Example Visa ${BULLETS} 0000: March 8, 2026: -$9.00</div>
    </div>
    <div id="speed"><b>Shipping Speed:</b><span>Standard Shipping</span></div>
    <div><span>Shipped on March 4, 2026</span></div>
    <div><span>Shipped on March 5, 2026</span></div>`;
  const r = parseInvoice(
    cap(
      page({
        shipments: [
          shipment(undefined, [{ asin: "B0FAKE0001", title: "Fake One", price: "$10.00" }]),
          shipment("Refunded", [{ asin: "B0FAKE0003", title: "Fake Three", price: "$9.00" }]),
        ],
        totals: [
          row("Item(s) Subtotal:", "$19.00"),
          row("Grand Total:", "$19.00"),
          row("Refund Total:", "$9.00"),
          row("Tax refund:", "$0.50"),
        ],
        extra,
      }),
    ),
  );

  it("keeps every shipment in order, shipped_on from Shipped on lines, and shipping speed", () => {
    expect(r.data.shipments.map((s) => s.items[0]?.asin)).toEqual(["B0FAKE0001", "B0FAKE0003"]);
    expect(r.data.shipments.map((s) => s.shipped_on?.iso)).toEqual(["2026-03-04", "2026-03-05"]);
    expect(r.data.shipments.every((s) => s.shipping_speed === "Standard Shipping")).toBe(true);
  });

  it("reads billing address and card transactions with brand, last4, date and amount", () => {
    expect(r.data.payment.billing_address).toMatchObject({
      name: "Alex Example",
      address_lines: ["2 Example Way", "Exampleville, EX 00001"],
    });
    expect(r.data.transactions.map((t) => [t.last4, t.date?.iso, t.amount?.amount])).toEqual([
      ["0000", "2026-03-04", 28],
      ["0000", "2026-03-08", -9],
    ]);
    expect(r.data.transactions[0]?.card_brand).toBe("Visa");
  });

  it("collects refund lines", () => {
    expect(r.data.refunds.map((l) => [l.type, l.amount?.amount])).toEqual([
      ["refund_total", 9],
      ["refund", 0.5],
    ]);
  });

  it("never emits more than four consecutive digits from a card", () => {
    const html = page({
      extra: `<div id="tx"><h5>Credit Card transactions</h5><div>Example Visa 4111111111111111: March 4, 2026: $1.00</div></div>`,
    });
    const out = parseInvoice(cap(html));
    expect(out.data.transactions[0]?.last4).toBe("1111");
    expect(JSON.stringify(out.data.transactions)).not.toContain("4111111111111111");
    expect(JSON.stringify(out.data.payment)).not.toMatch(/\d{5,}/);
  });
});

describe("parseInvoice: hidden content, unknown blocks and failures", () => {
  it("skips hidden elements and a template", () => {
    const r = parseInvoice(
      cap(
        page({
          extra: `<div data-rf-hidden="1"><h5>Billing address</h5><p>Hidden Person</p></div><template><p>Template text</p></template>`,
        }),
      ),
    );
    expect(JSON.stringify(r)).not.toContain("Hidden Person");
    expect(r.data.payment.billing_address).toBeUndefined();
  });

  it("returns an unknown visible block in other_sections", () => {
    const r = parseInvoice(
      cap(
        page({
          extra: `<div id="odd" data-component="odd"><h3>Odd Heading</h3><p>Unmodelled fake note</p></div>`,
        }),
      ),
    );
    expect(r.other_sections).toHaveLength(1);
    expect(r.other_sections[0]?.text).toContain("Unmodelled fake note");
  });

  it("falls back to the url for the order id and to text for the placed date", () => {
    const html = page()
      .replace(/<div data-component="orderId">.*?<\/div>/s, `<div data-component="orderId"></div>`)
      .replace(`data-component="orderDate"`, `data-component="renamedDate"`);
    const r = parseInvoice(cap(html));
    expect(r.data.order_id).toBe(OID);
    expect(r.meta.strategies["order_id"]).toBe("url");
    expect(r.data.placed?.iso).toBe("2026-03-03");
    expect(r.meta.strategies["placed"]).toBe("text-anchor");
  });

  it("order total falls back to the 'Order Total:' text anchor", () => {
    const r = parseInvoice(
      cap(
        page({
          totals: [row("Item(s) Subtotal:", "$5.00")],
          extra: `<div>Order Total: $5.00</div>`,
        }),
      ),
    );
    expect(r.data.order_total?.amount).toBe(5);
    expect(r.meta.strategies["order_total"]).toBe("text-anchor");
  });

  it("throws layout_unrecognized for the error banner page and for an empty page", () => {
    const banner = `<html><body><div role="main"><div id="orderDetails"><div data-component="errorbanner"><div class="a-box a-alert"><div class="a-box-inner a-alert-container"><h4 class="a-alert-heading">We're unable to load your order details</h4><div class="a-alert-content">Please try again later</div></div></div></div></div></div></body></html>`;
    for (const html of [banner, "<html><body><div role='main'>x</div></body></html>"]) {
      try {
        parseInvoice({
          ...cap(html),
          final_url: "https://www.example.com/x",
          url: "https://www.example.com/x",
        });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(RfError);
        expect((e as RfError).payload.code).toBe("layout_unrecognized");
      }
    }
  });
});
