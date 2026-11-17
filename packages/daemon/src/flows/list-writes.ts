import { RfError } from "@rainforest/core";
import type { Locator } from "playwright-core";
import type { PageContext } from "@rainforest/browser";
import {
  parseList,
  parseListsIndex,
  type ListPage,
  type ListsIndexPage,
} from "@rainforest/parsers";
import { guardedClick } from "./click-guard.ts";
import { AMAZON, clearCaptureCache, readPage, runWithBudget, settle, type Flow } from "./common.ts";

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
  // The site can answer a list URL with a different list (the default one, for an id it does
  // not know). Every write flow reads through here, so a page that is not the named list
  // stops the flow before anything is clicked.
  const shown = listState(result.data).list_id;
  if (shown !== listId) {
    throw new RfError(
      "not_found",
      "the page did not show the requested list; nothing was changed",
      { details: { shown_other_list: shown !== null } },
    );
  }
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
const LIST_ID = /^[A-Z0-9]{8,16}$/;

export const removeFromList: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  const itemId = String(args.item_id);
  if (!LIST_ID.test(listId)) throw new RfError("invalid_arguments", "list_id is not a list id");
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a list item id from get_list");
  return await runWithBudget(ctx, { list: 2 }, async (page) => {
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
    await settle(2500);
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

const sleep = settle;

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A structural outline of the controls under a selector (tags, ids, names, labels; never
 * field values). Attached to layout errors so a changed page can be diagnosed.
 */
async function outline(page: PageContext, selector: string): Promise<string[]> {
  return await page.page
    .evaluate((sel) => {
      const d = (globalThis as any).document;
      const roots = [...d.querySelectorAll(sel)].filter((e: any) => e.offsetParent !== null);
      const root: any = roots[roots.length - 1];
      if (!root) return ["(nothing visible matches)"];
      const rows: string[] = [];
      const picks =
        "form, input, select, textarea, button, a[role=button], span.a-button, [data-action]";
      for (const el of root.querySelectorAll(picks)) {
        const e = el as any;
        const key = `${e.id || ""} ${e.getAttribute("name") || ""} ${e.getAttribute("data-action") || ""}`;
        if (/address-ui|a-dropdown-button|a-accordion|countryCode/.test(key)) continue;
        if (e.getAttribute("type") === "hidden") continue;
        const by = e.getAttribute("aria-labelledby");
        const label = (
          e.getAttribute("aria-label") ||
          (by ? d.getElementById(by)?.textContent : "") ||
          (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT"
            ? ""
            : e.textContent) ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 40);
        rows.push(
          [
            e.tagName.toLowerCase(),
            e.id ? `#${String(e.id).slice(0, 60)}` : "",
            e.getAttribute("name") ? `name=${String(e.getAttribute("name")).slice(0, 40)}` : "",
            e.getAttribute("type") ? `type=${e.getAttribute("type")}` : "",
            e.getAttribute("data-action")
              ? `action=${String(e.getAttribute("data-action")).slice(0, 40)}`
              : "",
            label ? `"${label}"` : "",
            e.offsetParent !== null ? "" : "(hidden)",
          ]
            .filter(Boolean)
            .join(" "),
        );
        if (rows.length >= 60) break;
      }
      return rows;
    }, selector)
    .catch(() => ["(outline failed)"]);
}

/**
 * Mark the one visible control under `rootSelector` whose label matches, and return a
 * locator for it. The label is the control's aria-label, the text of its aria-labelledby
 * element, or its own text.
 */
async function controlByLabel(
  page: PageContext,
  rootSelector: string,
  controls: string,
  label: RegExp,
  what: string,
): Promise<Locator> {
  const mark = `rf-${Math.random().toString(36).slice(2, 10)}`;
  const count = await page.page.evaluate(
    ([sel, picks, source, flags, token]) => {
      const d = (globalThis as any).document;
      const re = new RegExp(source as string, flags as string);
      let n = 0;
      for (const root of d.querySelectorAll(sel)) {
        if ((root as any).offsetParent === null) continue;
        for (const el of (root as any).querySelectorAll(picks)) {
          const e = el as any;
          if (e.offsetParent === null) continue;
          const by = e.getAttribute("aria-labelledby");
          const text = String(
            e.getAttribute("aria-label") ||
              (by ? d.getElementById(by)?.textContent : "") ||
              e.getAttribute("value") ||
              e.textContent ||
              "",
          )
            .trim()
            .replace(/\s+/g, " ");
          if (re.test(text)) {
            e.setAttribute("data-rf-pick", token);
            n++;
          }
        }
      }
      return n;
    },
    [rootSelector, controls, label.source, label.flags, mark] as const,
  );
  if (count !== 1) {
    throw new RfError("layout_unrecognized", `expected exactly one ${what}, found ${count}`, {
      details: { outline: await outline(page, rootSelector) },
    });
  }
  return page.page.locator(`[data-rf-pick="${mark}"]`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function waitVisible(
  page: PageContext,
  selector: string,
  what: string,
  root: string,
): Promise<void> {
  try {
    await page.page.waitForSelector(selector, { state: "visible", timeout: 12_000 });
  } catch {
    throw new RfError("layout_unrecognized", `${what} did not appear`, {
      details: { outline: await outline(page, root) },
    });
  }
}

const DIALOG = ".a-popover, .a-modal-scroller";
const PRIVACY_VALUE = { private: "PRIVATE", shared: "SHARED", public: "PUBLIC" } as const;
type Privacy = keyof typeof PRIVACY_VALUE;

function readPrivacy(value: unknown): Privacy | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && Object.hasOwn(PRIVACY_VALUE, value)) return value as Privacy;
  throw new RfError("invalid_arguments", "privacy must be private, shared or public");
}

function listsState(index: ListsIndexPage): { list_id: string; name: string; privacy: string }[] {
  return index.lists.map((l) => ({ list_id: l.list_id, name: l.name, privacy: String(l.privacy) }));
}

/** Open the manage-list dialog of the list page that is currently loaded. */
async function openSettings(page: PageContext): Promise<void> {
  await guardedClick(page, page.page.locator("#overflow-menu-popover-trigger:visible"), {
    what: "the list's More menu",
    id: /^overflow-menu-popover-trigger$/,
  });
  await sleep(800);
  await guardedClick(page, page.page.locator("#editYourList:visible"), {
    what: "the Manage list link",
    id: /^editYourList$/,
  });
  await waitVisible(page, "#list-settings-form", "the manage-list dialog", DIALOG);
  await sleep(1200);
}

async function applySettings(
  page: PageContext,
  change: { name?: string; privacy?: Privacy },
): Promise<void> {
  await openSettings(page);
  if (change.name !== undefined) await page.page.locator("#list-settings-name").fill(change.name);
  if (change.privacy !== undefined) {
    await page.page
      .locator('#list-settings-form select[name="privacyStatus"]')
      .selectOption(PRIVACY_VALUE[change.privacy]);
  }
  await sleep(500);
  const save = await controlByLabel(
    page,
    DIALOG,
    'input[type="submit"], button',
    /^save( changes)?$/i,
    "Save control in the manage-list dialog",
  );
  await guardedClick(page, save, { what: "the dialog's Save control", label: /\bsave\b/i });
  await sleep(3500);
}

export const createList: Flow = async (args, ctx) => {
  const name = String(args.name).trim();
  const privacy = readPrivacy(args.privacy) ?? "private";
  if (!name) throw new RfError("invalid_arguments", "name must not be empty");
  return await runWithBudget(ctx, { list: privacy === "private" ? 2 : 4 }, async (page) => {
    const before = await loadLists(page);
    clearCaptureCache();
    await guardedClick(page, page.page.locator("#createList:visible"), {
      what: "the Create a List control",
      id: /^createList$/,
    });
    await waitVisible(page, "#create-list-form #list-name", "the create-list dialog", DIALOG);
    await sleep(800);
    await page.page.locator("#create-list-form #list-name").fill(name);
    await sleep(400);
    const submit = page.page.locator('#wl-redesigned-create-list input[type="submit"]:visible');
    await guardedClick(page, submit, { what: "the Create List control", label: /\bcreate\b/i });
    await sleep(4000);
    let after = await loadLists(page);
    const known = new Set(before.lists.map((l) => l.list_id));
    const created = after.lists.find((l) => !known.has(l.list_id) && l.name === name);
    const result = { before: listsState(before), after: listsState(after) };
    if (!created) {
      throw new RfError(
        "internal",
        "the new list did not appear; the observed lists are attached",
        {
          details: result,
        },
      );
    }
    if (privacy !== "private") {
      await loadList(page, created.list_id);
      await applySettings(page, { privacy });
      after = await loadLists(page);
    }
    const final = after.lists.find((l) => l.list_id === created.list_id);
    return {
      changed: true,
      list: { list_id: created.list_id, name, privacy: String(final?.privacy ?? created.privacy) },
      before: listsState(before),
      after: listsState(after),
    };
  });
};

export const updateList: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  if (!LIST_ID.test(listId)) throw new RfError("invalid_arguments", "list_id is not a list id");
  const name = typeof args.name === "string" ? args.name.trim() : undefined;
  const privacy = readPrivacy(args.privacy);
  if (name === undefined && privacy === undefined)
    throw new RfError("invalid_arguments", "give a name, a privacy setting, or both");
  if (name !== undefined && !name) throw new RfError("invalid_arguments", "name must not be empty");
  return await runWithBudget(ctx, { list: 2 }, async (page) => {
    const before = await loadList(page, listId);
    clearCaptureCache();
    await applySettings(page, {
      ...(name !== undefined ? { name } : {}),
      ...(privacy ? { privacy } : {}),
    });
    const after = await loadList(page, listId);
    const state = (l: ListPage) => ({
      list_id: listId,
      name: l.list.name ?? null,
      privacy: String(l.list.privacy),
    });
    const result = { before: state(before), after: state(after) };
    const nameOk = name === undefined || after.list.name === name;
    const privacyOk = privacy === undefined || String(after.list.privacy) === privacy;
    if (!nameOk || !privacyOk) {
      throw new RfError(
        "internal",
        "the list settings did not change as intended; the observed state is attached",
        {
          details: result,
        },
      );
    }
    return { changed: true, ...result };
  });
};

export const deleteList: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  if (!LIST_ID.test(listId)) throw new RfError("invalid_arguments", "list_id is not a list id");
  return await runWithBudget(ctx, { list: 3 }, async (page) => {
    const before = await loadLists(page);
    const target = before.lists.find((l) => l.list_id === listId);
    if (!target) {
      throw new RfError("not_found", "no such list", { details: { lists: listsState(before) } });
    }
    await loadList(page, listId);
    clearCaptureCache();
    await openSettings(page);
    const remove = await controlByLabel(
      page,
      DIALOG,
      'input[type="submit"], button',
      /^delete list$/i,
      "Delete list control in the manage-list dialog",
    );
    await guardedClick(page, remove, { what: "the Delete list control", label: /^delete list$/i });
    await sleep(1500);
    // The site asks once more; confirm in that dialog only.
    const confirm = await controlByLabel(
      page,
      DIALOG,
      'input[type="submit"], button',
      /^(yes|delete|delete list|confirm)$/i,
      "confirmation control for deleting the list",
    );
    await guardedClick(page, confirm, {
      what: "the delete confirmation control",
      label: /^(yes|delete|delete list|confirm)$/i,
    });
    await sleep(3500);
    const after = await loadLists(page);
    const result = {
      before: listsState(before),
      after: listsState(after),
      list: { list_id: listId, name: target.name },
    };
    if (after.lists.some((l) => l.list_id === listId)) {
      throw new RfError("internal", "the list is still there; the observed lists are attached", {
        details: result,
      });
    }
    return { changed: true, ...result };
  });
};

const PRIORITIES = ["lowest", "low", "medium", "high", "highest"] as const;

export const updateListItem: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  const itemId = String(args.item_id);
  if (!LIST_ID.test(listId)) throw new RfError("invalid_arguments", "list_id is not a list id");
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a list item id from get_list");
  const quantity = typeof args.quantity_wanted === "number" ? args.quantity_wanted : undefined;
  const priority = PRIORITIES.find((p) => p === args.priority);
  const comment = typeof args.comment === "string" ? args.comment : undefined;
  if (quantity === undefined && priority === undefined && comment === undefined)
    throw new RfError("invalid_arguments", "give quantity_wanted, priority, comment, or several");
  return await runWithBudget(ctx, { list: 2 }, async (page) => {
    const before = listState(await loadList(page, listId));
    const item = before.items.find((i) => i.item_id === itemId);
    if (!item)
      throw new RfError("not_found", "no such item on that list", { details: { state: before } });
    clearCaptureCache();
    const trigger = page.page
      .locator(`a[href*="/hz/wishlist/cqp"][href*="itemId=${itemId}&"]:visible`)
      .first();
    await guardedClick(page, trigger, {
      what: "the item's edit link",
      href: /^\/hz\/wishlist\/cqp\/[^?]*\?(?:[^#]*&)?listId=[A-Z0-9]{8,16}&/,
    });
    await waitVisible(page, "#WLNOTES_Comment", "the item's edit dialog", DIALOG);
    await sleep(800);
    if (comment !== undefined) await page.page.locator("#WLNOTES_Comment").fill(comment);
    if (quantity !== undefined)
      await page.page.locator("#WLNOTES_Requested").fill(String(quantity));
    if (priority !== undefined) {
      const options = await page.page.locator("#WLNOTES_Priority option").evaluateAll((els) =>
        els.map((e) => ({
          value: (e as unknown as { value: string }).value,
          text: String((e as unknown as { textContent: string }).textContent)
            .trim()
            .toLowerCase(),
        })),
      );
      const option = options.find((o) => o.text === priority);
      if (!option) {
        throw new RfError("layout_unrecognized", "the priority choices are not the expected ones", {
          details: { choices: options.map((o) => o.text) },
        });
      }
      await page.page.locator("#WLNOTES_Priority").selectOption(option.value);
    }
    await sleep(500);
    await guardedClick(page, page.page.locator('#WLNOTES_save input[type="submit"]:visible'), {
      what: "the edit dialog's Save control",
      label: /\bsave\b/i,
    });
    await sleep(3000);
    const after = listState(await loadList(page, listId));
    const now = after.items.find((i) => i.item_id === itemId);
    const result = { before: item, after: now ?? null };
    const ok =
      now !== undefined &&
      (quantity === undefined || now.quantity_wanted === quantity) &&
      (priority === undefined || String(now.priority ?? "").toLowerCase() === priority) &&
      (comment === undefined || (now.comment ?? "") === comment);
    if (!ok) {
      throw new RfError(
        "internal",
        "the item did not change as intended; the observed item is attached",
        {
          details: result,
        },
      );
    }
    return { changed: true, ...result };
  });
};

export const moveListItem: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  const itemId = String(args.item_id);
  const toListId = String(args.to_list_id);
  if (!LIST_ID.test(listId) || !LIST_ID.test(toListId))
    throw new RfError("invalid_arguments", "list_id and to_list_id must be list ids");
  if (!ITEM_ID.test(itemId))
    throw new RfError("invalid_arguments", "item_id is not a list item id from get_list");
  if (listId === toListId)
    throw new RfError("invalid_arguments", "the item is already on that list");
  if (args.copy === true) {
    throw new RfError(
      "unsupported",
      "the site offers Move only; to copy, add the product to the other list with add_to_list",
    );
  }
  return await runWithBudget(ctx, { list: 3 }, async (page) => {
    const before = listState(await loadList(page, listId));
    const item = before.items.find((i) => i.item_id === itemId);
    if (!item)
      throw new RfError("not_found", "no such item on that list", { details: { state: before } });
    clearCaptureCache();
    await guardedClick(
      page,
      page.page.locator(`#move-to-list-button-${itemId} input[type="submit"]:visible`),
      { what: "the item's Move control", label: /\bmove\b/i },
    );
    const row = `#regItemMove_${itemId}_${toListId}`;
    await waitVisible(page, row, "that destination in the move menu", ".a-popover");
    await sleep(600);
    await guardedClick(page, page.page.locator(`${row}:visible`), {
      what: "the destination list in the move menu",
      id: new RegExp(`^regItemMove_${itemId}_${toListId}$`),
    });
    await sleep(3500);
    const after = listState(await loadList(page, listId));
    const destination = listState(await loadList(page, toListId));
    const result = {
      item,
      source_after: after.items.length,
      destination_has_item: destination.items.some((i) => i.asin !== null && i.asin === item.asin),
    };
    if (after.items.some((i) => i.item_id === itemId) || !result.destination_has_item) {
      throw new RfError(
        "internal",
        "the item did not move as intended; the observed state is attached",
        {
          details: { ...result, source: after },
        },
      );
    }
    return { changed: true, ...result };
  });
};

export const addToList: Flow = async (args, ctx) => {
  const listId = String(args.list_id);
  const asin = String(args.asin);
  if (!LIST_ID.test(listId)) throw new RfError("invalid_arguments", "list_id is not a list id");
  if (!/^[A-Z0-9]{10}$/.test(asin))
    throw new RfError("invalid_arguments", "asin is not a product id");
  return await runWithBudget(ctx, { list: 2, product: 1 }, async (page) => {
    const before = listState(await loadList(page, listId));
    if (before.items.some((i) => i.asin === asin)) {
      return { changed: false, note: "that product is already on the list", list: before };
    }
    await page.goto(`${AMAZON}/dp/${asin}?th=1`, "product");
    await page.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
    await sleep(1500);
    clearCaptureCache();
    const stack = "#wishlistButtonStack, #add-to-wishlist-button-group";
    // Open the list chooser (the arrow next to Add to List), then pick this list's row.
    await guardedClick(page, page.page.locator("#add-to-wishlist-button:visible"), {
      what: "the Add to List chooser",
      id: /^add-to-wishlist-button$/,
    }).catch(async (error: unknown) => {
      if (error instanceof RfError && error.payload.code === "blocked_by_policy") throw error;
      throw new RfError("layout_unrecognized", "the Add to List chooser was not found", {
        details: { outline: await outline(page, stack) },
      });
    });
    const row = `#atwl-link-to-list-${listId}`;
    await waitVisible(page, row, "that list in the Add to List menu", ".a-popover");
    await sleep(500);
    await guardedClick(page, page.page.locator(`${row}:visible`), {
      what: "the list's row in the Add to List menu",
      id: new RegExp(`^atwl-link-to-list-${listId}$`),
    });
    await sleep(3500);
    const after = listState(await loadList(page, listId));
    const added = after.items.find((i) => i.asin === asin) ?? null;
    if (!added) {
      throw new RfError(
        "internal",
        "the product did not appear on the list; the observed list is attached",
        {
          details: { list: after },
        },
      );
    }
    return {
      changed: true,
      added,
      before_count: before.items.length,
      after_count: after.items.length,
    };
  });
};
