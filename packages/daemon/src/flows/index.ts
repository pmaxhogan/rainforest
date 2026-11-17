import { RfError, type ToolDef } from "@rainforest/core";
import type { SessionProvider } from "../browser-controller.ts";
import type { ToolContext, ToolOutput, ToolRouter } from "../interfaces.ts";
import { getBrowsingHistory, getCart, listSubscriptions } from "./account.ts";
import { getMedia, getReviewSummary, getReviews, getVariants } from "./catalog.ts";
import type { Flow } from "./common.ts";
import { getList, listLists } from "./lists.ts";
import { getInvoice, getOrder, listOrders } from "./orders.ts";
import { getPriceHistory } from "./price.ts";

/**
 * Typed flows only: each tool name maps to one function. There is no generic
 * "navigate" or "click selector" primitive reachable from the hub.
 */
export const FLOWS: Readonly<Record<string, Flow>> = {
  get_cart: getCart,
  list_subscriptions: listSubscriptions,
  get_browsing_history: getBrowsingHistory,
  list_orders: listOrders,
  get_order: getOrder,
  get_invoice: getInvoice,
  list_lists: listLists,
  get_list: getList,
  get_price_history: getPriceHistory,
  get_variants: getVariants,
  get_media: getMedia,
  get_reviews: getReviews,
  get_review_summary: getReviewSummary,
};

export function createRouter(browser: SessionProvider, now: () => number = Date.now): ToolRouter {
  return {
    async call(
      tool: ToolDef,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolOutput> {
      const flow = Object.hasOwn(FLOWS, tool.name) ? FLOWS[tool.name] : undefined;
      if (!flow)
        throw new RfError(
          "unsupported",
          `"${tool.name}" is not available in this daemon version yet`,
        );
      const data = await flow(args, { browser, now, signal: ctx.signal });
      return { data };
    },
  };
}
