import { RfError, type ToolDef } from "@rainforest/core";
import type { SessionProvider } from "../browser-controller.ts";
import type { ToolContext, ToolOutput, ToolRouter } from "../interfaces.ts";
import { getBrowsingHistory, getCart, listSubscriptions } from "./account.ts";
import type { Flow } from "./common.ts";

/**
 * Typed flows only: each tool name maps to one function. There is no generic
 * "navigate" or "click selector" primitive reachable from the hub.
 */
export const FLOWS: Readonly<Record<string, Flow>> = {
  get_cart: getCart,
  list_subscriptions: listSubscriptions,
  get_browsing_history: getBrowsingHistory,
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
