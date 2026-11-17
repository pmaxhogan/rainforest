import { z } from "zod";

/**
 * The tool registry: the single source of truth for tool names, input schemas,
 * descriptions and annotations. Compiled into both the hub and the daemon. The hub
 * forwards `{tool, args}`; the daemon validates again with the same schema.
 */

const browser = z
  .string()
  .max(64)
  .optional()
  .describe(
    "Which computer's browser to use: a browser id, name or alias from list_browsers. " +
      "Omit to use this connection's selection, else the most recently active computer.",
  );

const asin = z
  .string()
  .regex(/^[A-Z0-9]{10}$/)
  .describe("Amazon ASIN (10 characters)");

const cursor = z
  .string()
  .max(512)
  .optional()
  .describe("Opaque cursor from a previous response's next_cursor");

const maxChars = z
  .number()
  .int()
  .min(2000)
  .max(120_000)
  .optional()
  .describe(
    "Result size budget in characters (default 40000, hard cap 120000). Truncation is always explicit.",
  );

/** Cart line ids come from get_cart; the daemon checks this exact pattern. */
const cartItemId = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/)
  .describe("Cart line id from get_cart");

/** List item ids come from get_list; the daemon checks this exact pattern. */
const listItemId = z
  .string()
  .regex(/^[A-Za-z0-9-]{6,64}$/)
  .describe("List item id from get_list");

/**
 * Appended to the description of every tool the daemon does not implement yet (it answers
 * `unsupported`). Delete the suffix from a tool when its flow ships.
 */
export const NOT_IMPLEMENTED_SUFFIX = " Not implemented yet in this version; answers unsupported.";

/** For a result that can be cut but whose tool takes no `cursor`: say how to get the rest. */
const CUT_RAISE_MAX_CHARS =
  " A result over the budget is cut (truncated: true); this tool takes no cursor, so raise max_chars to get the rest.";
const CUT_NO_WAY =
  " A result over the default 40000-character budget is cut (truncated: true); this tool takes neither cursor nor max_chars, so the rest cannot be fetched.";

const orderId = z
  .string()
  .regex(/^[0-9D][0-9]{2}-[0-9]{7}-[0-9]{7}$/)
  .describe("Amazon order id, e.g. 111-1234567-1234567");

const listId = z
  .string()
  .regex(/^[A-Z0-9]{8,16}$/)
  .describe("List id from list_lists");

const D17_FLAGS = [
  "used_or_renewed",
  "no_featured_offer",
  "price_above_typical",
  "not_prime",
  "shipping_fee",
  "slow_delivery",
  "minimum_quantity",
  "quantity_limit",
  "multipack_ambiguity",
  "quantity_above_stock",
  "subscribe_and_save_default",
  "preorder_or_backorder",
  "addon_or_bundle_upsell",
  "protection_plan_prompt",
  "third_party_seller",
  "merchant_fulfilled",
] as const;

/** Per-offer flags from get_buying_options that stop an add unless acknowledged. */
export const OFFER_FLAGS = D17_FLAGS;
export type OfferFlag = (typeof OFFER_FLAGS)[number];

/** Flags that can never be acknowledged away. */
export const UNACKNOWLEDGEABLE_FLAGS = ["out_of_stock"] as const;

export type ToolKind = "hub" | "read" | "write";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** hub: answered by the hub itself. read / write: forwarded to a daemon. */
  kind: ToolKind;
  /** Write tools that remove something. */
  destructive?: boolean;
  /** Page type for pacing budgets inside the daemon. */
  pacing?:
    | "search"
    | "product"
    | "offers"
    | "reviews"
    | "account"
    | "cart"
    | "list"
    | "price_history"
    | "none";
  input: z.ZodObject;
}

function tool(def: ToolDef): ToolDef {
  return def;
}

export const TOOLS: readonly ToolDef[] = [
  // ---- browsers
  tool({
    name: "list_browsers",
    title: "List browsers",
    kind: "hub",
    description:
      "List the owner's computers that can drive Amazon: stable id, name, aliases, OS, online, last active, " +
      "idle/locked, Chrome running, Amazon signed in, daemon version, and whether it is this connection's selection.",
    input: z.object({}),
  }),
  tool({
    name: "select_browser",
    title: "Select browser",
    kind: "hub",
    description:
      "Set the default browser for THIS connection only (never globally). Pass null to clear the selection.",
    input: z.object({
      browser: z.string().max(64).nullable().describe("Browser id, name or alias; null clears"),
    }),
  }),
  tool({
    name: "show_on_screen",
    title: "Show on screen (hand-off)",
    kind: "write",
    pacing: "none",
    description:
      "Open an amazon.com product, cart, list or order page in a NORMAL (non-automation) tab on the chosen " +
      "computer and bring it to the front, so the owner can finish something (for example checkout) by hand. " +
      "This is the only way to reach checkout: placing orders is not possible through this server.",
    input: z.object({
      browser,
      target: z.discriminatedUnion("type", [
        z.object({ type: z.literal("product"), asin }),
        z.object({ type: z.literal("cart") }),
        z.object({ type: z.literal("list"), list_id: listId }),
        z.object({ type: z.literal("order"), order_id: orderId }),
        z.object({ type: z.literal("orders") }),
      ]),
    }),
  }),

  // ---- catalog reads
  tool({
    name: "search",
    title: "Search Amazon",
    kind: "read",
    pacing: "search",
    description:
      "Search amazon.com, one results page per call. Every result is labeled organic or sponsored (kind + " +
      "is_sponsored). Returns results, widgets (carousels/shelves with their own sponsored flag), all available " +
      "refinements grouped (each option has an opaque token), sort options, applied filters, corrections and " +
      "pagination. Beyond query, department, sort, min_price, max_price and brand, filter by passing a refinement " +
      "token from a previous response in `refinements` (Prime, star rating, condition, any left-rail filter). " +
      "Tokens are cumulative: only the last one is applied, and it replaces query, department and brand." +
      CUT_RAISE_MAX_CHARS,
    input: z.object({
      browser,
      query: z.string().min(1).max(300),
      department: z
        .string()
        .max(64)
        .optional()
        .describe("Search alias such as 'aps', 'electronics', 'grocery'"),
      sort: z
        .enum([
          "featured",
          "price_low_to_high",
          "price_high_to_low",
          "avg_customer_review",
          "newest",
          "best_sellers",
        ])
        .optional(),
      page: z.number().int().min(1).max(50).optional(),
      min_price: z.number().nonnegative().optional().describe("Dollars"),
      max_price: z.number().nonnegative().optional().describe("Dollars"),
      brand: z.string().max(100).optional(),
      refinements: z
        .array(z.string().max(512))
        .max(30)
        .optional()
        .describe(
          "Opaque refinement tokens from a previous search response (any left-rail filter, e.g. Prime, rating, condition)",
        ),
      max_chars: maxChars,
    }),
  }),
  tool({
    name: "get_product",
    title: "Get product",
    kind: "read",
    pacing: "product",
    description:
      "Read a product page: identity, buy-box state, featured offer, variant summary, media counts, rating " +
      "histogram, AI review summary, bullets, description, A+ text, spec tables, notices, and other_sections " +
      "(every visible block no typed parser consumed, so nothing is lost).",
    input: z.object({ browser, asin, max_chars: maxChars, cursor }),
  }),
  tool({
    name: "get_variants",
    title: "Get variants",
    kind: "read",
    pacing: "product",
    description:
      "Variant dimensions and values, the combination -> child ASIN map, and per-variant price / availability / " +
      "delivery where the page exposes them. fetch_missing loads child pages (within the pacing budget) for " +
      "variants whose offer is not on the page.",
    input: z.object({
      browser,
      asin,
      fetch_missing: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("How many child pages to load (default 0)"),
      max_chars: maxChars,
      cursor,
    }),
  }),
  tool({
    name: "get_buying_options",
    title: "Get buying options",
    kind: "read",
    pacing: "offers",
    description:
      "The featured offer (if any) plus ALL offers (new, used, renewed). Each offer has a short-lived opaque " +
      "offer_id (required by add_to_cart), price, shipping, total, condition, seller, ships-from, fulfillment, " +
      "Prime, delivery promise, quantity limits and flags. Also purchase types (one-time, Subscribe & Save) and " +
      "clippable coupons (listed only; clipping is not implemented). An offer_id expires after about 10 minutes." +
      CUT_RAISE_MAX_CHARS,
    input: z.object({
      browser,
      asin,
      condition: z.enum(["all", "new", "used", "renewed"]).optional(),
      max_chars: maxChars,
    }),
  }),
  tool({
    name: "get_media",
    title: "Get media",
    kind: "read",
    pacing: "product",
    description:
      "Hi-res image URLs per variant and videos (title, duration, URL, thumbnail). URLs only: no image data is returned." +
      CUT_NO_WAY,
    input: z.object({ browser, asin }),
  }),
  tool({
    name: "get_reviews",
    title: "Get reviews",
    kind: "read",
    pacing: "reviews",
    description:
      "Full review text, ten reviews per page (`page` N returns the Nth block of ten), with sort and filters. " +
      "Each review: rating, title, body, date, verified, variant attributes, helpful votes, media, badges." +
      CUT_RAISE_MAX_CHARS,
    input: z.object({
      browser,
      asin,
      sort: z.enum(["top", "recent"]).optional(),
      stars: z.enum(["all", "5", "4", "3", "2", "1", "positive", "critical"]).optional(),
      verified_only: z.boolean().optional(),
      keyword: z.string().max(100).optional(),
      this_variant_only: z.boolean().optional(),
      media_only: z.boolean().optional(),
      page: z.number().int().min(1).max(500).optional(),
      max_chars: maxChars,
    }),
  }),
  tool({
    name: "get_review_summary",
    title: "Get review summary",
    kind: "read",
    pacing: "product",
    description:
      "Rating, count, histogram, the AI 'Customers say' text and aspect chips, top positive and critical review." +
      CUT_NO_WAY,
    input: z.object({ browser, asin }),
  }),
  tool({
    name: "get_price_history",
    title: "Get price history",
    kind: "read",
    pacing: "price_history",
    description:
      "Price history per source (default all three), each entry with a terms note. amazon: the price facts the " +
      "product page shows (series only if the page embeds one). camelcamelcamel: stats, any series the page shows " +
      "and a chart image URL. keepa: a chart image URL and link only (series_available: false), no price numbers. " +
      "Chart URLs are links; no image data is returned. A failed lookup is reported inside its entry " +
      "(unavailable: true). Third-party lookups are cached for 6 hours and rate limited.",
    input: z.object({
      browser,
      asin,
      sources: z
        .array(z.enum(["amazon", "camelcamelcamel", "keepa"]))
        .min(1)
        .max(3)
        .optional()
        .describe("Default all three"),
    }),
  }),

  // ---- account reads
  tool({
    name: "get_cart",
    title: "Get cart",
    kind: "read",
    pacing: "cart",
    description:
      "Active cart items (opaque item id, ASIN, title, variant, price, quantity and options, seller, fulfillment, " +
      "condition, delivery promise, savings, notices), subtotal, and the Saved for later section.",
    input: z.object({ browser, max_chars: maxChars, cursor }),
  }),
  tool({
    name: "list_orders",
    title: "List orders",
    kind: "read",
    pacing: "account",
    description:
      "Order history, one page per call: `year`, or `range` (last30, months-3), or neither for Amazon's default " +
      "list (`year` wins over `range`). filter: orders (default), not_yet_shipped (open orders), cancelled (keeps " +
      "only the cancelled orders found on the requested page, so a page can come back empty while more pages " +
      "exist), archived (answers unsupported; archived orders still appear under their year). When Amazon has a " +
      "further page the result has next_page_cursor; a result cut for size has next_cursor. Pass either as `cursor`.",
    input: z.object({
      browser,
      year: z.number().int().min(1995).max(2100).optional(),
      range: z.enum(["last30", "months-3"]).optional(),
      filter: z.enum(["orders", "not_yet_shipped", "cancelled", "archived"]).optional(),
      cursor,
      max_chars: maxChars,
    }),
  }),
  tool({
    name: "get_order",
    title: "Get order",
    kind: "read",
    pacing: "account",
    description:
      "Full order details: items, prices, totals, shipments and tracking, payment summary (card brand and last 4), " +
      "return and refund status." +
      CUT_RAISE_MAX_CHARS,
    input: z.object({ browser, order_id: orderId, max_chars: maxChars }),
  }),
  tool({
    name: "get_invoice",
    title: "Get invoice",
    kind: "read",
    pacing: "account",
    description: "Invoice for an order: charge breakdown and payment transactions." + CUT_NO_WAY,
    input: z.object({ browser, order_id: orderId }),
  }),
  tool({
    name: "list_subscriptions",
    title: "List Subscribe & Save",
    kind: "read",
    pacing: "account",
    description: "Subscribe & Save subscriptions and upcoming deliveries (read only).",
    input: z.object({ browser, max_chars: maxChars, cursor }),
  }),
  tool({
    name: "list_lists",
    title: "List lists",
    kind: "read",
    pacing: "list",
    description: "The owner's lists with privacy and item counts." + CUT_NO_WAY,
    input: z.object({ browser }),
  }),
  tool({
    name: "get_list",
    title: "Get list",
    kind: "read",
    pacing: "list",
    description:
      "Items on a list: current price, price drops, added date, quantity wanted, priority, comment, availability.",
    input: z.object({ browser, list_id: listId, cursor, max_chars: maxChars }),
  }),
  tool({
    name: "get_browsing_history",
    title: "Get browsing history",
    kind: "read",
    pacing: "account",
    description: "Recently viewed products.",
    input: z.object({ browser, cursor, max_chars: maxChars }),
  }),
  tool({
    name: "get_search_history",
    title: "Get search history",
    kind: "read",
    pacing: "search",
    description:
      "Recent searches (best effort; returns `unsupported` with an explanation if Amazon hides it).",
    input: z.object({ browser }),
  }),

  // ---- writes: cart
  tool({
    name: "add_to_cart",
    title: "Add to cart",
    kind: "write",
    pacing: "cart",
    description:
      "Add ONE specific offer to the cart, always in two steps: offer_id must come from get_buying_options. " +
      "Adds nothing and fails with needs_choice (details.reason) when the offer is gone (offer_gone), its price or " +
      "seller changed (price_changed, seller_changed), it is out of stock (out_of_stock, never addable), or it " +
      "carries flags not all listed in `acknowledge` (flags; details list the flags and up to 8 alternatives). " +
      "Adds exactly one unit: quantity above 1 is not applied yet, and coupon clipping is not implemented yet. " +
      "purchase_type subscribe_and_save is always refused with blocked_by_policy, because a subscription is a " +
      "recurring order; use show_on_screen to finish one by hand. Result: {changed, before, after, added, " +
      "acknowledged_flags, declined_upsells, quantity_note}: before/after are cart states, added is the cart line " +
      "(its item_id works with the cart tools), acknowledged_flags the flags the offer carried, declined_upsells " +
      "the protection-plan or add-on prompts the flow answered with no, quantity_note is set when quantity was " +
      "above 1.",
    input: z.object({
      browser,
      offer_id: z.string().min(16).max(4096),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(999)
        .optional()
        .describe(
          "Default 1. One unit is added whatever this says; above 1 it only affects quantity flags",
        ),
      purchase_type: z
        .enum(["one_time", "subscribe_and_save"])
        .optional()
        .describe("Default one_time. subscribe_and_save is always refused (blocked_by_policy)"),
      clip_coupon: z.boolean().optional().describe("Not implemented yet; ignored"),
      acknowledge: z.array(z.enum(OFFER_FLAGS)).max(OFFER_FLAGS.length).optional(),
    }),
  }),
  tool({
    name: "set_cart_quantity",
    title: "Set cart quantity",
    kind: "write",
    pacing: "cart",
    description:
      "Set the quantity of a cart item (item_id from get_cart)." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({
      browser,
      item_id: cartItemId,
      quantity: z.number().int().min(1).max(999),
    }),
  }),
  tool({
    name: "remove_from_cart",
    title: "Remove from cart",
    kind: "write",
    destructive: true,
    pacing: "cart",
    description: "Remove an item from the cart. Returns {changed, before, after, item}.",
    input: z.object({ browser, item_id: cartItemId }),
  }),
  tool({
    name: "save_for_later",
    title: "Save for later",
    kind: "write",
    pacing: "cart",
    description: "Move a cart item to Saved for later. Returns {changed, before, after, item}.",
    input: z.object({ browser, item_id: cartItemId }),
  }),
  tool({
    name: "move_to_cart",
    title: "Move to cart",
    kind: "write",
    pacing: "cart",
    description:
      "Move a Saved for later item back to the cart. Returns {changed, before, after, item}.",
    input: z.object({ browser, item_id: cartItemId }),
  }),
  tool({
    name: "delete_saved_item",
    title: "Delete saved item",
    kind: "write",
    destructive: true,
    pacing: "cart",
    description: "Delete a Saved for later item. Returns {changed, before, after, item}.",
    input: z.object({ browser, item_id: cartItemId }),
  }),

  // ---- writes: lists
  tool({
    name: "create_list",
    title: "Create list",
    kind: "write",
    pacing: "list",
    description: "Create a list." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({
      browser,
      name: z.string().min(1).max(100),
      privacy: z.enum(["private", "shared", "public"]).optional().describe("Default private"),
    }),
  }),
  tool({
    name: "update_list",
    title: "Update list",
    kind: "write",
    pacing: "list",
    description: "Rename a list and/or change its privacy." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({
      browser,
      list_id: listId,
      name: z.string().min(1).max(100).optional(),
      privacy: z.enum(["private", "shared", "public"]).optional(),
    }),
  }),
  tool({
    name: "delete_list",
    title: "Delete list",
    kind: "write",
    destructive: true,
    pacing: "list",
    description: "Delete a list." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({ browser, list_id: listId }),
  }),
  tool({
    name: "add_to_list",
    title: "Add to list",
    kind: "write",
    pacing: "list",
    description: "Add a product to a list." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({ browser, list_id: listId, asin }),
  }),
  tool({
    name: "remove_from_list",
    title: "Remove from list",
    kind: "write",
    destructive: true,
    pacing: "list",
    description:
      "Remove an item from a list (item_id from get_list). Returns {changed, before, after, item}.",
    input: z.object({ browser, list_id: listId, item_id: listItemId }),
  }),
  tool({
    name: "update_list_item",
    title: "Update list item",
    kind: "write",
    pacing: "list",
    description:
      "Set quantity wanted, priority and/or comment on a list item." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({
      browser,
      list_id: listId,
      item_id: listItemId,
      quantity_wanted: z.number().int().min(1).max(999).optional(),
      priority: z.enum(["lowest", "low", "medium", "high", "highest"]).optional(),
      comment: z.string().max(500).optional(),
    }),
  }),
  tool({
    name: "move_list_item",
    title: "Move or copy list item",
    kind: "write",
    pacing: "list",
    description:
      "Move (or with copy: true, copy) an item to another list." + NOT_IMPLEMENTED_SUFFIX,
    input: z.object({
      browser,
      list_id: listId,
      item_id: listItemId,
      to_list_id: listId,
      copy: z.boolean().optional(),
    }),
  }),

  // ---- diagnostics
  tool({
    name: "get_status",
    title: "Get status",
    kind: "hub",
    description:
      "Hub state ({protocol, min_daemon_version, pending_calls}) plus the same per-computer rows as list_browsers " +
      "(online, daemon version, cool-down, remaining pacing budget). Takes no arguments; does not report parser health.",
    input: z.object({}),
  }),
  tool({
    name: "get_audit_log",
    title: "Get audit log",
    kind: "hub",
    description:
      "Recent tool calls: time, client, tool, browser, outcome, duration, error code; arguments for write tools " +
      "only. Never page content. 90-day retention.",
    input: z.object({
      limit: z.number().int().min(1).max(500).optional(),
      before: z.number().int().optional().describe("Only rows older than this epoch-ms timestamp"),
      tool: z.string().max(64).optional(),
      writes_only: z.boolean().optional(),
    }),
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return byName.get(name);
}

export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** MCP annotations for a tool. Read tools are read-only; writes are never marked read-only. */
export function annotationsFor(def: ToolDef): {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const readOnly = def.kind === "read" || (def.kind === "hub" && def.name !== "select_browser");
  return {
    title: def.title,
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && def.destructive === true,
    idempotentHint: readOnly,
    openWorldHint: def.kind !== "hub",
  };
}

/** JSON Schema for a tool's input, as MCP tools/list expects it. */
export function inputJsonSchema(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(def.input, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}
