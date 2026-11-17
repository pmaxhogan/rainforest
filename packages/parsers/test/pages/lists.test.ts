import { describe, expect, it } from "vitest";
import type { Capture } from "@rainforest/core";
import { RfError } from "@rainforest/core";
import { expectLosslessCoverage } from "../../src/testing.ts";
import {
  buildMoreItemsPath,
  parseList,
  parseListsIndex,
  parseLongDate,
  privacyOf,
} from "../../src/pages/lists.ts";

const LIST_A = "LISTFAKE0001A";
const LIST_B = "LISTFAKE0002B";
const LIST_C = "LISTFAKE0003C";
const H = 'data-rf-hidden="1"';

function capture(html: string, kind: "list" | "lists_index" = "list", url?: string): Capture {
  const u = url ?? `https://www.example.com/hz/wishlist/ls/${LIST_A}`;
  return {
    kind,
    url: u,
    final_url: u,
    captured_at: "2000-01-01T00:00:00.000Z",
    html: `<!DOCTYPE html><html><head><title>t</title></head><body>${html}</body></html>`,
  };
}

// ---- builders that reproduce the real structure with invented content

interface NavOpts {
  id: string;
  name: string;
  privacy?: string;
  label?: string;
  href?: string;
  selected?: boolean;
  extra?: string;
}

function navEntry(o: NavOpts): string {
  const href = o.href ?? `/hz/wishlist/ls/${o.id}?ref_=nav`;
  return `<div class="wl-list${o.selected === true ? " selected" : ""}">
    <a id="wl-list-link-${o.id}" class="a-link-normal aok-block hover-as-link" href="${href}">
      <div class="wl-list-entry-block">
        <div class="wl-list-entry-title">
          <div class="wl-list-entry-row-wrapper"><span id="wl-list-entry-title-${o.id}" class="a-color-base"> ${o.name} </span></div>
          <div class="wl-list-entry-row-wrapper">${
            o.label === undefined
              ? ""
              : `<span id="list-default-collaborator-label" class="a-size-small"> ${o.label} </span>`
          }</div>
        </div>
        <div id="wl-list-entry-privacy-${o.id}" class="wl-list-entry-privacy"><span class="a-color-base"> ${o.privacy ?? "Private"} </span></div>
        ${o.extra ?? ""}
      </div></a></div>`;
}

interface ItemOpts {
  id: string;
  asin?: string | null;
  title?: string;
  byline?: string;
  price?: string | null;
  dataPrice?: string;
  stars?: string;
  reviews?: string;
  badge?: string;
  added?: string;
  primary?: string;
  noteLabel?: string;
  rows?: string;
  extraInfo?: string;
  liAttrs?: string;
}

function priceHtml(amount: string): string {
  const [whole = "0", frac = "00"] = amount.replace("$", "").split(".");
  return `<span class="a-price" data-a-size="m" data-a-color="base"><span class="a-offscreen">${amount}</span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">${whole}<span class="a-price-decimal">.</span></span><span class="a-price-fraction">${frac}</span></span></span>`;
}

/** Hidden row templates exactly as the page ships them for an item without comment/quantity/priority. */
function hiddenRows(id: string): string {
  return `<div id="itemCommentRow_${id}" class="a-section a-hidden" ${H}><span id="itemComment_${id}"></span></div>
    <div class="a-section aok-inline-block">
      <span id="itemQuantityRow_${id}" class="a-hidden" ${H}><span id="itemRequestedLabel_${id}">Needs</span> <span id="itemRequested_${id}">1</span> &middot; <span id="itemPurchasedSection_${id}"><span id="itemPurchasedLabel_${id}">Has:</span> <span id="itemPurchased_${id}">0</span></span></span>
      <span class="g-priority-seperator a-hidden" ${H}>&middot;</span>
      <span id="itemPriorityRow_${id}" class="a-hidden" ${H}>Priority: <span id="itemPriorityLabel_${id}">medium</span></span>
    </div>`;
}

function item(o: ItemOpts, position = 1): string {
  const id = o.id;
  const asin = o.asin === undefined ? "B0FAKE0001" : o.asin;
  const title = o.title ?? "Invented Widget Deluxe";
  const price = o.price === undefined ? "$12.34" : o.price;
  const dataPrice = o.dataPrice ?? (price === null ? "-Infinity" : price.replace("$", ""));
  const asinAttr =
    asin === null
      ? ""
      : `data-csa-c-item-content-type="" data-csa-c-item-id="${asin}" data-csa-c-item-type="asin"`;
  const reposition =
    asin === null
      ? ""
      : `data-reposition-action-params="{&quot;listType&quot;:&quot;WishList&quot;,&quot;itemExternalId&quot;:&quot;ASIN:${asin}|MKTFAKE0001&quot;,&quot;sid&quot;:&quot;000-0000000-0000000&quot;}"`;
  const href = asin === null ? "#" : `/dp/${asin}/?coliid=${id}&colid=${LIST_A}&psc=1&ref_=x`;
  const stars =
    o.stars === undefined
      ? ""
      : `<div class="a-row"><span class="a-declarative" data-action="a-popover"><a aria-label="${o.stars} out of 5 stars" class="a-link-normal g-visible-js reviewStarsPopoverLink" href="#"><i id="review_stars_${id}" class="a-icon a-icon-star-small a-star-small-4-5"><span class="a-icon-alt">${o.stars} out of 5 stars</span></i><i class="a-icon a-icon-popover" role="presentation"></i></a></span>
         <a id="review_count_${id}" aria-label="${o.reviews ?? "1"}" class="a-size-base a-link-normal" href="/portal/customer-reviews/${asin ?? "X"}/">${o.reviews ?? "1"}</a></div>`;
  const badge =
    o.badge === undefined
      ? ""
      : o.badge === "prime"
        ? `<span class="wl-item-delivery-badge"><i id="prime-badge" class="a-icon a-icon-prime" role="img" aria-label="prime"></i></span>`
        : `<span class="wl-item-delivery-badge"><span class="a-color-secondary a-size-base">${o.badge}</span></span>`;
  const priceBlock =
    price === null && o.badge === undefined
      ? ""
      : `<div class="a-row wl-price-ppu-delivery-badge-row"><div data-item-prime-info="{&quot;id&quot;:&quot;${id}&quot;,&quot;asin&quot;:&quot;${asin ?? ""}&quot;}" class="a-section price-section">${
          price === null
            ? ""
            : `<span id="itemPrice_${id}" class="a-price-wrap">${priceHtml(price)}</span>`
        }${badge}</div></div>`;
  return `<li data-id="${LIST_A}" data-itemid="${id}" data-price="${dataPrice}" ${reposition} ${o.liAttrs ?? ""} class="a-spacing-base g-item-sortable"><span class="a-list-item">
    <div id="item_${id}" class="a-section">
      <div class="a-fixed-left-grid awl-ul-item-container-desktop"><div class="a-fixed-left-grid-inner">
        <div id="itemImage_${id}" class="a-fixed-left-grid-col awl-ul-item-image-desktop"><a class="a-link-normal" title="${title}" href="${href}"><img alt="${title}" src="https://images.example.com/placeholder.png" height="135" width="135"></a></div>
        <div class="a-section awl-ul-item-info-desktop">
          <div id="itemMain_${id}" class="a-fixed-left-grid-col a-col-right">
            <div id="itemAlertDefault_${id}" class="a-box a-alert a-hidden" role="alert" ${H}><div class="a-alert-content">An invented error</div></div>
            <div id="itemInfo_${id}" class="a-section">
              <div class="a-row a-size-small"><h2 class="a-size-base"><a id="itemName_${id}" class="a-link-normal" title="${title}" href="${href}">
                ${title}
              </a></h2>${
                o.byline === undefined
                  ? ""
                  : `<span id="item-byline-${id}" class="a-size-base"> by ${o.byline} </span>`
              }</div>
              <div ${asinAttr} data-csa-c-list-type="WishList" data-csa-c-posy="${position}" data-csa-c-type="item" class="a-row a-spacing-small a-size-small">
                ${stars}${priceBlock}
              </div>
              <div class="a-section awl-ul-keyword-item-subtitle">${o.rows ?? hiddenRows(id)}</div>
              ${o.extraInfo ?? ""}
            </div>
            <div class="a-section dateAddedText">${
              o.added === undefined
                ? ""
                : `<span id="itemAddedDate_${id}" class="a-size-small"> ${o.added} </span>`
            }</div>
            <div id="itemAction_${id}" class="a-section awl-ul-item-button-desktop"><div class="a-button-stack">
              <div id="wl-atc-${id}" class="atc-faceout-container"><form method="post"><input type="hidden" name="anti-csrftoken-a2z" value="x" ${H}><span class="a-declarative" data-action="cta-add-to-cart"><span id="pab-${id}" class="a-button a-button-normal a-button-primary"><span class="a-button-inner"><a href="javascript:void(0)" class="a-button-text a-text-center"> ${o.primary ?? "Add to Cart"} </a></span></span></span></form></div>
              <span class="a-declarative" data-action="reg-dispatch-modal" data-reg-dispatch-modal="{&quot;name&quot;:&quot;edit-notes&quot;,&quot;url&quot;:&quot;/hz/wishlist/cqp/x?listId=${LIST_A}&amp;itemId=${id}&quot;}"><span class="a-button a-button-base" id="a-autoid-${position}"><span class="a-button-inner"><a href="/hz/wishlist/cqp/x?listId=${LIST_A}&amp;itemId=${id}" class="a-button-text"><div id="keywordEditLabel_${id}"> ${o.noteLabel ?? "Add a note"} </div></a></span></span></span>
              <div class="g-visible-js"><span id="move-to-list-button-${id}" class="a-button a-button-dropdown"><span class="a-button-inner"><span id="move-to-list-button-${id}-announce" class="a-button-text" aria-hidden="true"> Move </span></span></span>
              <form method="post" action="/hz/wishlist/removeitem/form"><span class="a-declarative" data-action="reg-item-delete"><span id="delete-button-${id}" class="a-button a-button-base"><span class="a-button-inner"><input name="submit.deleteItem" class="a-button-input" type="submit"><span class="a-button-text"><span class="aok-offscreen">Delete</span></span></span></span></span></form></div>
            </div></div>
          </div>
        </div>
      </div></div>
    </div>
  </span></li>`;
}

interface PageOpts {
  nav?: string;
  items?: string;
  name?: string;
  privacy?: string;
  extraHeader?: string;
  listIdInput?: boolean;
  state?: string | null;
  filterOptions?: boolean;
  scroll?: { token: string; url: string; rendered: number } | null;
  endMarker?: boolean;
  intoPane?: string;
  viewCount?: number | null;
  controlBar?: string;
}

function listPage(o: PageOpts = {}): string {
  const items = o.items ?? "";
  const state =
    o.state === null
      ? ""
      : `<script type="a-state" data-a-state="{&quot;key&quot;:&quot;rememberState&quot;}">${
          o.state ?? `{"listId":"${LIST_A}","listType":"WishList","isSharedWL":false}`
        }</script>`;
  const scroll =
    o.scroll === null
      ? ""
      : `<li class="a-spacing-none"><span class="a-list-item"><form method="get" class="scroll-state"><input type="hidden" name="showMoreUrl" value="${o.scroll?.url ?? "/hz/wishlist/slv/items?filter=unpurchased&paginationToken=&sort=date-added&lid=" + LIST_A}" ${H}><input type="hidden" name="lastEvaluatedKey" value="${o.scroll?.token ?? ""}" ${H}><input type="hidden" name="itemsRenderedSoFar" value="${o.scroll?.rendered ?? 0}" ${H}></form></span></li>`;
  const end =
    o.endMarker === false
      ? ""
      : `<li class="a-spacing-none"><span class="a-list-item"><div id="endOfListMarker" class="a-section"><div class="a-divider a-divider-break"><h5 aria-level="5">End of list</h5></div></div></span></li>`;
  const bar =
    o.controlBar ??
    `<div id="control-bar" class="a-section control-bar-container">${state}
      <div id="view-switcher-buttons"><a id="grid-view-switcher" class="view-switcher" href="#"><img alt="Switch to grid view" src="https://images.example.com/placeholder.png"></a><a id="list-view-switcher" class="view-switcher view-switcher-active" href="#"><img alt="Switch to list view" src="https://images.example.com/placeholder.png"></a></div>
      <form id="wl-item-search" method="get"><input type="hidden" name="type" value="WishList" ${H}><input type="search" id="itemSearchTextInput" placeholder="Search this list" name="itemSearchKeyword"></form>
      <span class="a-dropdown-container"><label class="a-native-dropdown"><span>Show:</span></label><select name="sfr-trigger" aria-label="Show:"><option value="filter|unpurchased" selected ${H}>Unpurchased</option><option value="filter|purchased" ${H}>Purchased</option><option value="filter|all" ${H}>All items</option></select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text"><span class="a-dropdown-label"><span>Show:</span></span><span class="a-dropdown-prompt">Unpurchased</span></span></span></span></span>
      <span class="a-dropdown-container"><label class="a-native-dropdown"><span>Sort by:</span></label><select name="sfr-trigger" aria-label="Sort by:"><option value="sort|date-added" selected ${H}>Newest</option><option value="sort|priority" ${H}>Priority (high to low)</option></select><span class="a-button a-button-dropdown"><span class="a-button-inner"><span class="a-button-text"><span class="a-dropdown-label"><span>Sort by:</span></span><span class="a-dropdown-prompt">Newest</span></span></span></span></span>
      <div class="a-section control-bar g-visible-no-js" ${H}><form method="get" action="/hz/wishlist/ls/${LIST_A}"><select name="sort"><option value="date-added" selected>Newest</option><option value="priority">Priority (high to low)</option></select><select name="filter"><option value="unpurchased" selected>Unpurchased</option><option value="purchased">Purchased</option><option value="all">All items</option></select></form></div>
    </div>`;
  return `<div id="wishlist-page" class="a-tab-container">
    ${o.listIdInput === false ? "" : `<input type="hidden" name="" value="${LIST_A}" id="listId" ${H}>`}
    <ul class="a-tabs a-declarative"><li id="my-lists-tab" class="a-tab-heading a-active"><a href="/hz/wishlist/ls/ref=cm_wl_your_lists"><div role="heading" aria-level="1"> Your Lists</div></a></li><li id="friends-tab" class="a-tab-heading"><a href="/hz/wishlist/friends/ref_=cm_wl_friends">Your Friends</a></li></ul>
    <div class="a-section a-text-right"><span class="a-declarative" data-action="show-create-list" data-show-create-list="{&quot;listID&quot;:&quot;${LIST_A}&quot;,&quot;url&quot;:&quot;/hz/wishlist/create?isPopover=1&amp;createIngressName=FAKE&quot;}"><a id="createList" class="a-link-normal createListTrigger" href="#">Create a List</a></span> <a class="a-link-normal" href="/gp/help/customer/display.html?nodeId=1">List help</a></div>
    <div id="my-lists-tab-panel" class="a-box"><div class="a-box-inner"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
      <div id="left-nav" class="a-fixed-left-grid-col a-col-left"><div id="your-lists-nav" class="a-section">${
        o.nav ??
        navEntry({ id: LIST_A, name: "Invented Main List", label: "Default List", selected: true })
      }</div></div>
      <div id="content-right" class="a-fixed-left-grid-col a-col-right">
        <div id="cannotLeaveListAlert" class="a-box a-hidden" ${H}>Invented alert that must stay hidden</div>
        <div class="a-section list-header-container"><div id="list-header" class="a-section"><div id="wl-list-info" class="a-row">
          <div class="a-section aok-float-right"><div id="wl-add-keyword-modal"><div class="a-popover-preload" id="a-popover-addkeyword-screen-modal" ${H}><form id="add-new-keyword-form"><input type="hidden" name="listExternalId" value="x"></form></div></div><span class="a-declarative"><span id="wl-ul-add-keyword-button" class="a-button a-button-base"><span class="a-button-inner"><input class="a-button-input" type="submit"><span id="wl-ul-add-keyword-button-announce" class="a-button-text"> Add item </span></span></span></span></div>
          <span id="profile-list-name" aria-level="2" role="heading">${o.name ?? "Invented Main List"}</span> <span class="aok-nowrap"><span id="listPrivacy" class="a-color-secondary">${o.privacy ?? "Private"}</span></span>
          <div class="aok-inline-block"><div role="group" aria-label="Manage people"><img alt="2" src="https://images.example.com/placeholder.png"></div><span class="a-declarative" id="inviteAndShare"><a id="invite-collaborators-link" class="a-link-normal" href="#"><span class="wl-invite-text">Invite</span></a></span></div>
          ${o.extraHeader ?? ""}
        </div></div></div>
        <hr class="a-divider-normal">
        ${bar}
        <div id="wl-item-view" class="a-section"><div id="item-page-wrapper" class="a-section"><div class="a-section">
          <ul id="g-items" class="a-unordered-list a-nostyle a-vertical g-items-section"><li class="a-spacing-none"><span class="a-list-item">${
            o.viewCount === null
              ? ""
              : `<input type="hidden" name="" value="${o.viewCount ?? 0}" id="viewItemCount" ${H}>`
          }</span></li>
          ${items}${scroll}${end}</ul>
        </div></div></div>
        ${o.intoPane ?? ""}
      </div>
    </div></div></div></div>
  </div>`;
}

const ITEM_ID_1 = "ITEMFAKE0001";
const ITEM_ID_2 = "ITEMFAKE0002";
const ITEM_ID_3 = "ITEMFAKE0003";

// ---- helpers

describe("parseLongDate", () => {
  it("parses month-name dates without any timezone dependence", () => {
    expect(parseLongDate("Item added April 21, 2026")).toBe("2026-04-21");
    expect(parseLongDate("Dec 3 2025")).toBe("2025-12-03");
    expect(parseLongDate("Sept. 9, 2024")).toBe("2024-09-09");
  });
  it("rejects impossible or unparseable dates", () => {
    expect(parseLongDate("February 30, 2026")).toBeUndefined();
    expect(parseLongDate("Blarch 3, 2026")).toBeUndefined();
    expect(parseLongDate("no date here")).toBeUndefined();
    expect(parseLongDate(undefined)).toBeUndefined();
  });
});

describe("privacyOf", () => {
  it("maps the shown word", () => {
    expect(privacyOf("Private")).toBe("private");
    expect(privacyOf(" Shared ")).toBe("shared");
    expect(privacyOf("Public")).toBe("public");
    expect(privacyOf("Whatever")).toBe("unknown");
    expect(privacyOf(undefined)).toBe("unknown");
  });
});

describe("buildMoreItemsPath", () => {
  it("replaces only the paginationToken parameter", () => {
    const path = buildMoreItemsPath(
      "/hz/wishlist/slv/items?filter=unpurchased&paginationToken=&sort=date-added&lid=LISTFAKE0001A",
      "tok en",
    );
    const url = new URL(path, "https://www.example.com");
    expect(url.pathname).toBe("/hz/wishlist/slv/items");
    expect(url.searchParams.get("paginationToken")).toBe("tok en");
    expect(url.searchParams.get("filter")).toBe("unpurchased");
    expect(url.searchParams.get("lid")).toBe(LIST_A);
  });
});

// ---- list index

describe("parseListsIndex", () => {
  const nav =
    navEntry({ id: LIST_A, name: "Invented Main List", label: "Default List", selected: true }) +
    navEntry({ id: LIST_B, name: "Invented Party Plans", privacy: "Shared" }) +
    navEntry({
      id: LIST_C,
      name: "Invented Voice List",
      href: `/gp/alexa-shopping-list?externalId=${LIST_C}&ref_=nav`,
    });

  it("lists every nav entry with privacy, default flag, kind and selection", () => {
    const r = parseListsIndex(capture(listPage({ nav }), "lists_index"));
    expect(r.data.variant).toBe("lists");
    expect(r.data.lists.map((l) => l.list_id)).toEqual([LIST_A, LIST_B, LIST_C]);
    const [a, b, c] = r.data.lists;
    expect(a).toMatchObject({
      name: "Invented Main List",
      privacy: "private",
      privacy_text: "Private",
      is_default: true,
      selected: true,
      list_kind: "wish_list",
      label: "Default List",
      url_path: `/hz/wishlist/ls/${LIST_A}`,
      shared_with_me: false,
    });
    expect(b).toMatchObject({ privacy: "shared", is_default: false, selected: false });
    expect(b?.label).toBeUndefined();
    expect(c).toMatchObject({ list_kind: "shopping_list", privacy: "private" });
    expect(c?.url_path).toBe(`/gp/alexa-shopping-list?externalId=${LIST_C}`);
    expect(r.data.selected_list_id).toBe(LIST_A);
    expect(r.meta.strategies["nav.list_id"]).toBe("id");
  });

  it("falls back to the href, then to the title id, for the list id", () => {
    const noLinkId = `<div class="wl-list"><a href="/hz/wishlist/ls/${LIST_B}?ref_=x"><div class="wl-list-entry-block"><div class="wl-list-entry-title"><div class="wl-list-entry-row-wrapper"><span id="wl-list-entry-title-${LIST_B}">Invented Href List</span></div></div><div class="wl-list-entry-privacy">Public</div></div></a></div>`;
    const alexa = `<div class="wl-list"><a href="/gp/alexa-shopping-list?externalId=${LIST_C}"><div class="wl-list-entry-block"><div class="wl-list-entry-title"><div class="wl-list-entry-row-wrapper"><span>Invented Alexa Entry</span></div></div></div></a></div>`;
    const titleOnly = `<div class="wl-list"><a href="/somewhere/else"><div class="wl-list-entry-block"><div class="wl-list-entry-title"><div class="wl-list-entry-row-wrapper"><span id="wl-list-entry-title-${LIST_A}">Invented Title Only</span></div></div></div></a></div>`;
    const r = parseListsIndex(
      capture(listPage({ nav: noLinkId + alexa + titleOnly }), "lists_index"),
    );
    expect(r.data.lists.map((l) => [l.list_id, l.privacy])).toEqual([
      [LIST_B, "public"],
      [LIST_C, "unknown"],
      [LIST_A, "unknown"],
    ]);
    expect(r.data.lists[1]?.name).toBe("Invented Alexa Entry");
    expect(r.data.lists[2]?.name).toBe("Invented Title Only");
  });

  it("marks lists shared with the owner from a group heading and an owner line", () => {
    const shared = `<h3 class="a-size-base">Shared with you</h3>${navEntry({
      id: LIST_B,
      name: "Invented Shared Plans",
      label: "Shared by Alex Example",
      privacy: "Shared",
    })}`;
    const r = parseListsIndex(
      capture(
        listPage({
          nav: navEntry({ id: LIST_A, name: "Invented Main List", selected: true }) + shared,
        }),
        "lists_index",
      ),
    );
    const [own, theirs] = r.data.lists;
    expect(own?.shared_with_me).toBe(false);
    expect(theirs).toMatchObject({
      shared_with_me: true,
      owner: "Alex Example",
      section: "Shared with you",
      is_default: false,
    });
  });

  it("reads an item count when the nav shows one", () => {
    const r = parseListsIndex(
      capture(
        listPage({
          nav: navEntry({
            id: LIST_A,
            name: "Invented Main List",
            selected: true,
            extra: `<div class="wl-list-entry-count">1,204 items</div>`,
          }),
        }),
        "lists_index",
      ),
    );
    expect(r.data.lists[0]?.item_count).toBe(1204);
    expect(r.meta.strategies["nav.item_count"]).toBe("count-element");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("skips hidden nav entries and never leaks hidden text", () => {
    const hidden = `<div class="wl-list" ${H}><a id="wl-list-link-${LIST_C}" href="/hz/wishlist/ls/${LIST_C}"><span id="wl-list-entry-title-${LIST_C}">Invented Hidden Template</span></a></div>`;
    const r = parseListsIndex(
      capture(
        listPage({
          nav: navEntry({ id: LIST_A, name: "Invented Main List", selected: true }) + hidden,
        }),
        "lists_index",
      ),
    );
    expect(r.data.lists).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("Invented Hidden Template");
    expect(JSON.stringify(r)).not.toContain("Invented alert that must stay hidden");
  });

  it("reports tabs, the create control and the help link", () => {
    const r = parseListsIndex(capture(listPage({ nav }), "lists_index"));
    expect(r.data.tabs).toEqual([
      { label: "Your Lists", active: true, href: "/hz/wishlist/ls/ref=cm_wl_your_lists" },
      { label: "Your Friends", active: false, href: "/hz/wishlist/friends/ref_=cm_wl_friends" },
    ]);
    expect(r.data.can_create).toBe(true);
    expect(r.data.create_list_path).toBe("/hz/wishlist/create");
    expect(r.data.help_link).toEqual({
      text: "List help",
      href: "/gp/help/customer/display.html?nodeId=1",
    });
  });

  it("includes the selected list pane without duplicating the nav", () => {
    const r = parseListsIndex(
      capture(
        listPage({ nav, items: item({ id: ITEM_ID_1, byline: "Fake Brand" }) }),
        "lists_index",
      ),
    );
    expect(r.data.selected_list?.items).toHaveLength(1);
    expect(r.data.selected_list?.nav_lists).toEqual([]);
    expect(r.data.selected_list?.list.name).toBe("Invented Main List");
  });

  it("returns no lists, not an error, for the intro page", () => {
    const html = `<div id="wishlist-page" class="a-container">
      <ul class="a-tabs"><li id="my-lists-tab" class="a-tab-heading a-active"><a href="/hz/wishlist/ls/ref=x">Your Lists</a></li></ul>
      <div class="your-lists-container"><div class="intro-page-banner"><div class="intro-page-banner-header">Invented Banner</div></div>
        <div class="a-section"><div class="intro-page-benefits-header">Invented Benefits</div>
          <span class="a-declarative" data-action="show-create-list" data-show-create-list="{&quot;url&quot;:&quot;/hz/wishlist/create?isPopover=1&quot;}"><span id="createList" class="a-button createListTrigger"><span class="a-button-text">Create a List</span></span></span></div>
      </div></div>`;
    const r = parseListsIndex(
      capture(html, "lists_index", "https://www.example.com/hz/wishlist/intro"),
    );
    expect(r.data.variant).toBe("intro");
    expect(r.data.lists).toEqual([]);
    expect(r.data.can_create).toBe(true);
    expect(r.data.selected_list).toBeUndefined();
    expect(r.meta.warnings.some((w) => w.includes("intro page"))).toBe(true);
    expect(r.other_sections.map((s) => s.text).join(" ")).toContain("Invented Benefits");
    expect(r.other_sections.map((s) => s.text).join(" ")).toContain("Invented Banner");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("throws layout_unrecognized when nothing list-like is present", () => {
    expect(() =>
      parseListsIndex(capture("<div>Invented unrelated page</div>", "lists_index")),
    ).toThrow(RfError);
    try {
      parseListsIndex(capture("<p>nothing</p>", "lists_index"));
    } catch (e) {
      expect((e as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("puts an unknown visible block into other_sections and accounts for it", () => {
    const cap = capture(
      listPage({
        nav,
        intoPane: `<div id="invented-promo" class="a-section">Invented promotional banner text</div>`,
      }),
      "lists_index",
    );
    const r = parseListsIndex(cap);
    const promo = r.other_sections.find((s) => s.text.includes("Invented promotional banner"));
    expect(promo).toBeDefined();
    expect(promo?.key).toBe("invented-promo");
    expect(r.meta.unparsed_text_chars).toBe(0);
    expectLosslessCoverage(r, cap, 0.5);
  });
});

// ---- one list

describe("parseList header", () => {
  it("reads name, privacy, ids, state and header controls", () => {
    const r = parseList(capture(listPage({ items: item({ id: ITEM_ID_1 }), viewCount: 1 })));
    expect(r.data.list).toMatchObject({
      list_id: LIST_A,
      name: "Invented Main List",
      privacy: "private",
      privacy_text: "Private",
      list_kind: "wish_list",
      list_type_raw: "WishList",
      is_shared: false,
      view_item_count: 1,
      collaborator_count: 2,
      can_add_item: true,
      can_invite: true,
    });
    expect(r.data.list.extra_text).toBeUndefined();
    expect(r.meta.strategies["list.list_id"]).toBe("hidden-input");
    expect(r.meta.strategies["list.name"]).toBe("id");
    expect(r.data.nav_lists).toHaveLength(1);
    expect(r.data.has_search).toBe(true);
    expect(r.data.view).toBe("list");
  });

  it("falls back from the hidden input to the page state, the url, then the nav", () => {
    const noInput = parseList(capture(listPage({ listIdInput: false })));
    expect(noInput.meta.strategies["list.list_id"]).toBe("page-state");
    const noState = parseList(capture(listPage({ listIdInput: false, state: null })));
    expect(noState.data.list.list_id).toBe(LIST_A);
    expect(noState.meta.strategies["list.list_id"]).toBe("url");
    const other = capture(
      listPage({ listIdInput: false, state: null }),
      "list",
      "https://www.example.com/hz/wishlist",
    );
    expect(parseList(other).meta.strategies["list.list_id"]).toBe("nav-selected");
  });

  it("records a shared flag and a description when present", () => {
    const r = parseList(
      capture(
        listPage({
          state: `{"listId":"${LIST_A}","listType":"WishList","isSharedWL":true}`,
          extraHeader: `<div id="list-description" class="a-section">Invented gift ideas for a fake party</div>`,
          privacy: "Shared",
        }),
      ),
    );
    expect(r.data.list.is_shared).toBe(true);
    expect(r.data.list.privacy).toBe("shared");
    expect(r.data.list.description).toBe("Invented gift ideas for a fake party");
  });

  it("reads an item count from header text and keeps unknown header text", () => {
    const r = parseList(
      capture(
        listPage({
          extraHeader: `<span class="x">12 items</span> <span class="y">Invented stray note</span>`,
        }),
      ),
    );
    expect(r.data.list.item_count).toBe(12);
    expect(r.data.list.extra_text).toEqual(["Invented stray note"]);
  });

  it("throws when there is no list pane", () => {
    expect(() => parseList(capture(`<div id="wishlist-page"><p>Invented text</p></div>`))).toThrow(
      RfError,
    );
  });
});

describe("parseList controls", () => {
  it("reads filter and sort from the native no-js selects", () => {
    const r = parseList(capture(listPage()));
    expect(r.data.filter).toMatchObject({
      param: "filter",
      label: "Show",
      selected_value: "unpurchased",
      selected_label: "Unpurchased",
    });
    expect(r.data.filter?.options).toEqual([
      { value: "unpurchased", label: "Unpurchased", selected: true },
      { value: "purchased", label: "Purchased", selected: false },
      { value: "all", label: "All items", selected: false },
    ]);
    expect(r.data.sort?.selected_value).toBe("date-added");
    expect(r.data.sort?.options.map((o) => o.value)).toEqual(["date-added", "priority"]);
    expect(r.meta.strategies["control.filter.options"]).toBe("native-select");
  });

  it("falls back to the dropdown selects, then to the visible prompt", () => {
    const noNative = listPage().replace(
      /<div class="a-section control-bar g-visible-no-js"[\s\S]*?<\/form><\/div>/,
      "",
    );
    const r = parseList(capture(noNative));
    expect(r.meta.strategies["control.sort.options"]).toBe("dropdown-select");
    expect(r.data.sort?.options[1]).toEqual({
      value: "priority",
      label: "Priority (high to low)",
      selected: false,
    });
    expect(r.data.sort?.selected_value).toBe("date-added");

    const promptOnly = noNative.replace(/<select[\s\S]*?<\/select>/g, "");
    const p = parseList(capture(promptOnly));
    expect(p.data.sort?.options).toEqual([]);
    expect(p.data.sort?.selected_label).toBe("Newest");
    expect(p.data.filter?.selected_label).toBe("Unpurchased");
    expect(p.meta.strategies["control.sort.selected"]).toBe("dropdown-prompt");
  });

  it("keeps unknown control-bar text", () => {
    const bar = listPage().replace(
      `<div id="view-switcher-buttons">`,
      `<span class="stray">Invented stray control</span><div id="view-switcher-buttons">`,
    );
    const r = parseList(capture(bar));
    expect(r.data.extra_text).toEqual(["Invented stray control"]);
  });
});

describe("parseList items", () => {
  it("parses a full item", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            asin: "B0FAKE0001",
            title: 'Invented Widget 2" Deluxe',
            byline: "Fake Brand (Toy)",
            price: "$1,234.56",
            dataPrice: "1234.56",
            stars: "4.5",
            reviews: "1,203",
            badge: "prime",
            added: "Item added April 21, 2026",
          }),
          viewCount: 1,
        }),
      ),
    );
    const [it] = r.data.items;
    expect(r.data.items).toHaveLength(1);
    expect(it).toMatchObject({
      item_id: ITEM_ID_1,
      position: 1,
      source: "page",
      asin: "B0FAKE0001",
      external_id: "ASIN:B0FAKE0001|MKTFAKE0001",
      title: 'Invented Widget 2" Deluxe',
      url_path: "/dp/B0FAKE0001/",
      image_url: "https://images.example.com/placeholder.png",
      byline: "Fake Brand (Toy)",
      brand: "Fake Brand",
      byline_qualifier: "Toy",
      price: { amount: 1234.56, currency: "USD", raw: "$1,234.56" },
      price_hint: 1234.56,
      added: { raw: "Item added April 21, 2026", iso: "2026-04-21" },
      rating: { value: 4.5, out_of: 5 },
      review_count: 1203,
      prime: true,
      is_purchased: false,
      primary_action: "Add to Cart",
      can_add_to_cart: true,
      actions: ["Add to Cart", "Add a note", "Move", "Delete"],
    });
    expect(it?.extra_text).toBeUndefined();
    expect(it?.price_drop).toBeUndefined();
    expect(r.meta.strategies["item.item_id"]).toBe("data-itemid");
    expect(r.meta.strategies["item.price"]).toBe("price-element");
    expect(r.meta.strategies["item.asin"]).toBe("csa-item");
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.other_sections).toEqual([]);
  });

  it("keeps page order and numbers positions", () => {
    const r = parseList(
      capture(
        listPage({
          items:
            item({ id: ITEM_ID_1, asin: "B0FAKE0001" }, 1) +
            item({ id: ITEM_ID_2, asin: "B0FAKE0002" }, 2) +
            item({ id: ITEM_ID_3, asin: "B0FAKE0003" }, 3),
        }),
      ),
    );
    expect(r.data.items.map((i) => [i.position, i.item_id, i.asin])).toEqual([
      [1, ITEM_ID_1, "B0FAKE0001"],
      [2, ITEM_ID_2, "B0FAKE0002"],
      [3, ITEM_ID_3, "B0FAKE0003"],
    ]);
  });

  it("takes defaults from hidden row templates as absent, not as values", () => {
    const r = parseList(capture(listPage({ items: item({ id: ITEM_ID_1 }) })));
    const [it] = r.data.items;
    expect(it?.quantity_wanted).toBeUndefined();
    expect(it?.quantity_has).toBeUndefined();
    expect(it?.priority).toBeUndefined();
    expect(it?.comment).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("An invented error");
  });

  it("parses a visible comment, quantity and priority", () => {
    const rows = `<div id="itemCommentRow_${ITEM_ID_1}" class="a-section"><span id="itemComment_${ITEM_ID_1}"> Invented gift note for a fake person </span></div>
      <div class="a-section aok-inline-block">
        <span id="itemQuantityRow_${ITEM_ID_1}"><span id="itemRequestedLabel_${ITEM_ID_1}">Needs</span> <span id="itemRequested_${ITEM_ID_1}"> 3 </span> &middot; <span id="itemPurchasedSection_${ITEM_ID_1}"><span id="itemPurchasedLabel_${ITEM_ID_1}">Has:</span> <span id="itemPurchased_${ITEM_ID_1}"> 1 </span></span></span>
        <span class="g-priority-seperator">&middot;</span>
        <span id="itemPriorityRow_${ITEM_ID_1}">Priority: <span id="itemPriorityLabel_${ITEM_ID_1}"> Highest </span></span>
      </div>`;
    const r = parseList(
      capture(listPage({ items: item({ id: ITEM_ID_1, rows, noteLabel: "Edit" }) })),
    );
    const [it] = r.data.items;
    expect(it).toMatchObject({
      comment: "Invented gift note for a fake person",
      quantity_wanted: 3,
      quantity_has: 1,
      priority: "highest",
      is_purchased: false,
    });
    expect(it?.actions).toContain("Edit");
    expect(it?.extra_text).toBeUndefined();
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.meta.strategies["item.comment"]).toBe("id");
  });

  it("reads a priority from a text anchor when the label id is missing", () => {
    const rows = `<div class="a-section aok-inline-block"><span id="itemPriorityRow_${ITEM_ID_1}">Priority: low</span></div>`;
    const r = parseList(capture(listPage({ items: item({ id: ITEM_ID_1, rows }) })));
    expect(r.data.items[0]?.priority).toBe("low");
    expect(r.meta.strategies["item.priority"]).toBe("text-anchor");
  });

  it("marks an item purchased when the has-count reaches the wanted count", () => {
    const rows = `<div class="a-section aok-inline-block"><span id="itemQuantityRow_${ITEM_ID_1}"><span id="itemRequested_${ITEM_ID_1}">2</span> <span id="itemPurchasedSection_${ITEM_ID_1}"><span id="itemPurchased_${ITEM_ID_1}">2</span></span></span></div>`;
    const r = parseList(capture(listPage({ items: item({ id: ITEM_ID_1, rows }) })));
    expect(r.data.items[0]).toMatchObject({
      is_purchased: true,
      quantity_wanted: 2,
      quantity_has: 2,
    });
  });

  it("marks an item purchased from an explicit purchased marker", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            extraInfo: `<div class="a-row"><span class="a-color-success">Purchased on May 2, 2026</span></div>`,
          }),
        }),
      ),
    );
    expect(r.data.items[0]?.is_purchased).toBe(true);
    expect(r.data.items[0]?.purchased_text).toBe("Purchased on May 2, 2026");
    expect(r.meta.strategies["item.purchased"]).toBe("text-anchor");
  });

  it("parses a price drop from text, with percent, was-price and since-added", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            price: "$18.00",
            extraInfo: `<div class="a-row"><span class="a-color-price a-text-bold">Price dropped 25% (was $24.00) since added</span></div>`,
          }),
        }),
      ),
    );
    expect(r.data.items[0]?.price_drop).toEqual({
      raw: "Price dropped 25% (was $24.00) since added",
      percent: 25,
      was: { amount: 24, currency: "USD", raw: "$24.00" },
      since_added: true,
    });
    expect(r.data.items[0]?.extra_text).toBeUndefined();
    expect(r.meta.strategies["item.price_drop"]).toBe("text-anchor");
  });

  it("parses a price drop given as an amount and one inside a dedicated element", () => {
    const amount = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            extraInfo: `<div class="a-row">Price dropped by $3.50 since added</div>`,
          }),
        }),
      ),
    );
    expect(amount.data.items[0]?.price_drop).toMatchObject({
      amount: { amount: 3.5, currency: "USD", raw: "$3.50" },
      since_added: true,
    });
    const element = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            extraInfo: `<div id="itemPriceDrop_${ITEM_ID_1}">Price dropped 10%</div>`,
          }),
        }),
      ),
    );
    expect(element.data.items[0]?.price_drop).toMatchObject({ percent: 10, since_added: false });
    expect(element.meta.strategies["item.price_drop"]).toBe("price-drop-element");
  });

  it("handles an unavailable item: no price, finite-only price hint, stock text, buying options", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            price: null,
            primary: "See all buying options",
            extraInfo: `<div class="a-row"><span class="a-color-price">Currently unavailable.</span></div>`,
          }),
        }),
      ),
    );
    const [it] = r.data.items;
    expect(it?.price).toBeUndefined();
    expect(it?.price_hint).toBeUndefined();
    expect(it?.availability).toBe("Currently unavailable.");
    expect(it?.primary_action).toBe("See all buying options");
    expect(it?.can_add_to_cart).toBe(false);
    expect(it?.extra_text).toBeUndefined();
  });

  it("keeps a finite data-price as a hint when no price is visible", () => {
    const r = parseList(
      capture(listPage({ items: item({ id: ITEM_ID_1, price: null, dataPrice: "279.97" }) })),
    );
    expect(r.data.items[0]?.price).toBeUndefined();
    expect(r.data.items[0]?.price_hint).toBe(279.97);
  });

  it("parses offer hints, unit price and shipping fees", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            badge: "+ $4.99 shipping",
            extraInfo: `<div class="a-row">3 used &amp; new offers from $9.99</div><div class="a-row">($1.25/ounce)</div><div class="a-row">Only 2 left in stock - order soon.</div>`,
          }),
        }),
      ),
    );
    const [it] = r.data.items;
    expect(it?.offers).toEqual({
      raw: "3 used & new offers from $9.99",
      count: 3,
      from: { amount: 9.99, currency: "USD", raw: "$9.99" },
    });
    expect(it?.unit_price).toBe("($1.25/ounce)");
    expect(it?.availability).toBe("Only 2 left in stock - order soon.");
    expect(it?.shipping_fee).toEqual({ amount: 4.99, currency: "USD", raw: "$4.99" });
    expect(it?.delivery_text).toBe("+ $4.99 shipping");
    expect(it?.extra_text).toBeUndefined();
  });

  it("keeps unrecognised item text instead of dropping it", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({
            id: ITEM_ID_1,
            extraInfo: `<div class="a-row">Invented seller promo wording</div>`,
          }),
        }),
      ),
    );
    expect(r.data.items[0]?.extra_text).toEqual(["Invented seller promo wording"]);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("falls back for ids: container id, name link, asin from the url and external id", () => {
    const bare = item({ id: ITEM_ID_1, asin: "B0FAKE0001" })
      .replace(`data-itemid="${ITEM_ID_1}"`, "")
      .replace(/data-csa-c-item-id="[^"]*"/, "")
      .replace(/data-reposition-action-params="[^"]*"/, "");
    const r = parseList(capture(listPage({ items: bare })));
    expect(r.data.items[0]).toMatchObject({ item_id: ITEM_ID_1, asin: "B0FAKE0001" });
    expect(r.meta.strategies["item.asin"]).toBe("prime-info");
    const noInfo = bare.replace(/data-item-prime-info="[^"]*"/, "");
    const r2 = parseList(capture(listPage({ items: noInfo })));
    expect(r2.data.items[0]?.asin).toBe("B0FAKE0001");
    expect(r2.meta.strategies["item.asin"]).toBe("href");
  });

  it("supports an item without an asin (free-text entry)", () => {
    const r = parseList(
      capture(listPage({ items: item({ id: ITEM_ID_1, asin: null, price: null }) })),
    );
    expect(r.data.items[0]?.item_id).toBe(ITEM_ID_1);
    expect(r.data.items[0]?.asin).toBeUndefined();
  });

  it("skips hidden items and duplicates", () => {
    const hidden = item({ id: ITEM_ID_2, asin: "B0FAKE0002" }).replace("<li ", `<li ${H} `);
    const r = parseList(
      capture(
        listPage({
          items: item({ id: ITEM_ID_1 }) + hidden + item({ id: ITEM_ID_1 }),
        }),
      ),
    );
    expect(r.data.items.map((i) => i.item_id)).toEqual([ITEM_ID_1]);
  });

  it("parses a price range into low and high", () => {
    const html = item({ id: ITEM_ID_1 }).replace(
      /<span id="itemPrice_ITEMFAKE0001"[\s\S]*?<\/span><\/span><\/span><\/span>/,
      `<span id="itemPrice_${ITEM_ID_1}">${priceHtml("$10.00")}<span> - </span>${priceHtml("$20.00")}</span>`,
    );
    const r = parseList(capture(listPage({ items: html })));
    expect(r.data.items[0]?.price?.amount).toBe(10);
    expect(r.data.items[0]?.price_high?.amount).toBe(20);
  });
});

describe("parseList pagination", () => {
  it("reports the end of the list", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({ id: ITEM_ID_1 }),
          scroll: {
            token: "",
            url: "/hz/wishlist/slv/items?paginationToken=&lid=" + LIST_A,
            rendered: 1,
          },
        }),
      ),
    );
    expect(r.data.pagination).toMatchObject({
      has_more: false,
      end_of_list: true,
      items_rendered: 1,
    });
    expect(r.data.pagination.next_token).toBeUndefined();
    expect(r.data.pagination.more_url_template).toContain("paginationToken=");
    expect(r.data.is_empty).toBe(false);
    expect(r.meta.strategies["pagination.has_more"]).toBe("end-marker");
  });

  it("infers more items from a non-empty last-evaluated key", () => {
    const r = parseList(
      capture(
        listPage({
          items: item({ id: ITEM_ID_1 }),
          endMarker: false,
          scroll: {
            token: "opaque-token-1",
            url: "/hz/wishlist/slv/items?paginationToken=&lid=" + LIST_A,
            rendered: 1,
          },
        }),
      ),
    );
    expect(r.data.pagination).toMatchObject({
      has_more: true,
      end_of_list: false,
      next_token: "opaque-token-1",
    });
    expect(r.meta.strategies["pagination.has_more"]).toBe("last-evaluated-key");
    expect(r.meta.strategies["pagination.next_token"]).toBe("form-input");
  });

  it("falls back to the scrollState blob", () => {
    const blob = `<script type="a-state" data-a-state="{&quot;key&quot;:&quot;scrollState&quot;}">{"lastEvaluatedKey":"tok2","showMoreUrl":"/hz/wishlist/slv/items?paginationToken=&lid=${LIST_A}","moreItemsBaseUrl":"","itemsRenderedSoFar":4}</script>`;
    const r = parseList(
      capture(listPage({ items: item({ id: ITEM_ID_1 }) + blob, scroll: null, endMarker: false })),
    );
    expect(r.data.pagination).toMatchObject({
      has_more: true,
      next_token: "tok2",
      items_rendered: 4,
    });
    expect(r.meta.strategies["pagination.next_token"]).toBe("scroll-state");
  });

  it("appends items from a fetched fragment and takes its pagination", () => {
    const base = capture(
      listPage({
        items: item({ id: ITEM_ID_1 }),
        endMarker: false,
        scroll: {
          token: "tok-a",
          url: "/hz/wishlist/slv/items?paginationToken=&lid=" + LIST_A,
          rendered: 1,
        },
      }),
    );
    const fragment = `<li class="a-spacing-none"><span class="a-list-item">${item({ id: ITEM_ID_2, asin: "B0FAKE0002" }, 2)}</span></li>${""}
      <li><form class="scroll-state"><input type="hidden" name="lastEvaluatedKey" value="" ${H}><input type="hidden" name="itemsRenderedSoFar" value="2" ${H}></form></li>
      <li><div id="endOfListMarker">End of list</div></li>`;
    const r = parseList({ ...base, fragments: { more: fragment } });
    expect(r.data.items.map((i) => [i.item_id, i.source, i.position])).toEqual([
      [ITEM_ID_1, "page", 1],
      [ITEM_ID_2, "more", 2],
    ]);
    expect(r.data.pagination).toMatchObject({
      has_more: false,
      end_of_list: true,
      items_rendered: 2,
    });
  });

  it("returns an empty list without error", () => {
    const cap = capture(
      listPage({ items: "", viewCount: 0, scroll: { token: "", url: "", rendered: 0 } }),
    );
    const r = parseList(cap);
    expect(r.data.items).toEqual([]);
    expect(r.data.is_empty).toBe(true);
    expect(r.data.list.name).toBe("Invented Main List");
    expect(r.data.list.view_item_count).toBe(0);
    expect(r.meta.warnings).toEqual([]);
    expect(r.meta.unparsed_text_chars).toBe(0);
  });
});

describe("parseList lossless accounting", () => {
  it("accounts for every character of a fully modelled page", () => {
    const cap = capture(
      listPage({
        items: item({
          id: ITEM_ID_1,
          byline: "Fake Brand",
          stars: "4.5",
          added: "Item added May 5, 2026",
        }),
        scroll: { token: "", url: "/hz/wishlist/slv/items?paginationToken=", rendered: 1 },
      }),
    );
    const r = parseList(cap);
    expect(r.meta.unparsed_text_chars).toBe(0);
    expect(r.other_sections).toEqual([]);
    expectLosslessCoverage(r, cap, 0.99);
  });

  it("emits an unknown visible block as an other section", () => {
    const cap = capture(
      listPage({
        items: item({ id: ITEM_ID_1 }),
        intoPane: `<div id="invented-notice" class="a-section">Invented sharing notice text</div>`,
      }),
    );
    const r = parseList(cap);
    const notice = r.other_sections.find((s) => s.key === "invented-notice");
    expect(notice?.text).toBe("Invented sharing notice text");
    expect(r.meta.unparsed_text_chars).toBe(0);
  });

  it("does not report json blobs it understands as unknown", () => {
    const r = parseList(capture(listPage({ items: item({ id: ITEM_ID_1 }) })));
    expect(r.meta.unknown_blobs).toBeUndefined();
    const extra = capture(
      listPage({ items: item({ id: ITEM_ID_1 }) }).replace(
        "</ul>\n        </div></div></div>",
        `</ul><script type="a-state" data-a-state="{&quot;key&quot;:&quot;inventedState&quot;}">{"a":1}</script></div></div></div>`,
      ),
    );
    expect(parseList(extra).meta.unknown_blobs).toEqual(["inventedState"]);
  });
});
