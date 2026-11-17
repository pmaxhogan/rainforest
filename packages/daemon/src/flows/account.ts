import { parseBrowsingHistory, parseCart, parseSubscriptions } from "@rainforest/parsers";
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

export const getCart: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const { result, capture } = await readPage(
      page,
      `${AMAZON}/gp/cart/view.html`,
      "cart",
      "cart",
      parseCart,
    );
    ctx.browser.setSignedIn(true);
    const body = pageBody(result, capture);
    return fitToBudget(
      body,
      ["other_sections", "saved_items", "active_items"],
      maxCharsOf(args),
      ctx.now(),
    );
  });
};

export const listSubscriptions: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const url = `${AMAZON}/auto-deliveries?enableMydExperience=1`;
    const { result, capture } = await readPage(
      page,
      url,
      "account",
      "subscriptions",
      parseSubscriptions,
    );
    const body = pageBody(result, capture);
    return fitToBudget(body, arrayKeys(body), maxCharsOf(args), ctx.now());
  });
};

export const getBrowsingHistory: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const { result, capture } = await readPage(
      page,
      `${AMAZON}/gp/history`,
      "account",
      "browsing_history",
      parseBrowsingHistory,
      {
        // The page renders more cards as it scrolls; scroll a few times so they exist.
        beforeCapture: async (p) => {
          for (let i = 0; i < 6; i++) {
            await p.page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
            await new Promise((r) => setTimeout(r, 700));
          }
          await p.page.evaluate("window.scrollTo(0, 0)");
        },
      },
    );
    const body = pageBody(result, capture);
    return fitToBudget(body, arrayKeys(body), maxCharsOf(args), ctx.now());
  });
};
