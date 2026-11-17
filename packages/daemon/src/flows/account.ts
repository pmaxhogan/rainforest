import { RfError } from "@rainforest/core";
import {
  parseBrowsingHistory,
  parseCart,
  parseSearchHistory,
  parseSubscriptions,
} from "@rainforest/parsers";
import { guardedClick } from "./click-guard.ts";
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

/**
 * Best effort: Amazon shows recent searches only in the search box dropdown, so open the
 * home page, focus the empty search box and read the dropdown.
 */
export const getSearchHistory: Flow = async (_args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    const { result } = await readPage(
      page,
      `${AMAZON}/`,
      "search",
      "search_history",
      parseSearchHistory,
      {
        beforeCapture: async (p) => {
          const box = p.page.locator("#twotabsearchtextbox");
          await guardedClick(p, box, { what: "the search box", id: /^twotabsearchtextbox$/ });
          await p.page
            .waitForSelector(
              ".autocomplete-results-container .s-suggestion, #nav-flyout-searchAjax .s-suggestion",
              { timeout: 5000 },
            )
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 600));
        },
      },
    );
    if (!result.data.supported) {
      throw new RfError(
        "unsupported",
        `recent searches are not available: ${result.data.note ?? "Amazon did not show them"}`,
      );
    }
    return {
      entries: result.data.entries,
      note: "read from the search box dropdown; Amazon keeps only a short list",
    };
  });
};
