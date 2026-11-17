import { ORDERS, orderSubtotal, product, SHIP_TO, type Order } from "../catalog.ts";
import { esc, money } from "../util.ts";
import { layout } from "./layout.ts";

/** Order list, order details and the printable invoice for a couple of invented orders. */

const SELLER_LINK = `<a class="a-link-normal" href="/gp/aag/main?ie=UTF8&amp;seller=A0FAKESELL01">Example Goods Co</a>`;

function total(order: Order): number {
  return orderSubtotal(order) + order.shippingCents + order.taxCents;
}

function orderCard(order: Order): string {
  const items = order.lines
    .map((l) => {
      const p = product(l.asin);
      const title = esc(p?.title ?? l.asin);
      return `<li><span class="a-list-item"><div class="a-fixed-left-grid item-box yo-enhanced-items a-padding-small"><div class="a-fixed-left-grid-inner"><div class="a-fixed-left-grid-col a-col-left"><div class="product-image"><a class="a-link-normal" href="/dp/${l.asin}"><img alt="${title}" src="https://images.example.com/placeholder.png"></a>${
        l.quantity > 1 ? `<span class="product-image__qty">${l.quantity}</span>` : ""
      }</div></div><div class="a-fixed-left-grid-col a-col-right"><div class="a-row"><div class="yohtmlc-product-title"><a class="a-link-normal" href="/dp/${l.asin}">${title}</a></div></div></div></div></div></span></li>`;
    })
    .join("");
  return `<div class="order-card js-order-card" data-csa-c-type="widget" data-csa-c-content-id="amzn1.yourorders.order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.${order.id}"><div class="a-box-group a-spacing-base">
<div class="a-box a-color-offset-background order-header"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><h5 class="a-text-normal"><ul class="order-header__header-list" role="presentation">
<div class="a-fixed-right-grid-col a-col-left"><div class="a-row">
<div class="a-column a-span3"><li class="order-header__header-list-item" role="presentation"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Order placed</span></div><div class="a-row"><span class="a-size-base a-color-secondary aok-break-word">${order.placed}</span></div></li></div>
<div class="a-column a-span2"><li class="order-header__header-list-item" role="presentation"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Total</span></div><div class="a-row"><span class="a-size-base a-color-secondary aok-break-word">${money(total(order))}</span></div></li></div>
<div class="a-column a-span7 a-span-last"><li class="order-header__header-list-item" role="presentation"><div class="yohtmlc-recipient"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Ship to</span></div><div class="a-row a-size-base"><a href="javascript:void(0)" class="a-popover-trigger a-declarative aok-break-word">${SHIP_TO.name}</a></div></div></li></div>
</div></div>
<div class="a-text-right a-fixed-right-grid-col a-col-right"><div class="a-row a-size-mini"><li class="order-header__header-list-item" role="presentation"><div class="yohtmlc-order-id"><span class="a-color-secondary a-text-caps">Order #</span> <span class="a-color-secondary" dir="ltr">${order.id}</span></div></li></div>
<div class="a-row"><li class="order-header__header-list-item yohtmlc-order-level-connections" role="presentation"><a class="a-link-normal" href="/gp/your-account/order-details?orderID=${order.id}">View order details</a> <a class="a-link-normal" href="/gp/css/summary/print.html?orderID=${order.id}">View invoice</a></li></div></div>
</ul></h5></div></div></div></div>
<div class="a-box delivery-box"><div class="a-box-inner"><div class="a-fixed-right-grid a-spacing-small"><div class="a-fixed-right-grid-inner"><div class="a-fixed-right-grid-col a-col-left">
<div class="a-row"><div class="yohtmlc-shipment-status-primaryText"><h3><span class="a-size-medium delivery-box__primary-text a-text-bold">Delivered ${order.delivered}</span></h3></div></div>
<ul class="a-unordered-list a-nostyle a-vertical" role="list"><div class="a-row a-spacing-top-base">${items}</div></ul>
</div><div class="a-fixed-right-grid-col a-col-right"><div class="a-button-stack a-spacing-mini"><span class="a-button a-button-normal"><span class="a-button-inner"><a href="/progress-tracker/package?orderId=${order.id}&amp;shipmentId=FAKESHIP1&amp;packageIndex=0" class="a-button-text" role="button">Track package</a></span></span></div></div>
</div></div></div></div></div></div>`;
}

export function renderOrderList(url: URL): string {
  const timeFilter = url.searchParams.get("timeFilter") ?? "months-3";
  const options = [
    ["last30", "last 30 days"],
    ["months-3", "past 3 months"],
    ["year-2026", "2026"],
  ]
    .map(([v, l]) => `<option value="${v}"${v === timeFilter ? " selected" : ""}>${l}</option>`)
    .join("");
  const selectedLabel =
    { last30: "last 30 days", "months-3": "past 3 months", "year-2026": "2026" }[timeFilter] ??
    "past 3 months";
  return layout({
    title: "Your Orders",
    body: `<section class="your-orders-content-container aok-relative js-yo-container"><div class="your-orders-content-container__content js-yo-main-content">
<div class="a-row a-spacing-medium"><div class="a-column a-span6"><h1>Your Orders</h1></div></div>
<div class="a-section a-spacing-medium page-tabs"><ul><li class="page-tabs__tab page-tabs__tab--selected">Orders</li><li class="page-tabs__tab"><a class="a-link-normal" href="/your-orders/orders?orderFilter=open">Not Yet Shipped</a></li></ul></div>
<div class="a-row a-spacing-base"><div class="a-column a-span8"><form method="get" action="/your-orders/orders" class="js-time-filter-form a-spacing-none"><label for="time-filter" class="a-form-label time-filter__label aok-inline-block a-text-normal"><b>${ORDERS.length} orders</b> placed in</label><span class="a-dropdown-container"><select name="timeFilter" autocomplete="off" id="time-filter" class="a-native-dropdown">${options}</select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text a-declarative"><span class="a-dropdown-prompt">${selectedLabel}</span></span></span></span></span></form></div></div>
${ORDERS.map(orderCard).join("")}
<div class="a-row"><div class="a-text-center"><ul class="a-pagination"><li class="a-disabled">&larr; Previous<span class="a-letter-space"></span></li><li class="a-selected"><a href="/your-orders/orders?timeFilter=${esc(timeFilter)}&amp;page=0">1</a></li><li class="a-last a-disabled">Next &rarr;<span class="a-letter-space"></span></li></ul></div></div>
</div></section>`,
  });
}

function row(label: string, value: string): string {
  return `<li><span class="a-list-item"><div class="a-row od-line-item-row"><div class="a-column a-span7 od-line-item-row-label"><span class="a-size-base"><span>${label}</span></span></div><div class="a-column a-span5 od-line-item-row-content a-span-last"><span class="a-size-base a-color-base">${value}</span></div></div></span></li>`;
}

function summaryBlocks(order: Order): string {
  const sub = orderSubtotal(order);
  return `<div data-component="orderSummary"><div class="a-box-group"><div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
<div class="a-fixed-right-grid-col a-col-left"><div class="a-row"><div class="a-column a-span5"><div data-component="shippingAddress"><h5 class="a-spacing-micro">Ship to</h5><ul class="a-unordered-list a-nostyle a-vertical"><li><span class="a-list-item">${SHIP_TO.name}</span></li><li><span class="a-list-item">${SHIP_TO.street}<br>${SHIP_TO.city}</span></li><li><span class="a-list-item">${SHIP_TO.country}</span></li></ul></div></div>
<div class="a-column a-span7 a-span-last"><div class="a-section a-spacing-base"><div data-component="viewPaymentPlanSummaryWidget"><h5 class="a-spacing-micro">Payment method</h5><div aria-label="payment method list"><div aria-label="payment method"><span data-testid="payment-instrument-message">Example Visa ending in 0000</span></div></div></div></div></div></div></div>
<div id="od-subtotals" class="a-fixed-right-grid-col a-col-right"><div data-component="chargeSummary"><div class="a-column a-span12"><div class="a-row a-spacing-small"><h5>Order Summary</h5></div><ul class="a-unordered-list a-nostyle a-vertical">${
    row("Item(s) Subtotal:", money(sub)) +
    row("Shipping &amp; Handling:", money(order.shippingCents)) +
    row("Total before tax:", money(sub + order.shippingCents)) +
    row("Estimated tax to be collected:", money(order.taxCents)) +
    row("Grand Total:", money(total(order)))
  }</ul></div></div></div>
</div></div></div></div></div></div>`;
}

function shipmentBlock(order: Order, withButtons: boolean): string {
  const items = order.lines
    .map((l) => {
      const p = product(l.asin);
      const price = p?.featured?.priceCents ?? 0;
      return `<div class="a-fixed-left-grid a-spacing-base"><div class="a-fixed-left-grid-inner"><div data-component="purchasedItemsLeftGrid"><div class="a-fixed-left-grid-col a-col-left"><div data-component="itemImage"><div class="aok-relative"><a class="a-link-normal" href="/dp/${l.asin}"><img src="https://images.example.com/placeholder.png"></a></div></div></div></div>
<div data-component="purchasedItemsRightGrid"><div class="a-fixed-left-grid-col a-col-right"><div data-component="itemTitle"><div class="a-row"><a class="a-link-normal" href="/dp/${l.asin}">${esc(p?.title ?? l.asin)}</a></div></div><div data-component="orderedMerchant"><span class="a-size-small a-color-secondary">Sold by:${SELLER_LINK}</span></div><div data-component="itemCondition"><span>Condition: New</span></div><div data-component="quantity"><span class="a-size-small">${l.quantity}</span></div><div data-component="unitPrice"><span class="a-price a-text-price" data-a-size="s"><span class="a-offscreen">${money(price)}</span><span>${money(price)}</span></span></div></div></div></div></div>`;
    })
    .join("");
  const buttons = withButtons
    ? `<div data-component="shipmentsRightGrid"><div class="a-fixed-right-grid-col a-col-right"><div data-component="shipmentConnections"><div class="a-button-stack a-spacing-mini"><span class="a-button a-button-normal"><span class="a-button-inner"><a class="a-button-text" href="/progress-tracker/package?orderId=${order.id}&amp;shipmentId=FAKESHIP1&amp;packageIndex=0">Track package</a></span></span></div></div></div></div>`
    : "";
  return `<div data-component="orderCard"><div data-component="shipments"><div class="a-box-group"><div class="a-box"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner"><div data-component="shipmentsLeftGrid"><div class="a-fixed-right-grid-col a-col-left"><div data-component="shipmentStatus"><div id="shipment-top-row" class="a-row"><div class="a-section"><div class="a-row"><h4 class="a-color-base od-status-message"><span>Delivered ${order.delivered}</span></h4></div></div></div></div><div data-component="purchasedItems"><div class="a-row a-spacing-top-base">${items}</div></div></div></div>${buttons}</div></div></div></div></div></div></div>`;
}

function errorBanner(): string {
  return layout({
    title: "Order Details",
    body: `<div class="a-container" role="main"><div id="orderDetails"><div data-component="errorbanner"><div class="a-box a-alert a-alert-info"><div class="a-box-inner a-alert-container"><h4 class="a-alert-heading">We're unable to load your order details</h4><div class="a-alert-content">Check the order number and look again.</div></div></div></div></div></div>`,
  });
}

function shell(title: string, inner: string): string {
  return layout({
    title,
    body: `<div class="a-container a-color-alternate-background" role="main"><div id="orderDetails" class="a-section dynamic-width"><div class="a-cardui-deck"><div class="a-cardui"><div class="a-cardui-body"><div data-component="default">${inner}</div></div></div></div></div></div>`,
  });
}

const find = (id: string | null): Order | undefined => ORDERS.find((o) => o.id === id);

export function renderOrderDetails(orderId: string | null): string {
  const order = find(orderId);
  if (!order) return errorBanner();
  return shell(
    "Order Details",
    `<div data-component="title"><div data-component="titleLeftGrid"><div data-component="orderDetailsTitle"><h1>Order Details</h1></div></div></div>
<div data-component="briefOrderInfoInvoice"><div class="a-section"><div class="a-row"><div data-component="briefOrderInfoInvoiceLeftGrid"><div data-component="orderDateLabel"><span>Order placed</span></div><div data-component="orderDate"><span>${order.placed}</span></div><div data-component="orderIdLabel"><span>Order #</span></div><div data-component="orderId"><span>${order.id}</span></div></div>
<div data-component="briefOrderInfoInvoiceRightGrid"><div data-component="orderInvoice"><span class="a-button a-button-normal"><span class="a-button-inner"><a class="a-button-text" href="/gp/css/summary/print.html?orderID=${order.id}">View invoice</a></span></span></div></div></div></div></div>
${summaryBlocks(order)}${shipmentBlock(order, true)}`,
  );
}

export function renderInvoice(orderId: string | null): string {
  const order = find(orderId);
  if (!order) return errorBanner();
  return shell(
    "Order Summary",
    `<div data-component="title"><div data-component="titleLeftGrid"><div data-component="printODTitle"><h1>Order Summary</h1></div></div><div data-component="titleRightGrid"><span id="a-autoid-0" class="a-button a-button-primary printOD-hide-print"><span class="a-button-inner"><span id="a-autoid-0-announce" class="a-button-text">Print</span></span></span></div></div>
<div data-component="briefOrderInfoInvoice"><div data-component="orderDateLabel"><span>Order placed</span></div><div data-component="orderDate"><span>${order.placed}</span></div><div data-component="orderIdLabel"><span>Order #</span></div><div data-component="orderId"><span>${order.id}</span></div></div>
${summaryBlocks(order)}${shipmentBlock(order, false)}`,
  );
}
