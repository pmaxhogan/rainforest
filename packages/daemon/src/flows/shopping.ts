import { RfError } from "@rainforest/core";
import { checkNavigation } from "@rainforest/browser";
import {
  computeOfferFlags,
  isOfferOutOfStock,
  offerFlagContext,
  parseOffers,
  parseProduct,
  parseSearch,
  type Offer,
  type OffersData,
} from "@rainforest/parsers";
import {
  AMAZON,
  cursorOrThrow,
  fitToBudget,
  maxCharsOf,
  pageBody,
  readPage,
  type Flow,
} from "./common.ts";
import { mintOfferToken } from "./offer-token.ts";

const SORT_VALUES: Record<string, string> = {
  price_low_to_high: "price-asc-rank",
  price_high_to_low: "price-desc-rank",
  avg_customer_review: "review-rank",
  newest: "date-desc-rank",
  best_sellers: "exact-aware-popularity-rank",
};

/** Build the search URL. Returns notes about filters that need a refinement token instead. */
export function searchUrl(args: Record<string, unknown>): { url: string; notes: string[] } {
  const notes: string[] = [];
  const refinements = Array.isArray(args.refinements) ? (args.refinements as string[]) : [];
  let url: URL;
  if (refinements.length > 0) {
    // A refinement token is the page's own relative URL for that filter, and it already
    // carries the filters applied before it: the last one is the state to load.
    const token = refinements[refinements.length - 1]!;
    try {
      url = new URL(token, AMAZON);
    } catch {
      throw new RfError("invalid_arguments", "refinement token is not valid");
    }
    if (url.origin !== AMAZON || !/^\/s(\/|$)/.test(url.pathname)) {
      throw new RfError(
        "invalid_arguments",
        "refinement token is not a search refinement from a previous response",
      );
    }
    if (refinements.length > 1)
      notes.push(
        "several refinement tokens were given: tokens are cumulative, so only the last one was applied",
      );
  } else {
    url = new URL(`${AMAZON}/s`);
    url.searchParams.set("k", String(args.query));
    if (typeof args.department === "string" && /^[a-z0-9-]{1,40}$/i.test(args.department)) {
      url.searchParams.set("i", args.department);
    }
    const rh: string[] = [];
    if (typeof args.brand === "string") rh.push(`p_89:${args.brand.replace(/[,:|]/g, " ")}`);
    if (args.prime_only === true)
      notes.push(
        "prime_only: pick the Prime option from `refinements` in this response and pass its token",
      );
    if (typeof args.min_rating === "number")
      notes.push(
        "min_rating: pick the star option from `refinements` in this response and pass its token",
      );
    if (typeof args.condition === "string")
      notes.push(
        "condition: pick the condition option from `refinements` in this response and pass its token",
      );
    if (rh.length > 0) url.searchParams.set("rh", rh.join(","));
  }
  if (typeof args.min_price === "number") url.searchParams.set("low-price", String(args.min_price));
  if (typeof args.max_price === "number")
    url.searchParams.set("high-price", String(args.max_price));
  const sort = typeof args.sort === "string" ? SORT_VALUES[args.sort] : undefined;
  if (sort) url.searchParams.set("s", sort);
  if (typeof args.page === "number" && args.page > 1)
    url.searchParams.set("page", String(args.page));
  const verdict = checkNavigation(url.toString());
  if (!verdict.allow) throw new RfError("invalid_arguments", "that search cannot be loaded");
  return { url: url.toString(), notes };
}

export const search: Flow = async (args, ctx) => {
  const { url, notes } = searchUrl(args);
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const { result, capture } = await readPage(p, url, "search", "search", parseSearch);
    const body = pageBody(result, capture);
    if (notes.length > 0) body.filter_notes = notes;
    return fitToBudget(
      body,
      ["other_sections", "widgets", "refinements", "results"],
      maxCharsOf(args),
      ctx.now(),
    );
  });
};

export const getProduct: Flow = async (args, ctx) => {
  const continued = cursorOrThrow(args.cursor, args.max_chars, ctx.now());
  if (continued) return continued;
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    const url = `${AMAZON}/dp/${encodeURIComponent(String(args.asin))}`;
    const { result, capture } = await readPage(p, url, "product", "product", parseProduct, {
      shareCapture: true,
    });
    const body = pageBody(result, capture);
    return fitToBudget(
      body,
      ["other_sections", "related", "sponsored_blocks"],
      maxCharsOf(args),
      ctx.now(),
    );
  });
};

const AOD_PATH = (asin: string): string =>
  `/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp`;

function cents(offer: Offer): number | null {
  return offer.price ? Math.round(offer.price.amount * 100) : null;
}

/** Strip identifiers the model must never see and attach an opaque offer id instead. */
function present(offer: Offer, data: OffersData, now: number): Record<string, unknown> {
  const flags = computeOfferFlags(
    offer,
    offerFlagContext(data, offer, {
      now: new Date(now),
      utc_offset_minutes: -new Date(now).getTimezoneOffset(),
      // The account is assumed to have Prime (a stated assumption of this project).
      prime_member: true,
    }),
  );
  const outOfStock = isOfferOutOfStock(offer);
  const { internal, ...visible } = offer as Offer & {
    internal?: { asin: string | null; offer_listing_id: string | null; seller_id: string | null };
  };
  const out: Record<string, unknown> = { ...visible, flags, out_of_stock: outOfStock };
  if (internal?.asin && internal.offer_listing_id) {
    out.offer_id = mintOfferToken(
      {
        asin: internal.asin,
        offer_listing_id: internal.offer_listing_id,
        seller_id: internal.seller_id,
        seller_name: offer.seller?.name ?? null,
        condition: offer.condition,
        price_cents: cents(offer),
        flags,
        out_of_stock: outOfStock,
        source: offer.source,
        index: offer.index,
      },
      now,
    );
  } else {
    out.offer_id = null;
    out.offer_id_note = "this offer cannot be added to the cart from here";
  }
  return out;
}

export const getBuyingOptions: Flow = async (args, ctx) => {
  const asin = String(args.asin);
  const session = await ctx.browser.session();
  return await session.run(async (p) => {
    await p.goto(`${AMAZON}/dp/${encodeURIComponent(asin)}`, "product");
    await p.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    const capture = await p.capture("offers");
    try {
      capture.fragments = { aod: await p.fetchFragment(AOD_PATH(asin), "offers") };
    } catch (error) {
      if (
        error instanceof RfError &&
        (error.payload.code === "throttled" || error.payload.code === "needs_human")
      )
        throw error;
      // Without the panel the parser falls back to the buy box and says so.
    }
    const result = parseOffers(capture);
    const data = result.data;
    const now = ctx.now();
    const wanted =
      typeof args.condition === "string" && args.condition !== "all" ? args.condition : null;
    const keep = (o: Offer): boolean => !wanted || o.condition === wanted;
    const body = pageBody(result, capture);
    body.pinned_offer =
      data.pinned_offer && keep(data.pinned_offer) ? present(data.pinned_offer, data, now) : null;
    body.offers = data.offers.filter(keep).map((o) => present(o, data, now));
    body.offer_id_note =
      "offer_id values expire after about 10 minutes and are the only way to add an offer to the cart; flagged offers need those flags listed in add_to_cart's `acknowledge`";
    return fitToBudget(body, ["other_sections", "offers"], maxCharsOf(args), now);
  });
};
