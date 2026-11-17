import { OFFER_FLAGS, RfError, type OfferFlag } from "@rainforest/core";
import type { PageContext } from "@rainforest/browser";
import type { Locator } from "playwright-core";
import {
  computeOfferFlags,
  isOfferOutOfStock,
  offerFlagContext,
  parseOffers,
  type Offer,
  type OffersData,
} from "@rainforest/parsers";
import { cartState, loadCart } from "./cart-writes.ts";
import { guardedClick } from "./click-guard.ts";
import { AMAZON, clearCaptureCache, runWithBudget, settle, type Flow } from "./common.ts";
import { readOfferToken, type OfferSnapshot } from "./offer-token.ts";

/**
 * add_to_cart: always two-step. The caller must hold an offer id minted by
 * get_buying_options; the flow re-reads the offer, refuses when anything about it changed
 * or when it carries flags the caller did not acknowledge, clicks that one offer's own
 * Add to Cart control in the all-offers panel, declines any upsell, and proves the result
 * by reading the cart again. It never retries the click.
 */

type Internal = { asin: string | null; offer_listing_id: string | null; seller_id: string | null };

function internalOf(offer: Offer): Internal | undefined {
  return (offer as Offer & { internal?: Internal }).internal;
}

function summarize(offer: Offer): Record<string, unknown> {
  return {
    price: offer.price,
    total: offer.total ?? null,
    condition: offer.condition,
    seller: offer.seller?.name ?? null,
    fulfillment: offer.fulfillment,
    prime: offer.prime,
    delivery: offer.delivery ?? null,
  };
}

function needsChoice(reason: string, message: string, details: Record<string, unknown>): never {
  throw new RfError("needs_choice", message, { details: { reason, ...details } });
}

/**
 * Find the offer the token was minted for among the offers on the page now. Listing ids
 * are not stable between loads, so identity is seller + condition + sub-condition; when
 * that is ambiguous the price at mint time breaks the tie, and a remaining ambiguity is
 * "not found" (fail closed).
 */
export function matchOffer(all: Offer[], snapshot: OfferSnapshot): Offer | null {
  const same = all.filter(
    (o) =>
      (internalOf(o)?.seller_id ?? null) === snapshot.seller_id &&
      (o.seller?.name ?? null) === snapshot.seller_name &&
      o.condition === snapshot.condition &&
      (o.sub_condition ?? null) === snapshot.sub_condition &&
      Boolean(internalOf(o)?.offer_listing_id),
  );
  if (same.length === 1) return same[0]!;
  const byPrice = same.filter(
    (o) => o.price !== null && Math.round(o.price.amount * 100) === snapshot.price_cents,
  );
  return byPrice.length === 1 ? byPrice[0]! : null;
}

/** Decide whether the add may proceed. Pure: exported for tests. */
export function decideAdd(input: {
  snapshot: OfferSnapshot;
  current: Offer | null;
  data: OffersData;
  acknowledge: readonly string[];
  quantity: number;
  now: number;
}): { flags: OfferFlag[] } {
  const { snapshot, current, data } = input;
  const alternatives = [data.pinned_offer, ...data.offers]
    .filter((o): o is Offer => o !== null)
    .slice(0, 8)
    .map(summarize);
  if (!current) {
    needsChoice("offer_gone", "that offer is no longer listed; nothing was added", {
      alternatives,
    });
  }
  const nowCents = current.price ? Math.round(current.price.amount * 100) : null;
  if (nowCents === null || nowCents !== snapshot.price_cents) {
    needsChoice(
      "price_changed",
      "the offer's price changed since get_buying_options; nothing was added",
      {
        was_cents: snapshot.price_cents,
        now_cents: nowCents,
        offer: summarize(current),
        alternatives,
      },
    );
  }
  const sellerNow = internalOf(current)?.seller_id ?? null;
  if (sellerNow !== snapshot.seller_id || (current.seller?.name ?? null) !== snapshot.seller_name) {
    needsChoice(
      "seller_changed",
      "the offer's seller changed since get_buying_options; nothing was added",
      {
        offer: summarize(current),
        alternatives,
      },
    );
  }
  if (isOfferOutOfStock(current)) {
    needsChoice("out_of_stock", "that offer is out of stock and cannot be added", { alternatives });
  }
  const flags = computeOfferFlags(
    current,
    offerFlagContext(data, current, {
      now: new Date(input.now),
      requested_quantity: input.quantity,
      utc_offset_minutes: -new Date(input.now).getTimezoneOffset(),
      prime_member: true,
    }),
  );
  const known = new Set<string>(OFFER_FLAGS);
  const acknowledged = new Set(input.acknowledge.filter((f) => known.has(f)));
  const unacknowledged = flags.filter((f) => !acknowledged.has(f));
  if (unacknowledged.length > 0) {
    needsChoice(
      "flags",
      `this offer has flags that must be acknowledged before adding: ${unacknowledged.join(", ")}; nothing was added`,
      { flags: unacknowledged, all_flags: flags, offer: summarize(current), alternatives },
    );
  }
  return { flags };
}

/** Path of a URL without query or fragment, for diagnostics. */
function pathOf(value: string): string {
  try {
    return new URL(value).pathname.slice(0, 120);
  } catch {
    return "";
  }
}

/**
 * What the product page shows about its all-offers panel. Counts and flags, no text.
 * `frames` says whether the page is still being drawn (an animation frame arrives within
 * 700 ms): a page that is not drawn, because its window is covered or the display is
 * off, never runs the work that pages queue on the next frame.
 */
const PANEL_STATE = `(async () => {
  const count = (selector) => document.querySelectorAll(selector).length;
  const frames = await new Promise((resolve) => {
    let done = false;
    requestAnimationFrame(() => {
      done = true;
      resolve(true);
    });
    setTimeout(() => {
      if (!done) resolve(false);
    }, 700);
  });
  return {
    visibility: document.visibilityState,
    has_focus: document.hasFocus(),
    frames,
    ready_state: document.readyState,
    url_has_aod: /[?&]aod=1(&|$)/.test(location.search),
    panel_containers: count("#aod-container, #all-offers-display, #aod-background"),
    panel_offers: count("#aod-offer, #aod-pinned-offer"),
    add_controls: count("span[data-action='aod-atc-action']"),
    ways_in: count("#aod-ingress-link, #buybox-see-all-buying-choices, [data-action='show-all-offers-display'], a[href*='aod=1']"),
    buy_box_add: count("#add-to-cart-button"),
  };
})()`;

/**
 * The panel shows the featured offer and its first few other offers, and folds the rest
 * into a block that is not rendered until the shopper asks for more. An offer in that
 * block has its add control in the page, but it cannot be clicked. Open the block with
 * the panel's own control (it only shows what the page already holds) and wait for this
 * offer's control to appear.
 */
async function revealFoldedOffer(page: PageContext, button: Locator): Promise<void> {
  const more = page.page.locator("[data-action='aod-show-other-offers'] button:visible");
  if ((await more.count()) !== 1) {
    throw new RfError(
      "layout_unrecognized",
      "that offer's Add to Cart control is not shown in the panel and there is no control to show more offers; nothing was added",
    );
  }
  await guardedClick(page, more, {
    what: "the panel's see-more-options control",
    label: /^see (\d+ )?more options\b/i,
  });
  await button.waitFor({ state: "visible", timeout: 8000 }).catch(() => {
    throw new RfError(
      "layout_unrecognized",
      "that offer's Add to Cart control did not appear after showing more offers; nothing was added",
    );
  });
}

async function declineUpsells(page: PageContext): Promise<string[]> {
  const declined: string[] = [];
  // Protection plan and add-on prompts: always the "no" control, never the offer.
  const candidates = [
    {
      selector: "#attachSiNoCoverage input, #attachSiNoCoverage-announce, #attachSiNoCoverage",
      label: /no thanks|no, thanks|skip/i,
    },
    {
      selector: "[data-action='aod-no-coverage'] input, #aod-no-coverage input",
      label: /no thanks|no, thanks/i,
    },
  ];
  for (const candidate of candidates) {
    const locator = page.page.locator(candidate.selector).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    try {
      await guardedClick(page, locator, {
        what: "the upsell's decline control",
        label: candidate.label,
      });
    } catch {
      continue;
    }
    declined.push(candidate.selector.split(" ")[0]!);
  }
  return declined;
}

export const addToCart: Flow = async (args, ctx) => {
  const now = ctx.now();
  const snapshot = readOfferToken(args.offer_id, now);
  const quantity = typeof args.quantity === "number" ? args.quantity : 1;
  if (args.purchase_type === "subscribe_and_save") {
    throw new RfError(
      "blocked_by_policy",
      "starting a subscription places a recurring order, which this server never does; use show_on_screen to hand the product to the owner",
    );
  }
  const acknowledge = Array.isArray(args.acknowledge) ? (args.acknowledge as string[]) : [];
  // Two cart reads (before and after) and two product loads (the page, then its panel).
  // When the budget is short, say so if the offer id will not outlive the wait.
  const offerNote = (waitMs: number): string | undefined =>
    snapshot.exp < ctx.now() + waitMs
      ? "the offer_id will have expired by then: call get_buying_options again before retrying"
      : undefined;
  return await runWithBudget(
    ctx,
    { cart: 2, product: 2 },
    async (page) => {
      const before = await loadCart(page);

      // Open the product with the all-offers panel and read the offers from the panel as
      // it is rendered in the page (listing ids change on every load, so the control that
      // gets clicked must come from this same DOM).
      // Reach the panel the way a visitor does: the product page first, then a navigation
      // from inside that page (a direct jump to the panel URL draws a challenge).
      await page.goto(`${AMAZON}/dp/${snapshot.asin}?th=1`, "product");
      await page.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await page.follow(`${AMAZON}/dp/${snapshot.asin}?aod=1&th=1`, "product");
      await page.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await page.page
        // Any VISIBLE add control means the panel is open. Not "the first control": on a
        // product with a featured offer the first one in the document belongs to the sticky
        // copy of that offer, which is not rendered until the panel is scrolled, so a wait
        // on the first match never ends.
        .waitForSelector("span[data-action='aod-atc-action']:visible", { timeout: 20_000 })
        .catch(async () => {
          // Counts and flags only, so the refusal says what the page looked like: was the
          // tab visible, did the panel exist at all, was there a way into it.
          const state = await page.page.evaluate(PANEL_STATE).catch(() => null);
          const refused = page.guard
            .blocked()
            .slice(-8)
            .map((b) => ({ method: b.method, path: pathOf(b.url), rule: b.verdict.rule }));
          throw new RfError(
            "layout_unrecognized",
            "the all-offers panel did not open; nothing was added",
            { details: { page: state, refused } },
          );
        });
      await settle(1000);
      const data = parseOffers(await page.capture("offers")).data;
      const all = [data.pinned_offer, ...data.offers].filter((o): o is Offer => o !== null);
      const current = matchOffer(all, snapshot);
      const { flags } = decideAdd({ snapshot, current, data, acknowledge, quantity, now });

      // Find THIS offer's control in the panel by the listing id just read from it.
      const wantedListing = current ? (internalOf(current)?.offer_listing_id ?? "") : "";
      const index = await page.page.evaluate(
        `((wanted) => {
        const spans = [...document.querySelectorAll("span[data-action='aod-atc-action']")];
        const norm = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
        for (let i = 0; i < spans.length; i++) {
          if (spans[i].closest("#aod-sticky-pinned-container")) continue;
          let data;
          try { data = JSON.parse(spans[i].getAttribute("data-aod-atc-action") || "{}"); } catch (e) { continue; }
          if (data && typeof data.oid === "string" && (data.oid === wanted || norm(data.oid) === norm(wanted))) {
            spans[i].setAttribute("data-rf-target", "1");
            return i;
          }
        }
        return -1;
      })(${JSON.stringify(wantedListing)})`,
      );
      if (typeof index !== "number" || index < 0) {
        throw new RfError(
          "layout_unrecognized",
          "could not find that offer's Add to Cart control in the panel; nothing was added",
        );
      }
      const button = page.page.locator("span[data-rf-target='1'] input[name='submit.addToCart']");
      if (!(await button.isVisible().catch(() => false))) await revealFoldedOffer(page, button);
      clearCaptureCache();
      await guardedClick(page, button, {
        what: "the offer's Add to Cart control",
        name: /^submit\.addToCart$/,
      });
      await settle(3000);
      // What the rails refused between the click and now (paths only), for diagnosis.
      const refusedAfterClick = page.guard
        .blocked()
        .slice(-5)
        .map((b) => ({
          method: b.method,
          path: pathOf(b.url),
          rule: b.verdict.rule,
          main_frame: b.mainFrameDocument,
        }));
      const landedPath = pathOf(page.page.url());
      const declined = await declineUpsells(page);

      const after = await loadCart(page);
      const beforeQty = before.active_items
        .filter((i) => i.asin === snapshot.asin)
        .reduce((n, i) => n + (i.quantity ?? 1), 0);
      const afterQty = after.active_items
        .filter((i) => i.asin === snapshot.asin)
        .reduce((n, i) => n + (i.quantity ?? 1), 0);
      const line = after.active_items.find((i) => i.asin === snapshot.asin) ?? null;
      const result = {
        before: cartState(before),
        after: cartState(after),
        added: line
          ? { item_id: line.item_id, asin: line.asin, title: line.title, quantity: line.quantity }
          : null,
        acknowledged_flags: flags,
        declined_upsells: declined,
        quantity_note:
          quantity > 1
            ? "one unit was added; call set_cart_quantity with the returned item_id to change the quantity"
            : undefined,
      };
      if (afterQty !== beforeQty + 1) {
        throw new RfError(
          "internal",
          "the cart did not change as intended after the add; the observed cart state is attached",
          {
            details: {
              ...result,
              refused_after_click: refusedAfterClick,
              page_after_click: landedPath,
            },
          },
        );
      }
      return { changed: true, ...result };
    },
    offerNote,
  );
};
