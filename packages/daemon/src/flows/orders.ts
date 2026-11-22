import { checkNavigation } from "@rainforest/browser";
import { RfError } from "@rainforest/core";
import {
  parseInvoice,
  parseOrderDetails,
  parseOrderList,
  parseOrderSearch,
  type OrderCard,
} from "@rainforest/parsers";
import {
  AMAZON,
  arrayKeys,
  cursorOrThrow,
  fitToBudget,
  maxCharsOf,
  pageBody,
  readPage,
  type Flow,
} from "./common.ts";

const PAGE_CURSOR = /^orders:(\d{1,3}):([a-z0-9-]{0,24}):([a-z_]{0,20})$/;

/** Map the tool's filter names to what the order list accepts. */
function orderListUrl(timeFilter: string | null, filter: string, page: number): string {
  const params = new URLSearchParams();
  if (filter === "not_yet_shipped") params.set("orderFilter", "open");
  else if (timeFilter) params.set("timeFilter", timeFilter);
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return `${AMAZON}/your-orders/orders${query ? `?${query}` : ""}`;
}

export const listOrders: Flow = async (args, ctx) => {
  let page = 0;
  let timeFilter: string | null =
    typeof args.year === "number"
      ? `year-${args.year}`
      : typeof args.range === "string"
        ? args.range
        : null;
  let filter = typeof args.filter === "string" ? args.filter : "orders";
  if (typeof args.cursor === "string") {
    const match = PAGE_CURSOR.exec(args.cursor);
    if (!match) {
      const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
      if (continued) return continued;
    } else {
      page = Number(match[1]);
      timeFilter = match[2] ? match[2] : null;
      filter = match[3] ? match[3] : "orders";
    }
  }
  if (filter === "archived") {
    throw new RfError(
      "unsupported",
      "Amazon's current order list exposes no archived-orders view; archived orders still appear in their year when listed by year",
    );
  }
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const url = orderListUrl(timeFilter, filter, page);
    const { result, capture } = await readPage(p, url, "account", "order_list", parseOrderList);
    ctx.browser.setSignedIn(true);
    const body = pageBody(result, capture);
    if (filter === "cancelled") {
      // Amazon has no cancelled-only list: cancelled orders appear inline, so filter here.
      const orders = (body.orders as OrderCard[]).filter(
        (o) => o.is_cancelled || o.has_cancelled_shipment,
      );
      body.orders = orders;
      body.filter_note =
        "cancelled orders are filtered from this page of the order list; continue with next_page_cursor for more";
    }
    const pagination = result.data.pagination;
    if (pagination?.has_next) {
      body.next_page_cursor = `orders:${page + 1}:${timeFilter ?? ""}:${filter}`;
    }
    return fitToBudget(body, ["other_sections", "orders"], maxCharsOf(args), ctx.now());
  });
};

/**
 * The order list's own search box: page 1 is what its form submits, later pages are what
 * the results page's pagination links to.
 */
export function orderSearchUrl(query: string, page: number): string {
  const params = new URLSearchParams();
  if (page > 1) {
    params.set("page", String(page));
    params.set("search", query);
    return `${AMAZON}/your-orders/search?${params.toString()}`;
  }
  params.set("opt", "ab");
  params.set("search", query);
  return `${AMAZON}/your-orders/search/ref=ppx_yo2ov_dt_b_search?${params.toString()}`;
}

export const searchOrders: Flow = async (args, ctx) => {
  const query = String(args.query).trim().replace(/\s+/g, " ");
  const page = typeof args.page === "number" ? args.page : 1;
  const url = orderSearchUrl(query, page);
  // The purchase guard refuses some words anywhere in a URL. Say so before any page load,
  // in terms of the query, rather than as a refused navigation.
  if (!checkNavigation(url).allow) {
    throw new RfError(
      "invalid_arguments",
      'that query cannot be searched: it contains wording the purchase guard refuses in any URL (for example "turbo" or "one-click"); use other words from the product title',
    );
  }
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(p, url, "account", "order_search", parseOrderSearch);
    ctx.browser.setSignedIn(true);
    const body = pageBody(result, capture);
    body.page = page;
    if (result.data.pagination?.has_next) body.next_page = page + 1;
    return fitToBudget(body, ["other_sections", "results"], maxCharsOf(args), ctx.now());
  });
};

function mapOrderError(error: unknown): never {
  if (
    error instanceof RfError &&
    error.payload.code === "layout_unrecognized" &&
    error.payload.details?.reason === "error_banner"
  ) {
    throw new RfError(
      "not_found",
      "Amazon could not load that order (unknown order id for this account?)",
    );
  }
  throw error;
}

export const getOrder: Flow = async (args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const url = `${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(String(args.order_id))}`;
    try {
      const { result, capture } = await readPage(
        p,
        url,
        "account",
        "order_details",
        parseOrderDetails,
        { settleMs: 2500 },
      );
      const body = pageBody(result, capture);
      return fitToBudget(body, arrayKeys(body, ["shipments"]), maxCharsOf(args), ctx.now());
    } catch (error) {
      mapOrderError(error);
    }
  });
};

export const getInvoice: Flow = async (args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const url = `${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(String(args.order_id))}`;
    try {
      const { result, capture } = await readPage(p, url, "account", "invoice", parseInvoice, {
        settleMs: 2500,
      });
      const body = pageBody(result, capture);
      return fitToBudget(body, arrayKeys(body), undefined, ctx.now());
    } catch (error) {
      mapOrderError(error);
    }
  });
};
