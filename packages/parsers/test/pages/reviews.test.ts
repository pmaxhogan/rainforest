import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import { FAKE } from "@rainforest/core";
import {
  isoFromDateText,
  parseCountsText,
  parseHelpfulVotes,
  parseReviewDateLine,
  parseReviewSummary,
  parseReviews,
  reviewSummaryRoot,
  reviewsMainRoot,
} from "../../src/pages/reviews.ts";
import { parseDocument, visibleTextChars } from "../../src/index.ts";
import { expectLosslessCoverage } from "../../src/testing.ts";

const ASIN = "B0FAKE0001";
const VARIANT_ASIN = "B0FAKE0002";
const IMG = FAKE.imageUrl;

const doc = (body: string): string =>
  `<!DOCTYPE html><html><head><title>Amazon.com: Customer reviews: Fake Widget</title></head><body>${body}</body></html>`;

const capture = (
  html: string,
  url = `https://www.example.com/product-reviews/${ASIN}`,
): Capture => ({
  kind: "reviews",
  url,
  final_url: url,
  captured_at: "2026-01-01T00:00:00.000Z",
  html,
});

// ---- reviews-page dialect ------------------------------------------------------------

interface CardOptions {
  id?: string;
  rating?: number;
  title?: string;
  body?: string;
  date?: string;
  strip?: string | null;
  stripHref?: string;
  verified?: boolean;
  statement?: string | null;
  author?: string;
  images?: number;
  extra?: string;
  beforeBody?: string;
  translatedBody?: boolean;
  hidden?: boolean;
}

function reviewCard(o: CardOptions = {}): string {
  const id = o.id ?? "R1FAKE00001";
  const rating = o.rating ?? 5;
  const strip =
    o.strip === null
      ? ""
      : `<a class="a-size-mini a-link-normal a-color-secondary" data-hook="format-strip" href="${
          o.stripHref ??
          `/portal/customer-reviews/${VARIANT_ASIN}/ref=cm_cr_arp_d_rvw_fmt?formatType=current_format`
        }">${o.strip ?? "Finish: Teal"}</a><i class="a-icon a-icon-text-separator" role="img" aria-label="|"></i>`;
  const avp =
    o.verified === false
      ? ""
      : `<a class="a-link-normal" href="/gp/help/customer/display.html?nodeId=FAKE"><span class="a-size-mini a-color-state a-text-bold" data-hook="avp-badge">Verified Purchase</span></a>`;
  const statement =
    o.statement === null
      ? ""
      : `<div class="a-row a-spacing-small"><span class="a-size-base a-color-tertiary cr-vote-text" data-hook="helpful-vote-statement">${o.statement ?? ""}</span></div>`;
  const images = Array.from(
    { length: o.images ?? 0 },
    (_, i) =>
      `<span role="listitem"><span id="${id}-${i}" class="a-declarative"><a class="a-popover-trigger review-image-popover-trigger" href="javascript:void(0)" role="button"><img class="review-image-tile" data-hook="review-image-tile" src="https://images.example.com/images/I/FAKEIMG${i}._SY88.jpg"><i class="a-icon a-icon-popover" data-rf-hidden="1"></i></a></span></span>`,
  ).join("");
  const mediaBlock =
    (o.images ?? 0) > 0
      ? `<div id="a-popover-${id}_gallerySection_main" class="a-popover-preload" data-rf-hidden="1"><div class="cr-lightbox-popover-container" data-hook="image-popover"><span class="cr-lightbox-review-body">Lightbox copy of the body</span></div></div><div id="${id}_imageSection_main" class="a-section review-image-container"><div class="review-image-tile-section" role="list">${images}</div></div>`
      : "";
  const hiddenAttr = o.hidden === true ? ' data-rf-hidden="1"' : "";
  return `<li id="${id}" class="review aok-relative" data-hook="review"${hiddenAttr}><span class="a-list-item"><div id="${id}-review-card" class="a-row a-spacing-none"><div id="customer_review-${id}" class="a-section celwidget">
    <script>if(window.ue) { ue.count("FakeBadgeCount", 0) }</script>
    <div class="a-row a-spacing-mini" data-hook="genome-widget"><a class="a-profile" href="/gp/profile/amzn1.account.FAKEPROFILE0001/ref=cm_cr_arp_d_gw_btm"><div class="a-profile-avatar-wrapper"><div class="a-profile-avatar"><img src="${IMG}"></div></div><div class="a-profile-content"><span class="a-profile-name">${o.author ?? "Alex Example"}</span></div></a></div>
    <div class="a-row"><h5><a class="a-size-base a-link-normal review-title a-color-base review-title-content a-text-bold" data-hook="review-title" href="/portal/customer-reviews/srp/-/${id}/ref=cm_cr_arp_d_rvw_ttl?ie=UTF8"><i class="a-icon a-icon-star a-star-${rating} review-rating" data-hook="review-star-rating"><span class="a-icon-alt">${rating}.0 out of 5 stars</span></i><span class="a-letter-space"></span><span>${o.title ?? "Great fake gadget"}</span></a></h5></div>
    <span class="a-size-base a-color-secondary review-date" data-hook="review-date">${o.date ?? "Reviewed in the United States on April 17, 2031"}</span>
    <div class="a-row a-spacing-mini review-data review-format-strip">${strip}${avp}</div>
    ${o.beforeBody ?? ""}
    <div class="a-row a-spacing-small review-data"><span class="a-size-base review-text review-text-content" data-hook="review-body">${o.body ?? "<span>First paragraph.<br><br><br><br>Second paragraph.</span>"}</span></div>
    ${mediaBlock}
    <div class="a-row cr-vote-action-bar"><span class="cr-vote" data-hook="review-voting-widget">${statement}<div class="cr-helpful-icon-button cr-vote-component"><span class="a-declarative" data-action="reviews:vote-action"><div class="cr-helpful-button aok-float-left"><span class="a-button a-button-base"><span class="a-button-inner"><input class="a-button-input" data-hook="vote-helpful-button" type="submit"><span class="a-button-text"><div class="cr-helpful-text">Helpful</div></span></span></span></div></span></div><span class="cr-vote-focusable cr-vote-focusable-feedback"><span class="cr-vote-feedback cr-vote-component aok-hidden" data-rf-hidden="1">Sending feedback...</span></span></span><span class="cr-footer-line-height"><span><i class="a-icon a-icon-text-separator" role="img" aria-label="|"></i><span class="a-declarative"><a class="report-abuse-link" href="/portal/customer-reviews/report-review/ref=cm_cr_arp_d_rvw_hlp?csrfT=FAKETOKEN" aria-label="Report review">Report</a></span></span></span></div>
    ${o.extra ?? ""}
  </div></div></span></li>`;
}

const histogram = (): string =>
  [
    [5, "five", 70],
    [4, "four", 20],
    [3, "three", 6],
    [2, "two", 3],
    [1, "one", 1],
  ]
    .map(
      ([n, w, p]) =>
        `<a class="aui-primitive" href="/product-reviews/${ASIN}/ref=acr_dp_hist_${n}?ie=UTF8&reviewerType=all_reviews&filterByStar=${w}_star#reviews-filter-bar" aria-label="${n} ${n === 1 ? "star represents" : "stars represent"} ${p}% of ratings"><div class="aui-primitive"><span>5 star</span><span>4 star</span><span>3 star</span><span>2 star</span><span>1 star</span><span>70%</span><span>20%</span><span>${p}%</span></div></a>`,
    )
    .join("");

interface PageOptions {
  cards?: string;
  countLine?: string;
  filterInfo?: string;
  sortApplied?: "helpful" | "recent";
  starApplied?: string;
  starLabel?: string;
  /** Put the `selected` attribute on the applied option (the page does this for non-defaults). */
  selectedAttr?: boolean;
  next?: string | null;
  state?: Record<string, unknown> | null;
  extraList?: string;
  extraPage?: string;
  extraRoot?: string;
  header?: string;
  keyword?: string;
}

const SORT_OPTIONS = [
  ["helpful", "Top reviews"],
  ["recent", "Most recent"],
] as const;

const STAR_OPTIONS = [
  ["all_stars", "All stars"],
  ["five_star", "5 star only"],
  ["four_star", "4 star only"],
  ["three_star", "3 star only"],
  ["two_star", "2 star only"],
  ["one_star", "1 star only"],
  ["positive", "Positive reviews"],
  ["critical", "Critical reviews"],
] as const;

function select(
  id: string,
  param: string,
  options: readonly (readonly [string, string])[],
  applied: string,
  prompt: string,
  selectedAttr: boolean,
): string {
  const opts = options
    .map(
      ([value, label]) =>
        `<option data-rf-hidden="1" value="${value}"${selectedAttr && value === applied ? " selected" : ""} data-reviews-state-param='{"pageNumber":"1","nextPageToken":"","${param}":"${value}"}'>${label}</option>`,
    )
    .join("");
  return `<label class="aok-offscreen" for="${id}">Filter by ${param}</label><span class="a-dropdown-container"><select id="${id}" class="a-native-dropdown a-declarative" role="combobox" data-action="a-dropdown-select">${opts}</select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text a-declarative" data-action="a-dropdown-button"><span class="a-dropdown-prompt">${prompt}</span></span></span></span></span>`;
}

function reviewsPage(o: PageOptions = {}): string {
  const sort = o.sortApplied ?? "helpful";
  const star = o.starApplied ?? "all_stars";
  const sel = o.selectedAttr ?? false;
  const stateObj =
    o.state === null
      ? ""
      : `<span id="cr-state-object" data-state='${JSON.stringify({
          reviewsCsrfToken: "FAKECSRF",
          customerId: "FAKECUSTOMER",
          asin: ASIN,
          filterByStar: star === "all_stars" ? "" : star,
          formatType: "",
          reviewerType: "",
          filterByKeyword: o.keyword ?? "",
          reviewsAjaxUrl: "/portal/customer-reviews/ajax/reviews/get/",
          isArpPaginationDisabled: false,
          ...(o.state ?? {}),
        })}'></span>`;
  const next =
    o.next === null
      ? ""
      : (o.next ??
        `<span class="a-declarative" data-action="reviews:filter-action:replace-state"><span id="a-autoid-9" class="a-button a-button-base cm-cr-show-more"><span class="a-button-inner"><a id="a-autoid-9-announce" class="a-button-text" data-hook="show-more-button" href="/portal/customer-reviews/${ASIN}/ref=cm_cr_arp_d_paging_btm_2" data-reviews-state-param='{"shouldAppend":"true","deviceType":"desktop","nextPageToken":"FAKETOKEN2","pageNumber":"2"}'>Show 10 more reviews</a></span></span></span>`);
  return doc(`
<header id="navbar-main">Fake navigation chrome</header>
<div id="a-page"><div class="a-section a-spacing-small page-content">
  <div id="cm_cr-brdcmb" class="a-section a-subheader a-breadcrumb"><ul><li><span class="a-list-item"><a class="a-link-normal" href="/dp/${ASIN}/ref=cm_cr_arp_d_bdcrb_top">Fake Widget Pro 12-Pack</a></span></li><li class="a-breadcrumb-divider">&rsaquo;</li><li><span class="a-list-item"><span class="a-color-state">Customer reviews</span></span></li></ul></div>
  ${o.extraRoot ?? ""}
  <div class="a-fixed-right-grid page-content"><div class="a-fixed-right-grid-inner">
   <div class="a-fixed-right-grid-col a-col-left">
    <div id="cm_cr-product_info" class="a-fixed-left-grid product-details celwidget"><div class="a-fixed-left-grid-inner">
      <div class="a-text-left a-fixed-left-grid-col reviewNumericalSummary celwidget a-col-left">
        <div id="averageCustomerReviewsAnchor" class="aui-primitive"><h2 class="aui-primitive">Customer reviews</h2>
          <span class="aui-primitive" role="img" aria-label="4.6 out of 5 stars, 23,456 ratings">4.6</span><span class="aui-primitive">(23,456)</span>
          ${histogram()}
          <button class="aui-primitive" role="button" aria-label="How customer reviews and ratings work"><span>How customer reviews and ratings work</span></button>
        </div>
      </div>
      <div class="a-fixed-left-grid-col a-col-right"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
        <div class="product-image a-col-left"><a class="a-link-normal" href="/dp/${ASIN}"><img data-hook="cr-product-image" src="${IMG}"></a></div>
        <div class="product-info a-col-right">
          <div class="a-row product-title"><h1 class="product-info-title"><a class="a-link-normal" data-hook="product-link" href="/Fake-Widget-Pro/dp/${ASIN}/ref=cm_cr_arp_d_product_top?ie=UTF8">Fake Widget Pro 12-Pack</a></h1></div>
          <div class="a-row product-by-line"><div class="a-section" data-hook="cr-product-byline"><span id="cr-arp-byline">by <a class="a-link-normal" href="/stores/FakeBrand/page/FAKE?lp_asin=${ASIN}">Fake Brand</a></span></div></div>
          <div class="a-row product-variation-strip"><ul class="cr-variations-list"><li class="cr-variations-list-item"><span class="a-color-secondary">Finish: Amber</span></li><li class="cr-variations-list-item"><i class="a-icon a-icon-text-separator" role="img" aria-label="|"></i><a class="a-link-normal" aria-label="Change Finish" href="/dp/${ASIN}">Change</a></li></ul></div>
        </div></div></div>
        <div class="a-section cr-arp-solicitation"><span id="writeReviewButton" class="a-button writeReviewButton"><span class="a-button-inner"><a class="a-button-text" href="/review/create-review/ref=cm_cr_arp_d_wr_but_lft?ie=UTF8&channel=reviews-product&asin=${ASIN}">Write a review</a></span></span></div>
      </div>
    </div></div>
    ${stateObj}
    <a id="reviews-filter-bar"></a>
    <div id="cm_cr-view_opt_search" class="a-row celwidget"><span class="a-declarative" data-action="reviews:search-textbox"><label class="aok-hidden" data-rf-hidden="1" for="filterByKeywordTextBox">Search customer reviews</label><div class="a-search"><input id="filterByKeywordTextBox" class="a-input-text" type="search"${o.keyword === undefined ? "" : ` value="${o.keyword}"`}></div></span><span class="a-button a-button-search"><span class="a-button-inner"><input class="a-button-input" type="submit"><span class="a-button-text">Search</span></span></span></div>
    <div id="cm_cr-view_opt_sort_filter" class="a-row celwidget">
      <div class="a-section reviews-sort-order-options"><div class="a-row"><h3 class="reviews-sort-order-label">Sort by</h3></div><div class="a-row">${select("sort-order-dropdown", "sortBy", SORT_OPTIONS, sort, sort === "helpful" ? "Top reviews" : "Most recent", sel)}</div></div>
      <div class="a-section reviews-filter-by-options" role="group"><div class="a-row"><h3 id="reviews-filter-by-label">Filter by</h3></div><div class="a-row reviews-filter-by-dropdown">
        <div class="reviewer-type-select">${select(
          "reviewer-type-dropdown",
          "reviewerType",
          [
            ["all_reviews", "All reviewers"],
            ["avp_only_reviews", "Verified purchase only"],
          ],
          "all_reviews",
          "All reviewers",
          false,
        )}</div>
        <div class="star-rating-select">${select("star-count-dropdown", "filterByStar", STAR_OPTIONS, star, o.starLabel ?? "All stars", sel && star !== "all_stars")}</div>
        <div class="format-type-select">${select(
          "format-type-dropdown",
          "formatType",
          [
            ["all_formats", "All variants"],
            ["current_format", "Finish: Amber"],
          ],
          "all_formats",
          "All variants",
          false,
        )}</div>
        <div class="cr-media-type-select">${select(
          "media-type-dropdown",
          "mediaType",
          [
            ["all_contents", "Text, image, video"],
            ["media_reviews_only", "Image and video reviews only"],
          ],
          "all_contents",
          "Text, image, video",
          false,
        )}</div>
      </div></div>
    </div>
    <div role="status"><div id="filter-info-section" class="a-section" data-hook="cr-filter-info-section">${o.filterInfo ?? `<div class="a-row" data-hook="cr-filter-info-review-rating-count">${o.countLine ?? "2,468 customer reviews"}</div>`}<hr class="a-divider-normal"></div></div>
    <div class="a-section reviews-content">
      <div id="cm_cr-review_list" class="a-section review-views celwidget">
        <div class="a-section review-filter-error aok-hidden" data-rf-hidden="1"><div class="a-box a-alert a-alert-error" role="alert"><div class="a-box-inner"><h4 class="a-alert-heading">There was a problem filtering reviews. Please reload the page.</h4></div></div></div>
        ${o.header ?? `<h3 class="a-spacing-medium" data-hook="arp-local-reviews-header">From the United States</h3>`}
        ${o.extraList ?? ""}
        <ul class="a-unordered-list a-nostyle a-vertical" role="list">${o.cards ?? reviewCard()}</ul>
      </div>
      <div id="cm_cr-pagination_bar"><div class="a-row">${next}</div></div>
    </div>
   </div>
   <div class="a-fixed-right-grid-col right-column a-col-right"><div id="cm_cr_customer_service_widget" class="a-row celwidget"><span class="a-size-base"><a class="a-link-normal" href="/gp/help/customer/contact-us">Need customer service?</a></span></div></div>
  </div></div>
  ${o.extraPage ?? ""}
</div></div>
<footer id="navFooter">Fake footer chrome</footer>`);
}

describe("parseReviews: default page", () => {
  const result = parseReviews(capture(reviewsPage()));
  const d = result.data;

  it("reads the product, rating block and counts", () => {
    expect(d.asin).toBe(ASIN);
    expect(d.product).toMatchObject({
      title: "Fake Widget Pro 12-Pack",
      brand: "Fake Brand",
      brand_path: "/stores/FakeBrand/page/FAKE",
      image_url: IMG,
      variant_attributes: { Finish: "Amber" },
      path: `/Fake-Widget-Pro/dp/${ASIN}`,
    });
    expect(d.rating).toBe(4.6);
    expect(d.rating_count).toBe(23456);
    expect(d.review_count).toBe(2468);
    expect(d.matching_count).toBeNull();
    expect(d.review_count_text).toBe("2,468 customer reviews");
    expect(d.write_review_path).toBe("/review/create-review");
    expect(d.section_headers).toEqual(["From the United States"]);
    expect(result.meta.strategies).toMatchObject({
      asin: "state-object",
      rating: "aria-label",
      histogram: "aria-label",
    });
  });

  it("parses the histogram from aria labels (not from the sizing ghosts in the row text)", () => {
    expect(d.histogram).toEqual({ "5": 70, "4": 20, "3": 6, "2": 3, "1": 1 });
  });

  it("echoes default filters via the dropdown prompt and exposes every option value", () => {
    expect(d.filters).toEqual({
      sortBy: { value: "helpful", label: "Top reviews" },
      reviewerType: { value: "all_reviews", label: "All reviewers" },
      filterByStar: { value: "all_stars", label: "All stars" },
      formatType: { value: "all_formats", label: "All variants" },
      mediaType: { value: "all_contents", label: "Text, image, video" },
      filterByKeyword: null,
    });
    const byParam = Object.fromEntries(d.filter_options.map((f) => [f.param, f]));
    expect(Object.keys(byParam)).toEqual([
      "sortBy",
      "reviewerType",
      "filterByStar",
      "formatType",
      "mediaType",
      "filterByKeyword",
    ]);
    expect(byParam.sortBy?.choices.map((c) => [c.label, c.value])).toEqual([
      ["Top reviews", "helpful"],
      ["Most recent", "recent"],
    ]);
    expect(byParam.filterByStar?.choices.map((c) => c.value)).toEqual([
      "all_stars",
      "five_star",
      "four_star",
      "three_star",
      "two_star",
      "one_star",
      "positive",
      "critical",
    ]);
    expect(byParam.filterByStar?.choices.find((c) => c.selected)?.value).toBe("all_stars");
    expect(byParam.filterByKeyword).toMatchObject({ control: "text", choices: [] });
    expect(byParam.formatType?.choices.at(1)).toMatchObject({
      label: "Finish: Amber",
      value: "current_format",
    });
  });

  it("reads the show-more pagination", () => {
    expect(d.pagination).toEqual({
      page: 1,
      has_next: true,
      next_page_number: 2,
      next_page_token: "FAKETOKEN2",
      next_url: `/portal/customer-reviews/${ASIN}/ref=cm_cr_arp_d_paging_btm_2`,
      next_label: "Show 10 more reviews",
      mechanism: "show_more",
      ajax_url: "/portal/customer-reviews/ajax/reviews/get/",
      page_param_disabled: false,
    });
    expect(d.is_empty).toBe(false);
    expect(d.empty_message).toBeNull();
  });

  it("never exposes state-object secrets", () => {
    const json = JSON.stringify(result);
    expect(json).not.toContain("FAKECSRF");
    expect(json).not.toContain("FAKECUSTOMER");
    expect(json).not.toContain('FAKETOKEN"');
  });

  it("accounts for all visible text: only the chrome-free leftovers are unparsed", () => {
    const html = reviewsPage();
    const ratio = expectLosslessCoverage(result, capture(html), 0.99);
    expect(ratio).toBeGreaterThan(0.99);
    // The customer-service link is chrome with no typed output: it stays visible in other_sections.
    expect(result.other_sections.map((x) => x.key)).toEqual(["cm_cr_customer_service_widget"]);
    const root = reviewsMainRoot(parseDocument(html));
    expect(visibleTextChars(parseDocument(html), { root })).toBeGreaterThan(100);
  });
});

describe("parseReviews: review cards", () => {
  const parse = (cards: string) => parseReviews(capture(reviewsPage({ cards }))).data.reviews;

  it("parses every field of a full card", () => {
    const [r] = parse(
      reviewCard({
        id: "R1FAKE00007",
        rating: 4,
        title: "Solid fake gadget",
        date: "Reviewed in Canada on August 29, 2031",
        strip: "Finish: Teal",
        statement: "8 people found this helpful",
        author: "Sam Example",
      }),
    );
    expect(r).toMatchObject({
      review_id: "R1FAKE00007",
      rating: 4,
      title: "Solid fake gadget",
      body: "First paragraph.\n\nSecond paragraph.",
      date: { raw: "August 29, 2031", iso: "2031-08-29" },
      date_line: "Reviewed in Canada on August 29, 2031",
      country: "Canada",
      verified_purchase: true,
      variant_attributes: { Finish: "Teal" },
      variant_strip: "Finish: Teal",
      variant_asin: VARIANT_ASIN,
      helpful_votes: 8,
      helpful_text: "8 people found this helpful",
      author: { name: "Sam Example", profile_path: "/gp/profile/amzn1.account.FAKEPROFILE0001" },
      permalink: "/portal/customer-reviews/srp/-/R1FAKE00007",
      badges: [],
      is_translated: false,
      can_translate: false,
      responses: [],
      media: { images: [], videos: [] },
    });
  });

  it("distinguishes verified from unverified purchases", () => {
    const [a, b] = parse(
      reviewCard({ id: "R1FAKE00001" }) + reviewCard({ id: "R1FAKE00002", verified: false }),
    );
    expect(a?.verified_purchase).toBe(true);
    expect(b?.verified_purchase).toBe(false);
  });

  it("handles zero, singular and plural helpful votes", () => {
    const [none, one, many, big] = parse(
      reviewCard({ id: "R1FAKE00001", statement: null }) +
        reviewCard({ id: "R1FAKE00002", statement: "One person found this helpful" }) +
        reviewCard({ id: "R1FAKE00003", statement: "5 people found this helpful" }) +
        reviewCard({ id: "R1FAKE00004", statement: "2,345 people found this helpful" }),
    );
    expect(none?.helpful_votes).toBe(0);
    expect(none?.helpful_text).toBeNull();
    expect(one?.helpful_votes).toBe(1);
    expect(many?.helpful_votes).toBe(5);
    expect(big?.helpful_votes).toBe(2345);
  });

  it("splits a multi-attribute variant strip written with separator icons", () => {
    const [r] = parse(
      reviewCard({
        strip:
          'Finish: Teal<i class="a-icon a-icon-text-separator"></i>Size: Large<i class="a-icon a-icon-text-separator"></i>Style: 2:1',
      }),
    );
    expect(r?.variant_attributes).toEqual({ Finish: "Teal", Size: "Large", Style: "2:1" });
    expect(r?.variant_strip).toBe("Finish: Teal | Size: Large | Style: 2:1");
  });

  it("reads a strip written as one span per attribute", () => {
    const [r] = parse(
      reviewCard({
        strip:
          '<span>Finish: Teal<i class="a-icon a-icon-text-separator"></i></span><span>Size: Large</span>',
      }),
    );
    expect(r?.variant_attributes).toEqual({ Finish: "Teal", Size: "Large" });
  });

  it("returns no variant when the card has no strip", () => {
    const [r] = parse(reviewCard({ strip: null }));
    expect(r?.variant_attributes).toEqual({});
    expect(r?.variant_strip).toBeNull();
    expect(r?.variant_asin).toBeNull();
  });

  it("collects review media and derives full-size URLs; the hidden lightbox is ignored", () => {
    const [r] = parse(reviewCard({ images: 2 }));
    expect(r?.media.images).toEqual([
      {
        url: "https://images.example.com/images/I/FAKEIMG0.jpg",
        thumbnail_url: "https://images.example.com/images/I/FAKEIMG0._SY88.jpg",
      },
      {
        url: "https://images.example.com/images/I/FAKEIMG1.jpg",
        thumbnail_url: "https://images.example.com/images/I/FAKEIMG1._SY88.jpg",
      },
    ]);
    expect(r?.body).not.toContain("Lightbox");
  });

  it("reads a review video (poster and source)", () => {
    const [r] = parse(
      reviewCard({
        extra: `<div class="review-video-container" data-hook="review-video-tile"><video poster="${IMG}" src="https://videos.example.com/fake.mp4"></video></div>`,
      }),
    );
    expect(r?.media.videos).toEqual([
      { url: "https://videos.example.com/fake.mp4", thumbnail_url: IMG },
    ]);
  });

  it("recognizes Vine, top reviewer and early reviewer badges", () => {
    const [vine, top, early] = parse(
      reviewCard({
        id: "R1FAKE00001",
        extra: `<span class="a-color-success a-text-bold" data-hook="vine-badge">Vine Customer Review of Free Product</span>`,
      }) +
        reviewCard({
          id: "R1FAKE00002",
          beforeBody: `<div class="a-row"><span class="a-profile-descriptor">Top Contributor: Fake Gadgets</span></div>`,
        }) +
        reviewCard({
          id: "R1FAKE00003",
          extra: `<span class="a-size-mini a-color-secondary">Early Reviewer Rewards</span>`,
        }),
    );
    expect(vine?.badges).toEqual([{ kind: "vine", label: "Vine Customer Review of Free Product" }]);
    expect(top?.badges).toEqual([{ kind: "top_reviewer", label: "Top Contributor: Fake Gadgets" }]);
    expect(early?.badges).toEqual([{ kind: "early_reviewer", label: "Early Reviewer Rewards" }]);
    expect(vine?.verified_purchase).toBe(true);
  });

  it("marks an untranslated foreign review and keeps the language and the translate control", () => {
    const [r] = parse(
      reviewCard({
        body: `<span class="cr-original-review-content" lang="es">Cuerpo inventado</span><span class="cr-translated-review-content aok-hidden" data-rf-hidden="1"></span>`,
        extra: `<div id="cr-single-translate" class="a-section cr-translate-this-review-section"><span class="a-declarative" data-action="reviews:ajax-post"><a class="a-link-normal" data-hook="cr-translate-this-review-link" href="#customerReviews">Translate review to English</a></span></div>`,
      }),
    );
    expect(r).toMatchObject({
      body: "Cuerpo inventado",
      language: "es",
      is_translated: false,
      can_translate: true,
      original_body: null,
    });
  });

  it("reports a translated review with its original text", () => {
    const [r] = parse(
      reviewCard({
        title: `<span class="cr-translated-review-content">Translated title</span><span class="cr-original-review-content" lang="de" data-rf-hidden="1">Titel erfunden</span>`,
        body: `<span class="cr-translated-review-content">Translated body text</span><span class="cr-original-review-content" lang="de" data-rf-hidden="1">Erfundener Text</span>`,
      }),
    );
    expect(r).toMatchObject({
      title: "Translated title",
      body: "Translated body text",
      language: "de",
      is_translated: true,
      original_title: "Titel erfunden",
      original_body: "Erfundener Text",
    });
  });

  it("reads seller and brand responses and a comment count", () => {
    const [r] = parse(
      reviewCard({
        extra: `<div class="review-response" data-hook="review-response"><strong>Fake Brand</strong>: Thanks for the invented feedback.</div><a class="a-link-normal" data-hook="review-comment" href="#">3 comments</a>`,
      }),
    );
    expect(r?.responses).toEqual([
      { from: "Fake Brand", text: "Thanks for the invented feedback." },
    ]);
    expect(r?.comment_count).toBe(3);
  });

  it("falls back to the star class, an ASIN-less id and a text-anchored date", () => {
    const html = reviewsPage({
      cards: `<li class="review" data-hook="review"><div id="customer_review-R1FAKE00009"><div data-hook="genome-widget"><span class="a-profile-name">Pat Example</span></div><h5><i class="a-icon a-star-3 review-rating" data-hook="review-star-rating"></i><a class="review-title-content" href="/portal/customer-reviews/srp/-/R1FAKE00009/ref=x"><span>Plain title</span></a></h5><span>Reviewed in Mexico on 17 April 2031</span><span class="review-text-content">Plain body</span></div></li>`,
    });
    const result = parseReviews(capture(html));
    const [r] = result.data.reviews;
    expect(r).toMatchObject({
      review_id: "R1FAKE00009",
      rating: 3,
      title: "Plain title",
      body: "Plain body",
      country: "Mexico",
      date: { raw: "17 April 2031", iso: "2031-04-17" },
    });
    expect(result.meta.strategies).toMatchObject({
      "review.id": "customer-review-id",
      "review.rating": "star-class",
      "review.date": "text-anchor",
      "review.body": "css",
    });
  });

  it("skips hidden review templates", () => {
    const reviews = parse(
      reviewCard({ id: "R1FAKE00001" }) + reviewCard({ id: "R1FAKE00002", hidden: true }),
    );
    expect(reviews.map((r) => r.review_id)).toEqual(["R1FAKE00001"]);
  });

  it("keeps long bodies complete", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const [r] = parse(reviewCard({ body: `<span>${long}</span>` }));
    expect(r?.body).toBe(long);
  });
});

describe("parseReviews: filters", () => {
  const critical = reviewsPage({
    sortApplied: "recent",
    starApplied: "critical",
    starLabel: "Critical reviews",
    selectedAttr: true,
    countLine: "More than 7,000 matching customer reviews",
    filterInfo: `<h3 data-hook="cr-filtered-by-text">Filtered by</h3><div class="a-row"><span id="reviews-filter-info-segment" data-hook="cr-filter-info-text">Critical</span> <span class="a-declarative"><a class="a-link-normal" href="/portal/customer-reviews/${ASIN}/ref=cm_cr_arp_d_show_all" data-reviews-state-param='{"filterByStar":"","pageNumber":"1"}'>Clear filter</a></span></div><div class="a-row" data-hook="cr-filter-info-review-rating-count">More than 7,000 matching customer reviews</div>`,
    cards: reviewCard({ rating: 1 }),
  });

  it("echoes the critical and most-recent filters and the matching count", () => {
    const result = parseReviews(
      capture(
        critical,
        `https://www.example.com/product-reviews/${ASIN}?pageNumber=2&filterByStar=critical&sortBy=recent`,
      ),
    );
    const d = result.data;
    expect(d.filters.filterByStar).toEqual({ value: "critical", label: "Critical reviews" });
    expect(d.filters.sortBy).toEqual({ value: "recent", label: "Most recent" });
    expect(d.filter_banner).toBe("Critical");
    expect(d.review_count).toBeNull();
    expect(d.matching_count).toBe(7000);
    expect(d.review_count_approximate).toBe(true);
    expect(d.rating).toBe(4.6);
    expect(d.reviews[0]?.rating).toBe(1);
    expect(
      d.filter_options.find((f) => f.param === "filterByStar")?.choices.find((c) => c.selected),
    ).toMatchObject({
      value: "critical",
      label: "Critical reviews",
    });
  });

  it("derives the page from the next button and warns when the URL asked for another page", () => {
    const result = parseReviews(
      capture(
        critical,
        `https://www.example.com/product-reviews/${ASIN}?pageNumber=2&filterByStar=critical`,
      ),
    );
    expect(result.data.pagination.page).toBe(1);
    expect(result.meta.strategies["pagination.page"]).toBe("next-minus-one");
    expect(result.meta.warnings.join("\n")).toContain("pageNumber=2");
  });

  it("falls back to the state object, then the URL, then the first option", () => {
    const noPrompt = (html: string): string =>
      html.replace(/<span class="a-dropdown-prompt">[^<]*<\/span>/g, "");
    const viaState = parseReviews(
      capture(noPrompt(reviewsPage({ state: { filterByStar: "four_star" } }))),
    );
    expect(viaState.data.filters.filterByStar).toEqual({
      value: "four_star",
      label: "4 star only",
    });
    expect(viaState.meta.strategies["filter.filterByStar"]).toBe("state-object");

    const viaUrl = parseReviews(
      capture(
        noPrompt(reviewsPage({ state: null })),
        `https://www.example.com/product-reviews/${ASIN}?sortBy=recent&mediaType=media_reviews_only`,
      ),
    );
    expect(viaUrl.data.filters.sortBy?.value).toBe("recent");
    expect(viaUrl.data.filters.mediaType).toEqual({
      value: "media_reviews_only",
      label: "Image and video reviews only",
    });
    expect(viaUrl.meta.strategies["filter.sortBy"]).toBe("capture-url");

    const byDefault = parseReviews(capture(noPrompt(reviewsPage({ state: null }))));
    expect(byDefault.data.filters.reviewerType).toEqual({
      value: "all_reviews",
      label: "All reviewers",
    });
    expect(byDefault.meta.strategies["filter.reviewerType"]).toBe("default-option");
    expect(byDefault.data.asin).toBe(ASIN);
    expect(byDefault.meta.strategies.asin).toBe("capture-url");
  });

  it("reads the keyword filter from the input value, the state object or the URL", () => {
    expect(
      parseReviews(capture(reviewsPage({ keyword: "fake term" }))).data.filters.filterByKeyword,
    ).toBe("fake term");
    expect(
      parseReviews(capture(reviewsPage({ state: { filterByKeyword: "from state" } }))).data.filters
        .filterByKeyword,
    ).toBe("from state");
    expect(
      parseReviews(
        capture(
          reviewsPage({ state: null }),
          `https://www.example.com/product-reviews/${ASIN}?filterByKeyword=from+url`,
        ),
      ).data.filters.filterByKeyword,
    ).toBe("from url");
  });
});

describe("parseReviews: pagination, empty and error states", () => {
  it("reports the last page: no next control", () => {
    const d = parseReviews(capture(reviewsPage({ next: null }))).data;
    expect(d.pagination).toMatchObject({
      has_next: false,
      next_page_number: null,
      next_url: null,
      next_page_token: null,
      mechanism: "none",
    });
  });

  it("reads classic numbered pagination links", () => {
    const next = `<ul class="a-pagination"><li class="a-disabled">Previous</li><li class="a-selected"><a href="/product-reviews/${ASIN}?pageNumber=2">2</a></li><li class="a-last"><a href="/product-reviews/${ASIN}/ref=cm_cr_arp_d_paging_btm_next_3?pageNumber=3">Next page</a></li></ul>`;
    const d = parseReviews(capture(reviewsPage({ next }))).data;
    expect(d.pagination).toMatchObject({
      page: 2,
      has_next: true,
      next_page_number: 3,
      next_url: `/product-reviews/${ASIN}/ref=cm_cr_arp_d_paging_btm_next_3?pageNumber=3`,
      mechanism: "link",
      next_page_token: null,
    });
  });

  it("treats a disabled classic next link as the last page", () => {
    const next = `<ul class="a-pagination"><li class="a-selected"><a href="?pageNumber=5">5</a></li><li class="a-last a-disabled">Next page</li></ul>`;
    expect(parseReviews(capture(reviewsPage({ next }))).data.pagination).toMatchObject({
      page: 5,
      has_next: false,
      mechanism: "none",
    });
  });

  it("reports an empty result page with its message", () => {
    const html = reviewsPage({
      cards: "",
      countLine: "0 matching customer reviews",
      next: null,
      extraList: `<div class="a-section a-spacing-top-large a-text-center no-reviews-section"><span class="a-size-base">Sorry, no reviews match your current selections. Try changing your filter settings.</span></div>`,
    });
    const result = parseReviews(capture(html));
    expect(result.data.is_empty).toBe(true);
    expect(result.data.reviews).toEqual([]);
    expect(result.data.empty_message).toMatch(/no reviews match/i);
    expect(result.data.matching_count).toBe(0);
    expect(result.other_sections.map((x) => x.key)).toEqual(["cm_cr_customer_service_widget"]);
    expect(result.meta.warnings).not.toContain(
      "reviews: no review cards and no empty-state message",
    );
  });

  it("surfaces the filter error only when it is visible", () => {
    const hiddenErr = parseReviews(capture(reviewsPage({ cards: "" }))).data;
    expect(hiddenErr.is_empty).toBe(true);
    expect(hiddenErr.empty_message).toBeNull();
    const visibleErr = reviewsPage({ cards: "" }).replace(' aok-hidden" data-rf-hidden="1"', '"');
    const shown = parseReviews(capture(visibleErr));
    expect(shown.data.empty_message).toMatch(/problem filtering reviews/i);
  });

  it("flags an empty page that explains nothing", () => {
    const result = parseReviews(capture(reviewsPage({ cards: "" })));
    expect(result.meta.warnings).toContain("reviews: no review cards and no empty-state message");
  });

  it("offers translate-all and reads the global header", () => {
    const html = reviewsPage({
      header: `<h3 data-hook="arp-global-reviews-header">From other countries</h3>`,
      extraList: `<div id="cr-translate-1" class="a-section cr-translate-these-reviews-section"><span class="a-declarative" data-action="reviews:ajax-post"><span class="a-button"><span class="a-button-inner"><a class="a-button-text" data-hook="cr-translate-these-reviews-link" href="#customerReviews">Translate all reviews to English</a></span></span></span></div>`,
    });
    const d = parseReviews(capture(html)).data;
    expect(d.can_translate_all).toBe(true);
    expect(d.section_headers).toEqual(["From other countries"]);
  });

  it("throws layout_unrecognized when nothing resembles a reviews page", () => {
    expect(() => parseReviews(capture(doc("<p>Nothing here</p>")))).toThrow(RfError);
    try {
      parseReviews(capture(doc("<p>Nothing here</p>")));
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });
});

describe("parseReviews: lossless accounting inside parsed containers", () => {
  const keysWith = (html: string, needle: string): string[] =>
    parseReviews(capture(html))
      .other_sections.filter((x) => x.text.includes(needle))
      .map((x) => x.key);

  it("surfaces an unknown block inside the product info container", () => {
    const html = reviewsPage().replace(
      '<div class="a-row product-title">',
      '<div id="fakeInfoNote" class="a-row">Unknown product note</div><div class="a-row product-title">',
    );
    expect(keysWith(html, "Unknown product note")).toEqual(["fakeInfoNote"]);
  });

  it("surfaces an unknown block inside the filter info section", () => {
    const html = reviewsPage({
      filterInfo: `<div class="a-row" data-hook="cr-filter-info-review-rating-count">2,468 customer reviews</div><div id="fakeFilterNote" class="a-row">Unknown filter note</div>`,
    });
    expect(keysWith(html, "Unknown filter note")).toEqual(["fakeFilterNote"]);
  });

  it("surfaces an unknown control next to the Helpful button", () => {
    const html = reviewsPage({
      cards: reviewCard().replace(
        '<span class="cr-footer-line-height">',
        '<span id="fakeVoteExtra" class="a-size-base">Unknown vote extra</span><span class="cr-footer-line-height">',
      ),
    });
    expect(JSON.stringify(parseReviews(capture(html)).other_sections)).toContain(
      "Unknown vote extra",
    );
  });

  it("leaves the buy box and footer link visible in other_sections", () => {
    const html = reviewsPage({
      extraRoot: `<div id="cm_cr-buy_box" class="a-box"><a href="/dp/${ASIN}">See All Buying Options</a></div><div id="cm_cr-footer_dp_link" class="a-row"><a href="/dp/${ASIN}">See all details for Fake Widget Pro 12-Pack</a></div>`,
    });
    expect(parseReviews(capture(html)).other_sections.map((x) => x.key)).toEqual([
      "cm_cr-buy_box",
      "cm_cr-footer_dp_link",
      "cm_cr_customer_service_widget",
    ]);
  });
});

describe("parseReviews: empty message and filter error", () => {
  it("never reports an empty message on a page that has reviews", () => {
    const html = reviewsPage({
      cards: reviewCard({ title: "There are no reviews like this one" }),
    });
    const d = parseReviews(capture(html)).data;
    expect(d.reviews).toHaveLength(1);
    expect(d.is_empty).toBe(false);
    expect(d.empty_message).toBeNull();
  });

  it("reports a rendered filter error separately from emptiness", () => {
    const html = reviewsPage().replace(' aok-hidden" data-rf-hidden="1"', '"');
    const d = parseReviews(capture(html)).data;
    expect(d.filter_error).toMatch(/problem filtering reviews/i);
    expect(d.empty_message).toBeNull();
    expect(parseReviews(capture(reviewsPage())).data.filter_error).toBeNull();
  });

  it("tells the selected attribute and the dropdown prompt strategies apart", () => {
    const attrHit = parseReviews(
      capture(reviewsPage({ sortApplied: "recent", selectedAttr: true })),
    );
    expect(attrHit.meta.strategies["filter.sortBy"]).toBe("selected-attr");
    const promptHit = parseReviews(capture(reviewsPage({ sortApplied: "recent" })));
    expect(promptHit.meta.strategies["filter.sortBy"]).toBe("dropdown-prompt");
    expect(promptHit.data.filters.sortBy?.value).toBe("recent");
  });
});

describe("parseReviews: lossless accounting", () => {
  it("emits an unknown page block in other_sections", () => {
    const html = reviewsPage({
      extraPage: `<div id="fakePromoBlock" class="a-section"><h3>Invented promo</h3><p>Totally unknown promotional text.</p><a href="/promo">Promo link</a></div>`,
    });
    const result = parseReviews(capture(html));
    const hit = result.other_sections.find((s) => s.key === "fakePromoBlock");
    expect(hit?.heading).toBe("Invented promo");
    expect(hit?.text).toContain("Totally unknown promotional text.");
    expect(hit?.links).toEqual([{ text: "Promo link", href: "https://www.example.com/promo" }]);
  });

  it("emits an unknown element inside a review card instead of dropping it", () => {
    const html = reviewsPage({
      cards: reviewCard({
        extra: `<div id="fakeCardNote" class="a-row"><span>Invented card annotation</span></div>`,
      }),
    });
    const result = parseReviews(capture(html));
    expect(JSON.stringify(result.other_sections)).toContain("Invented card annotation");
  });

  it("counts loose text outside any block as unparsed", () => {
    const html = reviewsPage({ extraRoot: `<div class="a-row">stray loose words</div>` });
    const result = parseReviews(capture(html));
    expect(result.meta.unparsed_text_chars).toBe("stray loose words".length);
  });
});

// ---- helpers -------------------------------------------------------------------------

describe("helpers", () => {
  it("parses review date lines", () => {
    expect(parseReviewDateLine("Reviewed in the United Kingdom on 3 January 2031")).toEqual({
      country: "United Kingdom",
      date: { raw: "3 January 2031", iso: "2031-01-03" },
    });
    expect(parseReviewDateLine("Reviewed in Canada on Sept. 9, 2031").date).toEqual({
      raw: "Sept. 9, 2031",
      iso: "2031-09-09",
    });
    expect(parseReviewDateLine("some text")).toEqual({ country: null, date: null });
    expect(parseReviewDateLine("Reviewed in Japan on sometime").date).toEqual({
      raw: "sometime",
      iso: null,
    });
  });

  it("converts dates without ambiguity", () => {
    expect(isoFromDateText("May 19, 2032")).toBe("2032-05-19");
    expect(isoFromDateText("1 Feb 2034")).toBe("2034-02-01");
    expect(isoFromDateText("Smarch 3, 2024")).toBeNull();
    expect(isoFromDateText("November 40, 2026")).toBeNull();
  });

  it("parses helpful statements", () => {
    expect(parseHelpfulVotes("One person found this helpful")).toBe(1);
    expect(parseHelpfulVotes("2 people found this helpful")).toBe(2);
    expect(parseHelpfulVotes("13,579 people found this helpful")).toBe(13579);
    expect(parseHelpfulVotes("Helpful")).toBeNull();
  });

  it("parses the count line variants", () => {
    expect(parseCountsText("2,222 total ratings, 333 with reviews")).toEqual({
      rating_count: 2222,
      review_count: 333,
      approximate: false,
    });
    expect(parseCountsText("9,876 customer reviews")).toMatchObject({
      review_count: 9876,
      approximate: false,
    });
    expect(parseCountsText("More than 7,000 matching customer reviews")).toMatchObject({
      review_count: 7000,
      approximate: true,
      matching: true,
    });
    expect(parseCountsText("544,321 global ratings")).toMatchObject({ rating_count: 544321 });
    expect(parseCountsText("nothing")).toEqual({ approximate: false });
  });

  it("falls back to the older rating markup and histogram table", () => {
    const html = reviewsPage().replace(
      /<div id="averageCustomerReviewsAnchor"[\s\S]*?<\/button>\s*<\/div>/,
      `<div class="reviewNumericalSummary"><span data-hook="rating-out-of-text">4.2 out of 5</span><div data-hook="total-review-count">900 global ratings</div><table id="histogramTable"><tr class="a-histogram-row"><td>5 star</td><td>60%</td></tr><tr class="a-histogram-row"><td>4 star</td><td>20%</td></tr><tr class="a-histogram-row"><td>1 star</td><td>5%</td></tr></table></div>`,
    );
    const result = parseReviews(capture(html));
    expect(result.data.rating).toBe(4.2);
    expect(result.data.rating_count).toBe(900);
    expect(result.data.histogram).toEqual({ "5": 60, "4": 20, "1": 5 });
    expect(result.meta.strategies).toMatchObject({
      rating: "out-of-text",
      rating_count: "global-ratings",
      histogram: "table-rows",
    });
  });

  it("falls back to filter hrefs for the histogram", () => {
    const html = reviewsPage().replace(
      /<div id="averageCustomerReviewsAnchor"[\s\S]*?<\/button>\s*<\/div>/,
      `<div id="averageCustomerReviewsAnchor"><a href="/product-reviews/${ASIN}?filterByStar=five_star">5 star 80%</a><a href="/product-reviews/${ASIN}?filterByStar=two_star">2 star 4%</a></div>`,
    );
    const result = parseReviews(capture(html));
    expect(result.data.histogram).toEqual({ "5": 80, "2": 4 });
    expect(result.meta.strategies.histogram).toBe("filter-href");
  });
});

// ---- product-page summary ------------------------------------------------------------

const productCard = (o: {
  id: string;
  text?: string;
  country?: string;
  translated?: boolean;
  condition?: string;
  images?: number;
}): string => `
<li><span class="a-list-item"><div data-hook="reviewContainer"><div id="${o.id}" class="a-section aok-relative" data-hook="review">
  <div class="a-row a-spacing-mini" data-hook="genome-widget"><a class="a-profile" href="/gp/profile/amzn1.account.FAKEPROFILE0002?ref=cm_cr_dp_d_bdcrb_top"><div class="a-profile-content"><span class="a-profile-name">Jo Example</span></div></a></div>
  <div class="bar"><i class="a-icon a-icon-star a-star-4" data-hook="review-star-rating"><span class="a-icon-alt">4 out of 5 stars</span></i></div>
  <a class="a-link-normal" href="/portal/customer-reviews/srp/-/${o.id}/ref=cm_cr_dp_d_rvw_ttl?_encoding=UTF8"><h5 data-hook="reviewTitle" lang="${o.translated === true ? "fr" : "en-US"}">Fake featured title</h5></a>
  <div class="a-row" data-hook="review-by-line"><span data-hook="review-date">Reviewed in ${o.country ?? "the United States"} on June 2, 2031</span></div>
  <div class="a-row" data-hook="product-variation-attributes">${o.condition === undefined ? "" : `<a class="a-link-normal" href="/gp/help/customer/display.html"><span data-hook="item-condition-badge">Condition: ${o.condition}</span></a><i class="a-icon a-icon-text-separator"></i>`}<a class="a-link-normal" data-hook="format-strip" href="/portal/customer-reviews/${VARIANT_ASIN}/ref=cm_cr_dp_d_rvw_fmt?formatType=current_format"><span>Size: Large</span><i class="a-icon a-icon-text-separator"></i><span>Pack: 2</span></a><i class="a-icon a-icon-text-separator"></i><span><div data-hook="review-badges"><a class="a-link-normal" href="/gp/help/x"><span data-hook="avp-badge">Verified Purchase</span></a></div></span></div>
  <div data-hook="reviewTextContainer"><div class="a-cardui-deck" data-hook="reviewText">
    <div class="a-teaser-describedby-collapsed a-hidden" data-rf-hidden="1">Brief content visible, double tap to read full content.</div>
    <div class="a-cardui"><div class="a-cardui-body"><div class="a-reactive-container"><div><div class="a-cardui-content"><div><div data-hook="reviewRichContentContainer" lang="${o.translated === true ? "fr" : "en-US"}"><p><span>${o.text ?? "Invented featured body."}</span></p><p><span></span></p><p><span>Second invented paragraph.</span></p></div></div></div></div></div></div>
    <div class="a-cardui-footer" data-hook="reviewExpandButtonContainer"><div class="a-cardui-expand-control-footer"><a class="a-cardui-expand-control-footer-button" href="javascript:void(0)" role="button"><span class="a-see-more"><span class="a-see-more-text">Read more</span><span class="a-see-less-text" data-rf-hidden="1">Read less</span></span></a></div></div>
  </div>
  ${o.translated === true ? `<div data-hook="translationInfo">Translated from French by Amazon</div><a data-hook="seeOriginalReviewLink" href="javascript:void(0)">See original</a>` : ""}
  <div data-hook="translationSpinner" data-rf-hidden="1"></div></div>
  ${Array.from({ length: o.images ?? 0 }, (_, i) => `<img data-hook="review-image-tile" src="https://images.example.com/images/I/FAKEPROD${i}._SY88.jpg">`).join("")}
  <div class="a-section"><div class="vote-bar"><div data-hook="helpfulVoteWidget"><span data-hook="helpful-vote-statement">2 people found this helpful</span><div data-hook="helpfulVoteButton"><span class="a-button"><span class="a-button-inner"><span class="a-button-text"><div>Helpful</div></span></span></span></div><span data-hook="helpfulVoteLoadingMessage" data-rf-hidden="1">Sending feedback...</span></div><i class="a-icon a-icon-text-separator" role="img" aria-label="|"></i><div data-hook="reportAbuseButton"><a class="a-link-normal" href="javascript:void(0)" role="button" aria-label="Report Review">Report</a></div></div></div>
</div><div id="cr-review-media-popover-${o.id}" class="aok-hidden" data-rf-hidden="1"></div></div></span></li>`;

const chip = (
  sentiment: string,
  name: string,
  count: number,
  short: string,
  withAria = true,
): string =>
  `<div class="aui-primitive" data-csa-c-type="uxElement"><div class="aui-primitive a4-arrow-nav-item" role="tab"${withAria ? ` aria-label="${sentiment} aspect, ${name.toLowerCase()}, ${count} mentions"` : ""} aria-selected="false"><button class="aui-primitive" role="button"><div><img src="${IMG}"><div><span>${name}<span>(${short})</span></span></div></div></button></div></div>`;

interface ProductOptions {
  say?: string | null;
  chips?: string;
  local?: string;
  other?: string;
  extraSection?: string;
  withMedley?: boolean;
  topLabels?: string;
}

function productPage(o: ProductOptions = {}): string {
  const say =
    o.say === null
      ? ""
      : `<div class="celwidget"><div class="aui-primitive" data-csa-c-type="slot"><div class="aui-primitive"><h3 class="aui-primitive">Customers say</h3><div class="aui-primitive"><span class="aui-primitive">${o.say ?? "Customers find the invented gadget sturdy and fairly priced."}</span></div><div class="aui-primitive"><div class="aui-primitive"><span class="aui-primitive">AI Generated from the text of customer reviews</span><img src="${IMG}"><span class="aui-primitive">Generated from the text of customer reviews</span></div><h4 class="aui-primitive">Select to learn more</h4><div class="aui-primitive" role="tablist" aria-label="Select to learn more">${o.chips ?? chip("Positive", "Strap comfort", 6100, "6.1K") + chip("Mixed", "Charge cycles", 340, "340") + chip("Negative", "Packaging", 12, "12")}</div><div class="aui-primitive" data-rf-hidden="1">hidden template text</div></div></div></div></div>`;
  return doc(`
<header id="navbar-main">Fake navigation chrome</header>
<div id="averageCustomerReviews"><span id="acrPopover"><a href="javascript:void(0)"><span>4.4</span><i class="a-icon a-icon-star-mini"><span class="a-icon-alt">4.4 out of 5 stars</span></i></a></span><a id="acrCustomerReviewLink" href="#averageCustomerReviewsAnchor"><span id="acrCustomerReviewText" aria-label="4,321 Reviews">(4,321)</span></a></div>
<input type="hidden" id="ASIN" name="ASIN" value="${ASIN}">
<div id="customer-reviews_feature_div" class="celwidget" data-feature-name="customer-reviews"><div class="celwidget"><div id="customerReviews"><hr class="a-divider-normal"><span class="cr-widget-PageState"><span id="cr-state-object" data-state='{"asin":"${ASIN}","customerId":"FAKECUSTOMER","reviewsCsrfToken":"FAKECSRF"}'></span></span>
<div id="reviewsMedley" class="a-fixed-left-grid" data-hook="reviews-medley-widget"><div class="a-fixed-left-grid-inner">
 <div class="a-fixed-left-grid-col a-col-left"><span class="cr-widget-TitleRatingsHistogram"><div class="celwidget"><div id="averageCustomerReviewsAnchor" class="aui-primitive"><h2 class="aui-primitive">Customer reviews</h2><span class="aui-primitive" role="img" aria-label="4.4 out of 5 stars, 4,321 ratings">4.4</span><span class="aui-primitive">(4,321)</span>${histogram()}<button class="aui-primitive" role="button"><span>How customer reviews and ratings work</span></button></div></div></span>
  <div id="cr-ADPlaceholder" class="a-section reviews-display-ad">${o.extraSection ?? ""}</div></div>
 <div class="a-fixed-left-grid-col a-col-right"><div class="cm_cr_grid_center_right_non_images_widgets">${say}</div>
  <div class="cm_cr_grid_center_right_non_images_widgets"><div class="celwidget"><div id="cr-top-reviews-card"><div id="cr-top-reviews-live-region" class="a-offscreen"></div><div id="cr-top-reviews">
    ${o.topLabels ?? ""}
    <div class="a-section"><div id="localTopReviews" data-hook="topReviewsSection"><h3 class="a-spacing-medium">Top reviews from the United States</h3><ul id="localTopReviewsList" class="a-unordered-list">${o.local ?? productCard({ id: "R1FAKE10001" })}</ul></div>
    <div class="a-section a-spacing-medium"><a id="cm_cr_top_reviews_to_arp_button" class="a-touch-link a-box a-text-bold" href="/portal/customer-reviews/${ASIN}/ref=cm_cr_dp_d_show_all_top?_encoding=UTF8&ie=UTF8&reviewerType=all_reviews"><div class="a-box-inner">See more reviews</div></a></div>
    ${o.other === undefined ? "" : `<div id="internationalTopReviews" data-hook="topReviewsSection"><h3 class="a-spacing-medium">Top reviews from other countries</h3><ul id="internationalTopReviewsList" class="a-unordered-list"><div class="a-section"><span class="a-button"><span class="a-button-inner"><input data-hook="translateAllReviewsButton" type="submit" value="Translate all reviews to English"><span class="a-button-text">Translate all reviews to English</span></span></span></div>${o.other}</ul></div>`}
  </div></div></div></div></div>
</div></div></div></div></div></div>
<footer id="navFooter">Fake footer chrome</footer>`);
}

const pcapture = (html: string): Capture => ({
  kind: "product",
  url: `https://www.example.com/dp/${ASIN}`,
  final_url: `https://www.example.com/dp/${ASIN}`,
  captured_at: "2026-01-01T00:00:00.000Z",
  html,
});

describe("parseReviewSummary", () => {
  const result = parseReviewSummary(
    pcapture(
      productPage({
        other: productCard({ id: "R1FAKE10002", country: "Germany", translated: true }),
      }),
    ),
  );
  const d = result.data;

  it("reads rating, count and histogram", () => {
    expect(d.asin).toBe(ASIN);
    expect(d.rating).toBe(4.4);
    expect(d.rating_count).toBe(4321);
    expect(d.rating_text).toBe("4.4 out of 5 stars, 4,321 ratings");
    expect(d.histogram).toEqual({ "5": 70, "4": 20, "3": 6, "2": 3, "1": 1 });
  });

  it("reads the AI Customers say text and the aspect chips", () => {
    expect(d.customers_say).toEqual({
      text: "Customers find the invented gadget sturdy and fairly priced.",
      ai_generated: true,
      disclosure: "AI Generated from the text of customer reviews",
    });
    expect(d.aspects).toEqual([
      { label: "Strap comfort", sentiment: "positive", mentions: 6100, mentions_text: "6.1K" },
      { label: "Charge cycles", sentiment: "mixed", mentions: 340, mentions_text: "340" },
      { label: "Packaging", sentiment: "negative", mentions: 12, mentions_text: "12" },
    ]);
  });

  it("returns null customers_say and no aspects when the AI block is absent", () => {
    const none = parseReviewSummary(pcapture(productPage({ say: null }))).data;
    expect(none.customers_say).toBeNull();
    expect(none.aspects).toEqual([]);
    expect(none.rating).toBe(4.4);
  });

  it("falls back to the displayed label and abbreviated count when a chip has no aria label", () => {
    const r = parseReviewSummary(
      pcapture(productPage({ chips: chip("Positive", "Fit", 0, "8.3K", false) })),
    ).data;
    expect(r.aspects).toEqual([
      { label: "Fit", sentiment: null, mentions: 8300, mentions_text: "8.3K" },
    ]);
  });

  it("reads featured review cards (product dialect) with variant, votes and bodies", () => {
    expect(d.featured_header).toBe("Top reviews from the United States");
    expect(d.featured_reviews).toHaveLength(1);
    expect(d.featured_reviews[0]).toMatchObject({
      review_id: "R1FAKE10001",
      rating: 4,
      title: "Fake featured title",
      body: "Invented featured body.\n\nSecond invented paragraph.",
      date: { raw: "June 2, 2031", iso: "2031-06-02" },
      country: "United States",
      verified_purchase: true,
      variant_attributes: { Size: "Large", Pack: "2" },
      variant_asin: VARIANT_ASIN,
      helpful_votes: 2,
      author: { name: "Jo Example", profile_path: "/gp/profile/amzn1.account.FAKEPROFILE0002" },
      language: "en-US",
      permalink: "/portal/customer-reviews/srp/-/R1FAKE10001",
    });
    expect(d.featured_reviews[0]?.body).not.toContain("Read more");
  });

  it("reads the other-countries block, translation info and the see-all link", () => {
    expect(d.other_country_header).toBe("Top reviews from other countries");
    expect(d.other_country_reviews).toHaveLength(1);
    expect(d.other_country_reviews[0]).toMatchObject({
      country: "Germany",
      is_translated: true,
      translated_from: "French",
      language: "fr",
    });
    expect(d.see_all_reviews_path).toBe(`/portal/customer-reviews/${ASIN}`);
    expect(d.can_translate_all).toBe(true);
  });

  it("reads item condition and media on a product-page card", () => {
    const r = parseReviewSummary(
      pcapture(
        productPage({
          local: productCard({ id: "R1FAKE10003", condition: "Used - Very Good", images: 2 }),
        }),
      ),
    ).data;
    expect(r.featured_reviews[0]?.item_condition).toBe("Used - Very Good");
    expect(r.featured_reviews[0]?.media.images.map((i) => i.url)).toEqual([
      "https://images.example.com/images/I/FAKEPROD0.jpg",
      "https://images.example.com/images/I/FAKEPROD1.jpg",
    ]);
  });

  it("picks out labelled top positive and top critical reviews", () => {
    const html = productPage({
      topLabels: `<div class="a-section"><span class="a-text-bold">Top positive review</span><ul>${productCard({ id: "R1FAKE10004", text: "Positive invented body." })}</ul></div><div class="a-section"><span class="a-text-bold">Top critical review</span><ul>${productCard({ id: "R1FAKE10005", text: "Critical invented body." })}</ul></div>`,
    });
    const r = parseReviewSummary(pcapture(html)).data;
    expect(r.top_positive_review?.review_id).toBe("R1FAKE10004");
    expect(r.top_critical_review?.review_id).toBe("R1FAKE10005");
    expect(r.featured_reviews.map((x) => x.review_id)).toEqual(["R1FAKE10001"]);
  });

  it("skips hidden templates and finds the reviews root", () => {
    const html = productPage({
      local:
        productCard({ id: "R1FAKE10001" }) +
        productCard({ id: "R1FAKE10009" }).replace(
          'data-hook="review"',
          'data-hook="review" data-rf-hidden="1"',
        ),
    });
    expect(
      parseReviewSummary(pcapture(html)).data.featured_reviews.map((r) => r.review_id),
    ).toEqual(["R1FAKE10001"]);
    expect(reviewSummaryRoot(parseDocument(html))?.id).toBe("customer-reviews_feature_div");
    expect(reviewSummaryRoot(parseDocument(doc("<p>x</p>")))).toBeUndefined();
  });

  it("falls back to the mini rating widget when the medley rating is missing", () => {
    const html = productPage().replace(/aria-label="4\.4 out of 5 stars, 4,321 ratings"/, "");
    const r = parseReviewSummary(pcapture(html));
    expect(r.data.rating).toBe(4.4);
    expect(r.data.rating_count).toBe(4321);
    expect(r.meta.strategies.rating).toBe("acr-popover");
    expect(r.meta.strategies.rating_count).toBe("acr-count");
  });

  it("accounts for the section: an unknown block is emitted, the ad placeholder stays visible", () => {
    const html = productPage({ extraSection: `<span class="a-size-mini">Sponsored</span>` });
    const r = parseReviewSummary(pcapture(html));
    expect(JSON.stringify(r.other_sections)).toContain("Sponsored");
    expect(r.meta.unparsed_text_chars).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(r)).not.toContain("FAKECSRF");
    const unknown = parseReviewSummary(
      pcapture(
        productPage().replace(
          '<div id="cr-top-reviews">',
          '<div id="fakeUnknownPanel"><p>Unrecognised invented panel</p></div><div id="cr-top-reviews">',
        ),
      ),
    );
    expect(unknown.other_sections.find((s) => s.key === "fakeUnknownPanel")?.text).toBe(
      "Unrecognised invented panel",
    );
  });

  it("surfaces an unknown block inside the Customers say container", () => {
    const html = productPage().replace(
      '<h4 class="aui-primitive">Select to learn more</h4>',
      '<h4 class="aui-primitive">Select to learn more</h4><div id="fakeSayNote" class="aui-primitive">Unknown say note</div>',
    );
    const r = parseReviewSummary(pcapture(html));
    expect(
      r.other_sections.filter((x) => x.text.includes("Unknown say note")).map((x) => x.key),
    ).toEqual(["fakeSayNote"]);
    expect(r.data.aspects).toHaveLength(3);
  });

  it("throws layout_unrecognized when there is no reviews section at all", () => {
    expect(() => parseReviewSummary(pcapture(doc("<p>No reviews here</p>")))).toThrow(RfError);
  });
});

describe("fake data stays inside the reserved ranges", () => {
  it("uses fake ASINs", () => {
    expect(FAKE.asinPattern.test(ASIN)).toBe(true);
    expect(FAKE.asinPattern.test(VARIANT_ASIN)).toBe(true);
  });
});
