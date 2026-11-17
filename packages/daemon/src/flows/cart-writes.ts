import { RfError } from "@rainforest/core";
import type { PageContext } from "@rainforest/browser";
import { parseCart, type CartItem, type CartPage } from "@rainforest/parsers";
import { guardedClick } from "./click-guard.ts";
import {
  AMAZON,
  clearCaptureCache,
  readPage,
  requireBudget,
  type Flow,
  type FlowContext,
} from "./common.ts";

/** Compact cart state used for before/after comparison in every cart write. */
export interface CartState {
  active: {
    item_id: string;
    asin: string | null;
    title: string | null;
    quantity: number | null;
    price: number | null;
  }[];
  saved: { item_id: string; asin: string | null; title: string | null; price: number | null }[];
  subtotal: number | null;
}

export function cartState(cart: CartPage): CartState {
  return {
    active: cart.active_items.map((i) => ({
      item_id: i.item_id,
      asin: i.asin,
      title: i.title,
      quantity: i.quantity,
      price: i.price?.amount ?? null,
    })),
    saved: cart.saved_items.map((i) => ({
      item_id: i.item_id,
      asin: i.asin,
      title: i.title,
      price: i.price?.amount ?? null,
    })),
    subtotal: cart.subtotal?.amount ?? null,
  };
}

export async function loadCart(page: PageContext): Promise<CartPage> {
  const { result } = await readPage(
    page,
    `${AMAZON}/gp/cart/view.html`,
    "cart",
    "cart",
    parseCart,
    { settleMs: 1500 },
  );
  return result.data;
}

function find(cart: CartPage, itemId: string, list: "active" | "saved"): CartItem {
  const items = list === "active" ? cart.active_items : cart.saved_items;
  const item = items.find((i) => i.item_id === itemId);
  if (!item) {
    const elsewhere = (list === "active" ? cart.saved_items : cart.active_items).some(
      (i) => i.item_id === itemId,
    );
    throw new RfError(
      "not_found",
      elsewhere
        ? `that item is in the ${list === "active" ? "Saved for later" : "active cart"} section`
        : "no such item in the cart",
      {
        details: { state: cartState(cart) },
      },
    );
  }
  return item;
}

const ITEM_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * One cart-line action: read, click the line's own control, read again, compare.
 * `verify` decides whether the observed after-state matches the intent.
 */
async function lineAction(
  ctx: FlowContext,
  args: Record<string, unknown>,
  spec: {
    list: "active" | "saved";
    control: string;
    what: string;
    verify: (before: CartPage, after: CartPage, item: CartItem) => boolean;
  },
): Promise<unknown> {
  const itemId = String(args.item_id);
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a cart item id from get_cart");
  requireBudget(ctx, 2, "cart");
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const before = await loadCart(page);
    const item = find(before, itemId, spec.list);
    const name = `submit.${spec.control}.${itemId}`;
    // The page repeats some controls inside hidden layouts; only the visible one counts.
    const locator = page.page.locator(`input[name="${name}"]:visible`);
    clearCaptureCache();
    await guardedClick(page, locator, {
      what: spec.what,
      name: new RegExp(`^submit\\.${spec.control}\\.${itemId}$`),
    });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await loadCart(page);
    const result = {
      before: cartState(before),
      after: cartState(after),
      item: { item_id: item.item_id, asin: item.asin, title: item.title },
    };
    if (!spec.verify(before, after, item)) {
      throw new RfError(
        "internal",
        `${spec.what} did not take effect; the observed cart state is attached`,
        { details: result },
      );
    }
    return { changed: true, ...result };
  });
}

const gone = (list: CartItem[], item: CartItem): boolean =>
  !list.some((i) => i.item_id === item.item_id);
const hasAsin = (list: CartItem[], item: CartItem): boolean =>
  list.some((i) => i.asin !== null && i.asin === item.asin);

export const removeFromCart: Flow = (args, ctx) =>
  lineAction(ctx, args, {
    list: "active",
    control: "delete-active",
    what: "the cart line's Delete control",
    verify: (_b, after, item) =>
      gone(after.active_items, item) && !hasAsin(after.active_items, item),
  });

export const saveForLater: Flow = (args, ctx) =>
  lineAction(ctx, args, {
    list: "active",
    control: "save-for-later",
    what: "the cart line's Save for later control",
    verify: (_b, after, item) =>
      !hasAsin(after.active_items, item) && hasAsin(after.saved_items, item),
  });

export const moveToCart: Flow = (args, ctx) =>
  lineAction(ctx, args, {
    list: "saved",
    control: "move-to-cart",
    what: "the saved item's Move to cart control",
    verify: (_b, after, item) =>
      hasAsin(after.active_items, item) && !hasAsin(after.saved_items, item),
  });

export const deleteSavedItem: Flow = (args, ctx) =>
  lineAction(ctx, args, {
    list: "saved",
    control: "delete-saved",
    what: "the saved item's Delete control",
    verify: (_b, after, item) => gone(after.saved_items, item) && !hasAsin(after.saved_items, item),
  });

/** The most quantity steps one call will click. */
export const MAX_QUANTITY_STEPS = 20;

/**
 * Change a cart line's quantity with the line's own stepper, one click per unit, then
 * re-read the cart. Never goes below 1 (the stepper's last decrement deletes the line;
 * use remove_from_cart for that).
 */
export const setCartQuantity: Flow = async (args, ctx) => {
  const itemId = String(args.item_id);
  const target = Number(args.quantity);
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a cart item id from get_cart");
  if (!Number.isInteger(target) || target < 1)
    throw new RfError("invalid_arguments", "quantity must be a whole number of at least 1");
  requireBudget(ctx, 2, "cart");
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const before = await loadCart(page);
    const item = find(before, itemId, "active");
    const current = item.quantity ?? 1;
    const steps = target - current;
    const describe = { item_id: item.item_id, asin: item.asin, title: item.title };
    if (steps === 0) {
      return {
        changed: false,
        before: cartState(before),
        after: cartState(before),
        item: describe,
      };
    }
    if (Math.abs(steps) > MAX_QUANTITY_STEPS) {
      throw new RfError(
        "invalid_arguments",
        `the quantity can change by at most ${MAX_QUANTITY_STEPS} per call (it is ${current} now)`,
      );
    }
    const up = steps > 0;
    const line = `#sc-active-cart span.sc-action-quantity[data-itemid="${itemId}"]`;
    const button = page.page.locator(
      `${line} button[data-action="${up ? "a-stepper-increment" : "a-stepper-decrement"}"]:visible`,
    );
    clearCaptureCache();
    for (let i = 0; i < Math.abs(steps); i++) {
      const expectedNow = current + (up ? i : -i);
      await guardedClick(page, button, {
        what: up ? "the line's increase-quantity control" : "the line's decrease-quantity control",
        label: up ? /^Increase quantity by one\b/i : /^Decrease quantity by one\b/i,
      });
      // The stepper records the applied value on the line; wait for it before the next click.
      const wanted = String(expectedNow + (up ? 1 : -1));
      await page.page
        .waitForFunction(
          ([selector, value]) => {
            const doc = (
              globalThis as unknown as {
                document: {
                  querySelector(s: string): { getAttribute(n: string): string | null } | null;
                };
              }
            ).document;
            return doc.querySelector(selector as string)?.getAttribute("data-old-value") === value;
          },
          [line, wanted] as const,
          { timeout: 8000 },
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 900));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const after = await loadCart(page);
    const now = after.active_items.find((i) => i.item_id === itemId)?.quantity ?? null;
    const result = { before: cartState(before), after: cartState(after), item: describe };
    if (now !== target) {
      throw new RfError(
        "internal",
        `the quantity is ${now ?? "unknown"} after the change, not ${target}; the observed cart state is attached`,
        { details: result },
      );
    }
    return { changed: true, ...result };
  });
};
