import { RfError } from "@rainforest/core";
import { guardedClick } from "./click-guard.ts";
import {
  parseMedia,
  parseReviewSummary,
  parseReviews,
  parseVariants,
  type ReviewsPage,
} from "@rainforest/parsers";
import {
  AMAZON,
  arrayKeys,
  cursorOrThrow,
  fitToBudget,
  maxCharsOf,
  pageBody,
  readPage,
  settle,
  type Flow,
} from "./common.ts";

const productUrl = (asin: unknown): string => `${AMAZON}/dp/${encodeURIComponent(String(asin))}`;

export const getVariants: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(
      p,
      productUrl(args.asin),
      "product",
      "product",
      parseVariants,
      { shareCapture: true },
    );
    const body = pageBody(result, capture);
    // Optional: load a few child pages for variants whose offer is not on this page.
    const wanted = typeof args.fetch_missing === "number" ? args.fetch_missing : 0;
    const missing = (result.data.missing_offer_asins ?? []).slice(0, wanted);
    const fetched: Record<string, unknown>[] = [];
    for (const asin of missing) {
      if (ctx.signal.aborted) break;
      try {
        const child = await readPage(p, productUrl(asin), "product", "product", parseVariants, {
          shareCapture: true,
        });
        const combo = child.result.data.combinations.find((c) => c.asin === asin);
        fetched.push(combo ? { ...combo } : { asin, error: "not_found" });
      } catch (error) {
        if (
          error instanceof RfError &&
          (error.payload.code === "throttled" || error.payload.code === "needs_human")
        )
          throw error;
        fetched.push({ asin, error: error instanceof RfError ? error.payload.code : "internal" });
      }
    }
    if (wanted > 0) body.fetched_offers = fetched;
    return fitToBudget(body, ["other_sections", "combinations"], maxCharsOf(args), ctx.now());
  });
};

export const getMedia: Flow = async (args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(
      p,
      productUrl(args.asin),
      "product",
      "product",
      parseMedia,
      { shareCapture: true },
    );
    const body = pageBody(result, capture);
    return fitToBudget(body, arrayKeys(body), undefined, ctx.now());
  });
};

export const getReviewSummary: Flow = async (args, ctx) => {
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(
      p,
      productUrl(args.asin),
      "product",
      "product",
      parseReviewSummary,
      { shareCapture: true },
    );
    const body = pageBody(result, capture);
    return fitToBudget(body, arrayKeys(body), undefined, ctx.now());
  });
};

const STAR_VALUES: Record<string, string> = {
  all: "all_stars",
  "5": "five_star",
  "4": "four_star",
  "3": "three_star",
  "2": "two_star",
  "1": "one_star",
  positive: "positive",
  critical: "critical",
};

export function reviewsUrl(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  params.set("sortBy", args.sort === "recent" ? "recent" : "helpful");
  params.set("reviewerType", args.verified_only === true ? "avp_only_reviews" : "all_reviews");
  params.set("filterByStar", STAR_VALUES[String(args.stars ?? "all")] ?? "all_stars");
  params.set("formatType", args.this_variant_only === true ? "current_format" : "all_formats");
  params.set("mediaType", args.media_only === true ? "media_reviews_only" : "all_contents");
  if (typeof args.keyword === "string" && args.keyword.length > 0)
    params.set("filterByKeyword", args.keyword);
  return `${AMAZON}/product-reviews/${encodeURIComponent(String(args.asin))}?${params.toString()}`;
}

/** Reviews load ten at a time through an in-page "show more" control, not by URL. */
const SHOW_MORE = "a[data-hook=show-more-button]";
const REVIEWS_PER_PAGE = 10;

export const getReviews: Flow = async (args, ctx) => {
  const page = typeof args.page === "number" ? args.page : 1;
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    let clicks = 0;
    const { result, capture } = await readPage(
      p,
      reviewsUrl(args),
      "reviews",
      "reviews",
      parseReviews,
      {
        beforeCapture: async (pc) => {
          // Page N = the Nth block of ten: expand N-1 times. Every expansion is paced
          // and counted like a page load.
          for (let i = 1; i < page; i++) {
            if (ctx.signal.aborted) break;
            const more = pc.page.locator(SHOW_MORE).first();
            if (!(await more.isVisible().catch(() => false))) break;
            const plan = ctx.browser.pacer().plan("reviews");
            if (!plan.ok) {
              throw new RfError("throttled", `pacing limit reached (${plan.reason})`, {
                retry_after_s: Math.ceil(plan.retryAfterMs / 1000),
              });
            }
            await new Promise((r) => setTimeout(r, plan.waitMs));
            ctx.browser.pacer().record("reviews");
            await guardedClick(pc, more, { what: "the show-more-reviews control" });
            clicks++;
            await settle(1500);
          }
        },
      },
    );
    const data = result.data as ReviewsPage;
    const body = pageBody(result, capture);
    // Return only the requested block of ten; earlier blocks were returned by earlier pages.
    const start = clicks * REVIEWS_PER_PAGE;
    body.reviews = data.reviews.slice(start);
    body.page = clicks + 1;
    body.page_requested = page;
    if (clicks + 1 < page)
      body.page_note = "fewer pages exist than requested; this is the last one";
    return fitToBudget(body, ["other_sections", "reviews"], maxCharsOf(args), ctx.now());
  });
};
