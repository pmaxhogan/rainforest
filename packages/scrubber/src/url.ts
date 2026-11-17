/**
 * URL rewriting: every absolute URL moves to the placeholder host, media becomes the
 * placeholder image, path segments keep their SHAPE (ASINs and order ids mapped, known
 * structural segments kept, anything else becomes a synthetic slug), and the query string
 * is cut down to allowlisted parameter names with scrubbed values.
 */
import { PATH_SEGMENTS, QUERY_PARAMS } from "./allowlists.ts";
import type { ScrubContext } from "./context.ts";
import { FAKE_RANGES } from "./rules.mjs";
import { scrubText, scrubTokens } from "./text.ts";

export type UrlKind = "page" | "image" | "auto";

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|mp4|webm)$/i;
const IMAGE_HOST = /(?:^|[.-])(?:images?|img|media)[.-]/i;
const ASIN_TOKEN = /^[BX]0[A-Z0-9]{8}$/i;
const ISBN_TOKEN = /^\d{9}[\dX]$/i;
const ORDER_TOKEN = /^[0-9D]\d{2}-\d{7}-\d{7}$/i;
const ASIN_PARENTS = new Set(["dp", "product", "product-reviews", "d", "asin", "offer-listing"]);
const SEGMENTS = new Set(PATH_SEGMENTS);
const SAFE_FRAGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function scrubSegment(seg: string, prev: string, ctx: ScrubContext): string {
  if (seg === "") return seg;
  const dec = decode(seg);
  const lower = dec.toLowerCase();
  if (ASIN_TOKEN.test(dec) || (ISBN_TOKEN.test(dec) && ASIN_PARENTS.has(prev))) {
    ctx.count("asin");
    return ctx.fakeAsin(dec.toUpperCase());
  }
  if (ORDER_TOKEN.test(dec)) {
    ctx.count("order_id");
    return ctx.fakeOrderId(dec);
  }
  if (SEGMENTS.has(lower)) return seg;
  if (/^ref=/i.test(dec)) return "ref=rf";
  ctx.count("path_segment");
  // Product slugs are titles: synthesize word by word, keeping the separators.
  return encodeURIComponent(scrubText(dec, ctx)).replace(/%20/g, "-");
}

function scrubPath(path: string, ctx: ScrubContext): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = i > 0 ? decode(parts[i - 1] ?? "").toLowerCase() : "";
    out.push(scrubSegment(parts[i] ?? "", prev, ctx));
  }
  return out.join("/");
}

function scrubQuery(params: URLSearchParams, ctx: ScrubContext): string {
  const out = new URLSearchParams();
  for (const [name, value] of params) {
    const policy = QUERY_PARAMS.get(name);
    if (policy === undefined) {
      ctx.count("query_param_dropped");
      continue;
    }
    let v: string;
    if (ASIN_TOKEN.test(value) || (/asin/i.test(name) && ISBN_TOKEN.test(value))) {
      v = ctx.fakeAsin(value.toUpperCase());
      ctx.count("asin");
    } else if (policy === "keep") {
      v = scrubTokens(value, ctx);
    } else {
      v = scrubText(value, ctx);
    }
    out.append(name, v);
  }
  const s = out.toString();
  return s === "" ? "" : `?${s}`;
}

function scrubFragment(hash: string, ctx: ScrubContext): string {
  const frag = hash.replace(/^#/, "");
  if (frag === "") return "";
  return SAFE_FRAGMENT.test(frag) ? `#${scrubTokens(frag, ctx)}` : "";
}

/** Rewrite one URL. `kind` "image" always yields the placeholder image. */
export function scrubUrl(raw: string, ctx: ScrubContext, kind: UrlKind): string {
  const s = raw.trim();
  if (s === "") return raw;
  const lower = s.toLowerCase();
  if (s.startsWith("#")) return scrubFragment(s, ctx) || "#";
  if (lower.startsWith("mailto:")) {
    ctx.count("email");
    return `mailto:${ctx.fakeEmail(decode(s.slice(7)).toLowerCase())}`;
  }
  if (lower.startsWith("tel:")) {
    ctx.count("phone");
    return `tel:${ctx.fakePhone(s.slice(4).replace(/\D/g, ""))}`;
  }
  if (lower.startsWith("data:") || lower.startsWith("blob:")) {
    return kind === "page" ? "#" : FAKE_RANGES.imageUrl;
  }
  // javascript:, vbscript: and every other non-http scheme carry nothing parsers need.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return "#";
  let u: URL;
  try {
    u = new URL(s, "https://rf.invalid/");
  } catch {
    return kind === "image" ? FAKE_RANGES.imageUrl : "#";
  }
  const absolute = /^(?:https?:)?\/\//i.test(s);
  const image =
    kind === "image" ||
    (kind === "auto" && (IMAGE_EXT.test(u.pathname) || IMAGE_HOST.test(u.hostname)));
  if (image) {
    ctx.count("image_url");
    return FAKE_RANGES.imageUrl;
  }
  ctx.count("url");
  const rest =
    scrubPath(u.pathname, ctx) + scrubQuery(u.searchParams, ctx) + scrubFragment(u.hash, ctx);
  if (absolute) return FAKE_RANGES.host + rest;
  if (s.startsWith("/")) return rest;
  if (s.startsWith("?")) return scrubQuery(u.searchParams, ctx) + scrubFragment(u.hash, ctx);
  // Relative without a leading slash: the base path put one there; take it off again.
  return rest.replace(/^\//, "");
}

/** srcset: "url 1x, url 2x" -> placeholder image per entry, descriptors kept. */
export function scrubSrcset(value: string, ctx: ScrubContext): string {
  return value
    .split(",")
    .map((entry) => {
      const t = entry.trim();
      if (t === "") return t;
      const sp = t.search(/\s/);
      const desc = sp >= 0 ? t.slice(sp).trim() : "";
      ctx.count("image_url");
      const safeDesc = /^\d+(?:\.\d+)?[wx]$/.test(desc) ? ` ${desc}` : "";
      return FAKE_RANGES.imageUrl + safeDesc;
    })
    .join(", ");
}
