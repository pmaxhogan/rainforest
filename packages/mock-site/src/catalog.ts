/**
 * The invented catalog. Every product exists to exercise one shape the flows and parsers
 * must handle (a "footgun"): who sells it, whether there is a featured offer, Subscribe &
 * Save defaults, coupons, limits, upsells, pre-orders and variants. All names are invented.
 */

export const PLATFORM_SELLER = "Amazon.com";
export const PLATFORM_SHIPPER = "Amazon";

export type Condition = "New" | "Used - Like New" | "Used - Good" | "Renewed";

export interface Offer {
  /** Opaque offer listing id (what add-to-cart posts). */
  olid: string;
  seller: string;
  /** null = the platform itself. */
  sellerId: string | null;
  shipsFrom: string;
  condition: Condition;
  priceCents: number;
  prime: boolean;
  /** Shipping fee in cents; 0 = free. */
  shippingCents: number;
}

export type Scenario =
  | "platform"
  | "fba"
  | "merchant"
  | "no_featured_offer"
  | "unavailable"
  | "used_only"
  | "subscribe_and_save"
  | "coupon"
  | "quantity_limit"
  | "protection_plan"
  | "preorder"
  | "variants"
  | "plan";

export interface Variation {
  parent: string;
  color: string;
  size: string;
}

export interface Product {
  asin: string;
  title: string;
  brand: string;
  scenario: Scenario;
  rating: number;
  reviews: number;
  bullets: string[];
  /** The buy-box offer; null when there is no featured offer or the item is unavailable. */
  featured: Offer | null;
  /** Further offers listed in the all-offers panel (the featured one is the pinned offer). */
  others: Offer[];
  /** Subscribe & Save discount percent (the subscription row is the DEFAULT selection). */
  snsPercent?: number;
  couponCents?: number;
  /** Maximum quantity per customer. */
  limit?: number;
  /** The protection plan offered after adding this product. */
  planAsin?: string;
  releaseDate?: string;
  variation?: Variation;
  /** Not listed in search (plans, variation parents). */
  hidden?: boolean;
}

const offer = (o: Partial<Offer> & Pick<Offer, "olid" | "priceCents">): Offer => ({
  seller: PLATFORM_SELLER,
  sellerId: null,
  shipsFrom: PLATFORM_SHIPPER,
  condition: "New",
  prime: true,
  shippingCents: 0,
  ...o,
});

const thirdParty = (olid: string, priceCents: number, extra: Partial<Offer> = {}): Offer =>
  offer({
    olid,
    priceCents,
    seller: "Sample Outfitters",
    sellerId: "A0FAKESELL02",
    shipsFrom: "Sample Outfitters",
    prime: false,
    shippingCents: 599,
    ...extra,
  });

const PRODUCTS: Product[] = [
  {
    asin: "B0FAKE0001",
    title: "Example Bamboo Cutting Board, Large",
    brand: "Examplewood",
    scenario: "platform",
    rating: 4.6,
    reviews: 2381,
    bullets: ["Invented bamboo surface", "Juice groove on one side"],
    featured: offer({ olid: "FAKEOLID0001A", priceCents: 2499 }),
    others: [
      thirdParty("FAKEOLID0001B", 2299),
      offer({
        olid: "FAKEOLID0001C",
        priceCents: 1899,
        condition: "Used - Good",
        seller: "Example Resale Shop",
        sellerId: "A0FAKESELL03",
      }),
    ],
  },
  {
    asin: "B0FAKE0002",
    title: "Example Ceramic Pour-Over Kettle",
    brand: "Sampleware",
    scenario: "fba",
    rating: 4.3,
    reviews: 512,
    bullets: ["Invented gooseneck spout", "Holds one liter"],
    featured: offer({
      olid: "FAKEOLID0002A",
      priceCents: 3450,
      seller: "Example Goods Co",
      sellerId: "A0FAKESELL01",
    }),
    others: [],
  },
  {
    asin: "B0FAKE0003",
    title: "Example Waxed Canvas Tote Bag",
    brand: "Sample Outfitters",
    scenario: "merchant",
    rating: 4.1,
    reviews: 88,
    bullets: ["Invented waxed canvas", "Interior pocket"],
    featured: thirdParty("FAKEOLID0003A", 3999),
    others: [],
  },
  {
    asin: "B0FAKE0004",
    title: "Example Vintage Desk Lamp",
    brand: "Examplewood",
    scenario: "no_featured_offer",
    rating: 3.9,
    reviews: 41,
    bullets: ["Invented brass finish"],
    featured: null,
    others: [thirdParty("FAKEOLID0004A", 6400), thirdParty("FAKEOLID0004B", 7100)],
  },
  {
    asin: "B0FAKE0005",
    title: "Example Enamel Camping Mug",
    brand: "Sampleware",
    scenario: "unavailable",
    rating: 4.4,
    reviews: 1290,
    bullets: ["Invented enamel coating"],
    featured: null,
    others: [],
  },
  {
    asin: "B0FAKE0006",
    title: "Example Compact Film Scanner",
    brand: "Sample Optics",
    scenario: "used_only",
    rating: 3.7,
    reviews: 203,
    bullets: ["Invented 35mm adapter"],
    featured: offer({
      olid: "FAKEOLID0006A",
      priceCents: 5900,
      condition: "Used - Like New",
      seller: "Example Resale Shop",
      sellerId: "A0FAKESELL03",
    }),
    others: [],
  },
  {
    asin: "B0FAKE0007",
    title: "Example Whole Bean Coffee, 2 lb",
    brand: "Sample Roasters",
    scenario: "subscribe_and_save",
    rating: 4.5,
    reviews: 9804,
    bullets: ["Invented medium roast"],
    featured: offer({ olid: "FAKEOLID0007A", priceCents: 1800 }),
    others: [],
    snsPercent: 5,
  },
  {
    asin: "B0FAKE0008",
    title: "Example LED Reading Light",
    brand: "Sample Optics",
    scenario: "coupon",
    rating: 4.2,
    reviews: 677,
    bullets: ["Invented warm light"],
    featured: offer({ olid: "FAKEOLID0008A", priceCents: 1999 }),
    others: [],
    couponCents: 200,
  },
  {
    asin: "B0FAKE0009",
    title: "Example Small-Batch Hot Sauce",
    brand: "Sample Kitchen",
    scenario: "quantity_limit",
    rating: 4.8,
    reviews: 3302,
    bullets: ["Invented habanero blend"],
    featured: offer({ olid: "FAKEOLID0009A", priceCents: 1250 }),
    others: [],
    limit: 2,
  },
  {
    asin: "B0FAKE000A",
    title: "Example Robot Vacuum Cleaner",
    brand: "Sampletronics",
    scenario: "protection_plan",
    rating: 4.0,
    reviews: 1544,
    bullets: ["Invented edge brush"],
    featured: offer({ olid: "FAKEOLID000AA", priceCents: 19900 }),
    others: [],
    planAsin: "B0FAKE00P1",
  },
  {
    asin: "B0FAKE00P1",
    title: "Example 2-Year Protection Plan",
    brand: "Sample Protect",
    scenario: "plan",
    rating: 4.0,
    reviews: 10,
    bullets: ["Invented coverage"],
    featured: offer({ olid: "FAKEOLID00P1A", priceCents: 2499 }),
    others: [],
    hidden: true,
  },
  {
    asin: "B0FAKE000B",
    title: "Example Board Game, Second Edition",
    brand: "Sample Games",
    scenario: "preorder",
    rating: 4.7,
    reviews: 95,
    bullets: ["Invented cooperative play"],
    featured: offer({ olid: "FAKEOLID000BA", priceCents: 4999 }),
    others: [],
    releaseDate: "March 3, 2031",
  },
  {
    asin: "B0FAKE00V0",
    title: "Example Merino Crew Socks",
    brand: "Sample Knits",
    scenario: "variants",
    rating: 4.4,
    reviews: 720,
    bullets: ["Invented merino blend"],
    featured: null,
    others: [],
    hidden: true,
  },
];

/** Variation children: color x size, with one combination missing on purpose. */
const VARIANTS: [string, string, string, number][] = [
  ["B0FAKE00V1", "Red", "S", 1499],
  ["B0FAKE00V2", "Red", "M", 1499],
  ["B0FAKE00V3", "Blue", "S", 1599],
  ["B0FAKE00V4", "Blue", "L", 1699],
];
for (const [asin, color, size, priceCents] of VARIANTS) {
  PRODUCTS.push({
    asin,
    title: `Example Merino Crew Socks, ${color}, ${size}`,
    brand: "Sample Knits",
    scenario: "variants",
    rating: 4.4,
    reviews: 720,
    bullets: ["Invented merino blend"],
    featured: offer({ olid: `FAKEOLID${asin.slice(-2)}A`, priceCents }),
    others: [],
    variation: { parent: "B0FAKE00V0", color, size },
  });
}

export const VARIANT_COLORS = ["Red", "Blue"] as const;
export const VARIANT_SIZES = ["S", "M", "L"] as const;

export const CATALOG: ReadonlyMap<string, Product> = new Map(PRODUCTS.map((p) => [p.asin, p]));

export function product(asin: string): Product | undefined {
  return CATALOG.get(asin);
}

/** Every offer of a product, featured first. */
export function offersOf(p: Product): Offer[] {
  return [...(p.featured ? [p.featured] : []), ...p.others];
}

export function findOffer(olid: string): { product: Product; offer: Offer } | null {
  for (const p of CATALOG.values()) {
    for (const o of offersOf(p)) if (o.olid === olid) return { product: p, offer: o };
  }
  return null;
}

export function variationChildren(parent: string): Product[] {
  return [...CATALOG.values()].filter((p) => p.variation?.parent === parent);
}

/** Products listed in search, in catalog order. */
export function searchable(): Product[] {
  return [...CATALOG.values()].filter((p) => !p.hidden);
}

export interface OrderLine {
  asin: string;
  quantity: number;
}

export interface Order {
  id: string;
  placed: string;
  delivered: string;
  lines: OrderLine[];
  shippingCents: number;
  taxCents: number;
}

export const SHIP_TO = {
  name: "Alex Example",
  street: "100 Example Street",
  city: "Exampleville, EX 00000",
  country: "United States",
};

export const ORDERS: readonly Order[] = [
  {
    id: "000-0000000-0000001",
    placed: "November 2, 2026",
    delivered: "November 4",
    lines: [
      { asin: "B0FAKE0001", quantity: 1 },
      { asin: "B0FAKE0003", quantity: 2 },
    ],
    shippingCents: 0,
    taxCents: 860,
  },
  {
    id: "000-0000000-0000002",
    placed: "October 20, 2026",
    delivered: "October 23",
    lines: [{ asin: "B0FAKE0007", quantity: 1 }],
    shippingCents: 0,
    taxCents: 144,
  },
];

export function orderSubtotal(order: Order): number {
  return order.lines.reduce(
    (sum, l) => sum + (product(l.asin)?.featured?.priceCents ?? 0) * l.quantity,
    0,
  );
}
