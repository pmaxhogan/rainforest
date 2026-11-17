/**
 * Dev-only: runs the media parser over every product and offers capture under the directory
 * in RAINFOREST_CORPUS (cases are `<kind>/<case>/page.html` + `capture.json`). Asserts
 * structural invariants only; it embeds no real value and prints no page content.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAmazonMediaUrl, parseMedia } from "../../src/pages/media.ts";
import type { MediaData, MediaImage } from "../../src/pages/media.ts";
import { loadFixture } from "../../src/testing.ts";

const root = process.env["RAINFOREST_CORPUS"];
const ASIN_RE = /^[A-Z0-9]{10}$/;

function caseDirs(): string[] {
  if (root === undefined || root === "") return [];
  const out: string[] = [];
  for (const kind of ["product", "offers"]) {
    const base = join(root, kind);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, "capture.json"))) out.push(dir);
    }
  }
  return out;
}

const dirs = caseDirs();

function checkImage(image: MediaImage): void {
  for (const url of [image.hi_res, image.large, image.thumb]) {
    if (url !== null) expect(isAmazonMediaUrl(url)).toBe(true);
  }
  expect(image.hi_res !== null || image.large !== null || image.thumb !== null).toBe(true);
  if (image.width !== null) expect(image.width).toBeGreaterThan(0);
  if (image.height !== null) expect(image.height).toBeGreaterThan(0);
}

describe.skipIf(!process.env["RAINFOREST_CORPUS"])("media parser over the private corpus", () => {
  it("finds captures to parse", () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  const all: MediaData[] = [];

  dirs.forEach((dir, i) => {
    it(`case #${i}: structural invariants`, () => {
      const capture = loadFixture(dir);
      const { data, other_sections, meta } = parseMedia(capture);
      all.push(data);

      expect(other_sections).toEqual([]);
      expect(meta.unparsed_text_chars).toBe(0);
      expect(meta.warnings.filter((w) => /malformed|dropped|derived/.test(w))).toEqual([]);
      expect(() => JSON.stringify(data)).not.toThrow();
      // The blobs carry session fields (customer and request ids); none may be copied out.
      expect(JSON.stringify(data)).not.toMatch(/customerId|dpRequestId/);

      if (data.asin !== null) expect(data.asin).toMatch(ASIN_RE);

      expect(data.images.length).toBeGreaterThan(0);
      expect(meta.strategies["images"]).toBe("blob");
      data.images.forEach(checkImage);
      expect(data.images[0]?.variant).toBe("MAIN");
      expect(data.counts.images).toBe(data.images.length);
      expect(data.counts.videos).toBe(data.videos.length);

      if (data.images_by_variant !== null) {
        const keys = Object.keys(data.images_by_variant);
        expect(keys.length).toBeGreaterThan(0);
        expect(data.counts.variants_with_images).toBe(keys.length);
        expect(Object.keys(data.variant_labels ?? {}).sort()).toEqual([...keys].sort());
        for (const [key, list] of Object.entries(data.images_by_variant)) {
          expect(key).toMatch(ASIN_RE);
          expect(list.length).toBeGreaterThan(0);
          list.forEach(checkImage);
        }
      } else {
        expect(data.counts.variants_with_images).toBe(0);
      }

      for (const v of data.videos) {
        expect(v.url).not.toBeNull();
        expect(isAmazonMediaUrl(v.url)).toBe(true);
        if (v.manifest_url !== null) expect(isAmazonMediaUrl(v.manifest_url)).toBe(true);
        if (v.thumbnail_url !== null) expect(isAmazonMediaUrl(v.thumbnail_url)).toBe(true);
        if (v.duration_seconds !== null) expect(v.duration_seconds).toBeGreaterThan(0);
        expect(["mp4", "hls", "other"]).toContain(v.format);
      }
      if (data.counts.videos_declared !== null) {
        expect(data.counts.videos_declared).toBeGreaterThanOrEqual(data.videos.length);
      }
    });
  });

  it("covers captures with and without per-variant sets and videos", () => {
    expect(all.some((d) => d.images_by_variant !== null)).toBe(true);
    expect(all.some((d) => d.images_by_variant === null)).toBe(true);
    expect(all.some((d) => d.videos.length > 0)).toBe(true);
    expect(all.some((d) => d.videos.length === 0)).toBe(true);
  });
});
