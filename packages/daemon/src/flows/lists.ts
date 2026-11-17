import { parseList, parseListsIndex } from "@rainforest/parsers";
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

export const listLists: Flow = async (_args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(
      p,
      `${AMAZON}/hz/wishlist/ls`,
      "list",
      "lists_index",
      parseListsIndex,
    );
    const body = pageBody(result, capture);
    // The selected list's items belong to get_list; keep this result to the list of lists.
    delete body.selected_list;
    return fitToBudget(body, arrayKeys(body), undefined, ctx.now());
  });
};

export const getList: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const url = `${AMAZON}/hz/wishlist/ls/${encodeURIComponent(String(args.list_id))}`;
    const { result, capture } = await readPage(p, url, "list", "list", parseList, {
      // Lists lazy-load on scroll: scroll until the end-of-list marker or a bound is hit.
      beforeCapture: async (page) => {
        for (let i = 0; i < 12; i++) {
          const done = await page.page.evaluate(
            "(() => { window.scrollTo(0, document.body.scrollHeight); const e = document.querySelector('#endOfListMarker'); return !!e; })()",
          );
          await new Promise((r) => setTimeout(r, 900));
          if (done) break;
        }
        await page.page.evaluate("window.scrollTo(0, 0)");
      },
    });
    const body = pageBody(result, capture);
    return fitToBudget(body, ["other_sections", "items"], maxCharsOf(args), ctx.now());
  });
};
