/**
 * Price history parsers and URL helpers.
 *
 * Three sources, three audiences (see PRICE_SOURCE_TERMS):
 *  - camelcamelcamel product page (`price_history_camel`): a public third-party page. Stats
 *    table per price type, chart image URLs, product fields, an optional price-change table.
 *  - Amazon's own price information (`price_history_amazon`): what the product page DOM
 *    carries without further interaction (typical / list price, savings, "lowest price in N
 *    days" style statements) plus a precise description of how the interactive "Price history"
 *    ingress is wired. The chart itself is NOT in the DOM: it is produced inside the shopping
 *    assistant panel after a click, so `series_available` is false unless a series is embedded.
 *  - Keepa: only a keyless graph image URL builder, no parsing.
 *
 * Verified against real captures: the camel stats table, chart image, buy box, product fields,
 * range switcher and chart-type toggles; the Amazon typical / list price block, the savings
 * badge and the ingress pill. NOT seen in any capture (written from public knowledge, covered
 * by synthetic tests only): a camel price-change table, a camel not-tracked page, any bot
 * challenge page, an Amazon "lowest price in N days" badge, an Amazon embedded series.
 */
import { RfError } from "@rainforest/core";
import type { Capture, OtherSection, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  type Money,
  TEXT_NODE,
  attr,
  collapse,
  moneyFromPriceElement,
  parseDocument,
  parseMoney,
  q,
  qa,
  tableToRows,
  text,
  visible,
} from "../dom.ts";
import { tryJson } from "../blobs.ts";
import { Consumption, losslessReport } from "../lossless.ts";
import { firstOf, newMeta } from "../strategy.ts";

// ---------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------

/** An ASIN: exactly ten upper-case letters or digits. */
export const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export function isAsin(value: unknown): value is string {
  return typeof value === "string" && ASIN_PATTERN.test(value);
}

function requireAsin(asin: unknown): string {
  if (!isAsin(asin)) {
    throw new RfError("invalid_arguments", "asin must be exactly 10 upper-case letters or digits");
  }
  return asin;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function validYmd(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return undefined;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const DATE_NAMED = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/;
const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * ISO date (YYYY-MM-DD) from "Nov 30, 2025", "November 30 2025" or "2025-11-30". Anything
 * else (relative strings such as "5 days ago", numeric slash dates) is undefined: keep the raw
 * string. A time of day inside the string is ignored (its time zone is unknown).
 */
export function parseLooseDate(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const iso = DATE_ISO.exec(raw);
  if (iso !== null) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = DATE_NAMED.exec(raw);
  if (named !== null) {
    const month = MONTHS[(named[1] ?? "").slice(0, 3).toLowerCase()];
    if (month === undefined) return undefined;
    return validYmd(Number(named[3]), month, Number(named[2]));
  }
  return undefined;
}

/** The raw date substring found in a string, if any. */
function findDateRaw(s: string): string | undefined {
  return DATE_NAMED.exec(s)?.[0] ?? DATE_ISO.exec(s)?.[0];
}

export interface DatedPrice {
  date_raw: string;
  /** ISO date when the raw string parses unambiguously. */
  date?: string;
  price?: Money;
  /** The source cell or row text. */
  raw?: string;
}

function datedPoint(date_raw: string, price: Money | undefined, raw?: string): DatedPrice {
  const out: DatedPrice = { date_raw };
  const iso = parseLooseDate(date_raw);
  if (iso !== undefined) out.date = iso;
  if (price !== undefined) out.price = price;
  if (raw !== undefined) out.raw = raw;
  return out;
}

function stripTrailingColon(s: string): string {
  return collapse(s).replace(/\s*:\s*$/, "");
}

function snake(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------------------
// source terms and URL helpers
// ---------------------------------------------------------------------------------------

/** One neutral sentence per price source: whose data it is, and the access caveat. */
export const PRICE_SOURCE_TERMS: Record<"amazon" | "camelcamelcamel" | "keepa", string> = {
  amazon:
    "Price information on the Amazon product page is Amazon's own data, read from the page as it is shown to the signed-in browser.",
  camelcamelcamel:
    "Price history from camelcamelcamel is that site's own data; it is fetched at low volume and the site may restrict automated access.",
  keepa:
    "Price history charts from Keepa are that service's own data; the chart image is fetched at low volume and the service may restrict automated access.",
};

/** Hosts a camelcamelcamel chart image may be served from. Exact hostnames only. */
export const CAMEL_CHART_HOSTS: readonly string[] = ["charts.camelcamelcamel.com"];

/** Host of the keyless Keepa graph image. */
export const KEEPA_GRAPH_HOST = "graph.keepa.com";

/** True for an https URL whose hostname is exactly one of the camel chart hosts. */
export function isAllowedCamelChartUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    CAMEL_CHART_HOSTS.includes(url.hostname)
  );
}

export interface KeepaGraphOptions {
  /** Marketplace. The US store only. Default "com". */
  domain?: "com";
  /** Days of history shown (public docs: 1, 7, 30, 90, 180, 365, ...). Integer 1..3650. */
  range?: number;
  /** Pixels, integer 100..2000. */
  width?: number;
  height?: number;
  /** Which series to draw (1 = draw, 0 = hide). Unset = the service default. */
  amazon?: boolean;
  new?: boolean;
  used?: boolean;
}

function intIn(name: string, v: number, min: number, max: number): string {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RfError("invalid_arguments", `${name} must be an integer from ${min} to ${max}`);
  }
  return String(v);
}

/**
 * Keyless Keepa graph image URL (public knowledge of the image endpoint; not an official
 * contract, so only the parameters seen in public usage are exposed). Parameters are emitted
 * as asin, domain, range, width, height, amazon, new, used. Throws `invalid_arguments` for a
 * malformed ASIN or an out-of-range option.
 */
export function keepaGraphUrl(asin: string, opts: KeepaGraphOptions = {}): string {
  const id = requireAsin(asin);
  const domain = opts.domain ?? "com";
  if (domain !== "com") throw new RfError("invalid_arguments", "domain must be com");
  const p = new URLSearchParams();
  p.set("asin", id);
  p.set("domain", domain);
  if (opts.range !== undefined) p.set("range", intIn("range", opts.range, 1, 3650));
  if (opts.width !== undefined) p.set("width", intIn("width", opts.width, 100, 2000));
  if (opts.height !== undefined) p.set("height", intIn("height", opts.height, 100, 2000));
  for (const key of ["amazon", "new", "used"] as const) {
    const flag = opts[key];
    if (flag !== undefined) p.set(key, flag ? "1" : "0");
  }
  return `https://${KEEPA_GRAPH_HOST}/pricehistory.png?${p.toString()}`;
}

export const CAMEL_PRICE_TYPES = ["amazon", "new", "used"] as const;
export type CamelPriceType = (typeof CAMEL_PRICE_TYPES)[number];

export const CAMEL_TIME_PERIODS = ["1m", "3m", "6m", "1y", "all"] as const;
export type CamelTimePeriod = (typeof CAMEL_TIME_PERIODS)[number];

export interface CamelChartOptions {
  /** Pixels, integer 100..2000. Default 800 x 400. */
  width?: number;
  height?: number;
  /** Time period. Default "all". */
  period?: CamelTimePeriod;
  /** Draw the legend. Default true. */
  legend?: boolean;
}

/**
 * Public camelcamelcamel chart PNG for the US store. `kind` is one price type or a list of
 * them (drawn together, joined in the fixed order amazon, new, used). Throws
 * `invalid_arguments` for a malformed ASIN, an empty or unknown kind or an out-of-range
 * option. The result always passes isAllowedCamelChartUrl.
 */
export function camelChartUrl(
  asin: string,
  kind: CamelPriceType | readonly CamelPriceType[],
  opts: CamelChartOptions = {},
): string {
  const id = requireAsin(asin);
  const kinds: readonly unknown[] = Array.isArray(kind) ? kind : [kind];
  if (
    kinds.length === 0 ||
    kinds.some((k) => !(CAMEL_PRICE_TYPES as readonly unknown[]).includes(k))
  ) {
    throw new RfError("invalid_arguments", "kind must be amazon, new, used or a list of them");
  }
  const path = CAMEL_PRICE_TYPES.filter((t) => kinds.includes(t)).join("-");
  const period = opts.period ?? "all";
  if (!CAMEL_TIME_PERIODS.includes(period)) {
    throw new RfError("invalid_arguments", "period must be 1m, 3m, 6m, 1y or all");
  }
  const p = new URLSearchParams();
  p.set("zero", "0");
  p.set("w", intIn("width", opts.width ?? 800, 100, 2000));
  p.set("h", intIn("height", opts.height ?? 400, 100, 2000));
  p.set("desired", "false");
  p.set("legend", (opts.legend ?? true) ? "1" : "0");
  p.set("tp", period);
  p.set("lang", "en");
  return `https://${CAMEL_CHART_HOSTS[0]}/us/${id}/${path}.png?${p.toString()}`;
}

// ---------------------------------------------------------------------------------------
// camelcamelcamel
// ---------------------------------------------------------------------------------------

export type CamelBlockKind = "bot_challenge" | "rate_limited" | "access_denied";

export interface CamelBlock {
  kind: CamelBlockKind;
  /** The signals that fired, human readable. */
  evidence: string;
  score: number;
}

export interface CamelTypeStats {
  type: CamelPriceType | "unknown";
  /** Label as shown: "Amazon", "3rd Party New", "3rd Party Used". */
  label: string;
  /** False when every statistic cell is "-". */
  has_data: boolean;
  current?: Money;
  current_date_raw?: string;
  current_date?: string;
  highest?: Money;
  highest_date_raw?: string;
  highest_date?: string;
  lowest?: Money;
  lowest_date_raw?: string;
  lowest_date?: string;
  average?: Money;
  /** The row's cell texts keyed by column (lowest, highest, current, average). */
  cells_raw: Record<string, string>;
}

export interface CamelBuyBoxEntry {
  type: CamelPriceType | "unknown";
  label: string;
  price?: Money;
  /** Shown instead of a price ("Out of Stock"). */
  availability?: string;
  as_of_raw?: string;
  as_of_date?: string;
}

export interface CamelSeries {
  type: CamelPriceType | "unknown";
  label: string;
  points: DatedPrice[];
}

export interface CamelPeriodOption {
  key: string;
  label: string;
  active: boolean;
  /** "view data going back to Oct 17, 2026" style hint, as shown. */
  title?: string;
  since_raw?: string;
  since?: string;
}

export interface CamelPriceTypeToggle {
  type: CamelPriceType | "unknown";
  label: string;
  /** The type is drawn on the chart. */
  selected: boolean;
  /** The page says it has no data for this type. */
  no_data: boolean;
  title?: string;
}

export type CamelState = "ok" | "no_data" | "not_tracked" | "not_found";

export interface CamelPriceHistory {
  /** True when the capture is a bot wall or challenge page; every other field is then empty. */
  blocked: boolean;
  blocked_kind?: CamelBlockKind;
  blocked_evidence?: string;
  state?: CamelState;
  /** The page's own "not tracked / no data" message. */
  state_message?: string;
  asin?: string;
  locale?: string;
  title?: string;
  image_url?: string;
  /** "View all sizes / colors" link. */
  variants_url?: string;
  /** Header fields (ID, UPC, EAN, category, manufacturer, model, list price, ...) by snake name. */
  product_fields: Record<string, string>;
  list_price?: Money;
  /** "Last update scan" / "Last tracked" as shown (relative strings, kept raw). */
  last_update_scan?: string;
  last_tracked?: string;
  /** The stats header's "Last checked ..." hint. */
  last_checked_raw?: string;
  last_checked?: string;
  monitoring_since_raw?: string;
  monitoring_since?: string;
  section_heading?: string;
  price_types_description?: string;
  periods: CamelPeriodOption[];
  active_period?: string;
  price_type_toggles: CamelPriceTypeToggle[];
  stats: CamelTypeStats[];
  buy_box: CamelBuyBoxEntry[];
  /** Price-change history rows, when the page shows any. */
  series: CamelSeries[];
  /** Chart image URLs that passed the host allowlist. */
  chart_urls: string[];
  share_url?: string;
  /** Raw text of the user's own price watches, when signed in. */
  price_watches: string[];
}

function camelTypeOf(label: string): CamelPriceType | "unknown" {
  const l = label.toLowerCase();
  if (/\bnew\b/.test(l)) return "new";
  if (/\bused\b/.test(l)) return "used";
  if (/\bamazon\b/.test(l)) return "amazon";
  return "unknown";
}

function camelTypeFromField(field: string | undefined, label: string): CamelPriceType | "unknown" {
  if (field !== undefined && (CAMEL_PRICE_TYPES as readonly string[]).includes(field)) {
    return field as CamelPriceType;
  }
  return camelTypeOf(label);
}

interface BlockSignal {
  kind: CamelBlockKind;
  name: string;
  weight: 1 | 2;
  test: (ctx: BlockContext) => boolean;
}

interface BlockContext {
  doc: DomDocument;
  html: string;
  title: string;
  text: string;
}

const SHORT_PAGE = 5000;
const shortText =
  (re: RegExp) =>
  (c: BlockContext): boolean =>
    c.text.length <= SHORT_PAGE && re.test(c.text);
const htmlHas =
  (re: RegExp) =>
  (c: BlockContext): boolean =>
    re.test(c.html);
const titleIs =
  (re: RegExp) =>
  (c: BlockContext): boolean =>
    re.test(c.title);

const CHALLENGE_SELECTOR = [
  "#challenge-form",
  "#challenge-running",
  "#challenge-stage",
  "#challenge-error-text",
  "#cf-challenge-running",
  "#cf-please-wait",
  ".cf-browser-verification",
  ".cf-turnstile",
  "[name=cf-turnstile-response]",
  "#px-captcha",
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='captcha-delivery.com']",
].join(", ");

/**
 * Bot wall / challenge signals for a third-party page, from public knowledge of generic
 * challenge pages (no capture of one exists). A kind needs a score of at least 2; body phrases
 * only count on short pages so a long content page never matches.
 */
export const CAMEL_BLOCK_SIGNALS: readonly BlockSignal[] = [
  // bot_challenge
  {
    kind: "bot_challenge",
    name: "title 'Just a moment' / 'Attention Required' / 'One more step'",
    weight: 2,
    test: titleIs(/just a moment|attention required|one more step/i),
  },
  {
    kind: "bot_challenge",
    name: "title 'security check' / 'verify' / 'human'",
    weight: 1,
    test: titleIs(/security check|verify|human|robot|captcha|checking your browser/i),
  },
  {
    kind: "bot_challenge",
    // the benign JS-detections beacon lives at .../challenge-platform/scripts/jsd/ and is
    // injected into normal pages, so it never counts
    name: "script /cdn-cgi/challenge-platform/ (not the jsd beacon)",
    weight: 1,
    test: htmlHas(/\/cdn-cgi\/challenge-platform\/(?!scripts\/jsd\b)/i),
  },
  {
    kind: "bot_challenge",
    name: "challenge option object (_cf_chl_opt)",
    weight: 1,
    test: htmlHas(/_cf_chl_opt|cf_chl_(?:prog|f_tk|rt_tk)|__cf_chl_/i),
  },
  {
    kind: "bot_challenge",
    name: "challenge widget element",
    weight: 2,
    test: (c) => c.doc.querySelector(CHALLENGE_SELECTOR) !== null,
  },
  {
    kind: "bot_challenge",
    name: "text 'verify you are human' / 'checking your browser'",
    weight: 1,
    test: shortText(
      /verify(?:ing)? (?:that )?you are (?:a )?human|checking (?:if the site connection is secure|your browser)|performing security verification|press (?:and|&) hold|complete the (?:security )?check to continue/i,
    ),
  },
  {
    kind: "bot_challenge",
    name: "text 'enable JavaScript and cookies to continue'",
    weight: 1,
    test: shortText(
      /enable javascript and cookies to continue|needs to review the security of your connection/i,
    ),
  },
  // access_denied
  {
    kind: "access_denied",
    name: "text 'you have been blocked' / 'access denied' / 'error 1020'",
    weight: 1,
    test: shortText(/you have been blocked|access denied|error 1020|request blocked/i),
  },
  {
    kind: "access_denied",
    name: "title 'access denied' / 'forbidden' / 403",
    weight: 1,
    test: titleIs(/access denied|forbidden|^403\b|blocked/i),
  },
  {
    kind: "access_denied",
    name: "text 'Ray ID' on a short page",
    weight: 1,
    test: shortText(/ray id\s*:/i),
  },
  // rate_limited
  {
    kind: "rate_limited",
    name: "text 'too many requests' / 'rate limited' / 'error 1015'",
    weight: 1,
    test: shortText(/too many requests|rate limited|rate limit exceeded|error 1015/i),
  },
  {
    kind: "rate_limited",
    name: "title 'too many requests' / 429",
    weight: 1,
    test: titleIs(/too many requests|^429\b|rate limit/i),
  },
  {
    kind: "rate_limited",
    name: "text 'try again later'",
    weight: 1,
    test: shortText(/try again (?:later|in a few minutes|shortly)/i),
  },
];

const BLOCK_PRIORITY: readonly CamelBlockKind[] = [
  "bot_challenge",
  "access_denied",
  "rate_limited",
];
const BLOCK_THRESHOLD = 2;

/** Classify a capture as a bot wall, or null for a normal page. */
export function classifyCamelBlock(capture: Capture, doc?: DomDocument): CamelBlock | null {
  const document = doc ?? parseDocument(capture.html);
  // A page that renders the product header or the statistics table is real content, whatever
  // scripts a CDN injected into it.
  if (document.querySelector("#product-content, .camelegend, table.product_fields") !== null) {
    return null;
  }
  const ctx: BlockContext = {
    doc: document,
    html: capture.html,
    title: collapse(document.title ?? ""),
    text: text(document.body),
  };
  const scores = new Map<CamelBlockKind, { score: number; names: string[] }>();
  for (const s of CAMEL_BLOCK_SIGNALS) {
    let fired: boolean;
    try {
      fired = s.test(ctx);
    } catch {
      fired = false;
    }
    if (!fired) continue;
    const entry = scores.get(s.kind) ?? { score: 0, names: [] };
    entry.score += s.weight;
    entry.names.push(s.name);
    scores.set(s.kind, entry);
  }
  let best: CamelBlockKind | null = null;
  let bestScore = 0;
  for (const kind of BLOCK_PRIORITY) {
    const score = scores.get(kind)?.score ?? 0;
    if (score >= BLOCK_THRESHOLD && score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  if (best === null) return null;
  const names = scores.get(best)?.names ?? [];
  return { kind: best, evidence: `${best}: ${names.join("; ")}`, score: bestScore };
}

function emptyCamel(): CamelPriceHistory {
  return {
    blocked: false,
    product_fields: {},
    periods: [],
    price_type_toggles: [],
    stats: [],
    buy_box: [],
    series: [],
    chart_urls: [],
    price_watches: [],
  };
}

function stripSeoSuffix(s: string): string {
  return collapse(
    s
      .replace(/\s*\|\s*(?:Amazon|3rd Party)[^|]*price[^|]*$/i, "")
      .replace(/\s*\|.*price (?:tracker|history).*$/i, ""),
  );
}

const NOT_TRACKED_RE =
  /not (?:currently |yet )?(?:being )?(?:tracked|monitored)|no price history|(?:do not|don'?t|does not|doesn'?t) (?:currently )?(?:have|track|monitor)|(?:haven'?t|have not|hasn'?t|has not) (?:yet )?(?:started|begun|been)|not (?:yet )?in our database/i;
const NOT_FOUND_RE =
  /product not found|(?:couldn'?t|could not|can'?t|cannot) find (?:that|this|the) product|no such product|page not found/i;

function camelStatsFromTable(
  table: DomElement,
  c: Consumption,
  meta: ParseMeta,
  out: CamelPriceHistory,
): CamelTypeStats[] {
  const headerCells = Array.from(table.querySelectorAll("thead th, tr th"))
    .filter((th) => visible(th))
    .map((th) => text(th).toLowerCase());
  const column: Record<string, number> = {};
  headerCells.forEach((h, i) => {
    if (/lowest/.test(h)) column["lowest"] = i;
    else if (/highest/.test(h)) column["highest"] = i;
    else if (/current/.test(h)) column["current"] = i;
    else if (/average|avg/.test(h)) column["average"] = i;
  });
  if (Object.keys(column).length === 0) {
    // positional fallback: type, lowest, highest, current, average
    Object.assign(column, { lowest: 1, highest: 2, current: 3, average: 4 });
    meta.warnings.push("camel stats: header cells not recognised, used positional columns");
  }
  // "Last checked ..." hint on the current column header
  const hint = q(table, "thead [title^='Last checked'], th [title^='Last checked']");
  const hintTitle = attr(hint, "title");
  if (hintTitle !== undefined) {
    const raw = collapse(hintTitle.replace(/^Last checked\s*/i, "").replace(/\.\s*$/, ""));
    out.last_checked_raw = raw;
    const iso = parseLooseDate(raw);
    if (iso !== undefined) out.last_checked = iso;
  }
  const stats: CamelTypeStats[] = [];
  for (const tr of qa(table, "tbody tr")) {
    const cells = Array.from(tr.children).filter(
      (cell) => (cell.localName === "td" || cell.localName === "th") && visible(cell),
    );
    if (cells.length < 2) continue;
    const label = text(cells[0]);
    if (label === "") continue;
    const field = attr(tr, "data-field");
    const row: CamelTypeStats = {
      type: camelTypeFromField(field, label),
      label,
      has_data: false,
      cells_raw: {},
    };
    for (const key of ["lowest", "highest", "current", "average"] as const) {
      const idx = column[key];
      const cell = idx === undefined ? undefined : cells[idx];
      if (cell === undefined) continue;
      const raw = text(cell);
      row.cells_raw[key] = raw;
      const money = parseMoney(raw);
      if (money === undefined) continue;
      row.has_data = true;
      const dateRaw = /\(([^)]*)\)/.exec(raw)?.[1]?.trim();
      row[key] = money;
      if (key !== "average" && dateRaw !== undefined && dateRaw !== "") {
        row[`${key}_date_raw`] = dateRaw;
        const iso = parseLooseDate(dateRaw);
        if (iso !== undefined) row[`${key}_date`] = iso;
      }
    }
    stats.push(row);
  }
  c.take(table);
  return stats;
}

function headingFor(table: DomElement): string {
  const caption = q(table, "caption");
  if (caption !== undefined) return text(caption);
  for (
    let cur: DomElement | null = table, hops = 0;
    cur !== null && hops < 3;
    cur = cur.parentElement, hops++
  ) {
    for (let prev = prevElement(cur); prev !== null; prev = prevElement(prev)) {
      if (/^h[1-6]$/.test(prev.localName)) return text(prev);
      if (text(prev) !== "") break;
    }
  }
  return "";
}

function prevElement(el: DomElement): DomElement | null {
  const parent = el.parentElement;
  if (parent === null) return null;
  const sibs = Array.from(parent.children);
  const i = sibs.indexOf(el);
  return i > 0 ? (sibs[i - 1] ?? null) : null;
}

/** Tables of dated prices ("last 50 price changes" style). Layout not captured: text anchors. */
function parseSeriesTables(root: DomElement, c: Consumption, meta: ParseMeta): CamelSeries[] {
  const out: CamelSeries[] = [];
  for (const table of qa(root, "table")) {
    if (c.covers(table)) continue;
    const rows = tableToRows(table);
    if (rows.length < 2) continue;
    const heading = headingFor(table);
    const header = rows[0] ?? [];
    const headerIsHeader = header.every(
      (h) => findDateRaw(h) === undefined && parseMoney(h) === undefined,
    );
    const dataRows = headerIsHeader ? rows.slice(1) : rows;
    const headerLc = headerIsHeader ? header.map((h) => h.toLowerCase()) : [];
    const signalled =
      /price (?:changes?|history)|changes/i.test(heading) ||
      /price (?:changes?|history)/i.test(
        `${attr(table, "id") ?? ""} ${attr(table, "class") ?? ""}`,
      ) ||
      headerLc.some((h) => /^(?:date|when|changed)/.test(h));
    if (!signalled) continue;
    const dateCol = Math.max(
      0,
      headerLc.findIndex((h) => /date|when|changed/.test(h)),
    );
    const typeCols: { idx: number; type: CamelPriceType | "unknown"; label: string }[] = [];
    headerLc.forEach((h, i) => {
      if (i === dateCol) return;
      const type = camelTypeOf(h);
      if (type !== "unknown" || /price/.test(h))
        typeCols.push({ idx: i, type, label: header[i] ?? h });
    });
    const typeColIdx = headerLc.findIndex((h) => /^(?:price )?type$/.test(h));
    if (typeCols.length === 0 && dataRows[0] !== undefined) {
      // no header: date first, then one price cell
      typeCols.push({
        idx: dateCol === 0 ? 1 : 0,
        type: camelTypeOf(heading),
        label: heading || "Price",
      });
    }
    const byType = new Map<string, CamelSeries>();
    for (const row of dataRows) {
      const dateRaw = row[dateCol] !== undefined ? (findDateRaw(row[dateCol] ?? "") ?? "") : "";
      if (dateRaw === "") continue;
      for (const col of typeCols) {
        const raw = row[col.idx] ?? "";
        const money = parseMoney(raw);
        if (money === undefined) continue;
        let type = col.type;
        let label = col.label;
        if (type === "unknown" && typeColIdx >= 0) {
          label = row[typeColIdx] ?? label;
          type = camelTypeOf(label);
        }
        const key = `${type}:${label}`;
        let series = byType.get(key);
        if (series === undefined) {
          series = { type, label, points: [] };
          byType.set(key, series);
        }
        series.points.push(datedPoint(dateRaw, money, raw));
      }
    }
    if (byType.size === 0) continue;
    c.take(table);
    const prev = prevElement(table);
    if (prev !== null && /^h[1-6]$/.test(prev.localName) && text(prev) === heading) c.take(prev);
    out.push(...byType.values());
  }
  if (out.length > 0) meta.strategies["series"] = "text-anchor";
  return out;
}

const CHART_TEMPLATE_RE = /base_url\s*=\s*"(https:\/\/)"\s*\+\s*"([^"]+)"\s*\+\s*"([^"]+)"/;

function chartUrlsFrom(doc: DomDocument, meta: ParseMeta, c: Consumption): string[] {
  const urls: string[] = [];
  const reject: string[] = [];
  const add = (u: string | undefined, via: string): void => {
    if (u === undefined || u === "") return;
    if (isAllowedCamelChartUrl(u)) {
      if (!urls.includes(u)) urls.push(u);
    } else if (!reject.includes(u)) {
      reject.push(u);
      meta.warnings.push(`chart url rejected by the host allowlist (${via})`);
    }
  };
  const imgs = qa(doc, "#chart_parent img, img#summary_chart, img[src*='charts.']");
  for (const img of imgs) {
    add(attr(img, "src"), "img");
  }
  if (urls.length > 0) meta.strategies["chart_urls"] = "id";
  else {
    // fallback: the inline script that assembles the URL from a host + path template
    for (const script of Array.from(doc.querySelectorAll("script"))) {
      const m = CHART_TEMPLATE_RE.exec(script.textContent ?? "");
      if (m === null) continue;
      const built = `${m[1]}${m[2]}${m[3]}`
        .replace(/__/g, "/")
        .replace("GOOGLEPLS", ".png?")
        .replace("ZZZZ", "amazon")
        .replace("XXXX", "800")
        .replace("YYYY", "400");
      add(built, "inline-script");
    }
    if (urls.length > 0) meta.strategies["chart_urls"] = "inline-script";
  }
  void c;
  return urls;
}

/** The main content element of a camel page (the lossless scope). */
export function camelContentRoot(doc: DomDocument): DomElement {
  return q(doc, "#content") ?? q(doc, "main, [role=main]") ?? doc.body;
}

export const parseCamelPriceHistory: Parser<CamelPriceHistory> = (
  capture: Capture,
): ParseResult<CamelPriceHistory> => {
  const meta = newMeta();
  const doc = parseDocument(capture.html);
  const c = new Consumption();
  const data = emptyCamel();

  const block = classifyCamelBlock(capture, doc);
  if (block !== null) {
    data.blocked = true;
    data.blocked_kind = block.kind;
    data.blocked_evidence = block.evidence;
    meta.warnings.push(`blocked: ${block.evidence}`);
    const report = losslessReport(doc, c, { base: capture.final_url });
    meta.unparsed_text_chars = report.counts.unparsed;
    return { data, other_sections: report.sections, meta };
  }

  const root = camelContentRoot(doc);

  // ---- title
  const titleEl = q(root, "#product-content h2 a") ?? q(root, "#product-content h2");
  data.title = firstOf(
    "title",
    [
      ["id", () => text(titleEl)],
      ["label", () => stripSeoSuffix(text(q(doc, "h1.h1l a, h1.h1l")))],
      ["data-attr", () => stripSeoSuffix(attr(q(root, "img.pimg"), "alt") ?? "")],
      [
        "text-anchor",
        () => text(q(root, ".history-desc strong")).replace(/\s*\([A-Z0-9]{10}\)\s*$/, ""),
      ],
    ],
    meta,
  );
  if (titleEl !== undefined) c.take(titleEl.closest("h2") ?? titleEl);

  // ---- asin and locale
  const shareEl = q(root, "input#shareurl, input[name=shareurl]");
  data.asin = firstOf(
    "asin",
    [
      [
        "data-attr",
        () => {
          for (const el of qa(root, "[data-asin]")) {
            const v = attr(el, "data-asin");
            if (isAsin(v)) return v;
          }
          return undefined;
        },
      ],
      ["id", () => /\/([A-Z0-9]{10})\/?$/.exec(attr(shareEl, "value") ?? "")?.[1]],
      [
        "label",
        () => /\(([A-Z0-9]{10})\)\s*\.?\s*$/.exec(text(q(root, ".history-desc strong")))?.[1],
      ],
      ["href", () => /\/product\/([A-Z0-9]{10})\b/.exec(attr(titleEl, "href") ?? "")?.[1]],
      ["url", () => /\/product\/([A-Z0-9]{10})\b/.exec(capture.final_url || capture.url)?.[1]],
    ],
    meta,
    { optional: true },
  );
  data.locale = firstOf(
    "locale",
    [
      ["data-attr", () => attr(q(root, "[data-locale]"), "data-locale")],
      ["id", () => /\/([A-Za-z]{2})\/[A-Z0-9]{10}\/?$/.exec(attr(shareEl, "value") ?? "")?.[1]],
    ],
    meta,
    { optional: true },
  );
  if (shareEl !== undefined) {
    const share = attr(shareEl, "value");
    if (share !== undefined && /^https:\/\//.test(share)) data.share_url = share;
    c.take(shareEl.closest(".shareform") ?? shareEl);
  }

  // ---- thumbnail and variants link
  const thumb = q(root, "#product-content .pimg_parent img.pimg, #product-content img.pimg");
  const imageUrl = attr(thumb, "src");
  if (imageUrl !== undefined && /^https:\/\//.test(imageUrl)) data.image_url = imageUrl;
  c.takeAll(qa(root, "#product-content .pimg_parent"));
  const variants = q(root, "#product-content a.offers");
  if (variants !== undefined) {
    const href = attr(variants, "href");
    if (href !== undefined) data.variants_url = href;
    c.take(variants.closest("p") ?? variants);
  }

  // ---- product fields: header chips first, the details table overrides
  for (const chip of qa(root, "#product-content .product-title-field")) {
    const label = stripTrailingColon(text(q(chip, "strong")));
    if (label === "") continue;
    const value = collapse(
      text(chip)
        .slice(text(q(chip, "strong")).length)
        .replace(/^\s*:\s*/, ""),
    );
    if (value !== "") data.product_fields[snake(label)] = value;
  }
  c.takeAll(
    qa(root, "#product-content p").filter((p) => q(p, ".product-title-field") !== undefined),
  );
  const detailsTable = q(root, "table.product_fields");
  if (detailsTable !== undefined) {
    for (const row of tableToRows(detailsTable)) {
      const [label, value] = row;
      if (label !== undefined && value !== undefined && label !== "" && value !== "") {
        data.product_fields[snake(label)] = value;
      }
    }
    c.take(detailsTable);
    const h = prevElement(detailsTable.parentElement === null ? detailsTable : detailsTable);
    if (h !== null && /^h[1-6]$/.test(h.localName)) c.take(h);
    else {
      const wrap = detailsTable.closest(".cell");
      const heading = wrap === null ? undefined : q(wrap, "h3");
      if (heading !== undefined && text(heading) === "Product Details") c.take(heading);
    }
    meta.strategies["product_fields"] = "id";
  } else if (Object.keys(data.product_fields).length > 0) {
    meta.strategies["product_fields"] = "label";
  }
  const listPrice = data.product_fields["list_price"];
  if (listPrice !== undefined) data.list_price = parseMoney(listPrice);
  data.last_update_scan = data.product_fields["last_update_scan"];
  data.last_tracked = data.product_fields["last_tracked"];

  // ---- price history section: heading, descriptions, range switcher, type toggles
  const phHeading = q(root, "#phh3");
  if (phHeading !== undefined) {
    data.section_heading = text(phHeading);
    c.take(phHeading);
  }
  const descs = qa(root, ".history-desc");
  for (const [i, d] of descs.entries()) {
    const t = text(d);
    const since = /since we began monitoring it on(?: on)?\s+(.+?)\.?\s*$/i.exec(t)?.[1];
    if (since !== undefined && data.monitoring_since_raw === undefined) {
      data.monitoring_since_raw = collapse(since);
      const iso = parseLooseDate(since);
      if (iso !== undefined) data.monitoring_since = iso;
      meta.strategies["monitoring_since"] = "text-anchor";
      c.take(d);
    } else if (/price types?/i.test(t) && i > 0) {
      data.price_types_description = t;
      c.take(d);
    }
  }
  const periodList = q(root, "#tpbg");
  for (const li of qa(periodList, "li.tp, li[data-field]")) {
    const a = q(li, "a");
    const key = attr(li, "data-field") ?? attr(a, "data-field") ?? "";
    if (key === "") continue;
    const title = attr(a, "title");
    const opt: CamelPeriodOption = {
      key,
      label: attr(a, "data-text-xlarge") ?? (text(a) || key),
      active: /\bactive\b/.test(attr(li, "class") ?? ""),
    };
    if (title !== undefined) {
      opt.title = title;
      const since = /going back to (.+)$/i.exec(title)?.[1];
      if (since !== undefined) {
        opt.since_raw = collapse(since);
        const iso = parseLooseDate(since);
        if (iso !== undefined) opt.since = iso;
      }
    }
    data.periods.push(opt);
  }
  if (periodList !== undefined) {
    c.take(periodList);
    data.active_period = data.periods.find((p) => p.active)?.key;
    meta.strategies["periods"] = "id";
  }
  const toggles = qa(root, "ul.chart_types li.pt, ul.chart_types li[data-field]");
  for (const li of toggles) {
    const label = text(q(li, "label a, a")) || text(li);
    const field = attr(li, "data-field");
    const box = li.querySelector("input[type=checkbox]");
    const title = attr(q(li, "a"), "title");
    data.price_type_toggles.push({
      type: camelTypeFromField(field, label),
      label,
      selected: box?.hasAttribute("checked") ?? false,
      no_data: /disabled/.test(attr(li, "class") ?? "") || /no data/i.test(title ?? ""),
      ...(title !== undefined ? { title } : {}),
    });
  }
  const toggleList = q(root, "ul.chart_types");
  if (toggleList !== undefined) c.take(toggleList);

  // ---- chart
  data.chart_urls = chartUrlsFrom(doc, meta, c);
  const chartParent = q(root, "#chart_parent");
  if (chartParent !== undefined) c.take(chartParent);

  // ---- stats table
  const statsTable =
    q(root, ".camelegend table") ??
    qa(root, "table").find((t) => {
      const h = text(q(t, "thead") ?? q(t, "tr")).toLowerCase();
      return /lowest/.test(h) && /highest/.test(h);
    });
  if (statsTable !== undefined) {
    data.stats = camelStatsFromTable(statsTable, c, meta, data);
    c.take(statsTable.closest(".camelegend") ?? statsTable);
    meta.strategies["stats"] = q(root, ".camelegend table") !== undefined ? "id" : "label";
  } else {
    meta.warnings.push("stats: no statistics table found");
  }

  // ---- buy box (raw DOM so that the collapsed "Out of Stock" rows are read too)
  const buyTop = q(root, "#buy-box .top") ?? q(root, "#buy-box");
  if (buyTop !== undefined) {
    for (const cell of Array.from(buyTop.querySelectorAll(".cell"))) {
      const labelEl = cell.querySelector(".price-type-label");
      if (labelEl === null) continue;
      const label = collapse(labelEl.textContent ?? "").replace(/\s*Price$/i, "");
      const valueEl = cell.querySelector(".bgp");
      const valueText = collapse(valueEl?.textContent ?? "");
      const price = parseMoney(valueText);
      const asOf = collapse(cell.querySelector(".pricing-date")?.textContent ?? "");
      const asOfRaw = asOf.replace(/^as of\s*/i, "");
      const entry: CamelBuyBoxEntry = { type: camelTypeOf(label), label };
      if (price !== undefined) entry.price = price;
      else if (valueText !== "") entry.availability = valueText;
      if (asOfRaw !== "") {
        entry.as_of_raw = asOfRaw;
        const iso = parseLooseDate(asOfRaw);
        if (iso !== undefined) entry.as_of_date = iso;
      }
      data.buy_box.push(entry);
    }
    if (data.buy_box.length > 0) meta.strategies["buy_box"] = "id";
    c.take(buyTop);
  }
  const watches = q(root, "#existing-price-watches");
  if (watches !== undefined) {
    for (const cell of qa(watches, ".grid-x > .cell")) {
      const t = text(cell);
      if (t !== "") data.price_watches.push(t);
    }
    c.take(watches);
  }
  c.takeAll(qa(root, "#buy-box a.add-price-watch"));

  // ---- price change history (layout not captured; anchored on headings and headers)
  data.series = parseSeriesTables(root, c, meta);

  // ---- state
  const notice = qa(root, "p, h1, h2, h3, h4, div.callout, div.message, span")
    .filter((el) => !c.covers(el))
    .map((el) => ({ el, t: text(el) }))
    .find(
      ({ t }) =>
        t.length > 0 && t.length <= 400 && (NOT_TRACKED_RE.test(t) || NOT_FOUND_RE.test(t)),
    );
  const anyData = data.stats.some((s) => s.has_data) || data.series.length > 0;
  if (notice !== undefined && !anyData) {
    data.state = NOT_FOUND_RE.test(notice.t) ? "not_found" : "not_tracked";
    data.state_message = notice.t;
    c.take(notice.el);
    meta.strategies["state"] = "text-anchor";
  } else if (data.stats.length > 0 && !anyData) {
    data.state = "no_data";
    data.state_message = "every price type shows no data";
    meta.strategies["state"] = "label";
  } else if (data.stats.length > 0 || data.series.length > 0) {
    data.state = "ok";
    meta.strategies["state"] = "label";
  }

  const nothing =
    data.title === undefined &&
    data.asin === undefined &&
    data.stats.length === 0 &&
    data.state === undefined;
  if (nothing) {
    throw new RfError(
      "layout_unrecognized",
      "camelcamelcamel page: no product, statistics or notice found",
    );
  }

  const report = losslessReport(doc, c, { root, base: capture.final_url });
  meta.unparsed_text_chars = report.counts.unparsed;
  return { data, other_sections: report.sections, meta };
};

// ---------------------------------------------------------------------------------------
// Amazon
// ---------------------------------------------------------------------------------------

export type AmazonBasisKind = "typical" | "list" | "was" | "other";

export interface AmazonBasisPrice {
  /** Label as shown, without the colon: "Typical price", "List Price". */
  label: string;
  kind: AmazonBasisKind;
  price: Money;
  /** Amazon's explanatory text for the label (read from the hidden popover), when present. */
  explanation?: string;
  /** Days named in the explanation ("90-day median" -> 90). */
  window_days?: number;
}

export type AmazonStatementKind = "low" | "high" | "drop" | "other";

export interface AmazonPriceStatement {
  kind: AmazonStatementKind;
  /** The sentence or badge as shown. */
  text: string;
  /** Window the statement refers to, in days (month = 30, year = 365). */
  window_days?: number;
  price?: Money;
  /** Percentage when the statement names one. */
  percent?: number;
  /** "main" or the capture fragment it was found in. */
  source: string;
}

export interface AmazonIngressEntry {
  id?: string;
  /** data-ingress-position: "buybox" or "central". */
  position?: string;
  ref_marker?: string;
  /** The text sent to the assistant when the pill is clicked. */
  query_text?: string;
  nile_action_id?: string;
  group_id?: string;
  item_id?: string;
  /** Pill label as shown. */
  label?: string;
  /** True when the pill is rendered (the page hides it for assistant-ineligible sessions). */
  rendered: boolean;
}

export interface AmazonIngress {
  present: boolean;
  entries: AmazonIngressEntry[];
  /** data-action of the declarative click handler on the pill. */
  declarative_action?: string;
  /** Stream parameters the click handler sends (from the inline script). */
  stream_qis?: string;
  stream_metric_name?: string;
  /** The only path visible in the DOM: where the assistant panel content is fetched from. */
  panel_render_path?: string;
  /** The inline script hides the pill until the page's assistant-eligibility flag is set. */
  gated_on_assistant_eligibility: boolean;
  panel?: {
    container_id: string;
    state?: string;
    open_button_id?: string;
    open_button_label?: string;
  };
  /** What a user does to open it, and what happens. */
  mechanism: string;
}

export interface AmazonPriceHistory {
  asin?: string;
  current_price?: Money;
  /** "-23%" style savings badge, as a positive number. */
  savings_percent?: number;
  savings_label?: string;
  /** First labelled "Typical price" basis price. */
  typical_price?: Money;
  /** First labelled "List Price" basis price. */
  list_price?: Money;
  basis_prices: AmazonBasisPrice[];
  /** "Lowest price in N days" style badges and similar sentences. */
  statements: AmazonPriceStatement[];
  /** Text of a price-insight badge, when the page renders one. */
  insight_text?: string;
  ingress: AmazonIngress;
  /** False unless a series is embedded in the capture. */
  series_available: boolean;
  series_note: string;
  series?: DatedPrice[];
}

const INGRESS_MECHANISM =
  "Clicking the Price history pill (a button inside span.rufus-ingress-badge, wrapped in a span.a-declarative whose data-action is show-rufus-price-ingress) runs a click handler that calls the page-level rufus-handle-stream function with {qis, query: data-query-text, metricName, refMarker}. That opens the shopping assistant panel (#nav-flyout-rufus, normally closed) and streams the answer into it; the panel markup is fetched from the render path. No price-history endpoint or series is present in the page DOM.";

const SERIES_NOTE_PANEL =
  "The price history chart is produced inside the interactive assistant panel after a click; the capture contains no series.";
const SERIES_NOTE_NONE =
  "The capture contains neither a price history series nor an ingress to it.";

const WINDOW_UNITS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

function windowDays(n: string, unit: string): number | undefined {
  const mult = WINDOW_UNITS[unit.toLowerCase().replace(/s$/, "")];
  const v = Number(n);
  return mult === undefined || !Number.isFinite(v) ? undefined : v * mult;
}

const STATEMENT_RES: { kind: AmazonStatementKind; re: RegExp }[] = [
  {
    kind: "low",
    re: /\blowest price (?:in|over|during|within) (?:the )?(?:last|past)?\s*(\d+)[- ]?(day|week|month|year)s?\b/i,
  },
  { kind: "low", re: /\b(\d+)[- ](day|week|month|year) low\b/i },
  {
    kind: "high",
    re: /\bhighest price (?:in|over|during|within) (?:the )?(?:last|past)?\s*(\d+)[- ]?(day|week|month|year)s?\b/i,
  },
  { kind: "high", re: /\b(\d+)[- ](day|week|month|year) high\b/i },
  {
    kind: "drop",
    re: /\bprice (?:drop|dropped|decrease)[^.]*?(?:in|over) (?:the )?(?:last|past)\s*(\d+)[- ]?(day|week|month|year)s?\b/i,
  },
  {
    kind: "other",
    re: /\b(?:in|over|during) the (?:last|past) (\d+)[- ]?(day|week|month|year)s?\b[^.]*\$\d/i,
  },
];

function statementOf(t: string, source: string): AmazonPriceStatement | undefined {
  for (const { kind, re } of STATEMENT_RES) {
    const m = re.exec(t);
    if (m === null) continue;
    const out: AmazonPriceStatement = { kind, text: t, source };
    const days = windowDays(m[1] ?? "", m[2] ?? "");
    if (days !== undefined) out.window_days = days;
    const price = parseMoney(t);
    if (price !== undefined) out.price = price;
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(t)?.[1];
    if (pct !== undefined) out.percent = Number(pct);
    return out;
  }
  return undefined;
}

/** Innermost visible short elements whose own text is a price-history statement. */
/** Text of the nodes directly under an element, descendants skipped. */
function ownTextOf(el: DomElement): string {
  let s = "";
  for (let i = 0; i < el.childNodes.length; i++) {
    const n = el.childNodes[i];
    if (n !== undefined && n.nodeType === TEXT_NODE) s += n.textContent ?? "";
  }
  return collapse(s);
}

function findStatements(
  scopes: readonly (DomElement | DomDocument)[],
  source: string,
  c: Consumption | undefined,
): AmazonPriceStatement[] {
  const hits: { el: DomElement; st: AmazonPriceStatement }[] = [];
  const seen = new Set<DomElement>();
  for (const scope of scopes) {
    for (const el of qa(scope, "span, div, p, li, a, h1, h2, h3, h4, td")) {
      if (seen.has(el)) continue;
      seen.add(el);
      // other products' cards (carousels, sponsored, bought together) are not this item's
      const inCard = (e: DomElement): boolean => e.matches(".a-carousel-card, [id^='sp_detail']");
      if (el.closest(".a-carousel-card, [id^='sp_detail']") !== null) continue;
      const t = text(el, { exclude: inCard });
      if (t === "" || t.length > 200) continue;
      // the phrase must be the element's own words, or the element must be short (a badge
      // split over inline spans); a wrapper holding a badge plus other text is not reported
      if (statementOf(ownTextOf(el), source) === undefined && t.length > 80) continue;
      const st = statementOf(t, source);
      if (st !== undefined) hits.push({ el, st });
    }
  }
  const els = new Set(hits.map((h) => h.el));
  const out: AmazonPriceStatement[] = [];
  for (const { el, st } of hits) {
    // keep only the innermost element of a nest
    let hasInner = false;
    for (const other of els) {
      if (other !== el && isInside(other, el)) {
        hasInner = true;
        break;
      }
    }
    if (hasInner) continue;
    if (!out.some((o) => o.text === st.text && o.kind === st.kind)) out.push(st);
    c?.take(el);
  }
  return out;
}

function isInside(el: DomElement, ancestor: DomElement): boolean {
  for (let cur: DomElement | null = el; cur !== null; cur = cur.parentElement) {
    if (cur === ancestor) return true;
  }
  return false;
}

function ownBasisLabelKind(label: string): AmazonBasisKind {
  const l = label.toLowerCase();
  if (/typical/.test(l)) return "typical";
  if (/list|msrp/.test(l)) return "list";
  if (/\bwas\b/.test(l)) return "was";
  return "other";
}

const BASIS_LABEL_RE =
  /^(typical price|(?:print |bundle )?list price|was|m\.?s\.?r\.?p\.?)\s*:?\s*(.*)$/i;

interface Basis {
  label: string;
  price: Money;
}

function basisFromFeature(el: DomElement, meta: ParseMeta): Basis | undefined {
  return firstOf<Basis>(
    "basis_price",
    [
      [
        "data-attr",
        () => {
          const offscreen = q(el, ".apex-basisprice-offscreen-label, [data-basisprice-label]");
          const m = /^(.+?)\s*:\s*(.+)$/.exec(text(offscreen));
          const price = parseMoney(m?.[2]);
          return m !== null && price !== undefined
            ? { label: stripTrailingColon(m[1] ?? ""), price }
            : undefined;
        },
      ],
      [
        "label",
        () => {
          const label = stripTrailingColon(text(q(el, ".apex-basisprice-label")));
          const price = moneyFromPriceElement(q(el, ".apex-basisprice-value, .a-price"));
          return label !== "" && price !== undefined ? { label, price } : undefined;
        },
      ],
      [
        "text-anchor",
        () => {
          const m = BASIS_LABEL_RE.exec(text(el));
          const price = parseMoney(m?.[2]);
          return m !== null && price !== undefined
            ? { label: stripTrailingColon(m[1] ?? ""), price }
            : undefined;
        },
      ],
    ],
    meta,
    { optional: true },
  );
}

function popoverExplanation(el: DomElement): string | undefined {
  // The legal text sits in a hidden popover preload: read it from the raw DOM on purpose.
  const node = el.querySelector(".apex-basisprice-legal-message-popover-content-text");
  if (node === null) return undefined;
  let s = "";
  for (let i = 0; i < node.childNodes.length; i++) {
    const n = node.childNodes[i];
    if (n !== undefined && n.nodeType === TEXT_NODE) s += n.textContent ?? "";
  }
  const out = collapse(s);
  return out === "" ? undefined : out;
}

function findSeries(doc: DomDocument): DatedPrice[] | undefined {
  const keyRe = /^price_?history$/i;
  const visit = (v: unknown, depth: number): DatedPrice[] | undefined => {
    if (depth > 6 || v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = visit(item, depth + 1);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (keyRe.test(k) && Array.isArray(val)) {
        const pts: DatedPrice[] = [];
        for (const item of val) {
          let when: unknown;
          let amount: unknown;
          if (Array.isArray(item)) [when, amount] = item;
          else if (item !== null && typeof item === "object") {
            const o = item as Record<string, unknown>;
            when = o["date"] ?? o["timestamp"] ?? o["time"];
            amount = o["price"] ?? o["amount"] ?? o["value"];
          }
          if (typeof when !== "string" && typeof when !== "number") continue;
          if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
          pts.push(datedPoint(String(when), { amount, currency: "USD", raw: String(amount) }));
        }
        if (pts.length > 0) return pts;
      }
      const r = visit(val, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  for (const s of Array.from(
    doc.querySelectorAll("script[type='application/json'], script[type='application/ld+json']"),
  )) {
    const r = visit(tryJson(s.textContent), 0);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** The visible core price block (not its wrapper), or undefined. */
function amazonCorePrice(doc: DomDocument): DomElement | undefined {
  const nonEmpty = (el: DomElement): boolean => text(el) !== "";
  return (
    qa(doc, "#corePriceDisplay_desktop_feature_div").find(nonEmpty) ??
    qa(doc, "#corePrice_feature_div").find(nonEmpty)
  );
}

/**
 * The lossless scope of the Amazon parser: the price block (offer rows included), not the
 * whole product page, which the product parser already covers.
 */
export function amazonPriceRoot(doc: DomDocument): DomElement | undefined {
  return q(doc, "#apex_desktop") ?? amazonCorePrice(doc) ?? q(doc, "#centerCol") ?? undefined;
}

export const parseAmazonPriceHistory: Parser<AmazonPriceHistory> = (
  capture: Capture,
): ParseResult<AmazonPriceHistory> => {
  const meta = newMeta();
  const doc = parseDocument(capture.html);
  const c = new Consumption();

  // The lossless scope is the price block, not the whole product page.
  const corePrice = amazonCorePrice(doc);
  const root = amazonPriceRoot(doc);

  // ---- ingress
  const ingressEls = Array.from(
    doc.querySelectorAll(
      "[id^='rufus-price-ingress'], [data-csa-c-nile-action-id*='price_history']",
    ),
  );
  const entries: AmazonIngressEntry[] = [];
  for (const el of ingressEls) {
    const pill = q(el, ".a-button-text") ?? q(el, "a, button");
    const rendered = visible(el) && (pill === undefined ? text(el) !== "" : visible(pill));
    const entry: AmazonIngressEntry = { rendered };
    const set = (key: keyof AmazonIngressEntry, v: string | undefined): void => {
      if (v !== undefined && v !== "") (entry as unknown as Record<string, unknown>)[key] = v;
    };
    set("id", el.id || undefined);
    set("position", attr(el, "data-ingress-position"));
    set("ref_marker", attr(el, "data-ref-marker"));
    set("query_text", attr(el, "data-query-text"));
    set("nile_action_id", attr(el, "data-csa-c-nile-action-id"));
    set("group_id", attr(el, "data-csa-c-group-id"));
    set("item_id", attr(el, "data-csa-c-item-id"));
    set("label", text(pill) || undefined);
    entries.push(entry);
    if (rendered) c.take(el);
  }
  let streamQis: string | undefined;
  let streamMetric: string | undefined;
  let renderPath: string | undefined;
  let gated = false;
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    const body = script.textContent ?? "";
    if (/show-rufus-price-ingress/.test(body)) {
      streamQis ??= /qis:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
      streamMetric ??= /metricName:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
      if (/rufus-eligible/.test(body)) gated = true;
    }
    renderPath ??= /["'](\/rufus\/cl\/render[^"']*)["']/.exec(body)?.[1];
  }
  const declarative = attr(
    Array.from(doc.querySelectorAll("[data-action^='show-rufus-price']"))[0],
    "data-action",
  );
  const panelEl = doc.querySelector("#nav-flyout-rufus");
  const openBtn = doc.querySelector("#nav-rufus-disco");
  const ingress: AmazonIngress = {
    present: entries.length > 0,
    entries,
    gated_on_assistant_eligibility: gated,
    mechanism: INGRESS_MECHANISM,
  };
  if (declarative !== undefined) ingress.declarative_action = declarative;
  if (streamQis !== undefined) ingress.stream_qis = streamQis;
  if (streamMetric !== undefined) ingress.stream_metric_name = streamMetric;
  if (renderPath !== undefined) ingress.panel_render_path = renderPath;
  if (panelEl !== null) {
    ingress.panel = { container_id: panelEl.id };
    const state = attr(panelEl, "data-state");
    if (state !== undefined) ingress.panel.state = state;
    if (openBtn !== null) {
      ingress.panel.open_button_id = openBtn.id;
      const label = attr(openBtn, "aria-label");
      if (label !== undefined) ingress.panel.open_button_label = label;
    }
  }
  if (entries.length > 0) meta.strategies["ingress"] = "id";

  // ---- asin
  const asin = firstOf(
    "asin",
    [
      ["data-attr", () => entries.map((e) => e.item_id).find((v) => isAsin(v))],
      [
        "id",
        () => {
          // a hidden form input: carries the hidden marker in captures, so read the raw DOM
          const v = attr(doc.querySelector("input#ASIN, input[name=ASIN]") ?? undefined, "value");
          return isAsin(v) ? v : undefined;
        },
      ],
      [
        "url",
        () => /\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/.exec(capture.final_url || capture.url)?.[1],
      ],
    ],
    meta,
    { optional: true },
  );

  // ---- current price and savings
  const priceScope = corePrice ?? root ?? doc;
  const priceEl = q(priceScope, ".priceToPay, .apex-pricetopay-value");
  const accessEl = q(priceScope, "#apex-pricetopay-accessibility-label");
  const current = firstOf<Money>(
    "current_price",
    [
      ["id", () => moneyFromPriceElement(priceEl)],
      ["label", () => parseMoney(text(accessEl))],
      [
        "data-attr",
        () => {
          const v = attr(q(priceScope, "[data-csa-c-price-to-pay]"), "data-csa-c-price-to-pay");
          if (v === undefined || !/^\d+(?:\.\d+)?$/.test(v)) return undefined;
          return { amount: Number(v), currency: "USD", raw: `$${v}` };
        },
      ],
      [
        "legacy",
        () =>
          moneyFromPriceElement(
            q(doc, "#priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox"),
          ),
      ],
    ],
    meta,
  );
  if (priceEl !== undefined) c.take(priceEl);
  const savingsEl = q(priceScope, ".apex-savings-percentage, .savingsPercentage");
  const savings = firstOf<{ percent: number; label?: string }>(
    "savings_percent",
    [
      [
        "id",
        () => {
          const m = /(\d+(?:\.\d+)?)\s*%/.exec(text(savingsEl));
          return m === null ? undefined : { percent: Number(m[1]), label: text(savingsEl) };
        },
      ],
      [
        "label",
        () => {
          const t = text(accessEl);
          const m = /(\d+(?:\.\d+)?)\s*percent savings/i.exec(t);
          return m === null ? undefined : { percent: Number(m[1]), label: t };
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (savingsEl !== undefined) c.take(savingsEl.closest(".apex-savings-container") ?? savingsEl);
  if (accessEl !== undefined) c.take(accessEl);

  // ---- basis prices (typical / list)
  const basisPrices: AmazonBasisPrice[] = [];
  const featureScope = root ?? doc;
  for (const el of qa(featureScope, ".apex-basisprice-feature")) {
    if (el.closest(".a-carousel-card, [id^='sp_detail']") !== null) continue;
    const b = basisFromFeature(el, meta);
    if (b === undefined) continue; // label-less (variant tiles): left to other_sections
    const kind = ownBasisLabelKind(b.label);
    if (basisPrices.some((p) => p.kind === kind && p.price.amount === b.price.amount)) {
      c.take(el);
      continue;
    }
    const entry: AmazonBasisPrice = { label: b.label, kind, price: b.price };
    const explanation = popoverExplanation(el);
    if (explanation !== undefined) {
      entry.explanation = explanation;
      const days = /(\d+)-day/.exec(explanation)?.[1];
      if (days !== undefined) entry.window_days = Number(days);
    }
    basisPrices.push(entry);
    c.take(el);
  }

  // ---- statements and insight badge
  // Scope: the price block and the buy box only, never the whole page.
  const statementScopes: DomElement[] = [];
  if (root !== undefined) statementScopes.push(root);
  statementScopes.push(...qa(doc, "#buybox, #desktop_buybox"));
  const statements = findStatements(statementScopes, "main", c);
  for (const [name, html] of Object.entries(capture.fragments ?? {})) {
    statements.push(...findStatements([parseDocument(html)], name, undefined));
  }
  if (statements.length > 0) meta.strategies["statements"] = "text-anchor";
  const insightEls = qa(doc, ".price-insights-ingress-desktop-text");
  const insightText = insightEls
    .map((el) => text(el))
    .filter((t) => t !== "")
    .join(" ");
  for (const el of insightEls) c.take(el.closest(".price-insights-prominence-badge") ?? el);
  if (insightText !== "") meta.strategies["insight_text"] = "label";

  // ---- series
  const embedded = findSeries(doc);
  let seriesNote = SERIES_NOTE_NONE;
  if (embedded !== undefined) seriesNote = "A series is embedded in the capture.";
  else if (entries.length > 0) seriesNote = SERIES_NOTE_PANEL;

  if (
    corePrice === undefined &&
    root === undefined &&
    entries.length === 0 &&
    basisPrices.length === 0
  ) {
    throw new RfError("layout_unrecognized", "no price block or price history ingress found");
  }

  const data: AmazonPriceHistory = {
    basis_prices: basisPrices,
    statements,
    ingress,
    series_available: embedded !== undefined,
    series_note: seriesNote,
  };
  if (asin !== undefined) data.asin = asin;
  if (current !== undefined) data.current_price = current;
  if (savings !== undefined) {
    data.savings_percent = savings.percent;
    if (savings.label !== undefined) data.savings_label = savings.label;
  }
  data.typical_price = basisPrices.find((p) => p.kind === "typical")?.price;
  data.list_price = basisPrices.find((p) => p.kind === "list")?.price;
  if (data.typical_price === undefined) delete data.typical_price;
  if (data.list_price === undefined) delete data.list_price;
  if (insightText !== "") data.insight_text = insightText;
  if (embedded !== undefined) data.series = embedded;

  const report = losslessReport(
    doc,
    c,
    root === undefined ? {} : { root, base: capture.final_url },
  );
  meta.unparsed_text_chars = report.counts.unparsed;
  const other: OtherSection[] = report.sections;
  return { data, other_sections: other, meta };
};
