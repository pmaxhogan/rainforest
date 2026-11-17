/**
 * URL policy for automation tabs: the last line of defense. Pure and synchronous.
 *
 * Two independent layers:
 *  1. HARD DENY patterns apply to every request of every resource type on Amazon hosts
 *     (documents, XHR, fetch, form posts, subframes): checkout and buy flows, payment and
 *     wallet pages, addresses, account settings, sign-in, 1-click and digital buy
 *     endpoints, order cancel/edit, return initiation.
 *  2. Main-frame documents must additionally match a positive ALLOWLIST of the pages the
 *     typed flows need. Anything else is refused.
 *
 * Every predicate fails CLOSED: an unparseable URL, a missing field or an unknown host is
 * a denial.
 */

export interface RequestInfo {
  url: string;
  method: string;
  /** True when this request is the top-level document of the automation tab. */
  isMainFrameDocument: boolean;
  /** Request body when the browser exposes it. */
  postData?: string;
  /** True when a body exists but was not provided (too large or streamed). */
  hasUnreadPostData?: boolean;
}

export type Verdict = { allow: true } | { allow: false; reason: DenyReason; rule: string };

export type DenyReason =
  | "unparseable"
  | "scheme"
  | "checkout"
  | "payment"
  | "address"
  | "account_settings"
  | "sign_in"
  | "one_click"
  | "order_change"
  | "return_initiation"
  | "not_allowlisted"
  | "method";

export const AMAZON_HOST = "www.amazon.com";

/**
 * Amazon hosts that only receive telemetry beacons or serve suggestions. Their paths are
 * opaque encoded blobs that can contain any substring, so the path rules do not apply.
 * Nothing on them can change an order, a payment or the account.
 */
export const TELEMETRY_HOSTS: readonly string[] = [
  "fls-na.amazon.com",
  "unagi.amazon.com",
  "unagi-na.amazon.com",
  "completion.amazon.com",
];

/** Lower-case host without the trailing dot of a fully qualified name. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

/** Percent-decode what can be decoded and leave malformed escapes as they are. */
export function lenientDecode(value: string): string {
  let out = value;
  // Twice, so a doubly encoded marker is seen too.
  for (let round = 0; round < 2; round++) {
    out = out.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
      }
    });
  }
  return out;
}

/**
 * The path as the deny rules should see it: decoded, without `;parameters`, with repeated
 * and dot segments collapsed, and without the locale prefix (`/-/es/...`).
 */
export function normalizePath(pathname: string): string {
  let path = lenientDecode(pathname).replace(/\\/g, "/");
  path = path
    .split("/")
    .map((segment) => segment.replace(/;.*$/, ""))
    .filter((segment, index) => index === 0 || (segment !== "" && segment !== "."))
    .join("/");
  if (!path.startsWith("/")) path = `/${path}`;
  for (let i = 0; i < 3; i++) {
    const stripped = path.replace(/^\/-\/[a-z]{2}(?:[_-][a-z]{2})?(?=\/|$)/i, "");
    if (stripped === path) break;
    path = stripped === "" ? "/" : stripped;
  }
  return path;
}

/** Hosts the hard-deny layer applies to: amazon.com and every subdomain but telemetry. */
export function isAmazonHost(host: string): boolean {
  const h = normalizeHost(host);
  if (TELEMETRY_HOSTS.includes(h)) return false;
  return h === "amazon.com" || h.endsWith(".amazon.com");
}

interface DenyRule {
  name: string;
  reason: DenyReason;
  path: RegExp;
}

/**
 * Hard-deny rules, matched case-insensitively against the URL path (and for the generic
 * rules against path + query). Order does not matter: the first match wins and all are
 * denials.
 */
export const HARD_DENY_RULES: readonly DenyRule[] = [
  { name: "gp-buy", reason: "checkout", path: /^\/gp\/buy(\/|$)/i },
  { name: "checkout", reason: "checkout", path: /^\/checkout(\/|$)/i },
  { name: "checkoutportal", reason: "checkout", path: /^\/gp\/checkoutportal(\/|$)/i },
  { name: "go-to-checkout", reason: "checkout", path: /go-to-checkout/i },
  { name: "proceed-to-checkout", reason: "checkout", path: /proceed-?to-?checkout/i },
  { name: "cart-checkout", reason: "checkout", path: /^\/(gp\/)?cart\/.*checkout/i },
  { name: "buy-now", reason: "one_click", path: /buy-?now/i },
  { name: "one-click", reason: "one_click", path: /(one-?click|1-click)/i },
  { name: "turbo-checkout", reason: "one_click", path: /turbo-?checkout/i },
  { name: "digital-buy", reason: "one_click", path: /^\/gp\/digital(\/|$)/i },
  { name: "dmusic-purchase", reason: "one_click", path: /^\/gp\/dmusic\/purchase/i },
  { name: "video-purchase", reason: "one_click", path: /^\/gp\/video\/.*(buy|purchase|offers\/)/i },
  { name: "kindle-buy", reason: "one_click", path: /^\/kindle-dbs\/(buy|purchase)/i },
  {
    name: "prime-signup",
    reason: "checkout",
    path: /^\/(gp\/prime\/pipeline|amazonprime\/pipeline|prime\/pipeline)/i,
  },
  {
    name: "subscribe-create",
    reason: "checkout",
    path: /^\/gp\/subscribe-and-save\/(checkout|create)/i,
  },
  { name: "auth-portal", reason: "sign_in", path: /^\/ap(\/|$)/i },
  { name: "addresses", reason: "address", path: /^\/a\/addresses(\/|$)/i },
  { name: "address-book", reason: "address", path: /^\/gp\/css\/account\/address/i },
  {
    name: "glow-address-change",
    reason: "address",
    path: /^\/(gp\/delivery\/ajax\/address-change|portal-migration\/hz\/glow\/address-change)/i,
  },
  { name: "payments", reason: "payment", path: /^\/cpe(\/|$)/i },
  { name: "wallet", reason: "payment", path: /^\/gp\/wallet(\/|$)/i },
  {
    name: "your-payments",
    reason: "payment",
    path: /^\/(yourpayments|payments|hp\/wlp|gc\/redeem|gp\/css\/gc)(\/|$)/i,
  },
  { name: "account-settings", reason: "account_settings", path: /^\/gp\/css\/account(\/|$)/i },
  {
    name: "account-home",
    reason: "account_settings",
    path: /^\/(gp\/css\/homepage|gp\/your-account\/?$|your-account\/?$)/i,
  },
  {
    name: "login-security",
    reason: "account_settings",
    path: /^\/(ax\/account|gp\/profile\/|gp\/primecentral|mc\/|manageprime)/i,
  },
  { name: "order-edit", reason: "order_change", path: /^\/gp\/css\/order\/edit/i },
  { name: "order-cancel", reason: "order_change", path: /cancel/i },
  {
    name: "order-change",
    reason: "order_change",
    path: /^\/gp\/(css|your-account)\/order-(edit|change)/i,
  },
  {
    name: "returns-center",
    reason: "return_initiation",
    path: /^\/(spr\/returns|gp\/orc|returns)(\/|$)/i,
  },
];

/** Body markers that turn an otherwise acceptable cart request into a purchase. */
export const BUY_BODY_MARKERS: readonly RegExp[] = [
  /submit\.buy-?now/i,
  /buy-?now/i,
  /one-?click/i,
  /proceedToRetailCheckout/i,
  /proceedToCheckout/i,
  /turbo/i,
  /placeYourOrder/i,
  /place-?order/i,
];

/** Paths whose POST body must be readable and free of buy markers. */
export const BODY_CHECKED_PATHS: readonly RegExp[] = [
  /handle-buy-box/i,
  /^\/(gp\/)?cart(\/|$)/i,
  /add-to-cart/i,
];

const REF = String.raw`(\/ref=[^/?#]*)?\/?$`;

/** The form target of an offer's own Add to Cart control in the all-offers panel. */
const AOD_ADD_TO_CART_PATH = /^\/cart\/add-to-cart\/ref=aod_[A-Za-z0-9_]+\/?$/;

interface AllowRule {
  name: string;
  host: string;
  path: RegExp;
}

/** Positive allowlist for main-frame documents. GET only. */
export const MAIN_FRAME_ALLOWLIST: readonly AllowRule[] = [
  { name: "home", host: AMAZON_HOST, path: new RegExp(String.raw`^\/?$`) },
  { name: "home-ref", host: AMAZON_HOST, path: new RegExp(String.raw`^\/ref=[^/?#]*\/?$`) },
  { name: "search", host: AMAZON_HOST, path: new RegExp(String.raw`^\/s` + REF) },
  {
    name: "product",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/(?:[^/]+\/)?dp\/[A-Z0-9]{10}` + REF),
  },
  {
    name: "product-gp",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/product\/[A-Z0-9]{10}` + REF),
  },
  {
    name: "all-offers",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/(aod|product)\/ajax` + REF),
  },
  {
    name: "offer-listing",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/offer-listing\/[A-Z0-9]{10}` + REF),
  },
  {
    name: "reviews",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/(?:[^/]+\/)?product-reviews\/[A-Z0-9]{10}` + REF),
  },
  {
    name: "cart",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/(gp\/cart\/view\.html|cart)` + REF),
  },
  // Where the browser lands after the all-offers panel's Add to Cart form is submitted.
  { name: "cart-add-result", host: AMAZON_HOST, path: AOD_ADD_TO_CART_PATH },
  {
    name: "cart-smart-wagon",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/cart\/smart-wagon` + REF),
  },
  { name: "orders", host: AMAZON_HOST, path: new RegExp(String.raw`^\/your-orders\/orders` + REF) },
  {
    name: "orders-legacy",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/(css|your-account)\/order-history` + REF),
  },
  {
    name: "order-details",
    host: AMAZON_HOST,
    path: new RegExp(
      String.raw`^\/(gp\/your-account\/order-details|your-orders\/order-details|gp\/css\/order-details)` +
        REF,
    ),
  },
  {
    name: "invoice",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/css\/summary\/print\.html` + REF),
  },
  {
    name: "tracking",
    host: AMAZON_HOST,
    path: new RegExp(
      String.raw`^\/(progress-tracker\/package|progress-tracker\/package-tracking|gp\/your-account\/ship-track)` +
        REF,
    ),
  },
  {
    name: "lists",
    host: AMAZON_HOST,
    path: new RegExp(
      String.raw`^\/hz\/wishlist\/(ls|intro|genericItemsPage|your-lists)(\/[A-Z0-9]{8,16})?` + REF,
    ),
  },
  {
    name: "lists-legacy",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/registry\/wishlist(\/[A-Z0-9]{8,16})?` + REF),
  },
  {
    name: "subscriptions",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/auto-deliveries(\/(subscriptionList|landing))?` + REF),
  },
  {
    name: "subscriptions-legacy",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/subscribe-and-save\/manager\/viewsubscriptions` + REF),
  },
  {
    name: "browsing-history",
    host: AMAZON_HOST,
    path: new RegExp(String.raw`^\/gp\/history` + REF),
  },
  { name: "camel-product", host: "camelcamelcamel.com", path: /^\/product\/[A-Z0-9]{10}\/?$/ },
  {
    name: "camel-chart",
    host: "charts.camelcamelcamel.com",
    path: /^\/us\/[A-Z0-9]{10}\/[a-z-]+\.png$/,
  },
  { name: "keepa-graph", host: "graph.keepa.com", path: /^\/pricehistory\.png$/ },
];

/** Page navigations that may be a POST. Everything else must be a GET. */
export const MAIN_FRAME_POST_ALLOWLIST: readonly AllowRule[] = [
  { name: "aod-add-to-cart", host: AMAZON_HOST, path: AOD_ADD_TO_CART_PATH },
];

function deny(reason: DenyReason, rule: string): Verdict {
  return { allow: false, reason, rule };
}

/** Decide whether a request may proceed. Fails closed on anything unexpected. */
export function checkRequest(info: RequestInfo | null | undefined): Verdict {
  if (!info || typeof info.url !== "string" || typeof info.method !== "string")
    return deny("unparseable", "missing");
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return deny("unparseable", "url");
  }
  const scheme = url.protocol;
  if (scheme !== "https:") {
    // Sub-resources may be data/blob or injected by another installed extension; a
    // main-frame document may only be about:blank.
    if (
      !info.isMainFrameDocument &&
      (scheme === "data:" || scheme === "blob:" || scheme === "chrome-extension:")
    ) {
      return { allow: true };
    }
    if (info.isMainFrameDocument && info.url === "about:blank") return { allow: true };
    return deny("scheme", scheme);
  }
  const host = normalizeHost(url.hostname);
  const method = info.method.toUpperCase();

  if (isAmazonHost(host)) {
    // The rules are anchored at the start of the path, so match them against the path
    // with every prefix and decoration a server might ignore removed.
    try {
      decodeURIComponent(url.pathname);
    } catch {
      return deny("unparseable", "path-encoding");
    }
    const path = normalizePath(url.pathname);
    for (const rule of HARD_DENY_RULES) {
      if (rule.path.test(path) || rule.path.test(url.pathname)) return deny(rule.reason, rule.name);
    }
    // A buy marker in the query string is refused whatever the method.
    const query = `${url.search}\n${lenientDecode(url.search.replace(/\+/g, " "))}`;
    if (BUY_BODY_MARKERS.some((m) => m.test(query))) return deny("one_click", "query-buy-marker");
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      if (BODY_CHECKED_PATHS.some((p) => p.test(path))) {
        if (info.hasUnreadPostData || info.postData === undefined)
          return deny("one_click", "unreadable-body");
        const body = `${info.postData}\n${lenientDecode(info.postData.replace(/\+/g, " "))}`;
        if (BUY_BODY_MARKERS.some((m) => m.test(body))) return deny("one_click", "body-buy-marker");
      }
    }
  }

  if (!info.isMainFrameDocument) return { allow: true };

  if (method === "POST") {
    // The one page navigation that is a form post: adding a specific offer to the cart.
    // Its body was checked above (readable, no buy marker), or the request is already denied.
    for (const rule of MAIN_FRAME_POST_ALLOWLIST) {
      if (rule.host === url.hostname.toLowerCase() && rule.path.test(url.pathname))
        return { allow: true };
    }
  }
  if (method !== "GET") return deny("method", method);
  for (const rule of MAIN_FRAME_ALLOWLIST) {
    // Exact host as written (no trailing-dot or other variant) and the raw path.
    if (rule.host === url.hostname.toLowerCase() && rule.path.test(url.pathname))
      return { allow: true };
  }
  return deny("not_allowlisted", host);
}

/**
 * Same-origin documents the flows fetch from inside an already loaded Amazon page (they
 * are not navigations, so the main-frame allowlist does not cover them). GET only.
 */
export const FRAGMENT_ALLOWLIST: readonly AllowRule[] = [
  {
    name: "all-offers",
    host: AMAZON_HOST,
    path: /^\/gp\/product\/ajax\/aodAjaxMain(\/ref=[^/?#]*)?\/?$/,
  },
];

/** May a flow fetch this URL as a fragment from within the page? Fails closed. */
export function checkFragment(url: string): Verdict {
  const base = checkRequest({ url, method: "GET", isMainFrameDocument: false });
  if (!base.allow) return base;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny("unparseable", "url");
  }
  for (const rule of FRAGMENT_ALLOWLIST) {
    if (rule.host === parsed.hostname.toLowerCase() && rule.path.test(parsed.pathname))
      return { allow: true };
  }
  return deny("not_allowlisted", "fragment");
}

/** Convenience for flows: may the automation tab navigate to this URL at all? */
export function checkNavigation(url: string): Verdict {
  return checkRequest({ url, method: "GET", isMainFrameDocument: true });
}

/**
 * Text and attribute patterns of purchase controls. A write flow must refuse to click an
 * element matching any of these, whatever its selector matched.
 */
export const PURCHASE_CONTROL_PATTERNS: readonly RegExp[] = [
  /buy\s*now/i,
  /place\s*(your)?\s*order/i,
  /proceed\s*to\s*(retail\s*)?checkout/i,
  /check\s*out/i,
  /1-click|one-click|oneclick/i,
  /turbo/i,
  /pay\s*now/i,
  /use\s*this\s*(payment|address)/i,
  /subscribe\s*now/i,
  /set\s*up\s*now/i,
  /start\s*(your|my)?\s*([\w-]+\s+){0,3}(trial|membership)/i,
  /join\s*prime|try\s*prime|sign\s*up\s*for\s*prime|with\s*prime/i,
  /(deliver|ship)\s*to\s*this\s*address/i,
  /confirm\s*(purchase|order|subscription)/i,
  /cancel\s*(items|order|subscription)/i,
  /return\s*or\s*replace|start\s*a?\s*return/i,
  /pre-?order\s*now/i,
  /rent\s*now|buy\s*(with|for)\s/i,
];

export interface ControlDescriptor {
  text: string;
  id?: string | null;
  name?: string | null;
  ariaLabel?: string | null;
  value?: string | null;
  href?: string | null;
  formAction?: string | null;
}

/** True when the control looks like a purchase / irreversible control. Missing input denies. */
export function isPurchaseControl(control: ControlDescriptor | null | undefined): boolean {
  if (!control || typeof control.text !== "string") return true;
  const haystacks = [
    control.text,
    control.id,
    control.name,
    control.ariaLabel,
    control.value,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  for (const raw of haystacks) {
    // Ids and names use separators or camelCase where visible text uses spaces.
    const spaced = raw.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    if (PURCHASE_CONTROL_PATTERNS.some((p) => p.test(raw) || p.test(spaced))) return true;
  }
  for (const target of [control.href, control.formAction]) {
    if (
      typeof target === "string" &&
      target.length > 0 &&
      !target.startsWith("javascript:") &&
      target !== "#"
    ) {
      let absolute: string;
      try {
        absolute = new URL(target, `https://${AMAZON_HOST}/`).toString();
      } catch {
        return true;
      }
      const verdict = checkRequest({ url: absolute, method: "GET", isMainFrameDocument: false });
      if (!verdict.allow) return true;
    }
  }
  return false;
}
