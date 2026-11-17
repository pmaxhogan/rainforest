import { RfError } from "@rainforest/core";
import type { PageContext } from "@rainforest/browser";
import {
  parseList,
  parseListsIndex,
  type ListPage,
  type ListsIndexPage,
} from "@rainforest/parsers";
import { guardedClick } from "./click-guard.ts";
import { AMAZON, clearCaptureCache, readPage, requireBudget, type Flow } from "./common.ts";

/** Compact list state for before/after comparison in list writes. */
export interface ListState {
  list_id: string | null;
  name: string | null;
  privacy: string | null;
  items: {
    item_id: string;
    asin: string | null;
    title: string | null;
    quantity_wanted?: number | null;
    priority?: string | null;
    comment?: string | null;
  }[];
}

export function listState(list: ListPage): ListState {
  const header =
    (list as unknown as { list?: { list_id?: string; name?: string; privacy?: string } }).list ??
    {};
  const items = (list as unknown as { items: Record<string, unknown>[] }).items ?? [];
  return {
    list_id: header.list_id ?? null,
    name: header.name ?? null,
    privacy: header.privacy ?? null,
    items: items.map((i) => ({
      item_id: String(i.item_id),
      asin: (i.asin as string | null) ?? null,
      title: (i.title as string | null) ?? null,
      quantity_wanted: (i.quantity_wanted as number | null | undefined) ?? null,
      priority: (i.priority as string | null | undefined) ?? null,
      comment: (i.comment as string | null | undefined) ?? null,
    })),
  };
}

export async function loadList(page: PageContext, listId: string): Promise<ListPage> {
  const url = `${AMAZON}/hz/wishlist/ls/${encodeURIComponent(listId)}`;
  const { result } = await readPage(page, url, "list", "list", parseList, { settleMs: 1500 });
  return result.data;
}

export async function loadLists(page: PageContext): Promise<ListsIndexPage> {
  const { result } = await readPage(
    page,
    `${AMAZON}/hz/wishlist/ls`,
    "list",
    "lists_index",
    parseListsIndex,
    { settleMs: 1500 },
  );
  return result.data;
}

const ITEM_ID = /^[A-Za-z0-9-]{6,64}$/;

export const removeFromList: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  const itemId = String(args.item_id);
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a list item id from get_list");
  requireBudget(ctx, 2, "list");
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const before = listState(await loadList(page, listId));
    const item = before.items.find((i) => i.item_id === itemId);
    if (!item)
      throw new RfError("not_found", "no such item on that list", { details: { state: before } });
    clearCaptureCache();
    const button = page.page.locator(`#delete-button-${itemId} input[name="submit.deleteItem"]`);
    await guardedClick(page, button, {
      what: "the list item's Delete control",
      name: /^submit\.deleteItem$/,
    });
    await new Promise((r) => setTimeout(r, 2500));
    const after = listState(await loadList(page, listId));
    const result = { before, after, item };
    if (after.items.some((i) => i.item_id === itemId)) {
      throw new RfError(
        "internal",
        "the item is still on the list; the observed list state is attached",
        { details: result },
      );
    }
    return { changed: true, ...result };
  });
};
