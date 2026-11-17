import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { product } from "./catalog.ts";
import { renderAod } from "./pages/aod.ts";
import { renderCart } from "./pages/cart.ts";
import { renderHome } from "./pages/home.ts";
import { SERVICE_WORKER_JS, SERVICE_WORKER_PATH } from "./pages/layout.ts";
import {
  renderCreateListPopover,
  renderEditItemPopover,
  renderListPage,
  renderMoveItemPopover,
  renderSettingsPopover,
} from "./pages/lists.ts";
import { renderInvoice, renderOrderDetails, renderOrderList } from "./pages/orders.ts";
import { renderPlanUpsell, renderProduct } from "./pages/product.ts";
import { renderSearch } from "./pages/search.ts";
import {
  renderCaptcha,
  renderCheckout,
  renderCheckpoint,
  renderNotFound,
  renderSignIn,
  renderThrottled,
} from "./pages/traps.ts";
import {
  addToCart,
  addToList,
  cartAction,
  clipCoupon,
  createList,
  moveListItem,
  removeFromList,
  sessionView,
  setQuantity,
  Store,
  updateList,
  updateListItem,
  type CartAction,
  type MutationResult,
  type Session,
  type TrapName,
} from "./state.ts";

export interface MockSiteOptions {
  /** 0 picks a free port. Always bound to 127.0.0.1. */
  port?: number;
  seed?: number;
  /** Serve HTTPS with this key pair (the E2E browser maps the storefront host here). */
  tls?: { key: string; cert: string };
  /** Clock for page content (delivery dates). Defaults to the real clock. */
  now?: () => Date;
}

export interface MockSite {
  readonly port: number;
  readonly origin: string;
  readonly store: Store;
  close(): Promise<void>;
}

export const SESSION_COOKIE = "session-id";

/** Flags any page accepts to force an account-friction or trap response. */
export const MOCK_FLAGS = [
  "captcha",
  "captcha-redirect",
  "checkpoint",
  "checkpoint-inline",
  "signin",
  "redirect-checkout",
  "throttle",
  "notfound",
] as const;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  session: Session;
  store: Store;
  now: () => Date;
  form: URLSearchParams;
  wantsJson: boolean;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/html; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function redirect(res: ServerResponse, location: string, status = 302): void {
  res.statusCode = status;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), "application/json");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

/** Answer a mutation: JSON for the page script, else a redirect back to `back`. */
function mutated(ctx: Ctx, result: MutationResult, back: string): void {
  if (ctx.wantsJson) {
    const body: Record<string, unknown> = { ok: result.ok, message: result.message };
    if (result.upsell) body.upsell_html = renderPlanUpsell(result.upsell);
    json(ctx.res, result.ok ? 200 : 400, body);
  } else redirect(ctx.res, back, 303);
}

function trap(ctx: Ctx, name: TrapName): void {
  ctx.store.trap(name, ctx.method, ctx.path, ctx.now().getTime());
}

const PRODUCT_PATH = /^\/(?:[^/]+\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/;
const LIST_PATH = /^\/hz\/wishlist\/ls(?:\/([A-Z0-9]{8,16}))?(?:\/|$)/;
const SETTINGS_PATH = /^\/hz\/wishlist\/settings\/([A-Z0-9]{8,16})\/?$/;

/** The account-friction and trap responses any page can be forced into. */
function mockFlag(ctx: Ctx): boolean {
  const flag = ctx.url.searchParams.get("mock");
  if (!flag) return false;
  const back = encodeURIComponent(ctx.path);
  switch (flag) {
    case "captcha":
      // The real site serves the captcha in place of the page that was asked for.
      send(ctx.res, 200, renderCaptcha());
      return true;
    case "captcha-redirect":
      redirect(ctx.res, `/errors/validateCaptcha?amzn-r=${back}`);
      return true;
    case "checkpoint":
      redirect(ctx.res, `/checkpoint/continue?return_to=${back}`);
      return true;
    case "checkpoint-inline":
      send(ctx.res, 200, renderCheckpoint());
      return true;
    case "signin":
      redirect(ctx.res, `/ap/signin?openid.return_to=${back}`);
      return true;
    case "redirect-checkout":
      redirect(ctx.res, "/gp/buy/spc/handlers/display.html?hasWorkingJavascript=1");
      return true;
    case "throttle":
      send(ctx.res, 503, renderThrottled());
      return true;
    case "notfound":
      send(ctx.res, 404, renderNotFound());
      return true;
    default:
      return false;
  }
}

async function route(ctx: Ctx): Promise<void> {
  const { path, method, url, session, res } = ctx;

  // ---- traps: recorded on every hit, whatever the method
  if (/^\/gp\/buy(\/|$)/i.test(path) || /^\/checkout(\/|$)/i.test(path)) {
    trap(ctx, "checkout");
    return send(res, 200, renderCheckout());
  }
  if (/^\/ap(\/|$)/i.test(path)) {
    trap(ctx, "sign_in");
    return send(res, 200, renderSignIn());
  }
  if (/^\/checkpoint(\/|$)/i.test(path)) {
    trap(ctx, "checkpoint");
    return send(res, 200, renderCheckpoint());
  }
  if (/^\/errors\/validatecaptcha/i.test(path)) {
    trap(ctx, "captcha");
    return send(res, 200, renderCaptcha());
  }

  if (method === "GET" || method === "HEAD") {
    if (path === SERVICE_WORKER_PATH) {
      res.setHeader("service-worker-allowed", "/");
      return send(res, 200, SERVICE_WORKER_JS, "text/javascript; charset=utf-8");
    }
    if (mockFlag(ctx)) return;
    if (path === "/" || /^\/ref=/.test(path)) return send(res, 200, renderHome());
    if (/^\/s(\/|$)/.test(path)) return send(res, 200, renderSearch(url));
    const productMatch = PRODUCT_PATH.exec(path);
    if (productMatch) {
      const p = product(productMatch[1]!);
      if (!p || p.scenario === "plan") return send(res, 404, renderNotFound());
      return send(
        res,
        200,
        renderProduct(p, session, ctx.now(), url.searchParams.get("aod") === "1"),
      );
    }
    if (/^\/gp\/product\/ajax\/aodAjaxMain(\/|$)/.test(path)) {
      const p = product(url.searchParams.get("asin") ?? "");
      if (!p) return send(res, 404, "");
      return send(res, 200, renderAod(p, ctx.now()));
    }
    if (/^\/gp\/aod\/ajax(\/|$)/.test(path)) return send(res, 404, renderNotFound());
    if (/^\/(gp\/cart\/view\.html|cart)(\/|$)/.test(path))
      return send(res, 200, renderCart(session));
    if (/^\/hz\/wishlist\/intro/.test(path)) return redirect(res, "/hz/wishlist/ls");
    const listMatch = LIST_PATH.exec(path);
    if (listMatch) {
      const id = listMatch[1];
      if (id && !session.lists.some((l) => l.id === id)) return send(res, 404, renderNotFound());
      return send(res, 200, renderListPage(session, id ?? null));
    }
    if (/^\/hz\/wishlist\/create/.test(path)) return send(res, 200, renderCreateListPopover());
    const settingsMatch = SETTINGS_PATH.exec(path);
    if (settingsMatch) return send(res, 200, renderSettingsPopover(session, settingsMatch[1]!));
    if (/^\/hz\/wishlist\/cqp(\/|$)/.test(path))
      return send(res, 200, renderEditItemPopover(session, url.searchParams));
    if (/^\/hz\/wishlist\/movetolist(\/|$)/.test(path))
      return send(res, 200, renderMoveItemPopover(session, url.searchParams));
    if (/^\/your-orders\/orders(\/|$)/.test(path)) return send(res, 200, renderOrderList(url));
    if (/^\/(gp\/your-account|your-orders)\/order-details(\/|$)/.test(path))
      return send(res, 200, renderOrderDetails(url.searchParams.get("orderID")));
    if (/^\/gp\/css\/summary\/print\.html(\/|$)/.test(path))
      return send(res, 200, renderInvoice(url.searchParams.get("orderID")));
    return send(res, 404, renderNotFound());
  }

  if (method !== "POST") return send(res, 405, "");
  const form = ctx.form;

  // ---- purchase controls that reach the server are recorded as trap hits
  if (form.has("submit.buy-now") || /buy-?now/i.test(path)) {
    trap(ctx, "buy_now");
    return redirect(res, "/gp/buy/spc/handlers/display.html", 303);
  }
  if (form.has("proceedToRetailCheckout") || form.has("proceedToCheckout")) {
    trap(ctx, "proceed_to_checkout");
    return redirect(res, "/gp/buy/spc/handlers/display.html", 303);
  }

  // ---- cart writes
  if (/^\/gp\/product\/handle-buy-box(\/|$)/.test(path)) {
    if (!form.has("submit.add-to-cart"))
      return mutated(ctx, { ok: false, message: "Nothing to do." }, "/gp/cart/view.html");
    const olid = form.get("offerListingID") ?? form.get("items[0.base][offerListingId]") ?? "";
    // The Subscribe & Save row's form carries this field: submitting the DEFAULT-selected
    // row subscribes, which is exactly the footgun the add flow must avoid.
    const subscribe = form.has("snsOfferListingId");
    return mutated(
      ctx,
      addToCart(session, olid, Number(form.get("quantity") ?? 1), { subscribe }),
      "/gp/cart/view.html",
    );
  }
  if (/^\/cart\/add-to-cart(\/|$)/.test(path)) {
    const olid = form.get("items[0.base][offerListingId]") ?? form.get("offerListingID") ?? "";
    const qty = Number(form.get("items[0.base][quantity]") || form.get("quantity") || 1);
    return mutated(ctx, addToCart(session, olid, qty), "/gp/cart/view.html");
  }
  if (/^\/(gp\/)?cart(\/|$)/.test(path)) {
    if (form.get("action") === "update-quantity") {
      return mutated(
        ctx,
        setQuantity(session, form.get("itemID") ?? "", Number(form.get("quantity"))),
        "/gp/cart/view.html",
      );
    }
    for (const key of form.keys()) {
      const m = /^submit\.(delete|save-for-later|move-to-cart|delete-saved)\.(.+)$/.exec(key);
      if (m)
        return mutated(ctx, cartAction(session, m[1] as CartAction, m[2]!), "/gp/cart/view.html");
    }
    return mutated(ctx, { ok: false, message: "Unknown cart action." }, "/gp/cart/view.html");
  }
  if (/^\/gp\/coupon\/clip(\/|$)/.test(path))
    return mutated(
      ctx,
      clipCoupon(session, form.get("asin") ?? ""),
      `/dp/${form.get("asin") ?? ""}`,
    );

  // ---- list writes
  const listBack = (id: string | null): string =>
    id ? `/hz/wishlist/ls/${id}` : "/hz/wishlist/ls";
  if (/^\/hz\/wishlist\/create(\/|$)/.test(path))
    return mutated(
      ctx,
      createList(session, form.get("listName"), form.get("privacy")),
      listBack(null),
    );
  const settingsMatch = SETTINGS_PATH.exec(path);
  if (settingsMatch) {
    const id = settingsMatch[1]!;
    if (form.has("submit.deleteList"))
      return mutated(ctx, updateList(session, id, { delete: true }), listBack(null));
    return mutated(
      ctx,
      updateList(session, id, {
        name: form.get("listName") ?? undefined,
        privacy: form.get("privacy") ?? undefined,
      }),
      listBack(id),
    );
  }
  const listId = form.get("listId") ?? "";
  if (/^\/hz\/wishlist\/additem(\/|$)/.test(path))
    return mutated(ctx, addToList(session, listId, form.get("asin") ?? ""), listBack(listId));
  if (/^\/hz\/wishlist\/removeitem(\/|$)/.test(path))
    return mutated(
      ctx,
      removeFromList(session, listId, form.get("itemId") ?? ""),
      listBack(listId),
    );
  if (/^\/hz\/wishlist\/cqp(\/|$)/.test(path)) {
    return mutated(
      ctx,
      updateListItem(session, listId, form.get("itemId") ?? "", {
        comment: form.get("comment") ?? undefined,
        requested: form.get("requestedQty") || undefined,
        priority: form.get("priority") || undefined,
      }),
      listBack(listId),
    );
  }
  if (/^\/hz\/wishlist\/movetolist(\/|$)/.test(path)) {
    return mutated(
      ctx,
      moveListItem(
        session,
        listId,
        form.get("itemId") ?? "",
        form.get("toListId") ?? "",
        form.get("copy") === "1",
      ),
      listBack(listId),
    );
  }
  return send(res, 404, "");
}

/** Test-only control endpoints. Never reachable as a storefront page. */
function control(
  store: Store,
  ctx: { method: string; path: string; url: URL; res: ServerResponse },
): boolean {
  if (ctx.path === "/__mock/state" && ctx.method === "GET") {
    const id = ctx.url.searchParams.get("session") ?? store.lastSessionId;
    const s = id ? store.sessions.get(id) : undefined;
    json(ctx.res, 200, {
      seed: store.seed,
      session: s ? sessionView(s) : null,
      sessions: [...store.sessions.keys()],
      traps: store.traps,
      trap_counts: {
        checkout: store.trapCount("checkout"),
        proceed_to_checkout: store.trapCount("proceed_to_checkout"),
        buy_now: store.trapCount("buy_now"),
        sign_in: store.trapCount("sign_in"),
        checkpoint: store.trapCount("checkpoint"),
        captcha: store.trapCount("captcha"),
      },
      hits: store.hits,
    });
    return true;
  }
  if (ctx.path === "/__mock/reset" && ctx.method === "POST") {
    store.reset();
    json(ctx.res, 200, { ok: true });
    return true;
  }
  return false;
}

/** Handle one request against a store. Exported for in-process tests. */
export function createHandler(store: Store, now: () => Date = () => new Date()) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "https://www.amazon.com");
      const method = (req.method ?? "GET").toUpperCase();
      const path = url.pathname;
      if (control(store, { method, path, url, res })) return;
      let id = cookies(req)[SESSION_COOKIE];
      if (!id || !/^[A-Za-z0-9-]{1,40}$/.test(id)) {
        id = store.newSessionId();
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
      }
      store.record(method, path, url.search, id, now().getTime());
      const session = store.session(id);
      const body = method === "POST" ? await readBody(req) : "";
      const accept = String(req.headers.accept ?? "");
      await route({
        req,
        res,
        url,
        path,
        method,
        session,
        store,
        now,
        form: new URLSearchParams(body),
        wantsJson: accept.includes("application/json"),
      });
    } catch {
      if (!res.headersSent) send(res, 500, "");
      else res.end();
    }
  };
}

export async function createMockSite(options: MockSiteOptions = {}): Promise<MockSite> {
  const store = new Store(options.seed ?? 1);
  const handler = createHandler(store, options.now);
  const server = options.tls
    ? createHttpsServer(
        { key: options.tls.key, cert: options.tls.cert },
        (q, r) => void handler(q, r),
      )
    : createHttpServer((q, r) => void handler(q, r));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
