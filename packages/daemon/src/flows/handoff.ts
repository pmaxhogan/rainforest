import { RfError } from "@rainforest/core";
import { AMAZON, type Flow } from "./common.ts";

/**
 * Hand-off: open a page in a NORMAL tab for the human. The URL is built from a typed
 * target, never taken from the caller, and the automation session never attaches to it.
 * This is how a purchase gets finished: by the owner, by hand.
 */
export function handoffUrl(target: unknown): string {
  const t = target as { type?: string; asin?: string; list_id?: string; order_id?: string } | null;
  switch (t?.type) {
    case "product":
      if (typeof t.asin === "string" && /^[A-Z0-9]{10}$/.test(t.asin))
        return `${AMAZON}/dp/${t.asin}`;
      break;
    case "cart":
      return `${AMAZON}/gp/cart/view.html`;
    case "orders":
      return `${AMAZON}/your-orders/orders`;
    case "list":
      if (typeof t.list_id === "string" && /^[A-Z0-9]{8,16}$/.test(t.list_id))
        return `${AMAZON}/hz/wishlist/ls/${t.list_id}`;
      break;
    case "order":
      if (typeof t.order_id === "string" && /^[0-9D][0-9]{2}-[0-9]{7}-[0-9]{7}$/.test(t.order_id)) {
        return `${AMAZON}/gp/your-account/order-details?orderID=${t.order_id}`;
      }
      break;
    default:
      break;
  }
  throw new RfError("invalid_arguments", "unknown hand-off target");
}

/** Hand-offs open visible tabs, so they are capped: this many per window. */
export const HANDOFF_CAP = { opens: 6, windowMs: 10 * 60_000 } as const;
const recentOpens: number[] = [];

export const showOnScreen: Flow = async (args, ctx) => {
  const url = handoffUrl(args.target);
  const now = ctx.now();
  while (recentOpens.length > 0 && now - recentOpens[0]! >= HANDOFF_CAP.windowMs)
    recentOpens.shift();
  if (recentOpens.length >= HANDOFF_CAP.opens) {
    throw new RfError("throttled", "too many tabs were opened recently; try again later", {
      retry_after_s: Math.ceil((recentOpens[0]! + HANDOFF_CAP.windowMs - now) / 1000),
    });
  }
  recentOpens.push(now);
  ctx.browser.showOnScreen(url);
  return {
    changed: true,
    opened: url,
    note: "opened in a normal browser tab on this computer for the owner; automation is not attached to it",
  };
};
