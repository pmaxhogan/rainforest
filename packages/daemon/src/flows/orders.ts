import { RfError } from "@rainforest/core";
import {
  parseInvoice,
  parseOrderDetails,
  parseOrderList,
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
      return fitToBudget(body, arrayKeys(body), maxCharsOf(args), ctx.now());
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
