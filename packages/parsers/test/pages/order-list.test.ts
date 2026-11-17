import { describe, expect, it } from "vitest";
import { FAKE, type Capture } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import { parseDocument } from "../../src/dom.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";
import {
  cleanLink,
  isReadOnlyPath,
  orderListLosslessOptions,
  parseDateText,
  parseOrderList,
} from "../../src/pages/order-list.ts";

// ---- synthetic page builders (invented content, real structure)

const NAV = `<header id="navbar-main"><div id="navbar"><span>Fake store navigation</span></div></header>`;

interface ItemSpec {
  asin: string;
  title: string;
  qty?: number;
  details?: string;
  notices?: string[];
  buyAgain?: boolean;
}

function itemBox(i: ItemSpec): string {
  const rows =
    (i.details === undefined
      ? `<div class="a-row a-size-small a-color-secondary"><span></span></div>`
      : `<div class="a-row a-size-small a-color-secondary"><span>${i.details}</span></div>`) +
    (i.notices ?? [])
      .map((n) => `<div class="a-row"><span class="a-size-small">${n}</span></div>`)
      .join("");
  const buy =
    i.buyAgain === false
      ? ""
      : `<div class="a-row a-spacing-top-mini"><div class="yohtmlc-item-level-connections">
          <span class="a-button a-button-normal a-button-primary"><span class="a-button-inner">
          <a href="/gp/buyagain?ats=FAKETOKEN${i.asin}" class="a-button-text" role="button">
          <div class="buy-it-again-button__icon"></div><div class="reorder-modal-trigger-text">Buy it again</div></a></span></span>
          </div></div>`;
  return `<li><span class="a-list-item"><div class="a-fixed-left-grid item-box yo-enhanced-items a-padding-small"><div class="a-fixed-left-grid-inner">
    <div class="a-fixed-left-grid-col a-col-left"><div class="product-image">
      <a class="a-link-normal" tabindex="-1" href="/dp/${i.asin}?ref=ppx_fake_asin_title"><img alt="Alt text for ${i.title}" src="${FAKE.imageUrl}"></a>
      ${i.qty === undefined ? "" : `<span class="product-image__qty">${i.qty}</span>`}
    </div></div>
    <div class="a-fixed-left-grid-col a-col-right">
      <div class="a-row"><div class="yohtmlc-product-title"><a class="a-link-normal" href="/dp/${i.asin}?ref=ppx_fake_asin_title">${i.title}</a></div></div>
      <div class="a-row a-spacing-top-mini"></div>
      ${rows}
      ${buy}
    </div></div></div></span></li>`;
}

function carouselCard(i: ItemSpec, pos: number): string {
  return `<li class="a-carousel-card" role="listitem"><div class="yo-enhanced-card yo-enhanced-item-carousel__card" data-csa-c-type="item" data-csa-c-item-id="enhanced-order-item-${pos}">
    <div class="yo-enhanced-card-image aok-align-center-horizontally"><a class="a-link-normal" tabindex="-1" href="/dp/${i.asin}?ref=ppx_fake_asin_title"><img alt="Alt ${i.title}" src="${FAKE.imageUrl}"></a>${i.qty === undefined ? "" : `<span class="product-image__qty">${i.qty}</span>`}</div>
    <div class="a-spacing-top-mini yo-enhanced-title"><a class="a-link-normal" href="/dp/${i.asin}?ref=ppx_fake_asin_title">${i.title}</a></div>
    <div class="a-row a-size-small a-color-secondary yo-enhanced-details">
      <div class="a-row a-spacing-top-mini"></div>
      <div class="a-row a-size-small a-color-secondary"><span></span></div>
      ${(i.notices ?? []).map((n) => `<div class="a-row"><span class="a-size-small">${n}</span></div>`).join("")}
    </div>
    <div class="yohtmlc-item-level-connections a-spacing-top-mini"><span class="a-button a-button-normal a-button-primary"><span class="a-button-inner">
      <a href="/gp/buyagain?ats=FAKETOKEN${i.asin}" class="a-button-text" role="button"><div class="reorder-modal-trigger-text">Buy it again</div></a></span></span></div>
  </div></li>`;
}

interface ActionSpec {
  key: string;
  label: string;
  href: string;
  hidden?: boolean;
}

interface BoxSpec {
  primary?: string;
  secondary?: string;
  statusExtra?: string;
  items?: ItemSpec[];
  carousel?: ItemSpec[];
  afterItems?: string;
  actions?: ActionSpec[];
  rawActions?: string;
}

function deliveryBox(b: BoxSpec): string {
  const actions = (b.actions ?? [])
    .map(
      (a, n) =>
        `<li data-csa-c-type="item" data-csa-c-item-type="shipment-action" data-csa-c-item-id="ppx_fake_dt_b_fed_${a.key}" data-csa-c-pos="${n}"${a.hidden === true ? ` data-rf-hidden="1"` : ""}>
        <span class="a-button a-button-normal"><span class="a-button-inner"><a href="${a.href}" class="a-button-text" role="button">${a.label}</a></span></span></li>`,
    )
    .join("");
  const itemList =
    (b.items ?? []).map(itemBox).join("") +
    (b.carousel === undefined
      ? ""
      : `<div class="a-begin a-carousel-container"><input type="hidden" class="a-carousel-firstvisibleitem" data-rf-hidden="1">
        <div class="a-row a-carousel-controls a-carousel-row"><div class="a-carousel-row-inner">
        <div class="a-carousel-col a-carousel-left" data-rf-hidden="1"><a class="a-button a-button-image a-carousel-button" href="#"><span class="a-button-inner"><i class="a-icon a-icon-previous"><span class="a-icon-alt">Previous page</span></i></span></a></div>
        <div class="a-carousel-col a-carousel-center"><div class="a-carousel-viewport"><ol class="a-carousel" role="list">${b.carousel.map(carouselCard).join("")}</ol></div></div>
        <div class="a-carousel-col a-carousel-right" data-rf-hidden="1"><a class="a-button a-button-image a-carousel-button" href="#"><span class="a-button-inner"><i class="a-icon a-icon-next"><span class="a-icon-alt">Next page</span></i></span></a></div>
        </div></div></div>`) +
    (b.afterItems ?? "");
  return `<hr class="a-spacing-none a-divider-normal">
  <div class="a-box delivery-box"><div class="a-box-inner"><div class="a-fixed-right-grid a-spacing-small"><div class="a-fixed-right-grid-inner">
    <div class="a-fixed-right-grid-col a-col-left">
      <div class="a-row"><div class="yohtmlc-shipment-status-primaryText"><h3><span class="a-size-medium delivery-box__primary-text a-text-bold">${b.primary ?? ""}</span></h3></div></div>
      <div class="a-row"><div class="yohtmlc-shipment-status-secondaryText">${b.secondary === undefined ? "" : `<span class="delivery-box__secondary-text">${b.secondary}</span>`}</div>${b.statusExtra ?? ""}</div>
      <ul class="a-unordered-list a-nostyle a-vertical" role="list"><div class="a-row a-spacing-top-base">${itemList}</div></ul>
    </div>
    <div class="a-fixed-right-grid-col a-col-right"><div class="a-button-stack a-spacing-mini">
      <style>.yo-collapsible-actions__list > li:nth-child(n+4) { display: none; }</style>
      <div class="yo-collapsible-actions"><ul class="yohtmlc-shipment-level-connections a-nostyle yo-collapsible-actions__list" role="list">${actions}</ul>
      <div class="yo-collapsible-actions__toggle a-text-center"><div class="a-row a-expander-container"><a href="javascript:void(0)" data-action="a-expander-toggle" class="a-expander-header"><span class="a-expander-prompt">More options</span></a></div></div></div>
      ${b.rawActions ?? ""}
    </div></div>
  </div></div></div></div>`;
}

interface CardSpec {
  id?: string;
  placed?: string;
  total?: string;
  shipTo?: string;
  boxes?: BoxSpec[];
  headerExtra?: string;
  noIdElement?: boolean;
}

function orderCard(c: CardSpec): string {
  const id = c.id ?? "000-0000000-0000001";
  const boxes: BoxSpec[] = c.boxes ?? [
    {
      primary: "Delivered November 18",
      items: [{ asin: "B0FAKE0001", title: "Fake Widget One" }],
      actions: [
        {
          key: "veo",
          label: "View or edit order",
          href: "/your-orders/order-details?orderID=000-0000000-0000001&ref=ppx_fake",
        },
      ],
    },
  ];
  return `<div class="order-card js-order-card" data-csa-c-type="widget" data-csa-c-content-id="amzn1.yourorders.order-card" data-csa-c-slot-id="amzn1.yourorders.order-card.${id}">
  <div class="a-box-group a-spacing-base">
  <script type="text/javascript">window.fakeTelemetry = 1;</script>
  <div class="a-box a-color-offset-background order-header"><div class="a-box-inner"><div class="a-fixed-right-grid"><div class="a-fixed-right-grid-inner">
    <h5 class="a-text-normal"><ul class="order-header__header-list" role="presentation">
    <div class="a-fixed-right-grid-col a-col-left"><div class="a-row">
      <div class="a-column a-span3"><li class="order-header__header-list-item" role="presentation"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Order placed</span></div><div class="a-row"><span class="a-size-base a-color-secondary aok-break-word">${c.placed ?? "November 16, 2026"}</span></div></li></div>
      <div class="a-column a-span2"><li class="order-header__header-list-item" role="presentation"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Total</span></div><div class="a-row"><span class="a-size-base a-color-secondary aok-break-word">${c.total ?? "$12.34"}</span></div></li></div>
      <div class="a-column a-span7 a-span-last"><li class="order-header__header-list-item" role="presentation"><div class="yohtmlc-recipient">
        <div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Ship to</span></div>
        <div class="a-row a-size-base"><div id="shipToInsertionNode-shippingAddress-fake01">
          <span class="a-declarative" data-action="a-popover"><a href="javascript:void(0)" class="a-popover-trigger a-declarative insert-encrypted-trigger-text aok-break-word">${c.shipTo ?? "Alex Example"}<i class="a-icon a-icon-popover"></i></a></span>
          <div class="a-popover-preload" id="a-popover-shippingAddress-fake01" data-rf-hidden="1"><span class="a-color-base"><div class="a-row"><h5>Hidden Name Example</h5></div><div class="a-row">1 Example Street APT 0 | EXAMPLEVILLE, ZZ 00000</div><div class="a-row">Exampleland</div></span></div>
        </div></div>
      </div></li></div>
      ${c.headerExtra ?? ""}
    </div></div>
    <div class="a-text-right a-fixed-right-grid-col a-col-right">
      <div class="a-row a-size-mini"><li class="order-header__header-list-item" role="presentation"><div class="yohtmlc-order-id"><span class="a-color-secondary a-text-caps">Order #</span> <span class="a-color-secondary" dir="ltr">${c.noIdElement === true ? "" : id}</span></div></li></div>
      <div class="a-row"><li class="order-header__header-list-item yohtmlc-order-level-connections" role="presentation">
        <a class="a-link-normal" href="/your-orders/order-details?orderID=${id}&ref=ppx_fake_or">View order details</a><i class="a-icon a-icon-text-separator" role="img"></i>
        <a class="a-link-normal" href="/gp/css/summary/print.html?orderID=${id}&ref=ppx_fake_in">View invoice</a></li></div>
    </div></ul></h5>
  </div></div></div></div>
  <div class="a-box yo-ask-order-pill"><div class="a-box-inner a-padding-small"><button class="rufus-pill" type="button"><span class="rufus-tooltip-icon"></span><span class="rufus-font-size-base">Ask Alexa about this order</span></button></div></div>
  <script type="text/template" id="shipToData-fake01"><span>Template Name Example 1 Template Street</span></script>
  ${boxes.map(deliveryBox).join("")}
  </div></div>`;
}

interface PageSpec {
  cards?: string[];
  count?: string;
  tabs?: string;
  timeFilter?: string | null;
  pagination?: string | null;
  after?: string;
  before?: string;
  url?: string;
}

const TABS = `<div class="a-section a-spacing-medium page-tabs"><ul>
  <li class="page-tabs__tab page-tabs__tab--selected">Orders</li>
  <li class="page-tabs__tab"><a class="a-link-normal" href="/gp/buyagain?ref_=ppx_fake_tb_buy_again">Buy Again</a></li>
  <li class="page-tabs__tab"><a class="a-link-normal" href="/your-orders/orders?ref_=ppx_fake_tb_open&orderFilter=open">Not Yet Shipped</a></li>
  <li class="page-tabs__tab"><a class="a-link-normal" href="/your-orders/orders?ref_=ppx_fake_tb_digital&orderFilter=digital">Digital Orders</a></li>
  <li class="page-tabs__tab"><a class="a-link-normal" href="https://pay.example.com/jr/your-account/orders?ref=fake">Amazon Pay</a></li>
</ul></div>`;

function timeFilterForm(count: string, selected: string): string {
  const opts: [string, string, string][] = [
    ["d30", "last30", "last 30 days"],
    ["m3", "months-3", "past 3 months"],
    ["y2026", "year-2026", "2026"],
    ["y2025", "year-2025", "2025"],
  ];
  return `<div class="a-row a-spacing-base"><div class="a-column a-span8">
  <form method="get" action="/your-orders/orders" class="js-time-filter-form a-spacing-none">
    <label for="time-filter" class="a-form-label time-filter__label aok-inline-block a-text-normal"><b>${count}</b> placed in</label>
    <span class="a-dropdown-container"><select name="timeFilter" autocomplete="off" id="time-filter" class="a-native-dropdown">
      ${opts.map(([ref, value, label]) => `<option data-ref="${ref}" value="${value}"${value === selected ? " selected" : ""} data-rf-hidden="1">${label}</option>`).join("")}
    </select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text a-declarative"><span class="a-dropdown-prompt">${opts.find((o) => o[1] === selected)?.[2] ?? ""}</span></span><i class="a-icon a-icon-dropdown"></i></span></span></span>
    <input type="hidden" name="ref_" value="ppx_fake_filter_all" data-rf-hidden="1">
  </form></div>
  <div class="a-column a-span4 a-span-last"><div class="a-text-right" data-csa-c-content-id="yo-view-transactions-desktop"><a href="/cpe/yourpayments/transactions?ref_=fake" class="a-link-normal a-text-bold">View transactions</a></div></div></div>`;
}

function pagination(
  base: string,
  current: number,
  total: number,
  opts: { step?: number; param?: string } = {},
): string {
  const param = opts.param ?? "page";
  const step = opts.step ?? 1;
  const href = (n: number): string => `${base}&${param}=${(n - 1) * step}&ref_=ppx_fake_pagination`;
  const lis: string[] = [];
  lis.push(
    current === 1
      ? `<li class="a-disabled">&larr; Previous<span class="a-letter-space"></span></li>`
      : `<li class="a-normal"><a href="${href(current - 1)}">&larr; Previous</a></li>`,
  );
  for (let n = 1; n <= total; n++) {
    lis.push(
      n === current
        ? `<li class="a-selected"><a href="${href(n)}">${n}</a></li>`
        : `<li class="a-normal"><a href="${href(n)}">${n}</a></li>`,
    );
  }
  lis.push(
    current === total
      ? `<li class="a-last a-disabled">Next &rarr;<span class="a-letter-space"></span></li>`
      : `<li class="a-last"><a href="${href(current + 1)}">Next<span class="a-letter-space"></span>&rarr;</a></li>`,
  );
  return `<div class="a-row"><div class="a-text-center"><ul class="a-pagination">${lis.join("")}</ul></div></div>`;
}

function page(spec: PageSpec = {}): Capture {
  const url = spec.url ?? `${FAKE.host}/your-orders/orders?timeFilter=year-2026`;
  const cards = spec.cards ?? [orderCard({})];
  const html = `<!DOCTYPE html><html><head><title>Your Orders</title></head><body><div id="a-page">${NAV}
  <section class="your-orders-content-container aok-relative js-yo-container"><div class="your-orders-content-container__content js-yo-main-content">
  <div class="a-section a-spacing-medium a-spacing-top-small"><ul class="breadcrumbs">
    <li class="breadcrumbs__crumb"><a class="a-link-normal" href="/your-account/ref=ppx_fake">Your Account</a></li>
    <li class="breadcrumbs__crumb breadcrumbs__crumb--divider">&rsaquo;</li>
    <li class="breadcrumbs__crumb breadcrumbs__crumb--current"><span class="a-color-state">Your Orders</span></li></ul></div>
  <div class="a-row a-spacing-medium"><div class="a-column a-span6"><h1>Your Orders</h1></div><div class="a-column a-span6 a-span-last">
    <div class="search-bar"><form method="get" action="/your-orders/search/ref=ppx_fake_search" class="a-spacing-none">
      <input type="hidden" name="opt" value="ab" data-rf-hidden="1"><div class="search-bar__input-container">
      <label for="searchOrdersInput" class="a-form-label"></label><input type="search" id="searchOrdersInput" placeholder="Search all orders" name="search" class="a-input-text" aria-label="Search all orders">
      </div><div class="search-bar__button-container"><span class="a-button a-button-search"><span class="a-button-inner"><input class="a-button-input" type="submit"><span class="a-button-text">Search Orders</span></span></span></div>
    </form></div></div></div>
  ${spec.tabs ?? TABS}
  ${spec.timeFilter === null ? "" : (spec.timeFilter ?? timeFilterForm(spec.count ?? "21 orders", "year-2026"))}
  <div id="problem-displaying-orders-page-banner" class="a-box a-alert page-banner--hidden-by-default" data-rf-hidden="1"><div class="a-box-inner"><h4 class="a-alert-heading">Hidden banner heading</h4></div></div>
  ${spec.before ?? ""}
  ${cards.join("\n")}
  ${spec.pagination === null ? "" : (spec.pagination ?? pagination("/your-orders/orders?timeFilter=year-2026", 1, 3))}
  ${spec.after ?? ""}
  </div></section>
  <div id="navFooter" role="contentinfo"><span>Fake store footer</span></div></div></body></html>`;
  return {
    kind: "order_list",
    url,
    final_url: url,
    captured_at: "2000-01-01T00:00:00.000Z",
    html,
  };
}

// ---- tests

describe("parseOrderList page level", () => {
  const r = parseOrderList(page());
  const d = r.data;

  it("reads heading, breadcrumbs, count and the search form", () => {
    expect(d.heading).toBe("Your Orders");
    expect(d.breadcrumbs).toEqual(["Your Account", "Your Orders"]);
    expect(d.order_count_text).toBe("21 orders placed in");
    expect(d.order_count).toBe(21);
    expect(d.search).toEqual({
      action_path: "/your-orders/search",
      method: "get",
      query_param: "search",
      hidden: { opt: "ab" },
    });
    expect(d.links).toEqual([
      { label: "View transactions", path: "/cpe/yourpayments/transactions" },
    ]);
  });

  it("reads the time filter options although the options carry the hidden marker", () => {
    expect(d.time_filter?.options.map((o) => o.value)).toEqual([
      "last30",
      "months-3",
      "year-2026",
      "year-2025",
    ]);
    expect(d.time_filter?.options.map((o) => o.label)).toEqual([
      "last 30 days",
      "past 3 months",
      "2026",
      "2025",
    ]);
    expect(d.time_filter?.options.find((o) => o.selected)?.value).toBe("year-2026");
    expect(d.time_filter?.options[0]?.ref).toBe("d30");
    expect(d.time_filter?.selected_value).toBe("year-2026");
    expect(d.time_filter?.selected_label).toBe("2026");
    expect(r.meta.strategies["time_filter"]).toBe("select-id");
  });

  it("reads the filter tabs with relative paths and the selected tab", () => {
    expect(d.tabs.map((t) => [t.label, t.kind, t.selected, t.path, t.filter_value])).toEqual([
      ["Orders", "orders", true, undefined, undefined],
      ["Buy Again", "buy_again", false, "/gp/buyagain", undefined],
      ["Not Yet Shipped", "not_yet_shipped", false, "/your-orders/orders?orderFilter=open", "open"],
      ["Digital Orders", "digital", false, "/your-orders/orders?orderFilter=digital", "digital"],
      [
        "Amazon Pay",
        "amazon_pay",
        false,
        "https://pay.example.com/jr/your-account/orders",
        undefined,
      ],
    ]);
    expect(d.tabs[4]?.external).toBe(true);
    expect(d.selected_tab).toBe("orders");
  });

  it("reads zero-based page pagination with relative next/prev paths", () => {
    const p = d.pagination;
    expect(p?.current_label).toBe("1");
    expect(p?.current_index).toBe(0);
    expect(p?.index_param).toBe("page");
    expect(p?.index_base).toBe(0);
    expect(p?.index_step).toBe(1);
    expect(p?.has_prev).toBe(false);
    expect(p?.has_next).toBe(true);
    expect(p?.next_path).toBe("/your-orders/orders?timeFilter=year-2026&page=1");
    expect(p?.prev_path).toBeUndefined();
    expect(p?.pages.map((x) => x.label)).toEqual(["1", "2", "3"]);
    expect(p?.pages[2]?.path).toBe("/your-orders/orders?timeFilter=year-2026&page=2");
    expect(p?.last_label).toBe("3");
    expect(p?.has_gap).toBe(false);
  });

  it("derives the requested filters from the final URL", () => {
    expect(d.requested).toEqual({
      time_filter: "year-2026",
      order_filter: null,
      page: null,
      time_filter_applied: true,
      order_filter_applied: null,
    });
    expect(r.meta.warnings).toEqual([]);
  });

  it("is JSON serializable and compact", () => {
    expect(JSON.parse(JSON.stringify(r)).data.orders).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/<(?:div|span|a)\b/);
  });
});

describe("parseOrderList order card", () => {
  const r = parseOrderList(page());
  const o = r.data.orders[0];

  it("reads header fields", () => {
    expect(o?.order_id).toBe("000-0000000-0000001");
    expect(FAKE.orderIdPattern.test(o?.order_id ?? "")).toBe(true);
    expect(o?.order_type).toBe("physical");
    expect(o?.placed).toEqual({ raw: "November 16, 2026", iso: "2026-11-16" });
    expect(o?.total).toEqual({ amount: 12.34, currency: "USD", raw: "$12.34" });
    expect(o?.ship_to).toBe("Alex Example");
    expect(o?.header_fields).toEqual([]);
  });

  it("returns order-level read-only paths without tracking parameters", () => {
    expect(o?.order_details_path).toBe("/your-orders/order-details?orderID=000-0000000-0000001");
    expect(o?.invoice_path).toBe("/gp/css/summary/print.html?orderID=000-0000000-0000001");
    expect(o?.actions.map((a) => a.label)).toEqual([
      "View order details",
      "View invoice",
      "Ask Alexa about this order",
    ]);
  });

  it("never reads the hidden address popover or the text/template script", () => {
    const json = JSON.stringify(r);
    expect(json).not.toContain("Hidden Name Example");
    expect(json).not.toContain("Example Street");
    expect(json).not.toContain("EXAMPLEVILLE");
    expect(json).not.toContain("Template Name Example");
    expect(json).not.toContain("fakeTelemetry");
    expect(json).not.toContain("Hidden banner heading");
  });

  it("reads one shipment with its item", () => {
    expect(o?.shipments).toHaveLength(1);
    const s = o?.shipments[0];
    expect(s?.status_primary).toBe("Delivered November 18");
    expect(s?.status_kind).toBe("delivered");
    expect(s?.status_date).toEqual({
      raw: "November 18",
      iso: "2026-11-18",
      year_inferred: true,
    });
    const item = s?.items[0];
    expect(item?.asin).toBe("B0FAKE0001");
    expect(FAKE.asinPattern.test(item?.asin ?? "")).toBe(true);
    expect(item?.title).toBe("Fake Widget One");
    expect(item?.url_path).toBe("/dp/B0FAKE0001");
    expect(item?.image_url).toBe(FAKE.imageUrl);
    expect(item?.actions).toEqual([{ label: "Buy it again" }]);
    expect(o?.item_count).toBe(1);
    expect(o?.status_lines).toEqual(["Delivered November 18"]);
    expect(o?.is_cancelled).toBe(false);
    expect(o?.has_cancelled_shipment).toBe(false);
    expect(o?.is_archived).toBeUndefined();
  });

  it("records which strategy produced each key field", () => {
    expect(r.meta.strategies["orders"]).toBe("order-card-class");
    expect(r.meta.strategies["order.order_id"]).toBe("id-element");
    expect(r.meta.strategies["order.placed"]).toBe("label");
    expect(r.meta.strategies["order.total"]).toBe("label");
    expect(r.meta.strategies["order.item.title"]).toBe("title-link");
    expect(r.meta.strategies["order.item.asin"]).toBe("url");
    expect(r.meta.strategies["order.shipment.actions"]).toBe("collapsible-list");
  });
});

describe("shipment status and dates", () => {
  it("handles an order with two shipments (delivered + arriving)", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            placed: "December 28, 2026",
            boxes: [
              {
                primary: "Delivered December 30",
                secondary: "Your package was left near the front door.",
                items: [{ asin: "B0FAKE0001", title: "Fake Widget One" }],
                actions: [
                  {
                    key: "track_package",
                    label: "Track package",
                    href: "/progress-tracker/package?itemId=fakeitem0001&orderId=000-0000000-0000001&_encoding=UTF8&ref=ppx_fake",
                  },
                ],
              },
              {
                primary: "Arriving January 3",
                items: [{ asin: "B0FAKE0002", title: "Fake Widget Two" }],
              },
            ],
          }),
        ],
      }),
    );
    const o = r.data.orders[0];
    expect(o?.shipments).toHaveLength(2);
    expect(o?.status_lines).toEqual([
      "Delivered December 30 - Your package was left near the front door.",
      "Arriving January 3",
    ]);
    expect(o?.shipments[0]?.status_kind).toBe("delivered");
    expect(o?.shipments[0]?.status_date?.iso).toBe("2026-12-30");
    // The year rolls over: January 3 after a December order is next year.
    expect(o?.shipments[1]?.status_kind).toBe("arriving");
    expect(o?.shipments[1]?.status_date).toEqual({
      raw: "January 3",
      iso: "2027-01-03",
      year_inferred: true,
    });
    expect(o?.shipments[0]?.tracking_path).toBe(
      "/progress-tracker/package?itemId=fakeitem0001&orderId=000-0000000-0000001",
    );
    expect(o?.item_count).toBe(2);
  });

  it("treats an empty status as none without warnings (old orders)", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                items: [
                  {
                    asin: "B0FAKE0003",
                    title: "Fake Widget Three",
                    notices: ["Return window closed on January 28, 2026"],
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const o = r.data.orders[0];
    expect(o?.shipments[0]?.status_kind).toBe("none");
    expect(o?.shipments[0]?.status_primary).toBeUndefined();
    expect(o?.status_lines).toEqual([]);
    expect(o?.shipments[0]?.items[0]?.return_window).toEqual({
      text: "Return window closed on January 28, 2026",
      state: "closed",
      date: { raw: "January 28, 2026", iso: "2026-01-28" },
    });
    expect(r.meta.warnings).toEqual([]);
  });

  it("reads an open return window, details line, quantity badge and subscription notice", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Arriving December 1",
                items: [
                  {
                    asin: "B0FAKE0004",
                    title: "Fake Widget Four",
                    qty: 3,
                    details: "Size: Fake Large",
                    notices: [
                      "Return or replace items: Eligible through January 31, 2027",
                      "Auto-delivered: Every 3 weeks",
                    ],
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const item = r.data.orders[0]?.shipments[0]?.items[0];
    expect(item?.quantity).toBe(3);
    expect(item?.details).toBe("Size: Fake Large");
    expect(item?.return_window?.state).toBe("open");
    expect(item?.return_window?.date?.iso).toBe("2027-01-31");
    expect(item?.notices).toEqual([
      { text: "Auto-delivered: Every 3 weeks", kind: "subscription" },
    ]);
  });

  it("reads a refund / return card and keeps the help link text", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Refunded",
                secondary: "Your return is in transit. Your refund has been issued.",
                statusExtra: `<span class="a-declarative" data-action="a-popover"><a href="javascript:void(0)" class="a-popover-trigger a-declarative">When will I get my refund?<i class="a-icon a-icon-popover"></i></a></span>
                  <div class="a-popover-preload" id="a-popover-returnHelp-fake" data-rf-hidden="1"><span class="a-color-base">A refund will appear within a fake number of days.</span></div>`,
                items: [{ asin: "B0FAKE0005", title: "Fake Widget Five" }],
                actions: [
                  {
                    key: "prep_status",
                    label: "View return/refund status",
                    href: "/spr/returns/prep?contractId=fake-contract&rmaId=FAKERMA",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const o = r.data.orders[0];
    const s = o?.shipments[0];
    expect(s?.status_kind).toBe("refunded");
    expect(s?.status_extra).toEqual(["When will I get my refund?"]);
    expect(s?.return_or_refund).toContain("Your refund has been issued.");
    expect(o?.return_or_refund).toContain("Refunded");
    // Return flows are label-only: no path for the return/refund status link.
    expect(s?.actions).toEqual([{ label: "View return/refund status", key: "prep_status" }]);
    expect(JSON.stringify(r)).not.toContain("fake-contract");
    expect(JSON.stringify(r)).not.toContain("A refund will appear");
  });

  it("marks a cancelled order card and a partially cancelled one", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            id: "000-0000000-0000002",
            boxes: [
              {
                primary: "Cancelled",
                secondary: "This order was cancelled at your request.",
                items: [{ asin: "B0FAKE0006", title: "Fake Widget Six" }],
              },
            ],
          }),
          orderCard({
            id: "000-0000000-0000003",
            boxes: [
              {
                primary: "Order cancelled",
                items: [{ asin: "B0FAKE0007", title: "Fake Widget Seven" }],
              },
              {
                primary: "Delivered November 20",
                items: [{ asin: "B0FAKE0008", title: "Fake Widget Eight" }],
              },
            ],
          }),
        ],
      }),
    );
    const [a, b] = r.data.orders;
    expect(a?.shipments[0]?.status_kind).toBe("cancelled");
    expect(a?.is_cancelled).toBe(true);
    expect(a?.has_cancelled_shipment).toBe(true);
    expect(b?.is_cancelled).toBe(false);
    expect(b?.has_cancelled_shipment).toBe(true);
  });

  it("marks a card whose header says archived", () => {
    const extra = `<div class="a-column"><li class="order-header__header-list-item"><div class="a-row a-size-mini"><span class="a-color-secondary a-text-caps">Status</span></div><div class="a-row"><span>Archived order</span></div></li></div>`;
    const r = parseOrderList(page({ cards: [orderCard({ headerExtra: extra })] }));
    const o = r.data.orders[0];
    expect(o?.is_archived).toBe(true);
    expect(o?.header_fields).toEqual([{ label: "Status", value: "Archived order" }]);
  });
});

describe("items", () => {
  it("reads carousel cards for a shipment with many items", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Delivered November 8",
                carousel: [
                  {
                    asin: "B0FAKE0010",
                    title: "Fake Carousel One",
                    qty: 2,
                    notices: ["Return or replace items: Eligible through January 31, 2027"],
                  },
                  { asin: "B0FAKE0011", title: "Fake Carousel Two" },
                  { asin: "B0FAKE0012", title: "Fake Carousel Three" },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const items = r.data.orders[0]?.shipments[0]?.items ?? [];
    expect(items.map((i) => i.asin)).toEqual(["B0FAKE0010", "B0FAKE0011", "B0FAKE0012"]);
    expect(items[0]?.quantity).toBe(2);
    expect(items[0]?.return_window?.state).toBe("open");
    expect(items[1]?.actions).toEqual([{ label: "Buy it again" }]);
    expect(r.meta.strategies["order.shipment.items"]).toBe("item-box");
    expect(JSON.stringify(r)).not.toContain("Previous page");
  });

  it("keeps a collapsed-items marker such as 'and N more items'", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Arriving December 2",
                items: [{ asin: "B0FAKE0013", title: "Fake Widget Thirteen" }],
                afterItems: `<div class="a-row"><span class="a-size-small">and 4 more items</span></div>`,
              },
            ],
          }),
        ],
      }),
    );
    const s = r.data.orders[0]?.shipments[0];
    expect(s?.more_items).toEqual({ text: "and 4 more items", count: 4 });
    expect(r.other_sections).toEqual([]);
  });

  it("falls back to the product-title element, image alt and data-asin", () => {
    const html = `<li><span class="a-list-item"><div class="x">
      <div class="yohtmlc-product-title"></div><img alt="Alt Title Only" src="${FAKE.imageUrl}">
      <span data-asin="B0FAKE0014"></span></div></span></li>`;
    const r = parseOrderList(
      page({
        cards: [orderCard({ boxes: [{ primary: "Arriving December 2", afterItems: html }] })],
      }),
    );
    const item = r.data.orders[0]?.shipments[0]?.items[0];
    expect(item?.title).toBe("Alt Title Only");
    expect(item?.asin).toBe("B0FAKE0014");
    expect(r.meta.strategies["order.shipment.items"]).toBe("product-title");
    expect(r.meta.strategies["order.item.title"]).toBe("image-alt");
    expect(r.meta.strategies["order.item.asin"]).toBe("data-attr");
  });
});

describe("actions", () => {
  it("returns labels for everything and a path only for read-only destinations", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Delivered November 18",
                items: [{ asin: "B0FAKE0001", title: "Fake Widget One" }],
                actions: [
                  {
                    key: "track_package",
                    label: "Track package",
                    href: "/progress-tracker/package?itemId=fakeitem0001&ref=ppx_fake",
                  },
                  {
                    key: "veo",
                    label: "View or edit order",
                    href: "/your-orders/order-details?orderID=000-0000000-0000001&ref=ppx_fake",
                  },
                  {
                    key: "return_replace",
                    label: "Return or replace items",
                    href: "/spr/returns/cart?orderId=000-0000000-0000001",
                  },
                  {
                    key: "cancel_items",
                    label: "Cancel items",
                    href: "/gp/css/cancel/view.html?orderID=000-0000000-0000001",
                  },
                  {
                    key: "product_support",
                    label: "Get product support",
                    href: "/ps/product-support/order?orderId=000-0000000-0000001",
                  },
                  {
                    key: "gcx_share_gift_receipt",
                    label: "Share gift receipt",
                    href: "/gcx/-/ty/gr/000-0000000-0000001/shipment",
                    hidden: true,
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );
    const acts = r.data.orders[0]?.shipments[0]?.actions ?? [];
    expect(acts).toEqual([
      {
        label: "Track package",
        key: "track_package",
        path: "/progress-tracker/package?itemId=fakeitem0001",
      },
      {
        label: "View or edit order",
        key: "veo",
        path: "/your-orders/order-details?orderID=000-0000000-0000001",
      },
      { label: "Return or replace items", key: "return_replace" },
      { label: "Cancel items", key: "cancel_items" },
      { label: "Get product support", key: "product_support" },
      { label: "Share gift receipt", key: "gcx_share_gift_receipt", collapsed: true },
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain("/spr/returns");
    expect(json).not.toContain("/gp/css/cancel");
    expect(json).not.toContain("ats=");
    expect(json).not.toContain("FAKETOKEN");
    expect(json).not.toContain("More options");
  });

  it("falls back to the right column when there is no collapsible list", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Arriving December 2",
                items: [{ asin: "B0FAKE0001", title: "Fake Widget One" }],
                rawActions: `<span class="a-button"><span class="a-button-inner"><a class="a-button-text" role="button" href="/progress-tracker/package?itemId=fakeitem0009">Track package</a></span></span>`,
              },
            ],
          }),
        ],
      }),
    );
    const s = r.data.orders[0]?.shipments[0];
    expect(s?.actions.some((a) => a.label === "Track package")).toBe(true);
    expect(s?.tracking_path).toBe("/progress-tracker/package?itemId=fakeitem0009");
  });

  it("allowlist is fail-closed", () => {
    expect(isReadOnlyPath("/your-orders/order-details?orderID=x")).toBe(true);
    expect(isReadOnlyPath("/gp/css/summary/print.html?orderID=x")).toBe(true);
    expect(isReadOnlyPath("/progress-tracker/package?x=1")).toBe(true);
    expect(isReadOnlyPath("/dp/B0FAKE0001")).toBe(true);
    expect(isReadOnlyPath("/spr/returns/cart?orderId=x")).toBe(false);
    expect(isReadOnlyPath("/gp/buyagain?ats=x")).toBe(false);
    expect(isReadOnlyPath("/gp/css/cancel/view.html")).toBe(false);
    expect(isReadOnlyPath("/your-orders/order-details-evil")).toBe(false);
    expect(isReadOnlyPath("")).toBe(false);
  });
});

describe("strategy fallbacks", () => {
  it("finds cards by content id and the order id from the slot id", () => {
    const card = orderCard({ noIdElement: true }).replace(
      'class="order-card js-order-card"',
      'class="some-new-class"',
    );
    const r = parseOrderList(page({ cards: [card] }));
    expect(r.data.orders).toHaveLength(1);
    expect(r.meta.strategies["orders"]).toBe("csa-content-id");
    expect(r.data.orders[0]?.order_id).toBe("000-0000000-0000001");
    expect(r.meta.strategies["order.order_id"]).toBe("slot-id");
  });

  it("falls back to the details link for the order id", () => {
    const card = orderCard({ noIdElement: true })
      .replace('data-csa-c-slot-id="amzn1.yourorders.order-card.000-0000000-0000001"', "")
      .replace('class="order-card js-order-card"', 'class="js-order-card"');
    const r = parseOrderList(page({ cards: [card] }));
    expect(r.data.orders[0]?.order_id).toBe("000-0000000-0000001");
    expect(r.meta.strategies["order.order_id"]).toBe("details-link");
    expect(r.meta.strategies["orders"]).toBe("csa-content-id");
  });

  it("uses the select name and the dropdown prompt when ids and selected are missing", () => {
    const form = timeFilterForm("5 orders", "year-2025")
      .replace('id="time-filter"', "")
      .replace(/ selected/g, "");
    const r = parseOrderList(page({ timeFilter: form }));
    expect(r.meta.strategies["time_filter"]).toBe("select-name");
    expect(r.data.time_filter?.selected_value).toBe("year-2025");
  });

  it("reads a bare count row when the time-filter form is absent", () => {
    const row = `<div class="a-row a-spacing-base"><b>71 orders</b> placed in</div>`;
    const r = parseOrderList(
      page({ timeFilter: row, url: `${FAKE.host}/your-orders/orders?orderFilter=cancelled` }),
    );
    expect(r.data.time_filter).toBeUndefined();
    expect(r.data.order_count).toBe(71);
    expect(r.data.order_count_text).toBe("71 orders placed in");
    expect(r.meta.strategies["order_count"]).toBe("count-row");
  });

  it("selects the only link-less tab when no tab is marked", () => {
    const tabs = `<div class="page-tabs"><ul><li class="page-tabs__tab">Orders</li>
      <li class="page-tabs__tab"><a href="/gp/buyagain">Buy Again</a></li></ul></div>`;
    const r = parseOrderList(page({ tabs }));
    expect(r.data.selected_tab).toBe("orders");
  });

  it("uses the order header date when the placed label is unknown", () => {
    const card = orderCard({}).replace("Order placed", "Fake label");
    const r = parseOrderList(page({ cards: [card] }));
    expect(r.data.orders[0]?.placed?.iso).toBe("2026-11-16");
    expect(r.meta.strategies["order.placed"]).toBe("header-date");
    expect(r.data.orders[0]?.header_fields).toEqual([
      { label: "Fake label", value: "November 16, 2026" },
    ]);
  });

  it("flags digital order ids", () => {
    const r = parseOrderList(page({ cards: [orderCard({ id: "D01-0000000-0000001" })] }));
    expect(r.data.orders[0]?.order_type).toBe("digital");
    expect(r.data.orders[0]?.order_id).toBe("D01-0000000-0000001");
  });
});

describe("pagination", () => {
  it("reads the last page (Next disabled, Previous linked, ellipsis)", () => {
    const bar = `<div class="a-row"><div class="a-text-center"><ul class="a-pagination">
      <li class="a-normal"><a href="/your-orders/orders?timeFilter=year-2026&page=18&ref_=fake">&larr; Previous</a></li>
      <li class="a-normal"><a href="/your-orders/orders?timeFilter=year-2026&page=0&ref_=fake">1</a></li>
      <li class="a-disabled">&hellip;</li>
      <li class="a-normal"><a href="/your-orders/orders?timeFilter=year-2026&page=18&ref_=fake">19</a></li>
      <li class="a-selected"><a href="/your-orders/orders?timeFilter=year-2026&page=19&ref_=fake">20</a></li>
      <li class="a-last a-disabled">Next &rarr;</li></ul></div></div>`;
    const r = parseOrderList(page({ pagination: bar }));
    const p = r.data.pagination;
    expect(p?.has_next).toBe(false);
    expect(p?.next_path).toBeUndefined();
    expect(p?.has_prev).toBe(true);
    expect(p?.prev_path).toBe("/your-orders/orders?timeFilter=year-2026&page=18");
    expect(p?.has_gap).toBe(true);
    expect(p?.current_label).toBe("20");
    expect(p?.current_index).toBe(19);
    expect(p?.last_label).toBe("20");
  });

  it("works out step and base for a start-index style bar", () => {
    const bar = pagination("/your-orders/orders?orderFilter=open", 2, 3, {
      param: "startIndex",
      step: 10,
    });
    const r = parseOrderList(page({ pagination: bar }));
    const p = r.data.pagination;
    expect(p?.index_param).toBe("startIndex");
    expect(p?.index_step).toBe(10);
    expect(p?.index_base).toBe(0);
    expect(p?.current_index).toBe(10);
    expect(p?.next_path).toBe("/your-orders/orders?orderFilter=open&startIndex=20");
    expect(p?.prev_path).toBe("/your-orders/orders?orderFilter=open&startIndex=0");
  });

  it("has no pagination object when the bar is absent", () => {
    const r = parseOrderList(page({ pagination: null }));
    expect(r.data.pagination).toBeUndefined();
  });
});

describe("empty and unusual pages", () => {
  it("parses an empty year (0 orders) without throwing", () => {
    const empty = `<div class="a-section a-spacing-top-large"><span>You have not placed any orders in 2018.</span></div>`;
    const r = parseOrderList(
      page({
        cards: [],
        timeFilter: timeFilterForm("0 orders", "year-2025"),
        pagination: null,
        before: empty,
        url: `${FAKE.host}/your-orders/orders?timeFilter=year-2018`,
      }),
    );
    expect(r.data.orders).toEqual([]);
    expect(r.data.order_count).toBe(0);
    expect(r.data.order_count_text).toBe("0 orders placed in");
    expect(r.data.empty_text).toBe("You have not placed any orders in 2018.");
    expect(r.data.requested.time_filter_applied).toBe(false);
    expect(r.meta.warnings.some((w) => w.includes("timeFilter=year-2018"))).toBe(true);
    expect(r.other_sections).toEqual([]);
  });

  it("warns when a requested orderFilter is not honored by the page", () => {
    const r = parseOrderList(
      page({ url: `${FAKE.host}/your-orders/orders?orderFilter=cancelled&page=2` }),
    );
    expect(r.data.requested).toMatchObject({
      order_filter: "cancelled",
      page: 2,
      order_filter_applied: false,
    });
    expect(r.meta.warnings.some((w) => w.includes("orderFilter=cancelled"))).toBe(true);
  });

  it("reports a requested orderFilter as applied when its tab is selected", () => {
    const tabs = `<div class="page-tabs"><ul>
      <li class="page-tabs__tab"><a href="/your-orders/orders?ref_=fake&orderFilter=open">Orders</a></li>
      <li class="page-tabs__tab page-tabs__tab--selected">Not Yet Shipped</li></ul></div>`.replace(
      '<li class="page-tabs__tab page-tabs__tab--selected">Not Yet Shipped</li>',
      '<li class="page-tabs__tab page-tabs__tab--selected"><a href="/your-orders/orders?orderFilter=open">Not Yet Shipped</a></li>',
    );
    const r = parseOrderList(
      page({ tabs, url: `${FAKE.host}/your-orders/orders?orderFilter=open` }),
    );
    expect(r.data.requested.order_filter_applied).toBe(true);
    expect(r.data.selected_tab).toBe("not_yet_shipped");
  });

  it("throws layout_unrecognized for a page with no order list structure", () => {
    const cap: Capture = {
      kind: "order_list",
      url: `${FAKE.host}/x`,
      final_url: `${FAKE.host}/x`,
      captured_at: "2000-01-01T00:00:00.000Z",
      html: "<html><body><div id='a-page'><p>Something unrelated</p></div></body></html>",
    };
    expect(() => parseOrderList(cap)).toThrow(RfError);
    try {
      parseOrderList(cap);
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("falls back gracefully when the url is unparsable", () => {
    const cap = page();
    cap.final_url = "http://[bad";
    cap.url = "http://[bad";
    const r = parseOrderList(cap);
    expect(r.data.requested.time_filter).toBeNull();
  });
});

describe("lossless accounting", () => {
  it("reports an unknown block at page level in other_sections", () => {
    const cap = page({
      after: `<div id="fake-new-feature" class="a-section"><h2>Fake New Feature</h2><p>Invented unknown page block text.</p></div>`,
    });
    const r = parseOrderList(cap);
    const hit = r.other_sections.find((s) => s.text.includes("Invented unknown page block text."));
    expect(hit).toBeDefined();
    expect(hit?.heading).toBe("Fake New Feature");
    expect(JSON.stringify(r.data)).not.toContain("Invented unknown");
  });

  it("reports an unknown block inside a delivery box and inside an item", () => {
    const r = parseOrderList(
      page({
        cards: [
          orderCard({
            boxes: [
              {
                primary: "Arriving December 2",
                items: [
                  {
                    asin: "B0FAKE0001",
                    title: "Fake Widget One",
                    // An unknown row would be read as a notice; an unknown sibling element is not.
                  },
                ],
                afterItems: `<div class="fake-box-banner"><p>Invented delivery box banner.</p></div>`,
              },
            ],
          }).replace(
            "</div></div></div></div>\n  </div></div>",
            `</div></div></div></div><div class="fake-card-footer"><p>Invented card footer text.</p></div>\n  </div></div>`,
          ),
        ],
      }),
    );
    const text = r.other_sections.map((s) => s.text).join(" | ");
    expect(text).toContain("Invented delivery box banner.");
    expect(text).toContain("Invented card footer text.");
  });

  it("accounts for nearly all visible text and leaves nothing unparsed on a clean page", () => {
    const cap = page({
      cards: [
        orderCard({
          boxes: [
            {
              primary: "Delivered November 18",
              secondary: "Left at the fake door.",
              items: [
                {
                  asin: "B0FAKE0001",
                  title: "Fake Widget One",
                  details: "Color: Fake Blue",
                  notices: ["Return window closed on January 28, 2026"],
                },
              ],
              actions: [
                {
                  key: "track_package",
                  label: "Track package",
                  href: "/progress-tracker/package?itemId=fakeitem0001",
                },
              ],
            },
          ],
        }),
      ],
    });
    const r = parseOrderList(cap);
    const opts = orderListLosslessOptions(parseDocument(cap.html));
    const ratio = expectLosslessCoverage(r, cap, 0.99, opts);
    expect(ratio).toBeGreaterThanOrEqual(0.99);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.other_sections).toEqual([]);
  });

  it("counts unmarked stray text as other or unparsed, not as typed data", () => {
    const cap = page({ after: `<p>Stray invented sentence outside any block.</p>` });
    const r = parseOrderList(cap);
    const inOther = r.other_sections.some((s) => s.text.includes("Stray invented sentence"));
    expect(inOther || r.meta.unparsed_text_chars > 0).toBe(true);
  });
});

describe("parseDateText", () => {
  it("parses full dates, abbreviations and ordinals", () => {
    expect(parseDateText("Delivered November 9, 2026")).toEqual({
      raw: "November 9, 2026",
      iso: "2026-11-09",
    });
    expect(parseDateText("Arriving Dec. 3rd, 2026")?.iso).toBe("2026-12-03");
    expect(parseDateText("Sept 4 2026")?.iso).toBe("2026-09-04");
  });

  it("parses ranges", () => {
    expect(parseDateText("Arriving December 1 - December 3", "2026-11-20")).toEqual({
      raw: "December 1 - December 3",
      iso: "2026-12-01",
      iso_end: "2026-12-03",
      year_inferred: true,
    });
    expect(parseDateText("Arriving Dec 30 - Jan 2", "2026-12-20")).toMatchObject({
      iso: "2026-12-30",
      iso_end: "2027-01-02",
    });
    expect(parseDateText("Arriving Dec 1 to 3", "2026-11-20")).toMatchObject({
      iso: "2026-12-01",
      iso_end: "2026-12-03",
    });
  });

  it("leaves iso out without a year and without a reference date", () => {
    expect(parseDateText("Arriving December 1")).toEqual({ raw: "December 1" });
  });

  it("rejects impossible dates and relative words", () => {
    expect(parseDateText("February 30, 2026")?.iso).toBeUndefined();
    expect(parseDateText("Arriving today")).toBeUndefined();
    expect(parseDateText("Arriving Monday")).toBeUndefined();
    expect(parseDateText(undefined)).toBeUndefined();
    expect(parseDateText("May arrive soon")).toBeUndefined();
  });
});

describe("cleanLink", () => {
  it("strips tracking params and the ref path segment, keeps other params", () => {
    expect(cleanLink("/dp/B0FAKE0001?ref=ppx_fake&th=1")).toEqual({
      path: "/dp/B0FAKE0001?th=1",
      external: false,
    });
    expect(cleanLink("/your-orders/search/ref=ppx_fake")?.path).toBe("/your-orders/search");
    expect(cleanLink("https://www.amazon.com/gp/buyagain?ref_=x")?.path).toBe("/gp/buyagain");
  });

  it("marks other hosts external and rejects non-links", () => {
    expect(cleanLink("https://pay.example.com/a?ref=x")).toEqual({
      path: "https://pay.example.com/a",
      external: true,
    });
    expect(cleanLink("javascript:void(0)")).toBeUndefined();
    expect(cleanLink("#frag")).toBeUndefined();
    expect(cleanLink("")).toBeUndefined();
    expect(cleanLink(undefined)).toBeUndefined();
  });
});
