import { describe, expect, it } from "vitest";
import { FAKE, RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { cleanPath, isoFromText, parseSubscriptions } from "../../src/pages/subscriptions.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";

const CAPTURED = "2026-11-16T12:00:00.000Z";

function capture(html: string): Capture {
  return {
    kind: "subscriptions",
    url: `${FAKE.host}/auto-deliveries`,
    final_url: `${FAKE.host}/auto-deliveries`,
    captured_at: CAPTURED,
    html: `<!DOCTYPE html><html><head><title>Manage Your Deliveries</title></head><body>${html}</body></html>`,
  };
}

const epoch = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);

function manageUrl(bundle: string, ms: number): string {
  return `/auto-deliveries/?_encoding=UTF8&shipId=SHIP0001&deliveryDate=${ms}&deliveryBundleId=${bundle}&enableMydExperience=1&ref_=mydHub_deliveries_manage&sourcePage=hub&pf_rd_p=PFP&pf_rd_r=PFR`;
}

const NAV = `
<div id="CardInstanceNav0001">
  <div class="a-section tabBar"><span><a class="tab" href="/gp/buyagain?ref=nav">Buy Again</a></span>
    <span id="snsNavigationLogo" aria-current="page"><img alt="" src="${FAKE.imageUrl}">Subscribe &amp; Save</span></div>
  <div id="hub-navigation-pills" class="a-section">
    <span data-hub-section=""><a id="menu-item-button-pill-settings" class="pill" href="/auto-deliveries/preferences?enableMydExperience=1&amp;ref=x"><img role="img" aria-label="Settings" src="${FAKE.imageUrl}"></a></span>
    <span data-hub-section="deliveries"><a id="menu-item-button-pill-deliveries" class="pill pillSelected" href="/auto-deliveries?enableMydExperience=1&amp;ref=x" aria-current="location">Deliveries</a></span>
    <span data-hub-section="subscriptions"><a id="menu-item-button-pill-subscriptions" class="pill" href="/auto-deliveries?enableMydExperience=1&amp;scrollTo=subscriptions&amp;ref=x">Subscriptions</a></span>
    <span data-hub-section=""><a id="menu-item-button-pill-shop" class="pill" href="/auto-deliveries/landing?ref_=x">Shop</a></span>
  </div>
</div>`;

function slide(pos: number, inner: string, hidden = false): string {
  const h = hidden ? ' style="visibility: hidden" data-rf-hidden="1" aria-hidden="true"' : "";
  return `<li class="a-carousel-card" aria-setsize="4" aria-posinset="${pos}"${h}>${inner}</li>`;
}

function deliveryCard(opts: {
  bundle: string;
  label: string;
  last: string;
  ms?: number;
  imgs: string[];
  plus?: number;
  skip?: boolean;
  inprogress?: boolean;
}): string {
  const url = opts.ms === undefined ? "/auto-deliveries/?x=1" : manageUrl(opts.bundle, opts.ms);
  return `<div data-csa-c-type="card" data-csa-c-delivery-bundle-id="${opts.bundle}">
    <div data-mix-operations="cardClickHandler" data-manageurl="${url}">
      <div id="${opts.bundle}" class="a-row hub-delivery-card">
        <div class="deliveryCardLarge${opts.inprogress === true ? " card_inprogress" : ""}">
          <div class="a-section"><span class="a-size-medium a-text-bold">${opts.label}</span></div>
          <div class="a-section"><span class="a-size-base a-color-secondary">${opts.last}</span></div>
          <div class="multiImageSection">
            ${opts.imgs.map((alt) => `<div class="a-image-container"><img alt="${alt}" src="${FAKE.imageUrl}" class="productImage"></div>`).join("")}
            ${opts.plus === undefined ? "" : `<div class="a-section plusCount"><span class="a-size-base a-text-bold">+${opts.plus}</span></div>`}
          </div>
          <div class="a-section actionStackContainer">
            <div id="action-button-container-0"><span class="a-button"><span class="a-button-inner"><a href="${url}" class="a-button-text"><span>Manage</span></a></span></span></div>
            ${opts.skip === true ? `<div id="action-button-container-1"><span class="a-button"><span class="a-button-inner"><span class="a-button-text"><span>Skip items</span></span></span></span></div>` : ""}
          </div>
          <div id="bulk-skip-success-message" class="aok-hidden" data-rf-hidden="1"><span id="bulk-skip-success-text">Skipped</span></div>
        </div>
      </div>
    </div>
  </div>`;
}

const SENTINEL = `<div id="endOfDeliveriesDesktop" data-next-url="/api/marketplaces/MKT0001/customer/replenishment/fulfillment/deliveries?filteringContext.startDate=2027-01-18T00%3A00%3A00.000Z&amp;paginationContext.next=&amp;paginationContext.subscriptionsPerDelivery=30"></div>`;

function deliveriesSection(): string {
  return `
<div id="CardInstanceDeliv0001">
  <div id="cardHeader" class="a-section"><span class="a-size-large">Upcoming delivery days</span></div>
  <div id="deliveriesDesktopScroller" class="a-carousel-container">
    <a class="a-button a-carousel-button a-carousel-goto-prevpage" href="#"><i class="a-icon"><span class="a-icon-alt">Previous page</span></i></a>
    <div class="a-carousel-viewport"><ol class="a-carousel">
      ${slide(1, deliveryCard({ bundle: "BUNDLE0001", label: "Arriving Tue, Nov 17", last: "Last day to edit Wed, Nov 11", ms: epoch(2026, 11, 17), imgs: ["Fake Widget One"], inprogress: true }))}
      ${slide(2, deliveryCard({ bundle: "BUNDLE0002", label: "Arriving Tue, Nov 24", last: "Last day to edit Wed, Nov 18", ms: epoch(2026, 11, 24), imgs: ["Fake Widget Two", "Fake Widget Three", "Fake Widget Four"], plus: 2, skip: true }))}
      ${slide(3, deliveryCard({ bundle: "BUNDLE0003", label: "Arriving Tue, Dec 22", last: "Last day to edit Wed, Dec 16", ms: epoch(2026, 12, 22), imgs: ["Fake Widget Five"] }), true)}
      ${slide(4, SENTINEL, true)}
    </ol></div>
    <a class="a-button a-carousel-button a-carousel-goto-nextpage" href="#"><i class="a-icon"><span class="a-icon-alt">Next page</span></i></a>
  </div>
</div>`;
}

const SAVINGS = `
<div id="hub-savings-slot"><div id="CardInstanceSave0001"><h1 class="a-size-base">You've saved <span class="a-price"><span class="a-offscreen">$181.00</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">181</span></span></span></h1>
<div class="a-row"> since Sep 2025 <span id="customer-savings-breakdown-trigger"><a class="a-link-normal" href="#">Learn more</a></span></div>
<span id="a-popover-breakdown-3" data-rf-hidden="1"><h1>Your total subscription savings</h1><span class="a-price"><span class="a-offscreen">$165.00</span></span></span></div></div>`;

function tile(opts: {
  sub: string;
  asin: string;
  title: string;
  next: string;
  freq: string;
  extra?: string;
}): string {
  return `<div class="clickableTile" data-mix-operations="editSubscriptionModalHandler" data-edit-url="/auto-deliveries/ajax/subscription/?_encoding=UTF8&amp;subscriptionId=${opts.sub}&amp;subAsin=${opts.asin}&amp;shipId=SHIP0001&amp;ref_=mydHub_subscriptions&amp;clientName=mydHub&amp;pf_rd_p=PFP">
    <div class="a-row"><div class="tile">
      <div class="a-column"><div role="button"><div class="a-section"><div class="a-image-container"><img alt="${opts.title}" src="${FAKE.imageUrl}" class="productImage"></div></div></div></div>
      <div class="a-row tileContent">
        <div class="a-column"><div role="button"><div class="a-section"><span class="a-truncate a-size-base"><span class="a-truncate-full a-offscreen">${opts.title}</span><span class="a-truncate-cut" aria-hidden="true">${opts.title}</span></span></div></div></div>
        <div class="a-column"><div role="button"><div class="a-section"><span class="a-size-small a-color-secondary">Next delivery: ${opts.next}</span></div></div></div>
        <div class="a-column frequencyLine"><div role="button"><div class="a-section"><span class="a-size-small a-color-secondary">${opts.freq}</span></div></div></div>
        ${opts.extra === undefined ? "" : `<div class="a-column"><span class="a-size-small">${opts.extra}</span></div>`}
        <div class="a-column"><div role="button" data-edit-link="true" class="a-button a-button-small"><span class="a-button-inner"><span class="a-button-text">Edit</span></span></div></div>
      </div>
    </div></div></div>`;
}

const SUBS = `
<div id="CardInstanceSubs0001">
  <div id="subscriptions-desktop-section-heading"><div id="cardHeader" class="a-section"><span class="a-size-large a-text-bold">Your Subscriptions</span><span aria-hidden="true">&middot;</span>
    <div role="button" aria-label="Edit subscriptions" data-mix-operations="bulkEditSheetHandler" data-content="/auto-deliveries/ajax/subscriptions/edit/?_encoding=UTF8&amp;editAction=bulkSchedule&amp;offset=0&amp;ref_=x&amp;pf_rd_p=PFP"><span class="a-size-base-plus a-color-link">Edit All</span></div></div></div>
  <div id="categoryFiltersDesktopContainer">
    <span id="searchTogglePill" role="button" aria-label="Search"><i class="a-icon a-icon-search"></i></span>
    <span data-category-id="gl_fake_one" role="button"><span class="a-size-small">Fake Category One (2)</span><span class="aok-hidden" data-rf-hidden="1"><i class="a-icon"></i></span></span>
    <span data-category-id="gl_fake_two" role="button"><span class="a-size-small">Fake Category Two (1)</span></span>
  </div>
  <div id="subscriptionsDesktopGridLayout" class="a-section">
    ${tile({ sub: "SUB0001", asin: "B0FAKE0001", title: "Fake Widget One", next: "Nov 24", freq: "1 unit every 1 month" })}
    ${tile({ sub: "SUB0002", asin: "B0FAKE0002", title: "Fake Widget Two", next: "Dec 3", freq: "2 units every 6 weeks" })}
    ${tile({ sub: "SUB0003", asin: "B0FAKE0003", title: "Fake Widget Three", next: "Jan 5", freq: "1 unit every 3 months", extra: "Paused until Jan 1" })}
  </div>
</div>`;

function offer(i: number, opts: { asin: string; noPrice?: boolean }): string {
  const price = opts.noPrice
    ? ""
    : `<div class="snsBasePrice aok-hidden" data-asin="${opts.asin}" data-rf-hidden="1"><div class="a-row"><span class="a-color-price priceSavings">-5%</span><span class="a-price"><span class="a-offscreen">$9.99</span><span aria-hidden="true">$9.99</span></span></div></div>
       <div class="snsTieredPrice" data-asin="${opts.asin}"><div class="a-section"><div class="a-row priceRow"><span class="a-size-medium a-color-price priceSavings">-15%</span><div class="priceToPay"><span class="a-price" data-a-size="l"><span class="a-offscreen">$8.49</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">8<span class="a-price-decimal">.</span></span><span class="a-price-fraction">49</span></span></span></div></div>
       <div class="a-row basisPriceRow"><span class="a-size-small a-color-secondary">One-Time Price:</span><span class="a-size-small a-color-secondary a-text-strike">$9.99</span></div></div></div>`;
  return `<li data-id="asin-faceout-${i}" class="a-carousel-card"><div data-csa-c-item-id="amzn1.asin.1.${opts.asin}:amzn1.promotion.FAKE" data-csa-c-item-type="asin" data-csa-c-owner="eemb-sns" data-csa-c-type="item">
    <div class="a-row badge"><span id="eeBadgeInner-${opts.asin}" class="a-badge"><span class="a-badge-label"><span class="a-badge-label-inner"><span class="a-badge-text">Purchased 2 times</span></span></span></span></div>
    <div class="a-row"><a id="ee-cards-desktop-link-location-${opts.asin}" class="a-link-normal" href="/Fake-Widget-${i}/dp/${opts.asin}?ref_=sns_x&amp;pd_rd_w=W"><div class="a-image-container"><img alt="Fake Offer ${i}" src="${FAKE.imageUrl}"></div></a></div>
    <div class="a-row"><a class="a-color-base a-link-normal" href="/Fake-Widget-${i}/dp/${opts.asin}?ref_=sns_y"><span><span class="a-truncate a-size-base"><span class="a-truncate-full a-offscreen">Fake Offer ${i}</span><span class="a-truncate-cut" aria-hidden="true">Fake Offer ${i}</span></span></span></a></div>
    <div class="a-row a-spacing-top-mini">${price}</div>
    <div class="a-row a-spacing-top-mini"><div id="ee-promotion-${opts.asin}" class="a-section"><span class="a-size-small">Extra 10% off</span></div><span class="a-size-small aok-hidden" data-rf-hidden="1">when you subscribe</span></div>
    <div class="a-row"><div class="a-section"><span class="a-size-small">Deliver every:</span></div><div class="a-section"><span class="a-dropdown-container"><select name="snsFrequencySelectorDropdown" id="${opts.asin}" class="a-native-dropdown"><option class="a-prompt" value="" data-rf-hidden="1">1 month</option><option value="2W|sns" data-rf-hidden="1">2 weeks</option><option value="1M|sns" selected data-rf-hidden="1">1 month</option></select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text"><span class="a-dropdown-prompt">1 month</span></span></span></span></span></div></div>
    <div class="snsSubscribeButton" data-asin="${opts.asin}"><span id="${opts.asin}-sns-subscribe" class="a-button"><span class="a-button-inner"><span class="a-button-text">Subscribe now</span></span></span></div>
  </div></li>`;
}

function recommended(withoutPrice = false): string {
  return `
<div id="CardInstanceRec0001">
  <div id="displayItems" class="aok-hidden" data-count="2" data-rf-hidden="1"></div>
  <div class="a-carousel-container"><div class="a-section"><h2 class="a-size-large"><span>Recommended for you</span></h2></div>
  <div class="a-carousel-controls"><div class="a-carousel-col"><a class="a-button a-carousel-button a-carousel-goto-prevpage" href="#"><i class="a-icon"><span class="a-icon-alt">Previous page</span></i></a></div>
  <ol class="a-carousel">${offer(0, { asin: "B0FAKE0101" })}${offer(1, { asin: "B0FAKE0102", noPrice: withoutPrice })}</ol></div></div>
</div>`;
}

const FULL = NAV + deliveriesSection() + SAVINGS + SUBS + recommended(true);

function parse(html: string) {
  return parseSubscriptions(capture(html));
}

describe("parseSubscriptions: full page", () => {
  const r = parse(FULL);
  const d = r.data;

  it("reads the program tab and the section pills", () => {
    expect(d.program).toBe("Subscribe & Save");
    expect(d.program_links).toEqual([{ label: "Buy Again", href_path: "/gp/buyagain" }]);
    expect(d.tabs.map((t) => t.key)).toEqual(["settings", "deliveries", "subscriptions", "shop"]);
    expect(d.tabs.find((t) => t.key === "deliveries")).toMatchObject({
      label: "Deliveries",
      href_path: "/auto-deliveries?enableMydExperience=1",
      selected: true,
    });
    expect(d.tabs.find((t) => t.key === "subscriptions")?.href_path).toBe(
      "/auto-deliveries?enableMydExperience=1&scrollTo=subscriptions",
    );
    expect(d.tabs.find((t) => t.key === "settings")?.label).toBe("Settings");
    expect(r.meta.strategies.tabs).toBe("id");
  });

  it("parses visible and off-screen delivery cards, in order", () => {
    expect(d.deliveries_heading).toBe("Upcoming delivery days");
    expect(d.upcoming_deliveries).toHaveLength(3);
    const [a, b, c] = d.upcoming_deliveries;
    expect(a).toMatchObject({
      bundle_id: "BUNDLE0001",
      status_text: "Arriving",
      date_text: "Tue, Nov 17",
      delivery_date: "2026-11-17",
      last_edit_text: "Wed, Nov 11",
      last_edit_date: "2026-11-11",
      item_count: 1,
      in_progress: true,
      action_labels: ["Manage"],
      ship_id: "SHIP0001",
      position: 1,
      offscreen: false,
    });
    expect(a?.items).toEqual([{ title: "Fake Widget One", image_url: FAKE.imageUrl }]);
    expect(a?.manage_path).toContain("deliveryBundleId=BUNDLE0001");
    expect(a?.manage_path).not.toContain("pf_rd_p");
    expect(a?.manage_path).not.toContain("ref_=");
    expect(b).toMatchObject({
      delivery_date: "2026-11-24",
      extra_item_count: 2,
      item_count: 5,
      in_progress: false,
      action_labels: ["Manage", "Skip items"],
    });
    expect(b?.items.map((i) => i.title)).toEqual([
      "Fake Widget Two",
      "Fake Widget Three",
      "Fake Widget Four",
    ]);
    expect(c).toMatchObject({
      bundle_id: "BUNDLE0003",
      delivery_date: "2026-12-22",
      offscreen: true,
      position: 3,
      action_labels: ["Manage"],
    });
    expect(c?.items[0]?.title).toBe("Fake Widget Five");
    expect(r.meta.strategies.delivery_date).toBe("data-attr");
  });

  it("exposes the carousel paging endpoint and accounts for the sentinel slide", () => {
    expect(d.upcoming_deliveries_total).toBe(4);
    expect(d.deliveries_next_path).toMatch(
      /^\/api\/marketplaces\/MKT0001\/customer\/replenishment\/fulfillment\/deliveries\?filteringContext\.startDate=/,
    );
    expect(r.meta.warnings.filter((w) => w.startsWith("upcoming_deliveries"))).toEqual([]);
  });

  it("parses the savings banner and ignores the hidden breakdown popover", () => {
    expect(d.savings?.total).toEqual({ amount: 181, currency: "USD", raw: "$181.00" });
    expect(d.savings?.since_text).toBe("Sep 2025");
    expect(d.savings?.text).not.toContain("165");
  });

  it("parses subscription tiles with ids, quantity and frequency", () => {
    expect(d.subscriptions_heading).toBe("Your Subscriptions");
    expect(d.action_labels).toEqual(["Edit All"]);
    expect(d.bulk_edit_path).toBe(
      "/auto-deliveries/ajax/subscriptions/edit/?editAction=bulkSchedule&offset=0",
    );
    expect(d.subscriptions).toHaveLength(3);
    expect(d.subscriptions[0]).toMatchObject({
      subscription_id: "SUB0001",
      asin: "B0FAKE0001",
      title: "Fake Widget One",
      image_url: FAKE.imageUrl,
      next_delivery_text: "Nov 24",
      next_delivery_date: "2026-11-24",
      quantity: 1,
      frequency: { every: 1, unit: "month" },
      frequency_text: "1 unit every 1 month",
      status_text: null,
      ship_id: "SHIP0001",
      action_labels: ["Edit"],
    });
    expect(d.subscriptions[0]?.edit_path).toBe(
      "/auto-deliveries/ajax/subscription/?subscriptionId=SUB0001&subAsin=B0FAKE0001&shipId=SHIP0001",
    );
    expect(d.subscriptions[1]).toMatchObject({
      quantity: 2,
      frequency: { every: 6, unit: "week" },
      next_delivery_date: "2026-12-03",
    });
    // the year rolls over when the date would be in the past
    expect(d.subscriptions[2]?.next_delivery_date).toBe("2027-01-05");
    expect(r.meta.strategies.subscriptions).toBe("id");
  });

  it("keeps unexpected tile text and picks out a status word", () => {
    expect(d.subscriptions[2]?.status_text).toBe("Paused until Jan 1");
    expect(d.subscriptions[2]?.extra_text).toBe("Paused until Jan 1");
    expect(d.subscriptions[0]?.extra_text).toBeUndefined();
  });

  it("parses category filters and drops the search toggle", () => {
    expect(d.category_filters).toEqual([
      { id: "gl_fake_one", label: "Fake Category One", count: 2 },
      { id: "gl_fake_two", label: "Fake Category Two", count: 1 },
    ]);
  });

  it("parses recommended offers, picking the visible price tier", () => {
    expect(d.recommended_heading).toBe("Recommended for you");
    expect(d.recommended).toHaveLength(2);
    const o = d.recommended[0];
    expect(o).toMatchObject({
      asin: "B0FAKE0101",
      title: "Fake Offer 0",
      url_path: "/Fake-Widget-0/dp/B0FAKE0101",
      image_url: FAKE.imageUrl,
      price: { amount: 8.49, currency: "USD", raw: "$8.49" },
      discount_pct: 15,
      one_time_price: { amount: 9.99, currency: "USD", raw: "$9.99" },
      list_price: null,
      extra_discount_text: "Extra 10% off",
      extra_discount_pct: 10,
      purchased_text: "Purchased 2 times",
      purchased_count: 2,
      default_frequency: "1 month",
      action_labels: ["Subscribe now"],
    });
    expect(o?.frequency_options).toEqual([
      { value: "2W|sns", label: "2 weeks", selected: false },
      { value: "1M|sns", label: "1 month", selected: true },
    ]);
  });

  it("parses an offer without any price block as price null", () => {
    const x = d.recommended[1];
    expect(x?.asin).toBe("B0FAKE0102");
    expect(x?.price).toBeNull();
    expect(x?.discount_pct).toBeNull();
    expect(x?.one_time_price).toBeNull();
    expect(x?.extra_text).toBeUndefined();
  });

  it("is not empty and every ASIN is in the fake range", () => {
    expect(d.is_empty).toBe(false);
    expect(d.empty_message).toBeNull();
    for (const s of d.subscriptions) expect(s.asin).toMatch(FAKE.asinPattern);
    for (const o of d.recommended) expect(o.asin).toMatch(FAKE.asinPattern);
  });

  it("accounts for the whole visible page", () => {
    expect(r.other_sections).toEqual([]);
    expect(expectLosslessCoverage(r, capture(FULL), 0.99)).toBeGreaterThan(0.99);
  });

  it("is deterministic and JSON-serializable", () => {
    expect(JSON.parse(JSON.stringify(r))).toEqual(parse(FULL));
  });
});

describe("parseSubscriptions: hidden content and unknown blocks", () => {
  it("skips a delivery card inside a hidden template that is not a carousel slide", () => {
    const hiddenCard = `<div id="skeletonTemplateDesktop" class="aok-hidden" data-rf-hidden="1">${deliveryCard({ bundle: "BUNDLEGHOST", label: "Arriving Mon, Nov 30", last: "Last day to edit Tue, Nov 24", ms: epoch(2026, 11, 30), imgs: ["Ghost"] })}</div>`;
    const r = parse(FULL + hiddenCard);
    expect(r.data.upcoming_deliveries.map((x) => x.bundle_id)).toEqual([
      "BUNDLE0001",
      "BUNDLE0002",
      "BUNDLE0003",
    ]);
  });

  it("skips a hidden tile", () => {
    const hidden = `<div data-rf-hidden="1">${tile({ sub: "SUBGHOST", asin: "B0FAKE0999", title: "Ghost", next: "Nov 30", freq: "1 unit every 1 month" })}</div>`;
    const r = parse(NAV + SUBS.replace("</div>\n</div>", `${hidden}</div>\n</div>`));
    expect(r.data.subscriptions.map((s) => s.subscription_id)).not.toContain("SUBGHOST");
  });

  it("lands an unknown visible block in other_sections", () => {
    const html = `${FULL}<div id="mysteryPromo" class="a-section"><h3>Fake mystery promo</h3><p>Text nobody modelled.</p></div>`;
    const r = parse(html);
    const hit = r.other_sections.find((s) => s.key === "mysteryPromo");
    expect(hit?.heading).toBe("Fake mystery promo");
    expect(hit?.text).toContain("Text nobody modelled");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("reports blobs it does not understand", () => {
    const html = `${FULL}<script type="application/json" id="addressesByShipId">{"SHIP0001":{"label":"Fake"}}</script>`;
    const r = parse(html);
    expect(r.meta.unknown_blobs).toContain("addressesByShipId");
  });
});

describe("parseSubscriptions: empty state", () => {
  const html = `${NAV}<div id="CardInstanceEmpty0001"><span class="a-size-large">You have no active subscriptions.</span></div>`;

  it("flags an empty list and keeps the navigation", () => {
    const r = parse(html);
    expect(r.data.is_empty).toBe(true);
    expect(r.data.empty_message).toBe("You have no active subscriptions.");
    expect(r.data.subscriptions).toEqual([]);
    expect(r.data.upcoming_deliveries).toEqual([]);
    expect(r.data.savings).toBeNull();
    expect(r.data.tabs.map((t) => t.key)).toContain("subscriptions");
    expect(r.other_sections).toEqual([]);
  });

  it("an empty page with only navigation is still empty, not an error", () => {
    const r = parse(NAV);
    expect(r.data.is_empty).toBe(true);
    expect(r.data.empty_message).toBeNull();
  });

  it("throws layout_unrecognized when nothing is recognizable", () => {
    expect(() => parse("<div><p>Something else entirely</p></div>")).toThrow(RfError);
    expect(() => parse("")).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "layout_unrecognized" }),
      }),
    );
  });
});

describe("parseSubscriptions: strategy fallbacks", () => {
  it("finds tabs through data-hub-section when the pill ids are gone", () => {
    const html = NAV.replace(/ id="menu-item-button-pill-[a-z]+"/g, "");
    const r = parse(html + SUBS);
    expect(r.meta.strategies.tabs).toBe("data-attr");
    expect(r.data.tabs.map((t) => t.key)).toEqual(["", "deliveries", "subscriptions", ""]);
  });

  it("finds tiles through the handler attribute when the grid id is gone", () => {
    const r = parse(NAV + SUBS.replace('id="subscriptionsDesktopGridLayout"', ""));
    expect(r.meta.strategies.subscriptions).toBe("data-attr");
    expect(r.data.subscriptions).toHaveLength(3);
  });

  it("finds tiles through the edit url when the handler attribute is gone", () => {
    const r = parse(
      NAV +
        SUBS.replace('id="subscriptionsDesktopGridLayout"', "").replace(
          /data-mix-operations="editSubscriptionModalHandler"/g,
          "",
        ),
    );
    expect(r.meta.strategies.subscriptions).toBe("text-anchor");
    expect(r.data.subscriptions[0]?.subscription_id).toBe("SUB0001");
  });

  it("falls back to the delivery date text when the manage url has no epoch", () => {
    const section = deliveriesSection().replace(/deliveryDate=\d+&/g, "");
    const r = parse(NAV + section);
    expect(r.data.upcoming_deliveries[0]?.delivery_date).toBe("2026-11-17");
    expect(r.meta.strategies.delivery_date).toBe("text-anchor");
  });

  it("finds recommended cards by item owner when the list item ids are gone", () => {
    const r = parse(NAV + recommended().replace(/data-id="asin-faceout-\d"/g, ""));
    expect(r.meta.strategies.recommended).toBe("label");
    expect(r.data.recommended.map((o) => o.asin)).toEqual(["B0FAKE0101", "B0FAKE0102"]);
  });

  it("takes the ASIN from the product link when the item id is missing", () => {
    const html = recommended()
      .replace(/data-csa-c-item-id="[^"]*"/g, "")
      .replace(/data-asin="[^"]*"/g, "");
    const r = parse(NAV + html);
    expect(r.data.recommended[0]?.asin).toBe("B0FAKE0101");
  });

  it("reads the title from the image alt when the truncate markup is gone", () => {
    const html = SUBS.replace(/<span class="a-truncate-full[^>]*>[^<]*<\/span>/g, "");
    const r = parse(NAV + html);
    expect(r.data.subscriptions[0]?.title).toBe("Fake Widget One");
  });

  it("warns when the carousel promises more slides than were parsed", () => {
    const html = deliveriesSection().replace(SENTINEL, "");
    const r = parse(NAV + html + SUBS);
    expect(r.data.deliveries_next_path).toBeNull();
    expect(r.meta.warnings.some((w) => w.startsWith("upcoming_deliveries:"))).toBe(true);
  });
});

describe("helpers", () => {
  it("cleanPath drops tracking and keeps real parameters", () => {
    expect(cleanPath("/auto-deliveries/?a=1&ref_=x&pf_rd_p=y&b=2#frag")).toBe(
      "/auto-deliveries/?a=1&b=2",
    );
    expect(cleanPath("/x?ref=a")).toBe("/x");
    expect(cleanPath("")).toBeUndefined();
    expect(cleanPath(undefined)).toBeUndefined();
  });

  it("isoFromText uses an explicit year, the weekday, or the next occurrence", () => {
    expect(isoFromText("Dec 3, 2026", CAPTURED)).toBe("2026-12-03");
    expect(isoFromText("Tue, Nov 17", CAPTURED)).toBe("2026-11-17");
    expect(isoFromText("Nov 24", CAPTURED)).toBe("2026-11-24");
    expect(isoFromText("Jan 5", CAPTURED)).toBe("2027-01-05");
    // a weekday that does not match 2026 picks the year it does match
    expect(isoFromText("Wed, Nov 17", CAPTURED)).toBe("2027-11-17");
    expect(isoFromText("Mon, Nov 17", CAPTURED)).toBeUndefined();
    expect(isoFromText("Feb 30", CAPTURED)).toBeUndefined();
    expect(isoFromText("soon", CAPTURED)).toBeUndefined();
    expect(isoFromText(undefined, CAPTURED)).toBeUndefined();
    expect(isoFromText("Nov 24", "not a date")).toBeUndefined();
  });
});
