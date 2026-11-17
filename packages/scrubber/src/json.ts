/**
 * Recursive JSON scrub for allowlisted data blobs and JSON-valued attributes: keys kept
 * (after the token pass), strings through the text rules, numbers kept in magnitude class.
 */
import { JSON_KEPT_KEYS } from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";
import { scrubText, scrubTokens } from "./text.ts";
import { SYNTHETIC } from "./rules.mjs";
import { scrubUrl } from "./url.ts";

const KEPT = new Set(JSON_KEPT_KEYS);
const ZIP_KEY = /zip|postal/i;
const ASIN_KEY = /asin/i;
const URL_KEY = /(?:url|href|link|src|image|img|thumb|icon)s?$/i;
const IMAGE_KEY = /(?:image|img|thumb|icon|src)s?$/i;
const IDENT = /^[A-Za-z_$@][\w$@:.-]*$/;
const MARKUP = /^\s*<[A-Za-z!][\s\S]*>\s*$/;
const CLOSING_TAG = /<\/[A-Za-z][\w-]*\s*>|<[A-Za-z][^<>]*\/>/;

type HtmlScrubber = (html: string, ctx: ScrubContext) => string;
let htmlScrubber: HtmlScrubber | undefined;

/**
 * html.ts registers its fragment scrubber here (it imports this module, so this module
 * cannot import it back). An HTML string inside JSON (a popover's inlineContent) is then
 * scrubbed as markup, structure kept, instead of word by word as text.
 */
export function registerHtmlScrubber(fn: HtmlScrubber): void {
  htmlScrubber = fn;
}

function scrubNumber(n: number, ctx: ScrubContext): number {
  if (!Number.isFinite(n)) return n;
  const txt = String(Math.abs(n));
  if (Number.isInteger(n) && txt.length >= 9 && !/e/i.test(txt)) {
    // An id-sized integer: an obvious placeholder of the same length.
    ctx.count("id");
    return Number(ctx.placeholderDigits(txt)) * Math.sign(n);
  }
  const frac = /\.(\d+)$/.exec(txt)?.[1];
  if (frac !== undefined && frac.length >= 10) {
    // A full-precision score or rate: a short placeholder value in the same range.
    ctx.count("number");
    return Math.sign(n) * (Math.floor(Math.abs(n)) + 0.5);
  }
  const dec = /^-?\d+\.(\d{1,2})$/.exec(String(n));
  if (dec !== null) {
    // A decimal with cents is an amount: scaled in magnitude like amounts in text.
    ctx.count("number");
    const sign = n < 0 ? -1 : 1;
    const [whole = "0"] = String(Math.abs(n)).split(".");
    return sign * Number(ctx.scaleAmount(whole, dec[1]));
  }
  const sign = n < 0 ? "-" : "";
  const text = String(Math.abs(n));
  if (/e/i.test(text) || /^\d$/.test(text)) return n;
  ctx.count("number");
  return Number(sign + text.replace(/\d+/g, (run) => ctx.fakeDigits(run)));
}

function scrubKey(key: string, ctx: ScrubContext): string {
  // A map keyed by an account id ({"<shipId>": ...}) must not keep the id as a key.
  if (ctx.knownIds.has(key)) {
    ctx.count("id");
    return ctx.fakeToken(key);
  }
  if (/^(?:https?:)?\/\//i.test(key)) return scrubUrl(key, ctx, "auto");
  const t = scrubTokens(key, ctx);
  return IDENT.test(t) ? t : scrubText(key, ctx);
}

function scrubString(v: string, key: string | null, ctx: ScrubContext): string {
  if (htmlScrubber !== undefined && MARKUP.test(v) && CLOSING_TAG.test(v)) {
    ctx.count("json_blob");
    return htmlScrubber(v, ctx);
  }
  // Same rule as kept attributes: a URL, JSON or markup under a kept key is data.
  if (key !== null && KEPT.has(key) && !/[{}<>"]|:\/\//.test(v)) return scrubTokens(v, ctx);
  if (key !== null && ZIP_KEY.test(key) && /^\d{5}(?:-\d{4})?$/.test(v)) {
    ctx.count("zip");
    return ctx.fakeZip(v.slice(0, 5)) + (v.length > 5 ? "-0000" : "");
  }
  if (key !== null && ASIN_KEY.test(key) && /^[A-Za-z0-9]{10}$/.test(v)) {
    ctx.count("asin");
    return ctx.fakeAsin(v.toUpperCase());
  }
  if (
    /^(?:https?:)?\/\//i.test(v.trim()) ||
    (key !== null && URL_KEY.test(key) && /^[/?]/.test(v))
  ) {
    return scrubUrl(v, ctx, key !== null && IMAGE_KEY.test(key) ? "image" : "auto");
  }
  return scrubText(v, ctx);
}

/** Card last digits under any of these keys are always "0000" (or 0). */
const CARD_DIGITS_KEY = /^(?:last(?:4|four|digits|fourdigits)|tail|cardtail|panlast4)$/i;
/** Card expiry under these keys is always one fixed fake date. */
const EXPIRY_KEY = /expir|^exp(?:month|year|date)?$/i;
// Synthetic on purpose (SYNTHETIC.cardExpiry): the same fake expiry for every card.
const FAKE_EXPIRY = SYNTHETIC.cardExpiry;
/** A long number under an id-like key is an account id: an obvious placeholder instead. */
const ID_KEY = /(?:id|Id|ID)$/;

function placeholderNumber(digits: number, ctx: ScrubContext): number {
  ctx.count("id");
  return Number(`9${"0".repeat(Math.max(0, digits - 2))}1`);
}

/** Booleans describing the account or its feature cohorts are always false. */
const ACCOUNT_FLAG_KEY =
  /^(?:is|has)[A-Z]\w*(?:Customer|Prime|Pinnacle|Business|Addresses|Member|Enabled|Eligible|Profile|Fresh|OutOfArea)\w*$/;

export function scrubJson(value: unknown, ctx: ScrubContext, key: string | null = null): unknown {
  if (key !== null && typeof value === "boolean" && ACCOUNT_FLAG_KEY.test(key)) return false;
  if (
    key !== null &&
    CARD_DIGITS_KEY.test(key) &&
    (typeof value === "string" || typeof value === "number")
  ) {
    ctx.count("card");
    return typeof value === "number" ? 0 : "0000";
  }
  if (key !== null && EXPIRY_KEY.test(key)) {
    ctx.count("card");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value as object)) {
        out[scrubKey(k, ctx)] = /year/i.test(k)
          ? FAKE_EXPIRY.year
          : /month/i.test(k)
            ? FAKE_EXPIRY.month
            : null;
      }
      return out;
    }
    if (typeof value === "number") return /month/i.test(key) ? FAKE_EXPIRY.month : FAKE_EXPIRY.year;
    if (typeof value === "string") return "01/30";
  }
  if (key !== null && ID_KEY.test(key)) {
    if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) >= 1_000_000) {
      return placeholderNumber(String(Math.abs(value)).length, ctx);
    }
    if (typeof value === "string" && /^\d{7,}$/.test(value)) {
      return String(placeholderNumber(value.length, ctx));
    }
  }
  if (typeof value === "string") return scrubString(value, key, ctx);
  if (typeof value === "number") {
    if (key !== null && ZIP_KEY.test(key)) {
      ctx.count("zip");
      return ctx.fakeZip(String(value));
    }
    if (key !== null && ASIN_KEY.test(key) && /^\d{9,10}$/.test(String(value))) {
      ctx.count("asin");
      return ctx.fakeAsin(String(value));
    }
    return scrubNumber(value, ctx);
  }
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, ctx, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubKey(k, ctx)] = scrubJson(v, ctx, k);
    }
    return out;
  }
  return value;
}

/** JSON.stringify that is ASCII-only and safe inside a <script> element. */
export function stringifySafe(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u0080-\uffff]/g, (c) => {
    return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  });
}
