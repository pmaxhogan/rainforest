import { RfError, type ToolDef } from "@rainforest/core";
import type { SessionProvider } from "../browser-controller.ts";
import type { ToolContext, ToolOutput, ToolRouter } from "../interfaces.ts";
import { addToCart } from "./add-to-cart.ts";
import { getBrowsingHistory, getCart, getSearchHistory, listSubscriptions } from "./account.ts";
import {
  deleteSavedItem,
  moveToCart,
  removeFromCart,
  saveForLater,
  setCartQuantity,
} from "./cart-writes.ts";
import { getMedia, getReviewSummary, getReviews, getVariants } from "./catalog.ts";
import type { Flow } from "./common.ts";
import { showOnScreen } from "./handoff.ts";
import {
  addToList,
  createList,
  deleteList,
  moveListItem,
  removeFromList,
  updateList,
  updateListItem,
} from "./list-writes.ts";
import { getList, listLists } from "./lists.ts";
import { getInvoice, getOrder, listOrders, searchOrders } from "./orders.ts";
import { getPriceHistory } from "./price.ts";
import { getBuyingOptions, getProduct, search } from "./shopping.ts";

/**
 * Typed flows only: each tool name maps to one function. There is no generic
 * "navigate" or "click selector" primitive reachable from the hub.
 */
export const FLOWS: Readonly<Record<string, Flow>> = {
  get_cart: getCart,
  list_subscriptions: listSubscriptions,
  get_browsing_history: getBrowsingHistory,
  get_search_history: getSearchHistory,
  list_orders: listOrders,
  search_orders: searchOrders,
  get_order: getOrder,
  get_invoice: getInvoice,
  list_lists: listLists,
  get_list: getList,
  get_price_history: getPriceHistory,
  show_on_screen: showOnScreen,
  add_to_cart: addToCart,
  remove_from_cart: removeFromCart,
  save_for_later: saveForLater,
  move_to_cart: moveToCart,
  delete_saved_item: deleteSavedItem,
  set_cart_quantity: setCartQuantity,
  remove_from_list: removeFromList,
  create_list: createList,
  update_list: updateList,
  delete_list: deleteList,
  add_to_list: addToList,
  update_list_item: updateListItem,
  move_list_item: moveListItem,
  search,
  get_product: getProduct,
  get_buying_options: getBuyingOptions,
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
