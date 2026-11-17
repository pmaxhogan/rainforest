import { searchable } from "../catalog.ts";
import { esc } from "../util.ts";
import { CHECKOUT_REDIRECT_LINK, layout } from "./layout.ts";

/** `/`: a plain landing page that links into the catalog. */
export function renderHome(): string {
  const links = searchable()
    .map((p) => `<li><a href="/dp/${esc(p.asin)}">${esc(p.title)}</a></li>`)
    .join("");
  return layout({
    title: "Example storefront",
    navExtra: ` ${CHECKOUT_REDIRECT_LINK}`,
    body: `<div id="pageContent"><h1>Example storefront</h1><ul id="mock-catalog">${links}</ul></div>`,
  });
}
