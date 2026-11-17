/**
 * Recursive JSON scrub for allowlisted data blobs and JSON-valued attributes: keys kept
 * (after the token pass), strings through the text rules, numbers kept in magnitude class.
 */
import { JSON_KEPT_KEYS } from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";
import { scrubText, scrubTokens } from "./text.ts";
import { scrubUrl } from "./url.ts";

const KEPT = new Set(JSON_KEPT_KEYS);
const ZIP_KEY = /zip|postal/i;
const ASIN_KEY = /asin/i;
const URL_KEY = /(?:url|href|link|src|image|img|thumb|icon)s?$/i;
const IMAGE_KEY = /(?:image|img|thumb|icon|src)s?$/i;
const IDENT = /^[A-Za-z_$@][\w$@:.-]*$/;

function scrubNumber(n: number, ctx: ScrubContext): number {
  if (!Number.isFinite(n)) return n;
  const sign = n < 0 ? "-" : "";
  const text = String(Math.abs(n));
  if (/e/i.test(text) || /^\d$/.test(text)) return n;
  ctx.count("number");
  return Number(sign + text.replace(/\d+/g, (run) => ctx.fakeDigits(run)));
}

function scrubKey(key: string, ctx: ScrubContext): string {
  if (/^(?:https?:)?\/\//i.test(key)) return scrubUrl(key, ctx, "auto");
  const t = scrubTokens(key, ctx);
  return IDENT.test(t) ? t : scrubText(key, ctx);
}

function scrubString(v: string, key: string | null, ctx: ScrubContext): string {
  if (key !== null && KEPT.has(key)) return scrubTokens(v, ctx);
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

export function scrubJson(value: unknown, ctx: ScrubContext, key: string | null = null): unknown {
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
