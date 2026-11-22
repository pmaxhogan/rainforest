import { describe, expect, it } from "vitest";
import { FAKE, RfError, type Capture } from "@rainforest/core";
import { parseDocument } from "../../src/dom.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";
import { orderSearchLosslessOptions, parseOrderSearch } from "../../src/pages/order-search.ts";

// ---- synthetic page builders (invented content, real structure)

const NAV = `<header id="navbar-main"><div id="navbar"><span>Fake store navigation</span></div></header>`;

interface RowSpec {
  asin: string;
  title: string;
  orderId: string;
  ordered: string;
  extra?: string;
  noTitleLink?: boolean;
}

function row(r: RowSpec, n: number): string {
  const title =
    r.noTitleLink === true
      ? ""
      : `<div class="a-row a-spacing-small"><div class="a-section a-spacing-none"><a class="a-link-normal" href="/dp/${r.asin}?ref_=ppx_fake_search_asin_title_${n}"><p>${r.title}</p></a></div></div>`;
  return `<div class="a-section a-spacing-large a-spacing-top-large"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
    <div class="a-text-center a-fixed-left-grid-col a-col-left"><div><a class="a-link-normal" href="/dp/${r.asin}?ref_=ppx_fake_search_asin_image_${n}"><img alt="${r.title}" title="${r.title}" src="${FAKE.imageUrl}" height="90" width="90"></a></div></div>
    <div class="a-fixed-left-grid-col a-col-right">
      <div class="a-row a-spacing-small"><a class="a-link-normal" href="/your-orders/order-details?orderID=${r.orderId}&ref_=ppx_fake_search_order_details_${n}"><span>View order details</span></a><i class="a-icon a-icon-text-separator" role="presentation"></i><span>Ordered on ${r.ordered}</span></div>
      ${title}
      ${r.extra ?? ""}
      <div class="a-row"><div class="a-section a-spacing-none">
        <span class="a-button a-button-primary"><span class="a-button-inner"><a href="/gp/buyagain?ats=FAKETOKEN${r.asin}&ref_=ppx_fake_search_bia" class="a-button-text">Buy it again</a></span></span>
        <span class="a-button a-button-base"><span class="a-button-inner"><a href="/your-orders/pop?orderId=${r.orderId}&lineItemId=fakeline${n}&shipmentId=FAKESHIP${n}&packageId=1&asin=${r.asin}&ref_=ppx_fake_search_pop" class="a-button-text">View your item</a></span></span>
      </div></div>
    </div>
  </div></div></div>`;
}

interface PageSpec {
  query?: string;
  rows?: RowSpec[];
  summary?: string | null;
  pagination?: string;
  empty?: boolean;
  after?: string;
  url?: string;
  boxValue?: string;
}

function pagination(current: number, last: number, query: string): string {
  const href = (p: number): string =>
    `/your-orders/search?page=${p}&search=${encodeURIComponent(query)}&ref_=ppx_fake_pagination_pg_${current}`;
  const pages = Array.from({ length: last }, (_, i) => i + 1)
    .map(
      (p) =>
        `<li class="${p === current ? "a-selected" : "a-normal"}"><a href="${href(p)}">${p}</a></li>`,
    )
    .join("");
  const prev =
    current === 1
      ? `<li class="a-disabled"><span class="larr" data-rf-hidden="1">&larr;</span>Previous</li>`
      : `<li><a href="${href(current - 1)}"><span class="larr" data-rf-hidden="1">&larr;</span>Previous</a></li>`;
  const next =
    current === last
      ? `<li class="a-disabled a-last">Next<span class="rarr" data-rf-hidden="1">&rarr;</span></li>`
      : `<li class="a-last"><a href="${href(current + 1)}">Next<span class="rarr" data-rf-hidden="1">&rarr;</span></a></li>`;
  return `<nav class="a-text-center"><ul class="a-pagination">${prev}${pages}${next}</ul></nav>`;
}

function page(spec: PageSpec): Capture {
  const query = spec.query ?? "desk lamp";
  const rows = spec.rows ?? [];
  const summary =
    spec.summary === null || spec.empty === true
      ? ""
      : `<div class="a-section a-spacing-small"><p class="hzsearch-results-summary" role="heading">${spec.summary ?? `${rows.length} orders matching "<strong>${query}</strong>"`}</p></div>`;
  const empty =
    spec.empty === true
      ? `<div class="a-section a-spacing-small"><p class="a-text-bold" role="heading">No results found. Please try another search.</p><p>You can search by product title, order number, address, or recipient.</p></div>`
      : "";
  const html = `<!doctype html><html><head><title>Search results</title></head><body><div id="a-page">${NAV}
  <div class="a-section a-spacing-large hzsearch-content-container" role="main">
    <div class="a-section a-spacing-medium a-spacing-top-small"><ul class="a-unordered-list a-horizontal hzsearch-breadcrumbs">
      <li class="hzsearch-breadcrumbs__crumb"><span class="a-list-item"><a class="a-link-normal" href="/gp/css/homepage.html?ref_=ppx_fake_bc">Your Account</a></span></li>
      <li class="hzsearch-breadcrumbs__crumb hzsearch-breadcrumbs__crumb--divider"><span class="a-list-item">&rsaquo;</span></li>
      <li class="hzsearch-breadcrumbs__crumb"><span class="a-list-item"><a class="a-link-normal" href="/gp/your-account/order-history?ref_=ppx_fake_bc">Your Orders</a></span></li>
      <li class="hzsearch-breadcrumbs__crumb hzsearch-breadcrumbs__crumb--divider"><span class="a-list-item">&rsaquo;</span></li>
      <li class="hzsearch-breadcrumbs__crumb hzsearch-breadcrumbs__crumb--current"><span class="a-list-item"><span class="a-color-state">Search results</span></span></li>
    </ul></div>
    <div class="a-row a-spacing-mini">
      <div class="a-column a-span6"><div class="a-section a-spacing-none"><title data-rf-hidden="1">Hidden title</title><h1>Search results</h1></div></div>
      <div class="a-column a-span6 a-span-last"><div class="a-section a-spacing-none"><div class="search-bar"><form method="get" action="/your-orders/search">
        <div class="search-bar__input-container"><div class="a-search a-span12 a-spacing-none"><i class="a-icon a-icon-search"></i><input type="search" name="search" value="${spec.boxValue ?? query}" class="a-input-text a-span12 hzsearch-text-input"></div><input type="hidden" name="ref_" value="ppx_fake_sb"></div>
        <div class="search-bar__button-container"><span class="a-button a-button-search"><span class="a-button-inner"><input class="a-button-input" type="submit"><span class="a-button-text">Search Orders</span></span></span></div>
      </form></div></div></div>
    </div>
    ${summary}${empty}
    <div class="a-section a-spacing-none a-padding-small">${rows.map((r, i) => row(r, i + 1)).join(`<hr class="a-divider-normal">`)}<script>window.fakeTelemetry = 1;</script></div>
    ${spec.pagination ?? ""}
    ${spec.after ?? ""}
  </div></div></body></html>`;
  const url =
    spec.url ??
    `${FAKE.host}/your-orders/search/ref=ppx_fake_search?opt=ab&search=${encodeURIComponent(query)}`;
  return {
    kind: "order_search",
    url,
    final_url: url,
    captured_at: "2020-07-01T12:00:00.000Z",
    html,
  };
}

const LAMP: RowSpec = {
  asin: "B0FAKE0001",
  title: "Invented Brand Desk Lamp With A Long Descriptive Title",
  orderId: "000-0000000-0000001",
  ordered: "November 2, 2026",
};
const BULB: RowSpec = {
  asin: "B0FAKE0002",
  title: "Invented Brand Lamp Bulbs, Pack of 4",
  orderId: "000-0000000-0000001",
  ordered: "November 2, 2026",
};
const SHADE: RowSpec = {
  asin: "B0FAKE0003",
  title: "Invented Brand Desk Lamp Shade",
  orderId: "000-0000000-0000002",
  ordered: "March 9, 2025",
};

describe("parseOrderSearch", () => {
  it("reads one row per matching item with its order and date", () => {
    const cap = page({
      rows: [LAMP, BULB, SHADE],
      summary: `2 orders matching "<strong>desk lamp</strong>"`,
    });
    const r = parseOrderSearch(cap);
    const d = r.data;
    expect(d.heading).toBe("Search results");
    expect(d.breadcrumbs).toEqual(["Your Account", "Your Orders", "Search results"]);
    expect(d.requested).toEqual({ query: "desk lamp", page: null });
    expect(d.query).toBe("desk lamp");
    expect(d.match_text).toBe('2 orders matching "desk lamp"');
    expect(d.order_count).toBe(2);
    expect(d.empty_text).toBeUndefined();
    expect(d.pagination).toBeUndefined();
    expect(d.results).toEqual([
      {
        index: 0,
        asin: "B0FAKE0001",
        title: LAMP.title,
        url_path: "/dp/B0FAKE0001",
        image_url: FAKE.imageUrl,
        order_id: "000-0000000-0000001",
        order_details_path: "/your-orders/order-details?orderID=000-0000000-0000001",
        ordered: { raw: "November 2, 2026", iso: "2026-11-02" },
        actions: [{ label: "Buy it again" }, { label: "View your item" }],
      },
      {
        index: 1,
        asin: "B0FAKE0002",
        title: BULB.title,
        url_path: "/dp/B0FAKE0002",
        image_url: FAKE.imageUrl,
        order_id: "000-0000000-0000001",
        order_details_path: "/your-orders/order-details?orderID=000-0000000-0000001",
        ordered: { raw: "November 2, 2026", iso: "2026-11-02" },
        actions: [{ label: "Buy it again" }, { label: "View your item" }],
      },
      {
        index: 2,
        asin: "B0FAKE0003",
        title: SHADE.title,
        url_path: "/dp/B0FAKE0003",
        image_url: FAKE.imageUrl,
        order_id: "000-0000000-0000002",
        order_details_path: "/your-orders/order-details?orderID=000-0000000-0000002",
        ordered: { raw: "March 9, 2025", iso: "2025-03-09" },
        actions: [{ label: "Buy it again" }, { label: "View your item" }],
      },
    ]);
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.strategies).toMatchObject({
      results: "left-grid",
      match_text: "summary-class",
      query: "search-box",
      "result.title": "title-link",
      "result.asin": "url",
      "result.order_id": "order-link",
      "result.ordered": "order-row",
    });
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.other_sections).toEqual([]);
  });

  it("never attaches a path to a button that is not a read-only destination", () => {
    const d = parseOrderSearch(page({ rows: [LAMP] })).data;
    const paths = d.results.flatMap((h) => h.actions.map((a) => a.path));
    expect(paths).toEqual([undefined, undefined]);
    expect(JSON.stringify(d)).not.toContain("buyagain");
    expect(JSON.stringify(d)).not.toContain("your-orders/pop");
  });

  it("reads the pagination bar: first, middle and last page", () => {
    const rows = [LAMP, BULB, SHADE];
    const first = parseOrderSearch(
      page({
        rows,
        summary: `17 orders matching "<strong>desk lamp</strong>"`,
        pagination: pagination(1, 4, "desk lamp"),
      }),
    ).data;
    expect(first.order_count).toBe(17);
    expect(first.pagination).toMatchObject({
      has_prev: false,
      has_next: true,
      current_label: "1",
      last_label: "4",
      index_param: "page",
      index_base: 1,
      index_step: 1,
      next_path: "/your-orders/search?page=2&search=desk+lamp",
    });
    const middle = parseOrderSearch(
      page({
        rows,
        pagination: pagination(2, 4, "desk lamp"),
        url: `${FAKE.host}/your-orders/search?page=2&search=desk+lamp`,
      }),
    ).data;
    expect(middle.requested).toEqual({ query: "desk lamp", page: 2 });
    expect(middle.pagination).toMatchObject({ has_prev: true, has_next: true, current_label: "2" });
    const last = parseOrderSearch(page({ rows, pagination: pagination(4, 4, "desk lamp") })).data;
    expect(last.pagination).toMatchObject({ has_prev: true, has_next: false, current_label: "4" });
  });

  it("reports a search with no match as empty, with the page's own message", () => {
    const r = parseOrderSearch(page({ query: "zzqx vvkk", empty: true }));
    expect(r.data.results).toEqual([]);
    expect(r.data.order_count).toBeUndefined();
    expect(r.data.match_text).toBeUndefined();
    expect(r.data.query).toBe("zzqx vvkk");
    expect(r.data.empty_text).toBe(
      "No results found. Please try another search. You can search by product title, order number, address, or recipient.",
    );
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("refuses a page with no rows that does not say nothing matched", () => {
    // The search form alone is not a results page: answering "no results" would be wrong.
    for (const cap of [
      page({ rows: [], summary: null }),
      page({ rows: [], summary: `4 orders matching "<strong>desk lamp</strong>"` }),
    ]) {
      let error: unknown;
      try {
        parseOrderSearch(cap);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RfError);
      expect((error as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("refuses a page that is not an order search at all", () => {
    const cap: Capture = {
      kind: "order_search",
      url: `${FAKE.host}/your-orders/search?search=desk+lamp`,
      final_url: `${FAKE.host}/your-orders/search?search=desk+lamp`,
      captured_at: "2020-07-01T12:00:00.000Z",
      html: `<!doctype html><html><body><div id="a-page">${NAV}<div><h2>Something else entirely</h2><p>Unrelated text.</p></div></div></body></html>`,
    };
    expect(() => parseOrderSearch(cap)).toThrow(RfError);
  });

  it("falls back to the order link when the grid class is gone", () => {
    const cap = page({ rows: [LAMP, SHADE] });
    cap.html = cap.html.replaceAll("a-fixed-left-grid", "fake-renamed-grid");
    const r = parseOrderSearch(cap);
    expect(r.meta.strategies["results"]).toBe("order-link");
    expect(r.data.results.map((h) => [h.asin, h.order_id, h.ordered?.iso, h.title])).toEqual([
      ["B0FAKE0001", "000-0000000-0000001", "2026-11-02", LAMP.title],
      ["B0FAKE0003", "000-0000000-0000002", "2025-03-09", SHADE.title],
    ]);
  });

  it("falls back to the image text when a row has no title link", () => {
    const r = parseOrderSearch(page({ rows: [{ ...LAMP, noTitleLink: true }] }));
    expect(r.data.results[0]?.title).toBe(LAMP.title);
    expect(r.data.results[0]?.asin).toBe("B0FAKE0001");
    expect(r.meta.strategies["result.title"]).toBe("image-alt");
  });

  it("falls back to the text anchor for the summary and to the summary for the query", () => {
    const cap = page({ rows: [LAMP], summary: `1 order matching "<strong>desk lamp</strong>"` });
    cap.html = cap.html
      .replace("hzsearch-results-summary", "fake-renamed-summary")
      .replace(`name="search" value="desk lamp"`, `name="search"`);
    const r = parseOrderSearch(cap);
    expect(r.data.order_count).toBe(1);
    expect(r.data.query).toBe("desk lamp");
    expect(r.meta.strategies).toMatchObject({ match_text: "text-anchor", query: "summary" });
  });

  it("warns when the page shows results for another query", () => {
    const r = parseOrderSearch(page({ rows: [LAMP], boxValue: "floor lamp" }));
    expect(r.meta.warnings).toEqual(["the page's search box does not show the requested query"]);
  });

  it("keeps text it has no field for in other_sections (lossless)", () => {
    const cap = page({
      rows: [
        {
          ...LAMP,
          extra: `<div class="a-row"><span class="a-size-small">Invented new badge text</span></div>`,
        },
      ],
      after: `<div class="a-section fake-new-widget"><h2>Invented widget</h2><p>Widget body text.</p></div>`,
    });
    const r = parseOrderSearch(cap);
    const other = r.other_sections.map((s) => s.text).join(" | ");
    expect(other).toContain("Invented new badge text");
    expect(other).toContain("Widget body text.");
    expect(r.data.results).toHaveLength(1);
    const opts = orderSearchLosslessOptions(parseDocument(cap.html));
    expect(expectLosslessCoverage(r, cap, 0.99, opts)).toBeGreaterThanOrEqual(0.99);
  });

  it("skips rows the browser did not render", () => {
    const cap = page({ rows: [LAMP, SHADE] });
    cap.html = cap.html.replace(
      `<div class="a-section a-spacing-large a-spacing-top-large">`,
      `<div class="a-section a-spacing-large a-spacing-top-large" data-rf-hidden="1">`,
    );
    expect(parseOrderSearch(cap).data.results.map((h) => h.asin)).toEqual(["B0FAKE0003"]);
  });
});
