import { describe, expect, test } from "vitest";
import { RfError } from "@rainforest/core";
import type { Offer, OffersData } from "@rainforest/parsers";
import { decideAdd } from "../src/flows/add-to-cart.ts";
import type { OfferSnapshot } from "../src/flows/offer-token.ts";

const NOW = Date.parse("2026-01-10T18:00:00Z");

function offer(over: Record<string, unknown> = {}): Offer {
  return {
    index: 0,
    pinned: true,
    collapsed: false,
    source: "aod",
    price: { amount: 12.99, currency: "USD", raw: "$12.99" },
    shipping: { free: true, raw: "FREE delivery" },
    total: { amount: 12.99, currency: "USD", raw: "$12.99" },
    condition: "new",
    seller: { name: "Example Store", is_amazon: true },
    ships_from: "Example Store",
    fulfillment: "amazon",
    prime: true,
    delivery: {
      primary: { raw: "FREE delivery Monday, January 12", date_iso: "2026-01-12", free: true },
    },
    promotions: [],
    badges: [],
    fees: [],
    details: [],
    flags: [],
    internal: {
      asin: "B0FAKE0001",
      offer_listing_id: "listing-1",
      seller_id: null,
      condition: "new",
      price: null,
    },
    ...over,
  } as unknown as Offer;
}

function data(pinned: Offer | null, offers: Offer[] = []): OffersData {
  return {
    product: { asin: "B0FAKE0001", title: "Example widget" },
    pinned_offer: pinned,
    offers,
    no_offers: false,
    no_featured_offer: false,
    filters: [],
    pagination: {},
    purchase_types: [],
    coupons: [],
    promotions: [],
    buybox: {},
  } as unknown as OffersData;
}

const snapshot: OfferSnapshot = {
  asin: "B0FAKE0001",
  offer_listing_id: "listing-1",
  seller_id: null,
  seller_name: "Example Store",
  condition: "new",
  price_cents: 1299,
  flags: [],
  out_of_stock: false,
  source: "aod",
  index: 0,
  exp: NOW + 60_000,
};

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RfError);
    expect((error as RfError).payload.code).toBe("needs_choice");
    return String((error as RfError).payload.details?.reason);
  }
  return "allowed";
}

describe("decideAdd", () => {
  const base = { snapshot, acknowledge: [] as string[], quantity: 1, now: NOW };

  test("an unchanged offer either passes or names every flag it carries", () => {
    const current = offer();
    const outcome = reason(() => decideAdd({ ...base, current, data: data(current) }));
    expect(["allowed", "flags"]).toContain(outcome);
  });

  test("a missing offer, a changed price and a changed seller each stop the add", () => {
    expect(reason(() => decideAdd({ ...base, current: null, data: data(null) }))).toBe(
      "offer_gone",
    );
    const pricier = offer({ price: { amount: 14.99, currency: "USD", raw: "$14.99" } });
    expect(reason(() => decideAdd({ ...base, current: pricier, data: data(pricier) }))).toBe(
      "price_changed",
    );
    const noPrice = offer({ price: null });
    expect(reason(() => decideAdd({ ...base, current: noPrice, data: data(noPrice) }))).toBe(
      "price_changed",
    );
    const otherSeller = offer({ seller: { name: "Another Store", is_amazon: false } });
    expect(
      reason(() => decideAdd({ ...base, current: otherSeller, data: data(otherSeller) })),
    ).toBe("seller_changed");
  });

  test("a flagged offer needs every flag acknowledged, and unknown names do not count", () => {
    const used = offer({ condition: "used", condition_label: "Used - Good" });
    const usedData = data(used);
    let flags: string[] = [];
    try {
      decideAdd({ ...base, current: used, data: usedData });
    } catch (error) {
      flags = (error as RfError).payload.details?.flags as string[];
    }
    expect(flags).toContain("used_or_renewed");
    expect(
      reason(() =>
        decideAdd({ ...base, current: used, data: usedData, acknowledge: ["bogus", "everything"] }),
      ),
    ).toBe("flags");
    expect(
      reason(() =>
        decideAdd({ ...base, current: used, data: usedData, acknowledge: flags.slice(0, -1) }),
      ),
    ).toBe(flags.length > 1 ? "flags" : "allowed");
    expect(
      reason(() => decideAdd({ ...base, current: used, data: usedData, acknowledge: flags })),
    ).toBe("allowed");
  });
});
