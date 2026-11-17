import { describe, expect, it } from "vitest";
import { FAKE, RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { parseBrowsingHistory, productPath } from "../../src/pages/browsing-history.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";

function capture(html: string): Capture {
  return {
    kind: "browsing_history",
    url: `${FAKE.host}/gp/history`,
    final_url: `${FAKE.host}/gp/history`,
    captured_at: "2026-11-16T12:00:00.000Z",
    html: `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
  };
}

interface CardOpts {
  i: number;
  asin: string;
  title?: string;
  price?: string;
  unit?: string;
  rating?: string;
  count?: string;
  prime?: string;
  delivery?: string;
  date?: string;
  badge?: string;
  extra?: string;
}

function cell(o: CardOpts): string {
  const href = `/Fake-Product-${o.i}/dp/${o.asin}/ref=pd_ybh_a_d_sccl_${o.i}/000-0000000-0000001?pd_rd_w=W&amp;pf_rd_p=P&amp;psc=1`;
  return `<div id="gridItemRoot" class="a-column p13n-grid-column-root">
  <div id="p13n-asin-index-${o.i}" class="a-cardui expandableGrid p13n-grid-content">
    <span data-csa-c-type="item" data-csa-c-item-type="asin" data-csa-c-item-id="amzn1.asin.${o.asin}" data-csa-c-posx="${o.i}">
      <div class="p13n-sc-uncoverable-faceout">
        <div class="a-section"><a aria-hidden="true" class="a-link-normal aok-block" tabindex="-1" href="${href}"><img alt="" src="${FAKE.imageUrl}" class="a-dynamic-image p13n-sc-dynamic-image p13n-product-image" data-a-dynamic-image="{&quot;${FAKE.imageUrl}&quot;:[150,200]}"></a></div>
        <div>
          ${o.badge === undefined ? "" : `<div class="a-row"><a class="a-size-small a-link-normal p13n-best-seller" href="/gp/bestsellers/fake/1/ref=zg"><div class="_x_badge-container_1"><i class="_x_badge_2"><span class="a-size-small"><div class="clamp">${o.badge}</div></span></i></div></a></div>`}
          <a class="a-link-normal aok-block" href="${href}" role="link"><span><div class="p13n-sc-truncate-desktop-type2" data-rows="1">${o.title ?? `Fake Product ${o.i}`}</div></span></a>
          ${
            o.rating === undefined
              ? ""
              : `<div class="a-row"><div class="a-icon-row"><a aria-label="${o.rating} out of 5 stars, ${o.count ?? "10"} ratings" class="a-link-normal" href="/product-reviews/${o.asin}/ref=cr"><i aria-hidden="true" class="a-icon a-icon-star-small a-star-small-4-5"><span class="a-icon-alt">${o.rating} out of 5 stars</span></i> <span aria-hidden="true" class="a-size-small a-color-tertiary">${o.count ?? "10"}</span></a></div></div>`
          }
          ${
            o.price === undefined
              ? ""
              : `<div class="a-row"><div class="_x_p13n-sc-price-animation-wrapper_3"><a class="a-link-normal aok-block a-text-normal" href="${href}" role="link"><div class="a-row"><span class="a-size-base a-color-price"><span class="_x_p13n-sc-price_3mJ9Z">${o.price}</span></span>${o.unit === undefined ? "" : ` <span class="a-size-mini a-color-price aok-nowrap">${o.unit}</span>`}</div></a></div></div>`
          }
          ${
            o.delivery === undefined
              ? ""
              : `<div data-cy="delivery-block" class="udm-delivery-block"><div class="a-row udm-badge-block"><div class="a-column a-span12"><i class="a-icon-wrapper a-icon-small a-icon-prime-with-text a-text-bold"><i class="a-icon a-icon-prime a-icon-small" role="img" aria-label="Prime"></i><span class="a-icon-text">${o.prime ?? "Tomorrow"}</span></i></div></div><div class="a-row a-size-small udm-primary-delivery-message"><div class="a-column a-span12">FREE delivery <span id="WVCRIAFWG" class="a-text-bold">${o.date ?? "Tomorrow, Nov 17"}</span></div></div></div>`
          }
          ${o.extra === undefined ? "" : `<div class="a-row"><span class="a-size-small">${o.extra}</span></div>`}
        </div>
        <div class="a-row"><div class="p13n-individual-feedbackButton" data-asin="${o.asin}" data-event="DELETE_ITEM_FROM_VIEW"><span class="a-button a-button-base a-button-small"><span class="a-button-inner"><input type="submit" class="a-button-input"><span class="a-button-text" aria-hidden="true">Remove from view</span></span></span></div></div>
      </div>
    </span>
  </div>
  <div class="a-cardui aok-hidden p13n-grid-overlay" data-rf-hidden="1"><span class="p13n-grid-RemovedMessage">Removed</span><span class="p13n-grid-RemovedDescription">You said you are not interested in this</span></div>
</div>`;
}

const ALL_IDS = ["B0FAKE0001", "B0FAKE0002", "B0FAKE0003", "B0FAKE0004", "B0FAKE0005"];
const RECS = JSON.stringify(
  ALL_IDS.map((id) => ({ id, linkParameters: { pd_rd_i: id }, contextLinks: [] })),
).replace(/"/g, "&quot;");

function page(opts: {
  cells: string;
  status?: string;
  recs?: string;
  empty?: boolean;
  subnav?: boolean;
}): string {
  const status = opts.status ?? "ENABLED";
  return `${
    opts.subnav === false
      ? ""
      : `<div id="nav-subnav" data-category="yourstore"><a href="/gp/yourstore/home/?ie=UTF8&amp;ref_=x" class="nav-a"><span class="nav-a-content">Your Amazon.com</span></a><a href="/gp/history/?ie=UTF8&amp;ref_=x" class="nav-a" aria-label="Your Browsing History"><span class="nav-a-content">Your Browsing History</span></a></div>`
  }
<div id="CardInstanceFake0001" data-card-metrics-id="p13n-browsing-history_desktop-ybh_0">
  <div class="aok-hidden p13n-ybh-metadata" data-browsing-history-status="${status}" data-browsing-history-pause-expiration="0" data-lang="en-US" data-rf-hidden="1"></div>
  <div class="aok-hidden ybh-history-paused-alert-template" data-template="Paused until __DATE_PLACEHOLDER__" data-rf-hidden="1"></div>
  <div class="browsingHistoryHeader">
    <div class="headerWithSearch"><h2 class="page-title">Your Browsing History</h2><a data-mix-operations="showSettingsDisclosure" aria-label="Settings" class="a-link-normal" href="#" role="button"><img role="presentation" src="${FAKE.imageUrl}"></a></div>
    <div><p>These items were viewed recently. We use them to personalize recommendations.</p>
      <div id="browsingHistoryDisabledMessage" class="aok-hidden" data-rf-hidden="1"><div class="a-alert-content">Browsing history is turned off. <a href="#">Turn on history</a></div></div>
      <div id="browsingHistoryPausedMessage" class="aok-hidden" data-rf-hidden="1"><div class="a-alert-content"><p>Browsing history is paused.</p></div></div>
    </div>
  </div>
  <div class="a-row ${opts.empty === true ? "" : "aok-hidden"} p13n-empty-ybh" ${opts.empty === true ? "" : 'data-rf-hidden="1"'}><span class="a-size-base-plus">You have no recently viewed items.</span></div>
  <div class="p13n-ybh-grid"><div class="p13n-desktop-grid" ${opts.recs === undefined ? `data-client-recs-list="${RECS}"` : opts.recs} data-index-offset="4">
    ${opts.cells}
    <div id="endOfList"></div>
  </div></div>
  <span id="loading-results-spinner" class="a-spinner" data-rf-hidden="1"></span>
  <span id="a-popover-settings-1" class="a-popover-preload" data-rf-hidden="1"><h2>Settings</h2><h3>Pause History</h3></span>
</div>`;
}

const CELLS = [
  cell({
    i: 0,
    asin: "B0FAKE0001",
    price: "$12.17",
    unit: "($0.28/count)",
    rating: "4.3",
    count: "50,100",
    delivery: "x",
    prime: "Tomorrow",
    date: "Tomorrow, Nov 17",
    badge: "Best Seller",
  }),
  cell({ i: 1, asin: "B0FAKE0002", title: "Fake Priceless Gadget", rating: "5", count: "7" }),
  cell({
    i: 2,
    asin: "B0FAKE0003",
    price: "$3.50",
    delivery: "x",
    prime: "Two-Day",
    date: "Nov 19 - 21",
  }),
].join("\n");

function parse(html: string) {
  return parseBrowsingHistory(capture(html));
}

describe("parseBrowsingHistory: full page", () => {
  const html = page({ cells: CELLS });
  const r = parse(html);
  const d = r.data;

  it("reads the heading, description and history status", () => {
    expect(d.heading).toBe("Your Browsing History");
    expect(d.description).toBe(
      "These items were viewed recently. We use them to personalize recommendations.",
    );
    expect(d.history_status).toBe("enabled");
    expect(d.history_status_raw).toBe("ENABLED");
    expect(d.pause_expiration).toBe("0");
    expect(d.status_message).toBeNull();
    expect(r.meta.strategies.history_status).toBe("data-attr");
    expect(r.meta.strategies.heading).toBe("id");
  });

  it("parses every field of a fully populated card", () => {
    expect(d.items).toHaveLength(3);
    expect(d.items[0]).toEqual({
      position: 0,
      asin: "B0FAKE0001",
      title: "Fake Product 0",
      url_path: "/Fake-Product-0/dp/B0FAKE0001",
      image_url: FAKE.imageUrl,
      price: { amount: 12.17, currency: "USD", raw: "$12.17" },
      unit_price_text: "($0.28/count)",
      unit_price: { amount: 0.28, currency: "USD", raw: "$0.28" },
      rating: { value: 4.3, out_of: 5 },
      review_count: 50100,
      prime: true,
      delivery_badge: "Tomorrow",
      delivery_message: "FREE delivery Tomorrow, Nov 17",
      delivery_date_text: "Tomorrow, Nov 17",
      badges: ["Best Seller"],
      remove_label: "Remove from view",
      viewed_group: null,
    });
  });

  it("keeps items in page order and parses a delivery range", () => {
    expect(d.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(d.items[2]?.delivery_badge).toBe("Two-Day");
    expect(d.items[2]?.delivery_date_text).toBe("Nov 19 - 21");
    expect(d.items.every((i) => i.asin?.match(FAKE.asinPattern))).toBe(true);
  });

  it("handles an item without price, delivery or badges", () => {
    const x = d.items[1];
    expect(x?.title).toBe("Fake Priceless Gadget");
    expect(x?.price).toBeNull();
    expect(x?.unit_price).toBeNull();
    expect(x?.unit_price_text).toBeNull();
    expect(x?.prime).toBe(false);
    expect(x?.delivery_badge).toBeNull();
    expect(x?.delivery_message).toBeNull();
    expect(x?.badges).toEqual([]);
    expect(x?.rating).toEqual({ value: 5, out_of: 5 });
    expect(x?.review_count).toBe(7);
    expect(x?.extra_text).toBeUndefined();
  });

  it("lists every viewed ASIN and which ones are not rendered yet", () => {
    expect(d.all_asins).toEqual(ALL_IDS);
    expect(d.total_items).toBe(5);
    expect(d.unrendered_asins).toEqual(["B0FAKE0004", "B0FAKE0005"]);
    expect(d.has_more).toBe(true);
    expect(d.end_of_list_marker).toBe(true);
    expect(r.meta.strategies.all_asins).toBe("data-attr");
  });

  it("is not empty, has no date groups and reads the sub-navigation", () => {
    expect(d.is_empty).toBe(false);
    expect(d.empty_message).toBeNull();
    expect(d.group_headings).toEqual([]);
    expect(d.section_links).toEqual([
      { label: "Your Amazon.com", href_path: "/gp/yourstore/home/" },
      { label: "Your Browsing History", href_path: "/gp/history/" },
    ]);
  });

  it("accounts for the whole visible page and ignores hidden overlays and popovers", () => {
    expect(r.other_sections).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("not interested");
    expect(JSON.stringify(d)).not.toContain("Pause History");
    expect(expectLosslessCoverage(r, capture(html), 0.99)).toBeGreaterThan(0.99);
  });

  it("is JSON-serializable and deterministic", () => {
    expect(JSON.parse(JSON.stringify(r))).toEqual(parse(html));
  });
});

describe("parseBrowsingHistory: page state", () => {
  it("shows a visible 'turned off' alert as disabled", () => {
    const html = page({ cells: "", status: "DISABLED" }).replace(
      '<div id="browsingHistoryDisabledMessage" class="aok-hidden" data-rf-hidden="1">',
      '<div id="browsingHistoryDisabledMessage">',
    );
    const r = parse(html);
    expect(r.data.history_status).toBe("disabled");
    expect(r.data.status_message).toBe("Browsing history is turned off. Turn on history");
    expect(r.meta.strategies.history_status).toBe("label");
  });

  it("shows a visible paused alert as paused", () => {
    const html = page({ cells: CELLS }).replace(
      '<div id="browsingHistoryPausedMessage" class="aok-hidden" data-rf-hidden="1">',
      '<div id="browsingHistoryPausedMessage">',
    );
    expect(parse(html).data.history_status).toBe("paused");
  });

  it("falls back to the metadata token when no alert is visible", () => {
    expect(parse(page({ cells: CELLS, status: "PAUSED" })).data.history_status).toBe("paused");
  });

  it("reports an unknown state with a warning when there is no signal", () => {
    const html = page({ cells: CELLS }).replace(/data-browsing-history-status="[A-Z]+"/, "");
    const r = parse(html);
    expect(r.data.history_status).toBe("unknown");
    expect(r.meta.warnings.some((w) => w.startsWith("history_status"))).toBe(true);
  });

  it("an empty history shows the empty message and has no more items", () => {
    const html = page({ cells: "", empty: true, recs: 'data-client-recs-list="[]"' });
    const r = parse(html);
    expect(r.data.is_empty).toBe(true);
    expect(r.data.empty_message).toBe("You have no recently viewed items.");
    expect(r.data.items).toEqual([]);
    expect(r.data.all_asins).toEqual([]);
    expect(r.data.total_items).toBeNull();
    expect(r.data.has_more).toBe(false);
    expect(r.other_sections).toEqual([]);
  });

  it("is complete when every listed ASIN is rendered", () => {
    const recs = `data-client-recs-list="${JSON.stringify([{ id: "B0FAKE0001" }, { id: "B0FAKE0002" }, { id: "B0FAKE0003" }]).replace(/"/g, "&quot;")}"`;
    const r = parse(page({ cells: CELLS, recs }));
    expect(r.data.unrendered_asins).toEqual([]);
    expect(r.data.has_more).toBe(false);
  });

  it("throws layout_unrecognized for an unrelated page", () => {
    expect(() => parse("<div><p>Nothing to see</p></div>")).toThrow(RfError);
    expect(() => parse("")).toThrow(
      expect.objectContaining({
        payload: expect.objectContaining({ code: "layout_unrecognized" }),
      }),
    );
  });
});

describe("parseBrowsingHistory: hidden content, unknown blocks and fallbacks", () => {
  it("skips a hidden card", () => {
    const hidden = `<div data-rf-hidden="1" class="aok-hidden">${cell({ i: 9, asin: "B0FAKE0999", price: "$1.00" })}</div>`;
    const r = parse(page({ cells: CELLS + hidden }));
    expect(r.data.items.map((i) => i.asin)).toEqual(["B0FAKE0001", "B0FAKE0002", "B0FAKE0003"]);
  });

  it("lands an unknown visible block in other_sections", () => {
    const html =
      page({ cells: CELLS }) +
      '<div id="mysteryBanner" class="a-section"><h3>Fake mystery banner</h3><p>Unmodelled copy.</p></div>';
    const r = parse(html);
    const hit = r.other_sections.find((s) => s.key === "mysteryBanner");
    expect(hit?.heading).toBe("Fake mystery banner");
    expect(hit?.text).toContain("Unmodelled copy");
  });

  it("keeps unexpected text inside a card as extra_text", () => {
    const r = parse(
      page({
        cells: cell({ i: 0, asin: "B0FAKE0001", price: "$4.00", extra: "Only 2 left in stock" }),
      }),
    );
    expect(r.data.items[0]?.extra_text).toBe("Only 2 left in stock");
  });

  it("finds cards by item type when the grid cell ids are gone", () => {
    const html = page({ cells: CELLS }).replace(/id="p13n-asin-index-\d"/g, "");
    const r = parse(html);
    expect(r.meta.strategies.items).toBe("data-attr");
    expect(r.data.items).toHaveLength(3);
    expect(r.data.items[0]?.position).toBeNull();
  });

  it("finds cards by the faceout class as a last resort and takes the ASIN from the link", () => {
    const html = page({ cells: CELLS })
      .replace(/id="p13n-asin-index-\d"/g, "")
      .replace(/data-csa-c-item-type="asin"/g, "")
      .replace(/data-csa-c-item-id="[^"]*"/g, "")
      .replace(/data-asin="[^"]*"/g, "");
    const r = parse(html);
    expect(r.meta.strategies.items).toBe("text-anchor");
    expect(r.data.items.map((i) => i.asin)).toEqual(["B0FAKE0001", "B0FAKE0002", "B0FAKE0003"]);
  });

  it("falls back to the rendered ids when the full list attribute is missing", () => {
    const r = parse(page({ cells: CELLS, recs: "" }));
    expect(r.meta.strategies.all_asins).toBe("id");
    expect(r.data.all_asins).toEqual(["B0FAKE0001", "B0FAKE0002", "B0FAKE0003"]);
    expect(r.data.has_more).toBe(false);
  });

  it("reads the rating from the star class when there is no aria-label", () => {
    const html = page({ cells: CELLS })
      .replace(/ aria-label="4.3 out of 5 stars, 50,100 ratings"/, "")
      .replace('<span class="a-icon-alt">4.3 out of 5 stars</span>', "");
    const r = parse(html);
    expect(r.data.items[0]?.rating).toEqual({ value: 4.5, out_of: 5 });
  });

  it("assigns date-group headings to the cards that follow them", () => {
    const grouped = `<h3>Fake Group One</h3>${cell({ i: 0, asin: "B0FAKE0001", price: "$1.00" })}<h3>Fake Group Two</h3>${cell({ i: 1, asin: "B0FAKE0002" })}${cell({ i: 2, asin: "B0FAKE0003" })}`;
    const r = parse(page({ cells: grouped }));
    expect(r.data.group_headings).toEqual(["Fake Group One", "Fake Group Two"]);
    expect(r.data.items.map((i) => i.viewed_group)).toEqual([
      "Fake Group One",
      "Fake Group Two",
      "Fake Group Two",
    ]);
    expect(r.other_sections).toEqual([]);
  });

  it("warns when ids are listed but no card has rendered yet", () => {
    const r = parse(page({ cells: "" }));
    expect(r.data.items).toEqual([]);
    expect(r.data.unrendered_asins).toEqual(ALL_IDS);
    expect(r.meta.warnings.some((w) => w.startsWith("items:"))).toBe(true);
  });
});

describe("productPath", () => {
  it("drops query, fragment and the ref segment", () => {
    expect(productPath("/Fake/dp/B0FAKE0001/ref=pd_x/000-0000000-0000001?a=1#f")).toBe(
      "/Fake/dp/B0FAKE0001",
    );
    expect(productPath("/Fake/dp/B0FAKE0001?psc=1")).toBe("/Fake/dp/B0FAKE0001");
    expect(productPath("")).toBeUndefined();
    expect(productPath(undefined)).toBeUndefined();
  });
});
