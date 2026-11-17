import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Capture, PageKind, ParseResult } from "@rainforest/core";
import {
  parseBrowsingHistory,
  parseCamelPriceHistory,
  parseCart,
  parseInvoice,
  parseList,
  parseListsIndex,
  parseOffers,
  parseOrderDetails,
  parseOrderList,
  parseProduct,
  parseReviews,
  parseSearch,
  parseSubscriptions,
} from "../src/index.ts";
import { DEFAULT_FIXTURES_ROOT, loadExpected, loadFixture } from "../src/testing.ts";

/**
 * Committed fixtures are synthetic (see docs/PRIVACY.md). Each case directory holds a
 * scrubbed capture and the parser's expected result; this test replays every case.
 */
const PARSERS: Partial<Record<PageKind, (capture: Capture) => ParseResult<unknown>>> = {
  search: parseSearch,
  product: parseProduct,
  offers: parseOffers,
  reviews: parseReviews,
  cart: parseCart,
  order_list: parseOrderList,
  order_details: parseOrderDetails,
  invoice: parseInvoice,
  subscriptions: parseSubscriptions,
  lists_index: parseListsIndex,
  list: parseList,
  browsing_history: parseBrowsingHistory,
  price_history_camel: parseCamelPriceHistory,
};

const kinds = existsSync(DEFAULT_FIXTURES_ROOT)
  ? readdirSync(DEFAULT_FIXTURES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
  : [];

describe("committed fixtures", () => {
  test("every fixture kind has a parser", () => {
    for (const kind of kinds) expect(Object.keys(PARSERS), kind.name).toContain(kind.name);
  });

  for (const kind of kinds) {
    const parser = PARSERS[kind.name as PageKind];
    if (!parser) continue;
    const dir = join(DEFAULT_FIXTURES_ROOT, kind.name);
    for (const entry of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      test(`${kind.name}/${entry.name} parses to its expected result`, () => {
        const caseDir = join(dir, entry.name);
        const result = parser(loadFixture(caseDir));
        // Round-trip through JSON so undefined fields compare like the stored file.
        expect(JSON.parse(JSON.stringify(result))).toEqual(loadExpected(caseDir));
        expect(result.meta.unparsed_text_chars).toBeGreaterThanOrEqual(0);
      });
    }
  }
});
