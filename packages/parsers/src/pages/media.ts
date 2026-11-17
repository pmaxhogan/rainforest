/**
 * Product media parser: `get_media`.
 *
 * Images come from the image-block JSON (JSON-first): the above-the-fold script carries the
 * current variant's gallery (`colorImages.initial`), the below-the-fold script carries one
 * entry per variant (`colorImages` keyed by the variant label, `colorToAsin` mapping label to
 * ASIN) and the video list. Newer layouts may carry `imageGalleryData`. The DOM fallbacks are
 * the `#altImages` thumbnail strip and the landing image attributes.
 *
 * SECURITY: the daemon may fetch the URLs returned here to build image blocks, so every URL
 * must pass `safeMediaUrl` (https, no credentials, default port, host under
 * MEDIA_HOST_SUFFIXES). Anything else is dropped with a warning. The image-block blobs also
 * carry session-specific fields (customer id, request id); only whitelisted fields are copied.
 *
 * The product parser owns lossless coverage of the page, so this parser returns no
 * `other_sections` and reports `unparsed_text_chars: 0`.
 */
import { RfError } from "@rainforest/core";
import type { Capture, ParseMeta, ParseResult, Parser } from "@rainforest/core";
import {
  type DomDocument,
  type DomElement,
  attr,
  collapse,
  parseCount,
  parseDocument,
  q,
  qa,
} from "../dom.ts";
import { extractBalanced, extractJsonAfter, harvestBlobs, tryJson } from "../blobs.ts";
import { firstOf, newMeta } from "../strategy.ts";

/**
 * Host suffixes a media URL may have. Evidence-based: across the captured product pages every
 * image, thumbnail, swatch and video URL was served from `m.media-amazon.com`. The legacy
 * `images-amazon.com` / `ssl-images-amazon.com` CDNs are NOT listed because no capture
 * uses them; add them only with evidence. Third-party hosts (including S3 and CloudFront,
 * which anyone can rent) must never be added: a page can reference attacker-chosen URLs.
 */
export const MEDIA_HOST_SUFFIXES: readonly string[] = ["media-amazon.com"];

/** Control characters, spaces, DEL and backslashes make URL parsers disagree; refuse them outright. */
function hasForbiddenChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/** The URL normalized, or null unless it is https, credential-free, default-port and on an Amazon media host. */
export function safeMediaUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === "" || hasForbiddenChar(s)) return null;
  if (s.startsWith("//")) s = `https:${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }
  const host = url.hostname;
  const ok = MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return ok ? url.href : null;
}

export function isAmazonMediaUrl(raw: string | null | undefined): boolean {
  return safeMediaUrl(raw) !== null;
}

// ---- data model

export interface MediaImage {
  /** Gallery slot label: MAIN, PT01, PT02, ..., EV01. Null when the page does not label it. */
  variant: string | null;
  /** Highest resolution URL. Falls back to `large` when the page lists no hi-res URL. */
  hi_res: string | null;
  large: string | null;
  thumb: string | null;
  /** Pixel size of the largest rendition the page lists (not necessarily the hi-res file). */
  width: number | null;
  height: number | null;
  alt: string | null;
  /** Amazon's physical image id (the file stem), useful to match thumbnails across blobs. */
  physical_id: string | null;
}

export type MediaVideoFormat = "mp4" | "hls" | "other";

export interface MediaVideo {
  id: string | null;
  title: string | null;
  duration_seconds: number | null;
  /** Playable asset (progressive file when the page lists one, else the manifest). */
  url: string | null;
  format: MediaVideoFormat | null;
  /** HLS manifest (`.m3u8`) when the page lists one; may equal `url`. */
  manifest_url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  /** Amazon's raw grouping label for the video (for example "IB_G1"); not interpreted. */
  group_type: string | null;
  /** Creator display name when the page names one. */
  creator: string | null;
  creator_type: string | null;
  variant: string | null;
  is_hero: boolean;
}

export interface MediaCounts {
  images: number;
  videos: number;
  /** Video total the page declares (it may list fewer inline). Null when not declared. */
  videos_declared: number | null;
  /** Variants that have their own image set. */
  variants_with_images: number;
}

export interface MediaData {
  /** ASIN of the variant the gallery belongs to. */
  asin: string | null;
  images: MediaImage[];
  /** Per-variant image sets keyed by child ASIN (or the page's variant label when no ASIN is known). Null when the page embeds none. */
  images_by_variant: Record<string, MediaImage[]> | null;
  /** Key of `images_by_variant` -> the page's variant label (for example "Black 2-Pack"). */
  variant_labels: Record<string, string> | null;
  videos: MediaVideo[];
  counts: MediaCounts;
}

// ---- generic helpers (shared with the variants parser)

/** JSON that tolerates trailing commas (object-literal style) as found in inline scripts. */
export function looseJson(src: string): unknown {
  const direct = tryJson(src);
  if (direct !== undefined) return direct;
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quote !== null) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"') {
      quote = c;
    } else if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j] as string)) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += c;
  }
  return tryJson(out);
}

/** Text of every inline classic script (not JSON / a-state data scripts, not external). */
export function inlineScriptTexts(doc: DomDocument): string[] {
  const out: string[] = [];
  for (const s of Array.from(doc.querySelectorAll("script"))) {
    if (s.hasAttribute("src")) continue;
    const type = (attr(s, "type") ?? "").toLowerCase();
    if (type !== "" && type !== "text/javascript" && type !== "module") continue;
    out.push(s.textContent ?? "");
  }
  return out;
}

const JS_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/** The JS string literal starting at `at` (a quote), unescaped; undefined when unterminated. */
export function readJsString(src: string, at: number): string | undefined {
  const quote = src[at];
  if (quote !== "'" && quote !== '"') return undefined;
  let out = "";
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i] as string;
    if (c === quote) return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = src[i + 1] ?? "";
    if (n === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (n === "\n") {
      i += 1;
    } else {
      out += JS_ESCAPES[n] ?? n;
      i += 1;
    }
  }
  return undefined;
}

export interface JsonFound {
  /** The anchor matched. */
  found: boolean;
  /** Parsed value; undefined when the payload was malformed. */
  value: unknown;
}

const PARSE_CALL = /^(?:[\w$.]*parseJSON|JSON\.parse)\(\s*/;

/**
 * The JSON payload after `anchor` in `src`: a bare literal, a `parseJSON('...')` /
 * `JSON.parse("...")` call (the payload is JSON inside a JS string, so JS escapes such as
 * `\'` are removed before parsing) or a plain quoted string.
 */
export function jsonAfter(src: string, anchor: RegExp): JsonFound {
  const re = new RegExp(anchor.source, anchor.flags.replace("g", ""));
  const m = re.exec(src);
  if (m === null) return { found: false, value: undefined };
  let at = m.index + m[0].length;
  while (at < src.length && /\s/.test(src[at] as string)) at++;
  const call = PARSE_CALL.exec(src.slice(at));
  if (call !== null) at += call[0].length;
  const ch = src[at];
  if (ch === "'" || ch === '"') {
    const literal = readJsString(src, at);
    return { found: true, value: literal === undefined ? undefined : looseJson(literal) };
  }
  const direct = extractJsonAfter(src.slice(at), /^/);
  if (direct !== undefined) return { found: true, value: direct };
  const balanced = extractBalanced(src, at);
  return { found: true, value: balanced === undefined ? undefined : looseJson(balanced) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

const ASIN_RE = /^[A-Z0-9]{10}$/;

function asinOrNull(v: unknown): string | null {
  const s = str(v);
  return s !== null && ASIN_RE.test(s) ? s : null;
}

// ---- URL gate with one summarized warning

export class MediaUrlGate {
  readonly dropped = new Map<string, number>();

  url(raw: unknown): string | null {
    const s = str(raw);
    if (s === null) return null;
    const safe = safeMediaUrl(s);
    if (safe === null) {
      let host = "unparseable";
      try {
        host = new URL(s.startsWith("//") ? `https:${s}` : s).host || "unparseable";
      } catch {
        // keep "unparseable"
      }
      this.dropped.set(host, (this.dropped.get(host) ?? 0) + 1);
    }
    return safe;
  }

  report(meta: ParseMeta, scope = "media"): void {
    if (this.dropped.size === 0) return;
    const total = Array.from(this.dropped.values()).reduce((a, b) => a + b, 0);
    const hosts = Array.from(this.dropped.keys()).sort().join(", ");
    meta.warnings.push(
      `${scope}: dropped ${total} URL(s) that are not https URLs on an Amazon media host (hosts: ${hosts})`,
    );
  }
}

// ---- images

interface Rendition {
  width: number;
  height: number;
}

function largestRendition(main: unknown): Rendition | null {
  if (!isRecord(main)) return null;
  let best: Rendition | null = null;
  for (const dims of Object.values(main)) {
    if (!Array.isArray(dims)) continue;
    const w = num(dims[0]);
    const h = num(dims[1]);
    if (w === null || h === null) continue;
    if (best === null || w * h > best.width * best.height) best = { width: w, height: h };
  }
  return best;
}

function normalizeImage(raw: unknown, gate: MediaUrlGate): MediaImage | null {
  if (!isRecord(raw)) return null;
  const large = gate.url(raw["large"] ?? raw["mainUrl"]);
  const hiRes = gate.url(raw["hiRes"] ?? raw["hiResUrl"]);
  const thumb = gate.url(raw["thumb"] ?? raw["thumbUrl"]);
  if (hiRes === null && large === null && thumb === null) return null;
  let rendition = largestRendition(raw["main"]);
  if (rendition === null && Array.isArray(raw["dimensions"])) {
    const w = num(raw["dimensions"][0]);
    const h = num(raw["dimensions"][1]);
    if (w !== null && h !== null) rendition = { width: w, height: h };
  }
  return {
    variant: str(raw["variant"]),
    hi_res: hiRes ?? large,
    large,
    thumb,
    width: rendition?.width ?? null,
    height: rendition?.height ?? null,
    alt: str(raw["altText"]) ?? str(raw["alt"]),
    physical_id: str(raw["physicalIdForMedia"]),
  };
}

function normalizeImages(raw: unknown, gate: MediaUrlGate): MediaImage[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaImage[] = [];
  for (const item of raw) {
    const image = normalizeImage(item, gate);
    if (image !== null) out.push(image);
  }
  return out;
}

/** Swap the size modifier of an image URL (`._AC_US40_.jpg`) for another (`._AC_SL1500_.jpg`). */
function withSizeModifier(url: string, modifier: string): string | null {
  const swapped = url.replace(/\._[^/.]*_\.([A-Za-z0-9]+)$/, `.${modifier}.$1`);
  return swapped === url ? null : swapped;
}

function variantFromClass(el: DomElement): string | null {
  const m = /\bvariant-([A-Za-z0-9]+)\b/.exec(el.getAttribute("class") ?? "");
  return m?.[1] ?? null;
}

/** Largest rendition in a `data-a-dynamic-image` map, considering only URLs that pass the host gate. */
function dynamicImageLargest(
  el: DomElement | undefined,
  gate: MediaUrlGate,
): { url: string; width: number; height: number } | null {
  const parsed = tryJson(attr(el, "data-a-dynamic-image"));
  if (!isRecord(parsed)) return null;
  let best: { url: string; width: number; height: number } | null = null;
  for (const [raw, dims] of Object.entries(parsed)) {
    if (!Array.isArray(dims)) continue;
    const w = num(dims[0]);
    const h = num(dims[1]);
    if (w === null || h === null) continue;
    const url = gate.url(raw);
    if (url === null) continue;
    if (best === null || w * h > best.width * best.height) best = { url, width: w, height: h };
  }
  return best;
}

// ---- videos

function secondsFromTimestamp(s: string | null): number | null {
  if (s === null) return null;
  const parts = s.split(":").map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    return null;
  }
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function videoKind(url: string): MediaVideoFormat {
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mp4")) return "mp4";
  return "other";
}

interface VideoAcc {
  key: string;
  video: MediaVideo;
}

function creatorOf(profile: unknown): { name: string | null; type: string | null } {
  if (!isRecord(profile)) return { name: null, type: null };
  return {
    name: str(profile["name"]) ?? str(profile["displayName"]) ?? str(profile["creatorName"]),
    type: str(profile["type"]) ?? str(profile["creatorType"]),
  };
}

/** Merge entries of the above-the-fold and below-the-fold video lists (same video, different file formats). */
function mergeVideos(lists: readonly unknown[][], gate: MediaUrlGate): MediaVideo[] {
  const acc: VideoAcc[] = [];
  for (const list of lists) {
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const url = gate.url(raw["url"] ?? raw["videoUrl"]);
      const key =
        str(raw["mediaObjectId"]) ?? str(raw["aciContentId"]) ?? str(raw["holderId"]) ?? url;
      if (key === null) continue;
      let entry = acc.find((a) => a.key === key);
      if (entry === undefined) {
        const creator = creatorOf(raw["creatorProfile"]);
        entry = {
          key,
          video: {
            id: str(raw["mediaObjectId"]) ?? str(raw["aciContentId"]),
            title: str(raw["title"]),
            duration_seconds:
              num(raw["durationSeconds"]) ?? secondsFromTimestamp(str(raw["durationTimestamp"])),
            url: null,
            format: null,
            manifest_url: null,
            thumbnail_url: null,
            width: num(raw["videoWidth"]),
            height: num(raw["videoHeight"]),
            group_type: str(raw["groupType"]),
            creator: creator.name,
            creator_type: creator.type,
            variant: str(raw["variant"]),
            is_hero: raw["isHeroVideo"] === true,
          },
        };
        acc.push(entry);
      }
      const video = entry.video;
      video.thumbnail_url ??= gate.url(raw["thumbUrl"] ?? raw["thumb"] ?? raw["slateUrl"]);
      video.title ??= str(raw["title"]);
      video.duration_seconds ??= num(raw["durationSeconds"]);
      if (url !== null) {
        const kind = videoKind(url);
        if (kind === "hls") video.manifest_url ??= url;
        else if (video.format !== "mp4") {
          video.url = url;
          video.format = kind;
        }
      }
    }
  }
  const out: MediaVideo[] = [];
  for (const { video } of acc) {
    if (video.url === null && video.manifest_url !== null) {
      video.url = video.manifest_url;
      video.format = "hls";
    }
    if (video.url !== null) out.push(video);
  }
  return out;
}

// ---- the parser

const ATF_INITIAL = /['"]colorImages['"]\s*:\s*\{\s*['"]initial['"]\s*:\s*/;
const ATF_VIDEOS = /['"]videos['"]\s*:\s*/;
const BTF_BLOB = /register\(\s*['"]ImageBlockBTF['"][\s\S]*?(?=(?:[\w$.]*parseJSON|JSON\.parse)\()/;
const GALLERY_DATA = /['"]imageGalleryData['"]\s*:\s*/;
const ATF_SCRIPT = /ImageBlockATF/;
const MEDIA_KEY_LIKE = /image|video|media|immersive|gallery|vse/i;

const KNOWN_BLOBS = [/^data-a-dynamic-image/, "imageBlockStateData"] as const;

function declaredCount(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

function extractAsinFromUrl(url: string): string | null {
  const m = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(url);
  return m?.[1] ?? null;
}

export const parseMedia: Parser<MediaData> = (capture: Capture): ParseResult<MediaData> => {
  const doc = parseDocument(capture.html);
  const meta = newMeta();
  const gate = new MediaUrlGate();
  const scripts = inlineScriptTexts(doc);

  const harvest = harvestBlobs(doc, { known: KNOWN_BLOBS });
  meta.unknown_blobs = harvest.unknownKeys.filter((k) => MEDIA_KEY_LIKE.test(k));
  if (meta.unknown_blobs.length === 0) delete meta.unknown_blobs;
  for (const key of harvest.malformed) {
    if (MEDIA_KEY_LIKE.test(key)) meta.warnings.push(`media: blob "${key}" is malformed JSON`);
  }

  /** First payload for an anchor across scripts; records malformed payloads. */
  const payload = (name: string, anchor: RegExp, only?: RegExp, within?: RegExp): unknown => {
    for (const script of scripts) {
      if (only !== undefined && !only.test(script)) continue;
      let text = script;
      if (within !== undefined) {
        const w = within.exec(script);
        if (w === null) continue;
        text = script.slice(w.index + w[0].length);
      }
      const found = jsonAfter(text, anchor);
      if (!found.found) continue;
      if (found.value === undefined) {
        meta.warnings.push(`media: ${name} blob is malformed JSON; using the DOM fallbacks`);
        continue;
      }
      return found.value;
    }
    return undefined;
  };

  const atfInitial = payload("colorImages.initial", ATF_INITIAL, ATF_SCRIPT);
  const atfVideos = payload("atf videos", ATF_VIDEOS, ATF_SCRIPT, ATF_INITIAL);
  const btf = ((): Record<string, unknown> | undefined => {
    for (const script of scripts) {
      const w = BTF_BLOB.exec(script);
      if (w === null) continue;
      const found = jsonAfter(script.slice(w.index + w[0].length), /^/);
      if (found.value === undefined) {
        meta.warnings.push("media: ImageBlockBTF blob is malformed JSON; using the DOM fallbacks");
        continue;
      }
      if (isRecord(found.value)) return found.value;
    }
    return undefined;
  })();
  const gallery = payload("imageGalleryData", GALLERY_DATA);

  // ---- asin
  const asin = firstOf<string>(
    "asin",
    [
      ["blob", () => asinOrNull(btf?.["mediaAsin"])],
      ["id", () => asinOrNull(doc.querySelector("input#ASIN")?.getAttribute("value") ?? undefined)],
      [
        "text-anchor",
        () => extractAsinFromUrl(capture.final_url) ?? extractAsinFromUrl(capture.url),
      ],
    ],
    meta,
    { optional: true },
  );

  // ---- images (current variant, gallery order)
  const landing = q(doc, "#landingImage") ?? q(doc, "#imgTagWrapperId img");
  const images =
    firstOf<MediaImage[]>(
      "images",
      [
        ["blob", () => normalizeImages(atfInitial, gate)],
        [
          "blob-btf",
          () => {
            const colors = btf?.["colorImages"];
            const landingKey = str(btf?.["landingAsinColor"]);
            if (!isRecord(colors) || landingKey === null) return null;
            return normalizeImages(colors[landingKey], gate);
          },
        ],
        ["blob-gallery", () => normalizeImages(gallery, gate)],
        [
          "dom-alt-images",
          () => {
            const out: MediaImage[] = [];
            let derived = false;
            for (const li of qa(doc, "#altImages li.imageThumbnail")) {
              const img = q(li, "img");
              const thumb = gate.url(attr(img, "src"));
              if (thumb === null) continue;
              const variant = variantFromClass(li);
              let hiRes = withSizeModifier(thumb, "_AC_SL1500_");
              const large = withSizeModifier(thumb, "_AC_");
              if (hiRes !== null || large !== null) derived = true;
              if (variant === "MAIN" && landing !== undefined) {
                const exact = gate.url(
                  attr(landing, "data-old-hires") ?? attr(landing, "data-a-hires"),
                );
                if (exact !== null) hiRes = exact;
              }
              out.push({
                variant,
                hi_res: hiRes ?? thumb,
                large,
                thumb,
                width: null,
                height: null,
                alt: str(attr(img, "alt")),
                physical_id: null,
              });
            }
            if (derived && out.length > 0) {
              meta.warnings.push("media: hi_res and large URLs were derived from thumbnail URLs");
            }
            return out;
          },
        ],
        [
          "dom-landing-image",
          () => {
            if (landing === undefined) return null;
            const best = dynamicImageLargest(landing, gate);
            const hiRes = gate.url(
              attr(landing, "data-old-hires") ?? attr(landing, "data-a-hires"),
            );
            const large = gate.url(best?.url ?? attr(landing, "src"));
            if (hiRes === null && large === null) return null;
            return [
              {
                variant: "MAIN",
                hi_res: hiRes ?? large,
                large,
                thumb: null,
                width: best?.width ?? null,
                height: best?.height ?? null,
                alt: str(attr(landing, "alt")),
                physical_id: null,
              },
            ];
          },
        ],
      ],
      meta,
    ) ?? [];

  // ---- per-variant image sets
  let imagesByVariant: Record<string, MediaImage[]> | null = null;
  let variantLabels: Record<string, string> | null = null;
  const sets = firstOf<{ sets: Record<string, MediaImage[]>; labels: Record<string, string> }>(
    "images_by_variant",
    [
      [
        "blob-btf",
        () => {
          const colors = btf?.["colorImages"];
          if (!isRecord(colors)) return null;
          const colorToAsin = btf?.["colorToAsin"];
          const toAsin = isRecord(colorToAsin) ? colorToAsin : {};
          const result: Record<string, MediaImage[]> = {};
          const labels: Record<string, string> = {};
          for (const [label, raw] of Object.entries(colors)) {
            if (label === "initial") continue;
            const list = normalizeImages(raw, gate);
            if (list.length === 0) continue;
            const mapped = toAsin[label];
            const key =
              (isRecord(mapped) ? asinOrNull(mapped["asin"]) : asinOrNull(mapped)) ?? label;
            result[key] = list;
            labels[key] = label;
          }
          return Object.keys(result).length > 0 ? { sets: result, labels } : null;
        },
      ],
    ],
    meta,
    { optional: true },
  );
  if (sets !== undefined) {
    imagesByVariant = sets.sets;
    variantLabels = sets.labels;
  }

  // ---- videos
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const videos =
    firstOf<MediaVideo[]>(
      "videos",
      [
        ["blob", () => mergeVideos([listOf(atfVideos), listOf(btf?.["videos"])], gate)],
        [
          "dom-video-elements",
          () => {
            const out: MediaVideo[] = [];
            for (const video of qa(
              doc,
              "#imageBlock video, #altImages video, #main-image-container video",
            )) {
              const src = gate.url(attr(video, "src") ?? attr(q(video, "source"), "src"));
              if (src === null) continue;
              const kind = videoKind(src);
              out.push({
                id: null,
                title: str(attr(video, "title")) ?? str(attr(video, "aria-label")),
                duration_seconds: null,
                url: src,
                format: kind,
                manifest_url: kind === "hls" ? src : null,
                thumbnail_url: gate.url(attr(video, "poster")),
                width: null,
                height: null,
                group_type: null,
                creator: null,
                creator_type: null,
                variant: null,
                is_hero: false,
              });
            }
            return out;
          },
        ],
      ],
      meta,
      { optional: true },
    ) ?? [];

  const declared =
    firstOf<number>(
      "videos_declared",
      [
        [
          "blob",
          () =>
            declaredCount(btf?.["totalVideoCount"]) ??
            declaredCount(
              scripts
                .filter((s) => ATF_SCRIPT.test(s))
                .map((s) => /['"]totalVideoCount['"]\s*:\s*(\d+)/.exec(s)?.[1])
                .find((n) => n !== undefined),
            ),
        ],
        [
          "label",
          () => {
            const el = q(doc, "#altImages li.videoThumbnail");
            return el === undefined ? null : parseCount(collapse(el.textContent ?? ""));
          },
        ],
      ],
      meta,
      { optional: true },
    ) ?? null;

  gate.report(meta);

  const nothingFound = images.length === 0 && videos.length === 0;
  if (nothingFound && asin === undefined && atfInitial === undefined && btf === undefined) {
    throw new RfError("layout_unrecognized", "no image block found on the product page");
  }
  if (nothingFound) meta.warnings.push("media: no images or videos found");

  return {
    data: {
      asin: asin ?? null,
      images,
      images_by_variant: imagesByVariant,
      variant_labels: variantLabels,
      videos,
      counts: {
        images: images.length,
        videos: videos.length,
        videos_declared: declared,
        variants_with_images: imagesByVariant === null ? 0 : Object.keys(imagesByVariant).length,
      },
    },
    other_sections: [],
    meta,
  };
};
