import { product } from "../catalog.ts";
import { findList, PRIORITIES, type ListItem, type Session, type WishList } from "../state.ts";
import { esc, priceHtml } from "../util.ts";
import { HIDDEN, layout } from "./layout.ts";

/**
 * `/hz/wishlist/ls[/<ID>]`: the list navigation, the selected list and its items, with the
 * control wiring the real page uses (dispatch-modal edit, per-item delete form, move
 * popover, create-list trigger, the "Manage list" settings link). The popovers are
 * fragments the page script loads; their forms post back with fetch.
 */

const PRIVACY_TEXT = { private: "Private", shared: "Shared", public: "Public" } as const;
const H = 'data-rf-hidden="1"';

function navEntry(list: WishList, selected: boolean): string {
  return `<div class="wl-list${selected ? " selected" : ""}"><a id="wl-list-link-${list.id}" class="a-link-normal aok-block hover-as-link" href="/hz/wishlist/ls/${list.id}?ref_=wl_nav"><div class="wl-list-entry-block"><div class="wl-list-entry-title"><div class="wl-list-entry-row-wrapper"><span id="wl-list-entry-title-${list.id}" class="a-color-base">${esc(list.name)}</span></div><div class="wl-list-entry-row-wrapper">${
    list.isDefault
      ? `<span id="list-default-collaborator-label" class="a-size-small">Default List</span>`
      : ""
  }</div></div><div id="wl-list-entry-privacy-${list.id}" class="wl-list-entry-privacy"><span class="a-color-base">${PRIVACY_TEXT[list.privacy]}</span></div></div></a></div>`;
}

function itemHtml(list: WishList, item: ListItem, position: number): string {
  const p = product(item.asin);
  const title = p?.title ?? item.asin;
  const cents = p?.featured?.priceCents ?? null;
  const id = item.itemId;
  const href = `/dp/${item.asin}/?coliid=${id}&amp;colid=${list.id}&amp;psc=1&amp;ref_=lv_ov_lig_dp_it`;
  const cqp = `/hz/wishlist/cqp/ref=hz_lv_cqp_ajax?listId=${list.id}&amp;itemId=${id}&amp;asin=${item.asin}&amp;isAjax=1&amp;listType=WishList`;
  const move = `/hz/wishlist/movetolist/?listId=${list.id}&amp;itemId=${id}&amp;asin=${item.asin}&amp;listType=WishList`;
  const comment = item.comment
    ? `<div id="itemCommentRow_${id}" class="a-section"><span id="itemComment_${id}">${esc(item.comment)}</span></div>`
    : `<div id="itemCommentRow_${id}" class="a-section a-hidden" ${H}><span id="itemComment_${id}"></span></div>`;
  return `<li data-id="${list.id}" data-itemid="${id}" data-price="${cents === null ? "-Infinity" : (cents / 100).toFixed(2)}" data-reposition-action-params="{&quot;listType&quot;:&quot;WishList&quot;,&quot;itemExternalId&quot;:&quot;ASIN:${item.asin}|MKTFAKE0001&quot;}" class="a-spacing-base g-item-sortable"><span class="a-list-item">
<div id="item_${id}" class="a-section"><div class="a-fixed-left-grid awl-ul-item-container-desktop"><div class="a-fixed-left-grid-inner">
<div id="itemImage_${id}" class="a-fixed-left-grid-col awl-ul-item-image-desktop"><a class="a-link-normal" title="${esc(title)}" href="${href}"><img alt="${esc(title)}" src="https://images.example.com/placeholder.png" height="135" width="135"></a></div>
<div class="a-section awl-ul-item-info-desktop"><div id="itemMain_${id}" class="a-fixed-left-grid-col a-col-right">
<div id="itemInfo_${id}" class="a-section"><div class="a-row a-size-small"><h2 class="a-size-base"><a id="itemName_${id}" class="a-link-normal" title="${esc(title)}" href="${href}">${esc(title)}</a></h2><span id="item-byline-${id}" class="a-size-base">by ${esc(p?.brand ?? "Unknown")}</span></div>
<div data-csa-c-item-id="${item.asin}" data-csa-c-item-type="asin" data-csa-c-list-type="WishList" data-csa-c-posy="${position}" data-csa-c-type="item" class="a-row a-spacing-small a-size-small"><div class="a-row wl-price-ppu-delivery-badge-row"><div class="a-section price-section">${
    cents === null
      ? ""
      : `<span id="itemPrice_${id}" class="a-price-wrap">${priceHtml(cents)}</span>`
  }</div></div></div>
<div class="a-section awl-ul-keyword-item-subtitle">${comment}<div class="a-section aok-inline-block"><span id="itemQuantityRow_${id}"><span id="itemRequestedLabel_${id}">Needs</span> <span id="itemRequested_${id}">${item.requested}</span> &middot; <span id="itemPurchasedSection_${id}"><span id="itemPurchasedLabel_${id}">Has:</span> <span id="itemPurchased_${id}">${item.has}</span></span></span> <span class="g-priority-seperator">&middot;</span> <span id="itemPriorityRow_${id}">Priority: <span id="itemPriorityLabel_${id}">${item.priority}</span></span></div></div>
</div>
<div class="a-section dateAddedText"><span id="itemAddedDate_${id}" class="a-size-small">Item added ${esc(item.added)}</span></div>
<div id="itemAction_${id}" class="a-section awl-ul-item-button-desktop"><div class="a-button-stack">
<span class="a-declarative" data-action="reg-dispatch-modal" data-reg-dispatch-modal="{&quot;name&quot;:&quot;edit-notes&quot;,&quot;url&quot;:&quot;${cqp}&quot;}"><span class="a-button a-button-base" id="edit-note-button-${id}"><span class="a-button-inner"><a href="${cqp}" class="a-button-text" data-mock-popover="${cqp}"><div id="keywordEditLabel_${id}">${item.comment ? "Edit" : "Add a note"}</div></a></span></span></span>
<div class="g-visible-js"><span class="a-declarative" data-action="show-move-to-list-popover" data-show-move-to-list-popover="{&quot;url&quot;:&quot;${move}&quot;}"><span id="move-to-list-button-${id}" class="a-button a-button-dropdown" data-mock-popover="${move}"><span class="a-button-inner"><span id="move-to-list-button-${id}-announce" class="a-button-text">Move</span></span></span></span>
<form method="post" action="/hz/wishlist/removeitem/form" data-mock-ajax><input type="hidden" name="listId" value="${list.id}" ${H}><input type="hidden" name="itemId" value="${id}" ${H}><span class="a-declarative" data-action="reg-item-delete"><span id="delete-button-${id}" class="a-button a-button-base"><span class="a-button-inner"><input name="submit.deleteItem" class="a-button-input" type="submit" aria-label="Delete"><span class="a-button-text"><span class="aok-offscreen">Delete</span></span></span></span></span></form></div>
</div></div>
</div></div></div></div></div></span></li>`;
}

export function renderListPage(session: Session, listId: string | null): string {
  const selected = (listId ? findList(session, listId) : undefined) ?? session.lists[0] ?? null;
  const nav = session.lists.map((l) => navEntry(l, l === selected)).join("");
  const create = `<span class="a-declarative" data-action="show-create-list" data-show-create-list="{&quot;url&quot;:&quot;/hz/wishlist/create?isPopover=1&amp;createIngressName=wl_nav&quot;}"><a id="createList" class="a-link-normal createListTrigger" href="#" data-mock-popover="/hz/wishlist/create?isPopover=1&amp;createIngressName=wl_nav">Create a List</a></span>`;
  const tabs = `<ul class="a-tabs a-declarative"><li id="my-lists-tab" class="a-tab-heading a-active"><a href="/hz/wishlist/ls/ref=cm_wl_your_lists"><div role="heading" aria-level="1">Your Lists</div></a></li></ul>`;
  let pane = "";
  if (selected) {
    const items = selected.items.map((it, i) => itemHtml(selected, it, i + 1)).join("");
    const settings = `/hz/wishlist/settings/${selected.id}?type=WishList&amp;ajax=true`;
    pane = `<div id="content-right" class="a-fixed-left-grid-col a-col-right">
<div class="a-section list-header-container"><div id="list-header" class="a-section"><div id="wl-list-info" class="a-row"><span id="profile-list-name" aria-level="2" role="heading">${esc(selected.name)}</span> <span class="aok-nowrap"><span id="listPrivacy" class="a-color-secondary">${PRIVACY_TEXT[selected.privacy]}</span></span>
<span id="overflow-menu-popover-trigger" class="a-declarative" data-action="a-popover" data-mock-popover="${settings}"><a class="a-link-normal" href="#" aria-label="More"><img alt="" src="https://images.example.com/placeholder.png"></a></span></div></div></div>
<div class="a-popover-preload" id="a-popover-list-overflow-menu-popover" ${H}><a id="editYourList" class="a-link-normal editYourListTrigger" href="/hz/wishlist/settings/${selected.id}?type=WishList" data-mock-popover="${settings}">Manage list</a></div>
<div id="wl-item-view" class="a-section"><div id="item-page-wrapper" class="a-section"><div class="a-section"><ul id="g-items" class="a-unordered-list a-nostyle a-vertical g-items-section">
<li class="a-spacing-none"><span class="a-list-item"><input type="hidden" name="" value="${selected.items.length}" id="viewItemCount" ${H}></span></li>
${items}
<li class="a-spacing-none"><span class="a-list-item"><form method="get" class="scroll-state"><input type="hidden" name="showMoreUrl" value="/hz/wishlist/slv/items?filter=unpurchased&amp;paginationToken=&amp;itemsLayout=LIST&amp;sort=date-added&amp;type=wishlist&amp;lid=${selected.id}" ${H}><input type="hidden" name="lastEvaluatedKey" value="" ${H}><input type="hidden" name="itemsRenderedSoFar" value="${selected.items.length}" ${H}></form></span></li>
<li class="a-spacing-none"><span class="a-list-item"><div id="endOfListMarker" class="a-section"><div class="a-divider a-divider-break"><h5 aria-level="5">End of list</h5></div></div></span></li>
</ul></div></div></div></div>`;
  }
  return layout({
    title: selected ? `Example storefront: ${selected.name}` : "Example storefront: Your Lists",
    body: `<div id="wishlist-page" class="a-tab-container">${
      selected ? `<input type="hidden" name="" value="${selected.id}" id="listId" ${H}>` : ""
    }${tabs}<div class="a-section a-text-right">${create}</div>
<div id="my-lists-tab-panel" class="a-box"><div class="a-box-inner"><div class="a-fixed-left-grid"><div class="a-fixed-left-grid-inner">
<div id="left-nav" class="a-fixed-left-grid-col a-col-left"><div id="your-lists-nav" class="a-section">${nav}</div></div>${pane}
</div></div></div></div></div>`,
  });
}

// ---- popover fragments (loaded by the page script, posted back with fetch)

const privacyRadios = (current: string): string =>
  (["private", "shared", "public"] as const)
    .map(
      (p) =>
        `<label><input type="radio" name="privacy" value="${p}"${p === current ? " checked" : ""}> ${PRIVACY_TEXT[p]}</label>`,
    )
    .join(" ");

export function renderCreateListPopover(): string {
  return `<div id="create-list-popover" class="a-popover-wrapper"><form id="create-list-form" method="post" action="/hz/wishlist/create" data-mock-ajax><label for="list-name">List name</label><input id="list-name" type="text" name="listName" maxlength="100"><div id="create-list-privacy">${privacyRadios("private")}</div><span class="a-button a-button-primary"><span class="a-button-inner"><input class="a-button-input" type="submit" name="submit.createList" aria-labelledby="create-list-submit-announce"><span id="create-list-submit-announce" class="a-button-text">Create List</span></span></span><a href="#" data-mock-close>Close</a></form></div>`;
}

export function renderSettingsPopover(session: Session, listId: string): string {
  const list = findList(session, listId);
  if (!list) return `<div id="list-settings-popover">That list does not exist.</div>`;
  return `<div id="list-settings-popover" class="a-popover-wrapper"><form id="list-settings-form" method="post" action="/hz/wishlist/settings/${list.id}" data-mock-ajax><label for="list-settings-name">List name</label><input id="list-settings-name" type="text" name="listName" value="${esc(list.name)}" maxlength="100"><div id="list-settings-privacy">${privacyRadios(list.privacy)}</div><span class="a-button a-button-primary"><span class="a-button-inner"><input class="a-button-input" type="submit" name="submit.save" aria-labelledby="list-settings-save-announce"><span id="list-settings-save-announce" class="a-button-text">Save changes</span></span></span></form>
<form id="list-delete-form" method="post" action="/hz/wishlist/settings/${list.id}" data-mock-ajax><span class="a-button"><span class="a-button-inner"><input class="a-button-input" type="submit" name="submit.deleteList" aria-labelledby="list-delete-announce"><span id="list-delete-announce" class="a-button-text">Delete list</span></span></span></form><a href="#" data-mock-close>Close</a></div>`;
}

export function renderEditItemPopover(session: Session, params: URLSearchParams): string {
  const listId = params.get("listId") ?? "";
  const itemId = params.get("itemId") ?? "";
  const item = findList(session, listId)?.items.find((i) => i.itemId === itemId);
  if (!item) return `<div id="cqp-popover">That item is not on the list.</div>`;
  const priorities = PRIORITIES.map(
    (p) => `<option value="${p}"${p === item.priority ? " selected" : ""}>${p}</option>`,
  ).join("");
  return `<div id="cqp-popover" class="a-popover-wrapper"><form id="cqp-form" method="post" action="/hz/wishlist/cqp" data-mock-ajax><input type="hidden" name="listId" value="${esc(listId)}" ${HIDDEN}><input type="hidden" name="itemId" value="${esc(itemId)}" ${HIDDEN}><label for="cqp-comment">Comment</label><textarea id="cqp-comment" name="comment" maxlength="500">${esc(item.comment)}</textarea><label for="cqp-quantity">Needs</label><input id="cqp-quantity" type="number" name="requestedQty" min="1" max="999" value="${item.requested}"><label for="cqp-priority">Priority</label><select id="cqp-priority" name="priority">${priorities}</select><span class="a-button a-button-primary"><span class="a-button-inner"><input class="a-button-input" type="submit" name="submit.save" aria-labelledby="cqp-save-announce"><span id="cqp-save-announce" class="a-button-text">Save</span></span></span><a href="#" data-mock-close>Close</a></form></div>`;
}

export function renderMoveItemPopover(session: Session, params: URLSearchParams): string {
  const listId = params.get("listId") ?? "";
  const itemId = params.get("itemId") ?? "";
  const targets = session.lists
    .filter((l) => l.id !== listId)
    .map(
      (l) =>
        `<li><form method="post" action="/hz/wishlist/movetolist" data-mock-ajax><input type="hidden" name="listId" value="${esc(listId)}" ${HIDDEN}><input type="hidden" name="itemId" value="${esc(itemId)}" ${HIDDEN}><input type="hidden" name="toListId" value="${l.id}" ${HIDDEN}><span class="a-button"><span class="a-button-inner"><input id="move-to-${l.id}" class="a-button-input" type="submit" name="submit.moveToList" aria-label="Move to ${esc(l.name)}"><span class="a-button-text">${esc(l.name)}</span></span></span></form></li>`,
    )
    .join("");
  return `<div id="move-to-list-popover" class="a-popover-wrapper"><h4>Move to another list</h4><ul id="move-to-list-targets">${targets}</ul><a href="#" data-mock-close>Close</a></div>`;
}
