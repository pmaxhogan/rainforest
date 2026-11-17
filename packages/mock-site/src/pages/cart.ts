import { product } from "../catalog.ts";
import { cartSubtotal, linePrice, type CartLine, type Session } from "../state.ts";
import { esc, money, priceHtml } from "../util.ts";
import { CHECKOUT_REDIRECT_LINK, HIDDEN, layout } from "./layout.ts";
import { findOffer } from "../catalog.ts";

/** `/gp/cart/view.html`: active lines, Saved for later, subtotal and the checkout trap. */

const CART_ACTION = "/cart/ref=ox_sc_cart_actions_1";

function sellerLines(line: CartLine): string {
  const found = findOffer(line.olid);
  if (!found) return "";
  const { offer } = found;
  return `<li data-csa-c-content-id="seller" role="presentation"><span class="a-list-item"><span class="a-size-small a-color-secondary sc-seller">Sold by: ${esc(offer.seller)}</span></span></li>`;
}

/**
 * The real site's quantity stepper: the container carries the item id and the applied
 * quantity (`data-old-value`); each click on a button applies one unit (the page script
 * posts the change, then the content is re-rendered, which updates `data-old-value` and the
 * labels). A hidden number input holds the value, as on the real page.
 */
function quantityStepper(line: CartLine): string {
  const p = product(line.asin);
  const title = esc(p?.title ?? line.asin);
  const id = esc(line.itemId);
  const n = line.quantity;
  return `<span class="a-declarative sc-action-quantity" data-itemid="${id}" data-old-value="${n}"><input name="quantityBox" type="number" value="${n}" min="0" ${HIDDEN}><span class="a-button a-button-small"><span class="a-button-inner"><button type="button" data-action="a-stepper-decrement" data-a-selector="decrement" aria-label="Decrease quantity by one, Quantity is ${n}, ${title}">-</button></span></span><span class="a-button-text" data-a-selector="value">${n}</span><span class="a-button a-button-small"><span class="a-button-inner"><button type="button" data-action="a-stepper-increment" data-a-selector="increment" aria-label="Increase quantity by one, Quantity is ${n}, ${title}">+</button></span></span></span>`;
}

function lineHtml(session: Session, line: CartLine, list: "active" | "saved"): string {
  const p = product(line.asin);
  const title = p?.title ?? line.asin;
  const id = line.itemId;
  const cents = linePrice(session, line);
  const prefix = list === "saved" ? "sc-saved" : "sc-item";
  const controls =
    list === "active"
      ? `${quantityStepper(line)}<span data-action="delete" class="sc-action-delete"><span class="a-declarative" data-action="sc-item-action" data-sc-item-action='{"action":"delete","itemID":"${esc(id)}","itemType":"active"}'><input name="submit.delete-active.${esc(id)}" value="Delete" data-action="delete" type="submit"></span></span>` +
        `<span data-action="save-for-later" class="sc-action-save-for-later"><input name="submit.save-for-later.${esc(id)}" value="Save for later" data-action="save-for-later" type="submit"></span>`
      : `<span data-action="delete-saved"><input name="submit.delete-saved.${esc(id)}" data-action="delete-saved" value="Delete" type="submit"></span>` +
        `<div data-action="move-to-cart"><input name="submit.move-to-cart.${esc(id)}" data-action="move-to-cart" value="Move to cart" type="submit"></div>` +
        // A repeated copy inside a hidden layout, like the real page: only the visible one counts.
        `<div class="sc-hidden" style="display:none"><div data-action="move-to-cart"><input name="submit.move-to-cart.${esc(id)}" data-action="move-to-cart" value="Move to cart" type="submit"></div></div>`;
  const tail = [
    `<li role="presentation"><span class="a-list-item"><span data-csa-c-content-id="availability" class="a-size-small a-color-success sc-product-availability">In Stock</span></span></li>`,
    sellerLines(line),
    line.subscribe
      ? `<li class="sc-subscribe-and-save"><span class="a-list-item">Subscribe &amp; Save: Delivery every 1 month</span></li>`
      : "",
    line.notice
      ? `<li><span class="a-list-item"><div class="a-box a-alert-inline a-alert-inline-info" role="alert"><div class="a-box-inner a-alert-container"><div class="a-alert-content">${esc(line.notice)}</div></div></div></span></li>`
      : "",
  ].join("");
  return `<div id="${prefix}-${esc(id)}" class="a-row sc-list-item sc-list-item-border" role="listitem" data-asin="${esc(line.asin)}" data-itemid="${esc(id)}" data-itemtype="${list}" data-quantity="${line.quantity}" data-price="${(cents / 100).toFixed(2)}" data-outofstock="0" data-csa-c-item-id="amzn1.asin.${esc(line.asin)}">
<div class="sc-list-item-content"><div class="a-spacing-mini sc-item-content-group sc-image-wrap"><a class="a-link-normal sc-product-link" href="/gp/product/${esc(line.asin)}/ref=ox_sc_title_1?psc=1" tabindex="-1"><img alt="" class="sc-product-image" src="https://images.example.com/placeholder.png"></a></div>
<div class="sc-item-content-group"><ul data-feature-id="sc-item-content-list" class="a-unordered-list">
<li class="sc-item-product-title-cont"><span class="a-list-item"><a class="a-link-normal sc-product-link sc-product-title" href="/gp/product/${esc(line.asin)}/ref=ox_sc_title_1?psc=1"><span class="a-size-base-plus"><h3 class="a-text-normal"><span class="a-truncate sc-grid-item-product-title"><span class="a-truncate-full a-offscreen">${esc(title)}</span><span class="a-truncate-cut" aria-hidden="true">${esc(title)}</span></span></h3></span></a></span></li>
<div class="sc-item-price-block"><span data-feature-id="sc-item-price">${priceHtml(cents, "apex-price-to-pay-value")}</span></div>
<div class="sc-grid-content-tail responsive-grid">${tail}</div>
</ul><div class="a-row sc-action-links">${controls}</div></div></div></div>`;
}

export function renderCart(session: Session): string {
  const { cents, count } = cartSubtotal(session);
  const active = session.active.map((l) => lineHtml(session, l, "active")).join("");
  const saved = session.saved.map((l) => lineHtml(session, l, "saved")).join("");
  const label = `Subtotal (${count} item${count === 1 ? "" : "s"}):`;
  const activeBlock =
    session.active.length > 0
      ? `<div id="sc-active-cart" data-cart-total-item-count="${count}" data-name="Active Cart"><div class="a-cardui-body">
<div class="a-row sc-cart-header"><h2 id="sc-active-items-header">Shopping Cart</h2></div>
<form id="activeCartViewForm" method="post" action="${CART_ACTION}" data-mock-ajax><div class="sc-list-body" role="list">${active}</div></form>
<div class="sc-subtotal"><span id="sc-subtotal-label-activecart">${label}</span> <span id="sc-subtotal-amount-activecart" class="a-size-medium sc-price"><span class="a-size-medium sc-price">${money(cents)}</span></span></div>
</div></div>`
      : `<div id="sc-active-cart" data-cart-total-item-count="0" data-name="Active Cart"><div class="a-cardui-body"><h3 class="sc-your-amazon-cart-is-empty">Your Amazon Cart is empty</h3><div class="sc-empty-cart" data-name="Empty Cart"></div></div></div>`;
  const savedBlock = `<div id="sc-secondary-list"><div class="a-cardui-body">
<ul id="sc-secondary-list-tab"><li id="sc-saved-cart-caption"><a role="tab"><div id="sc-saved-cart-list-caption-text" data-saved-item-quantity="${session.saved.length}">Saved for later</div></a></li></ul>
<div id="sc-saved-cart" data-listtype="saved-for-later"><form id="savedCartViewForm" method="post" action="${CART_ACTION}" data-mock-ajax><div id="sc-saved-cart-items" class="sc-list-body">${saved}</div></form></div>
</div></div>`;
  // The checkout control. Pressing it is a plain form POST: the rails must refuse it.
  const buyBox =
    session.active.length > 0
      ? `<div id="sc-buy-box"><div class="a-cardui-body"><form id="gutterCartViewForm" method="post" action="/gp/cart/view.html/ref=ox_sc_proceed"><input type="hidden" name="mock-gutter" value="1" ${HIDDEN}><span id="sc-buy-box-ptc-button" class="a-button a-button-primary"><span class="a-button-inner"><input name="proceedToRetailCheckout" class="a-button-input" type="submit" value="Proceed to checkout" aria-labelledby="sc-buy-box-ptc-button-announce"><span id="sc-buy-box-ptc-button-announce" class="a-button-text">Proceed to checkout</span></span></span></form></div></div>`
      : "";
  return layout({
    title: "Shopping Cart",
    navExtra: ` ${CHECKOUT_REDIRECT_LINK}`,
    body: `<div id="sc-page-content" role="main"><div id="sc-retail-cart-container"><div id="sc-cart-column">${activeBlock}${savedBlock}</div></div>${buyBox}</div>`,
  });
}
