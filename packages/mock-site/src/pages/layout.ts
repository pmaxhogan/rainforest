import { esc } from "../util.ts";

/**
 * Page chrome shared by every storefront page. Elements that the real site keeps hidden
 * are hidden twice: by CSS (so the browser's hidden-element pass marks them) and by
 * `data-rf-hidden="1"` (so the raw HTML parses the same way in unit tests).
 */

export const HIDDEN = 'class="aok-hidden" data-rf-hidden="1"';

const CSS = `
body{font-family:sans-serif;margin:0}
.aok-hidden,.a-hidden,.a-popover-preload,.aod-hide,.aod-visibility-hidden,.aod-oas-other-offers-hide{display:none!important}
#a-popover-root,#mock-modal-root{display:none}
header,footer{background:#eee;padding:4px}
`;

/**
 * The page script. Mutations never navigate the main frame (the rails only allow GET
 * documents): forms marked `data-mock-ajax` are sent with fetch and the page content is
 * then re-rendered from the server, the way the real site updates in place. A purchase
 * button is never intercepted, so pressing one is a plain form submission that the rails
 * must refuse.
 */
const CLIENT_JS = `(function () {
  function refresh() {
    return fetch(location.href, { credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) {
      var d = new DOMParser().parseFromString(t, "text/html");
      var fresh = d.getElementById("a-page");
      var page = document.getElementById("a-page");
      if (fresh && page) page.innerHTML = fresh.innerHTML;
    });
  }
  function post(url, body) {
    return fetch(url, { method: "POST", body: body, credentials: "include", headers: { accept: "application/json" } })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); });
  }
  function closePopover() {
    var root = document.getElementById("a-popover-root");
    root.innerHTML = "";
    root.style.display = "none";
  }
  function after(result) {
    window.__mockLastResult = result;
    closePopover();
    return refresh().then(function () {
      var modal = document.getElementById("mock-modal-root");
      if (result && result.upsell_html) {
        modal.innerHTML = result.upsell_html;
        modal.style.display = "block";
      } else {
        modal.innerHTML = "";
        modal.style.display = "none";
      }
    });
  }
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-mock-ajax")) return;
    var submitter = e.submitter;
    if (submitter && /buy-?now/i.test(submitter.getAttribute("name") || "")) return;
    e.preventDefault();
    var body = new URLSearchParams(submitter ? new FormData(form, submitter) : new FormData(form));
    post(form.getAttribute("action"), body).then(after);
  });
  document.addEventListener("change", function (e) {
    var s = e.target;
    if (!s.matches || !s.matches("select[data-mock-quantity]")) return;
    var body = new URLSearchParams({ action: "update-quantity", itemID: s.getAttribute("data-mock-quantity"), quantity: s.value });
    post("/cart/ref=ox_sc_update_quantity", body).then(after);
  });
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-mock-popover]");
    if (t) {
      e.preventDefault();
      fetch(t.getAttribute("data-mock-popover"), { credentials: "include" }).then(function (r) { return r.text(); }).then(function (h) {
        var root = document.getElementById("a-popover-root");
        root.innerHTML = h;
        root.style.display = "block";
      });
      return;
    }
    var close = e.target.closest && e.target.closest("[data-mock-close]");
    if (close) {
      e.preventDefault();
      closePopover();
      var modal = document.getElementById("mock-modal-root");
      modal.innerHTML = "";
      modal.style.display = "none";
    }
  });
})();`;

/** Path of the storefront's service worker (registered at scope "/" on every page). */
export const SERVICE_WORKER_PATH = "/mock-sw.js";

/**
 * Like the real storefront, a service worker at scope "/" that fetches top-level
 * navigations itself. It is a plain pass-through, but a request it makes is invisible to
 * page-level interception unless the guard bypasses service workers for the tab.
 */
export const SERVICE_WORKER_JS = `self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (event) {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request));
});
`;

const REGISTER_JS = `if ("serviceWorker" in navigator) navigator.serviceWorker.register("${SERVICE_WORKER_PATH}", { scope: "/" }).catch(function () {});`;

export interface LayoutOptions {
  title: string;
  query?: string;
  /** Extra chrome links (for example the trap link that redirects into checkout). */
  navExtra?: string;
  /** Inside #a-page; the content root the parsers look for. */
  body: string;
  /** After #a-page (scripts, state blobs). */
  tail?: string;
  canonical?: string;
}

export function layout(o: LayoutOptions): string {
  return `<!DOCTYPE html><html lang="en-us"><head><meta charset="utf-8"><title>${esc(o.title)}</title>${
    o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">` : ""
  }<style>${CSS}</style></head><body>
<header id="navbar-main"><div id="navbar"><a href="/">Example storefront</a>
<form id="nav-search-bar-form" method="get" action="/s"><select id="searchDropdownBox" name="url"><option value="search-alias=aps" selected>All Departments</option></select><input id="twotabsearchtextbox" name="k" value="${esc(o.query ?? "")}"></form>
<a id="nav-orders" href="/your-orders/orders">Orders</a> <a id="nav-cart" href="/gp/cart/view.html">Cart</a> <a id="nav-lists" href="/hz/wishlist/ls">Lists</a>${o.navExtra ?? ""}</div></header>
<div id="a-page">${o.body}</div>
<div id="navFooter" role="contentinfo">Example storefront footer</div>
<div id="a-popover-root"></div><div id="mock-modal-root"></div>
${o.tail ?? ""}<script>${CLIENT_JS}${REGISTER_JS}</script></body></html>`;
}

/** The trap link: an allowlisted URL that the server answers with a 302 into checkout. */
export const CHECKOUT_REDIRECT_LINK = `<a id="mock-deal-link" href="/s?k=deal&amp;mock=redirect-checkout">Deal of the day</a>`;
