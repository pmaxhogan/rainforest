import { RfError } from "@rainforest/core";
import {
  PRICE_SOURCE_TERMS,
  camelChartUrl,
  keepaGraphUrl,
  parseAmazonPriceHistory,
  parseCamelPriceHistory,
} from "@rainforest/parsers";
import { AMAZON, readPage, resultMeta, type Flow } from "./common.ts";

const CACHE_TTL_MS = 6 * 3600 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

type Source = "amazon" | "camelcamelcamel" | "keepa";

/**
 * Price history per source. Third-party lookups are cached for hours per ASIN and are
 * additionally bounded by the `price_history` pacing caps.
 */
export const getPriceHistory: Flow = async (args, ctx) => {
  const asin = String(args.asin);
  const sources = (
    Array.isArray(args.sources) ? args.sources : ["amazon", "camelcamelcamel", "keepa"]
  ) as Source[];
  const out: Record<string, unknown> = { asin };
  const session = await ctx.browser.session();
  for (const source of sources) {
    const key = `${source}:${asin}`;
    const hit = cache.get(key);
    if (hit && ctx.now() - hit.at < CACHE_TTL_MS) {
      out[source] = { ...(hit.value as object), cached: true };
      continue;
    }
    let value: Record<string, unknown>;
    try {
      if (source === "keepa") {
        value = {
          chart_image_url: keepaGraphUrl(asin),
          link: `https://keepa.com/#!product/1-${asin}`,
          series_available: false,
          retrieved_at: new Date(ctx.now()).toISOString(),
        };
      } else if (source === "amazon") {
        value = await session.run(async (p) => {
          const { result, capture } = await readPage(
            p,
            `${AMAZON}/dp/${asin}`,
            "product",
            "price_history_amazon",
            parseAmazonPriceHistory,
            { shareCapture: true },
          );
          return { ...(result.data as object), meta: resultMeta(result, capture) };
        });
      } else {
        value = await session.run(async (p) => {
          const { result, capture } = await readPage(
            p,
            `https://camelcamelcamel.com/product/${asin}`,
            "price_history",
            "price_history_camel",
            parseCamelPriceHistory,
            { settleMs: 2500 },
          );
          return {
            ...(result.data as object),
            chart_image_url: camelChartUrl(asin, ["amazon", "new", "used"]),
            meta: resultMeta(result, capture),
          };
        });
      }
    } catch (error) {
      if (
        error instanceof RfError &&
        (error.payload.code === "needs_human" || error.payload.code === "throttled")
      )
        throw error;
      value = {
        unavailable: true,
        error:
          error instanceof RfError ? error.payload : { code: "internal", message: "lookup failed" },
      };
      out[source] = { ...value, terms_note: PRICE_SOURCE_TERMS[source] };
      continue;
    }
    cache.set(key, { at: ctx.now(), value });
    out[source] = { ...value, terms_note: PRICE_SOURCE_TERMS[source] };
  }
  return out;
};
