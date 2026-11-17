import { describe, expect, it } from "vitest";
import { RfError } from "@rainforest/core";
import type { Capture } from "@rainforest/core";
import {
  MEDIA_HOST_SUFFIXES,
  isAmazonMediaUrl,
  jsonAfter,
  looseJson,
  parseMedia,
  readJsString,
  safeMediaUrl,
} from "../../src/pages/media.ts";
import type { MediaData } from "../../src/pages/media.ts";

const CDN = "https://m.media-amazon.com/images/I";
const img = (stem: string, mod = "_AC_SL1500_"): string => `${CDN}/${stem}.${mod}.jpg`;

function capture(html: string): Capture {
  return {
    kind: "product",
    url: "https://www.example.com/dp/B0FAKE0001",
    final_url: "https://www.example.com/dp/B0FAKE0001",
    captured_at: "2000-01-01T00:00:00.000Z",
    html,
  };
}

/** Escape a string for a single-quoted JS literal, the way the page embeds parseJSON payloads. */
const jsq = (s: string): string => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function image(stem: string, variant: string, extra: Record<string, unknown> = {}) {
  return {
    hiRes: img(stem),
    thumb: img(stem, "_AC_US40_"),
    large: img(stem, "_AC_"),
    main: {
      [img(stem, "_AC_SY355_")]: [355, 266],
      [img(stem, "_AC_SY879_")]: ["879", "659"],
      [img(stem, "_AC_SY450_")]: [450, 338],
    },
    variant,
    altText: `Invented photo ${variant}`,
    physicalIdForMedia: stem,
    ...extra,
  };
}

function video(id: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    creatorProfile: {},
    groupType: "IB_G1",
    aciContentId: `amzn1.fake.${id}`,
    mediaObjectId: id,
    title: `Invented video ${id}`,
    durationSeconds: 30,
    durationTimestamp: "00:30",
    url,
    thumbUrl: img(`vthumb${id}`, "_SX200_CR0,0,200,112_"),
    videoWidth: "1920",
    videoHeight: "1080",
    isHeroVideo: false,
    variant: null,
    ...extra,
  };
}

function atfScript(images: unknown, videos: unknown = [], total = 0): string {
  return `<script type="text/javascript">
P.now('media-block-initialised').execute(function(isMediaBlockInitialised) {
  P.when('A').register("ImageBlockATF", function(A){
    var data = {
      'isMediaBlock': true,
      'asin' : 'B0FAKE0001',
      'colorImages': { 'initial': A.$.parseJSON('${jsq(JSON.stringify(images))}')},
      'colorToAsin': {'initial': '{}'},
      'totalVideoCount': ${total},
      'videos': A.$.parseJSON('${jsq(JSON.stringify(videos))}'),
      'weblabs' : {},
    };
    return data;
  });
});
</script>`;
}

function btfScript(btf: Record<string, unknown>): string {
  return `<script type="text/javascript">
P.when('jQuery').register('ImageBlockBTF', function(jQuery){
  var data = {};
  var obj = jQuery.parseJSON('${jsq(JSON.stringify(btf))}');
  data["colorImages"] = obj.colorImages;
});
</script>`;
}

const page = (body: string): string =>
  `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

describe("MEDIA_HOST_SUFFIXES (security-relevant)", () => {
  it("is exactly the evidence-based list", () => {
    expect([...MEDIA_HOST_SUFFIXES]).toEqual(["media-amazon.com"]);
  });

  it("contains the Amazon media suffix and no rentable or third-party host", () => {
    expect(MEDIA_HOST_SUFFIXES).toContain("media-amazon.com");
    expect(MEDIA_HOST_SUFFIXES).not.toContain("amazonaws.com");
    expect(MEDIA_HOST_SUFFIXES).not.toContain("cloudfront.net");
    expect(MEDIA_HOST_SUFFIXES).not.toContain("amazon.com");
    expect(MEDIA_HOST_SUFFIXES).not.toContain("example.com");
    expect(MEDIA_HOST_SUFFIXES).not.toContain("");
  });

  it("accepts https URLs on the suffix or its subdomains", () => {
    expect(isAmazonMediaUrl("https://m.media-amazon.com/images/I/FAKE0001.jpg")).toBe(true);
    expect(isAmazonMediaUrl("https://media-amazon.com/images/I/FAKE0001.jpg")).toBe(true);
    expect(isAmazonMediaUrl("https://images.media-amazon.com/x.png")).toBe(true);
    expect(isAmazonMediaUrl("//m.media-amazon.com/images/I/FAKE0001.jpg")).toBe(true);
    expect(isAmazonMediaUrl("HTTPS://M.MEDIA-AMAZON.COM/x.jpg")).toBe(true);
    expect(safeMediaUrl("  https://m.media-amazon.com/images/I/A,B_.jpg ")).toBe(
      "https://m.media-amazon.com/images/I/A,B_.jpg",
    );
  });

  it("fails closed on lookalikes, schemes, credentials, ports and junk", () => {
    expect(isAmazonMediaUrl("https://images.example.com/placeholder.png")).toBe(false);
    expect(isAmazonMediaUrl("https://evilmedia-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com.evil.example/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://media-amazon.com.evil.example/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://evil.example/m.media-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com@evil.example/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://evil.example\\@m.media-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://user:pw@m.media-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com:8443/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("http://m.media-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("ftp://m.media-amazon.com/x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("javascript:alert(1)")).toBe(false);
    expect(isAmazonMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com./x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com/x y.jpg")).toBe(false);
    expect(isAmazonMediaUrl("https://m.media-amazon.com/\u0000x.jpg")).toBe(false);
    expect(isAmazonMediaUrl("/images/I/relative.jpg")).toBe(false);
    expect(isAmazonMediaUrl("")).toBe(false);
    expect(isAmazonMediaUrl(null)).toBe(false);
    expect(isAmazonMediaUrl(undefined)).toBe(false);
  });
});

describe("script payload helpers", () => {
  it("readJsString unescapes JS escapes and rejects unterminated literals", () => {
    expect(readJsString("'a\\'b\\\\c\\u0041\\x42\\n'", 0)).toBe("a'b\\cAB\n");
    expect(readJsString('"say \\"hi\\""', 0)).toBe('say "hi"');
    expect(readJsString("'never closed", 0)).toBeUndefined();
    expect(readJsString("no quote", 0)).toBeUndefined();
  });

  it("looseJson tolerates trailing commas but not other breakage", () => {
    expect(looseJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(looseJson('{"a":"x,}"}')).toEqual({ a: "x,}" });
    expect(looseJson("{broken")).toBeUndefined();
  });

  it("jsonAfter reads parseJSON strings, bare literals and reports malformed payloads", () => {
    expect(jsonAfter('k: A.$.parseJSON(\'[{"a":"it\\\'s"}]\')', /k:\s*/)).toEqual({
      found: true,
      value: [{ a: "it's" }],
    });
    expect(jsonAfter('k: {"a": 1, }', /k:\s*/)).toEqual({ found: true, value: { a: 1 } });
    expect(jsonAfter("k: parseJSON('{oops')", /k:\s*/)).toEqual({ found: true, value: undefined });
    expect(jsonAfter("nothing", /k:\s*/)).toEqual({ found: false, value: undefined });
  });
});

describe("parseMedia: images", () => {
  const html = page(`
    <input type="hidden" id="ASIN" name="ASIN" value="B0FAKE0001">
    ${atfScript([
      image("FAKEIMG0001", "MAIN"),
      image("FAKEIMG0002", "PT01"),
      image("FAKEIMG0003", "PT02", { altText: "Don't break on apostrophes" }),
    ])}
  `);

  it("returns the current variant gallery in order, JSON-first, with dimensions", () => {
    const { data, meta, other_sections } = parseMedia(capture(html));
    expect(data.images.map((i) => i.variant)).toEqual(["MAIN", "PT01", "PT02"]);
    expect(data.images[0]).toEqual({
      variant: "MAIN",
      hi_res: img("FAKEIMG0001"),
      large: img("FAKEIMG0001", "_AC_"),
      thumb: img("FAKEIMG0001", "_AC_US40_"),
      width: 879,
      height: 659,
      alt: "Invented photo MAIN",
      physical_id: "FAKEIMG0001",
    });
    expect(data.images[2]?.alt).toBe("Don't break on apostrophes");
    expect(data.asin).toBe("B0FAKE0001");
    expect(data.counts).toEqual({
      images: 3,
      videos: 0,
      videos_declared: 0,
      variants_with_images: 0,
    });
    expect(data.images_by_variant).toBeNull();
    expect(data.variant_labels).toBeNull();
    expect(meta.strategies["images"]).toBe("blob");
    expect(meta.warnings).toEqual([]);
    expect(other_sections).toEqual([]);
    expect(meta.unparsed_text_chars).toBe(0);
  });

  it("falls back to large when the page lists no hi-res URL and tolerates missing sizes", () => {
    const only = image("FAKEIMG0004", "MAIN", { hiRes: null, main: undefined });
    const { data } = parseMedia(capture(page(atfScript([only]))));
    expect(data.images[0]?.hi_res).toBe(img("FAKEIMG0004", "_AC_"));
    expect(data.images[0]?.width).toBeNull();
  });

  it("does not leak fields it does not whitelist", () => {
    const btf = {
      customerId: "FAKECUSTOMER",
      dpRequestId: "FAKEREQUEST",
      colorImages: {},
      mediaAsin: "B0FAKE0001",
    };
    const { data } = parseMedia(
      capture(page(atfScript([image("FAKEIMG0001", "MAIN")]) + btfScript(btf))),
    );
    const json = JSON.stringify(data);
    expect(json).not.toContain("FAKECUSTOMER");
    expect(json).not.toContain("FAKEREQUEST");
  });

  it("builds per-variant image sets keyed by child ASIN, with labels", () => {
    const btf = {
      landingAsinColor: "Small Red",
      colorToAsin: {
        "Small Red": { asin: "B0FAKE0001" },
        "Large Blue": { asin: "B0FAKE0002" },
        "No Asin": {},
      },
      colorImages: {
        "Small Red": [image("FAKEIMG0001", "MAIN")],
        "Large Blue": [image("FAKEIMG0005", "MAIN"), image("FAKEIMG0006", "PT01")],
        "No Asin": [image("FAKEIMG0007", "MAIN")],
        Empty: [],
      },
    };
    const { data, meta } = parseMedia(capture(page(btfScript(btf))));
    expect(Object.keys(data.images_by_variant ?? {}).sort()).toEqual([
      "B0FAKE0001",
      "B0FAKE0002",
      "No Asin",
    ]);
    expect(data.images_by_variant?.["B0FAKE0002"]?.map((i) => i.variant)).toEqual(["MAIN", "PT01"]);
    expect(data.variant_labels).toEqual({
      B0FAKE0001: "Small Red",
      B0FAKE0002: "Large Blue",
      "No Asin": "No Asin",
    });
    expect(data.counts.variants_with_images).toBe(3);
    // No ATF gallery: the landing variant's entry from the below-the-fold blob is the fallback.
    expect(data.images).toHaveLength(1);
    expect(meta.strategies["images"]).toBe("blob-btf");
    expect(meta.strategies["images_by_variant"]).toBe("blob-btf");
  });

  it("reads imageGalleryData-style entries", () => {
    const gallery = [
      {
        mainUrl: img("FAKEIMG0008"),
        thumbUrl: img("FAKEIMG0008", "_AC_US40_"),
        dimensions: [1200, 900],
      },
      { mainUrl: img("FAKEIMG0009"), dimensions: ["800", "600"] },
    ];
    const html2 = page(
      `<script>var cfg = { "imageGalleryData" : ${JSON.stringify(gallery)} };</script>`,
    );
    const { data, meta } = parseMedia(capture(html2));
    expect(meta.strategies["images"]).toBe("blob-gallery");
    expect(data.images.map((i) => [i.large, i.width, i.height])).toEqual([
      [img("FAKEIMG0008"), 1200, 900],
      [img("FAKEIMG0009"), 800, 600],
    ]);
  });

  it("rejects non-Amazon image hosts: drops the URL (or the image) and warns with the host", () => {
    const entries = [
      image("FAKEIMG0001", "MAIN"),
      image("FAKEIMG0002", "PT01", { hiRes: "https://images.example.com/placeholder.png" }),
      {
        hiRes: "https://images.example.com/a.png",
        large: "http://m.media-amazon.com/insecure.png",
        thumb: "https://m.media-amazon.com.evil.example/t.png",
        variant: "PT02",
      },
    ];
    const { data, meta } = parseMedia(capture(page(atfScript(entries))));
    expect(data.images.map((i) => i.variant)).toEqual(["MAIN", "PT01"]);
    // The rejected hi-res URL falls back to the (valid) large URL, never to the bad one.
    expect(data.images[1]?.hi_res).toBe(img("FAKEIMG0002", "_AC_"));
    expect(JSON.stringify(data)).not.toContain("example.com/placeholder");
    expect(JSON.stringify(data)).not.toContain("evil.example");
    const warning = meta.warnings.find((w) => w.startsWith("media: dropped"));
    expect(warning).toContain("images.example.com");
    expect(warning).toContain("m.media-amazon.com.evil.example");
    expect(warning).toContain("m.media-amazon.com");
  });
});

describe("parseMedia: videos", () => {
  const atfVideos = [
    video("FAKEVID0001", "https://m.media-amazon.com/images/S/fake/FAKEVID0001.480.mp4"),
    video("FAKEVID0002", "https://m.media-amazon.com/images/S/fake/FAKEVID0002.480.mp4", {
      groupType: "IB_G4",
      creatorProfile: { name: "Alex Example", type: "creator" },
      durationSeconds: undefined,
      durationTimestamp: "01:05",
    }),
  ];
  const btfVideos = [
    video("FAKEVID0001", "https://m.media-amazon.com/images/S/fake/FAKEVID0001.hls.m3u8"),
    video("FAKEVID0003", "https://m.media-amazon.com/images/S/fake/FAKEVID0003.hls.m3u8", {
      title: "Manifest only",
    }),
    video("FAKEVID0004", "https://videos.example.com/FAKEVID0004.mp4"),
  ];
  const html = page(
    atfScript([image("FAKEIMG0001", "MAIN")], atfVideos, 9) +
      btfScript({ videos: btfVideos, totalVideoCount: 9, colorImages: {} }),
  );

  it("merges above- and below-the-fold lists by media id, keeping mp4 and manifest", () => {
    const { data, meta } = parseMedia(capture(html));
    expect(data.videos.map((v) => v.id)).toEqual(["FAKEVID0001", "FAKEVID0002", "FAKEVID0003"]);
    const first = data.videos[0];
    expect(first).toEqual({
      id: "FAKEVID0001",
      title: "Invented video FAKEVID0001",
      duration_seconds: 30,
      url: "https://m.media-amazon.com/images/S/fake/FAKEVID0001.480.mp4",
      format: "mp4",
      manifest_url: "https://m.media-amazon.com/images/S/fake/FAKEVID0001.hls.m3u8",
      thumbnail_url: img("vthumbFAKEVID0001", "_SX200_CR0,0,200,112_"),
      width: 1920,
      height: 1080,
      group_type: "IB_G1",
      creator: null,
      creator_type: null,
      variant: null,
      is_hero: false,
    });
    expect(data.videos[1]).toMatchObject({
      duration_seconds: 65,
      group_type: "IB_G4",
      creator: "Alex Example",
      creator_type: "creator",
    });
    // A manifest-only video uses the manifest as its playable URL.
    expect(data.videos[2]).toMatchObject({
      format: "hls",
      url: "https://m.media-amazon.com/images/S/fake/FAKEVID0003.hls.m3u8",
      manifest_url: "https://m.media-amazon.com/images/S/fake/FAKEVID0003.hls.m3u8",
    });
    expect(data.counts.videos).toBe(3);
    expect(data.counts.videos_declared).toBe(9);
    expect(meta.strategies["videos"]).toBe("blob");
    // The non-Amazon video was dropped and reported.
    expect(meta.warnings.find((w) => w.startsWith("media: dropped"))).toContain(
      "videos.example.com",
    );
    expect(JSON.stringify(data)).not.toContain("videos.example.com");
  });

  it("falls back to visible video elements and the ingress label for the declared count", () => {
    const html2 = page(`
      <div id="imageBlock">
        <video src="https://m.media-amazon.com/images/S/fake/FAKEVID0005.mp4" poster="https://images.example.com/p.png" title="Invented clip"></video>
        <video src="https://images.example.com/other.mp4"></video>
        <div data-rf-hidden="1"><video src="https://m.media-amazon.com/images/S/fake/hidden.mp4"></video></div>
      </div>
      <div id="altImages"><ul>
        <li class="imageThumbnail variant-MAIN"><img src="${img("FAKEIMG0001", "_AC_US40_")}" alt="Invented"></li>
        <li class="videoThumbnail"><span>7 VIDEOS</span></li>
      </ul></div>`);
    const { data, meta } = parseMedia(capture(html2));
    expect(meta.strategies["videos"]).toBe("dom-video-elements");
    expect(data.videos).toHaveLength(1);
    expect(data.videos[0]).toMatchObject({
      title: "Invented clip",
      url: "https://m.media-amazon.com/images/S/fake/FAKEVID0005.mp4",
      format: "mp4",
      thumbnail_url: null,
    });
    expect(data.counts.videos_declared).toBe(7);
    expect(meta.strategies["videos_declared"]).toBe("label");
    expect(meta.warnings.find((w) => w.startsWith("media: dropped"))).toContain(
      "images.example.com",
    );
  });
});

describe("parseMedia: fallbacks", () => {
  it("falls back to the alt-image strip when the JSON blobs are malformed", () => {
    const html = page(`
      <script>
        P.when('A').register("ImageBlockATF", function(A){ var data = {
          'colorImages': { 'initial': A.$.parseJSON('[{"hiRes": broken')},
        }; });
      </script>
      <script>
        P.when('jQuery').register('ImageBlockBTF', function(jQuery){ var obj = jQuery.parseJSON('{"colorImages": '); });
      </script>
      <img id="landingImage" src="${img("FAKEIMG0011", "_AC_SY500_")}" data-old-hires="${img("FAKEIMG0011")}"
        data-a-dynamic-image='{"${img("FAKEIMG0011", "_AC_SY500_")}":[500,400],"${img("FAKEIMG0011", "_AC_SY700_")}":[700,560]}'>
      <div id="altImages"><ul>
        <li class="a-spacing-small item imageThumbnail variant-MAIN"><img src="${img("FAKEIMG0011", "_AC_US40_")}" alt="Invented main"></li>
        <li class="a-spacing-small item imageThumbnail variant-PT01"><img src="${img("FAKEIMG0012", "_AC_US40_")}" alt="Invented side"></li>
        <li class="a-spacing-small item imageThumbnail" data-rf-hidden="1"><img src="${img("FAKEIMG0013", "_AC_US40_")}" alt="hidden"></li>
        <li class="a-spacing-small item imageThumbnail variant-PT03"><img src="https://images.example.com/t.png" alt="foreign"></li>
      </ul></div>`);
    const { data, meta } = parseMedia(capture(html));
    expect(meta.strategies["images"]).toBe("dom-alt-images");
    expect(data.images.map((i) => i.variant)).toEqual(["MAIN", "PT01"]);
    expect(data.images[0]).toMatchObject({
      // The exact hi-res of the landing image wins for MAIN; other slots are derived.
      hi_res: img("FAKEIMG0011"),
      large: img("FAKEIMG0011", "_AC_"),
      thumb: img("FAKEIMG0011", "_AC_US40_"),
      alt: "Invented main",
    });
    expect(data.images[1]?.hi_res).toBe(img("FAKEIMG0012"));
    expect(meta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("colorImages.initial blob is malformed JSON"),
        expect.stringContaining("ImageBlockBTF blob is malformed JSON"),
        expect.stringContaining("derived from thumbnail URLs"),
        expect.stringContaining("images.example.com"),
      ]),
    );
  });

  it("uses the landing image attributes when there is no thumbnail strip", () => {
    const html = page(`
      <div id="imgTagWrapperId"><img id="landingImage" alt="Invented product" src="${img("FAKEIMG0021", "_AC_SY500_")}"
        data-a-dynamic-image='{"${img("FAKEIMG0021", "_AC_SY500_")}":[500,400],"${img("FAKEIMG0021", "_AC_SY700_")}":[700,560],"https://images.example.com/x.png":[9000,9000]}'></div>`);
    const { data, meta } = parseMedia(capture(html));
    expect(meta.strategies["images"]).toBe("dom-landing-image");
    expect(data.images).toHaveLength(1);
    expect(data.images[0]).toMatchObject({
      variant: "MAIN",
      large: img("FAKEIMG0021", "_AC_SY700_"),
      width: 700,
      height: 560,
      alt: "Invented product",
    });
    // The rejected (largest) rendition never wins.
    expect(JSON.stringify(data)).not.toContain("images.example.com");
  });

  it("reports media-looking blobs it does not understand", () => {
    const html = page(`
      <script type="a-state" data-a-state='{"key":"imageBlockStateData"}'>{"a":1}</script>
      <script type="a-state" data-a-state='{"key":"inventedVideoPlayerState"}'>{"a":1}</script>
      <script type="a-state" data-a-state='{"key":"unrelated-checkout-state"}'>{"a":1}</script>
      <script type="a-state" data-a-state='{"key":"brokenImageState"}'>{"a":</script>
      ${atfScript([image("FAKEIMG0001", "MAIN")])}`);
    const { meta } = parseMedia(capture(html));
    expect(meta.unknown_blobs).toEqual(["inventedVideoPlayerState", "brokenImageState"]);
    expect(meta.warnings).toContain('media: blob "brokenImageState" is malformed JSON');
  });

  it("returns an empty result with a warning when the ASIN is known but there is no media", () => {
    const { data, meta } = parseMedia(
      capture(page('<input type="hidden" id="ASIN" value="B0FAKE0001">')),
    );
    expect(data.images).toEqual([]);
    expect(data.videos).toEqual([]);
    expect(data.asin).toBe("B0FAKE0001");
    expect(meta.warnings).toContain("media: no images or videos found");
  });

  it("throws layout_unrecognized when nothing identifies a product image block", () => {
    const blank: Capture = {
      ...capture(page("<p>nothing here</p>")),
      url: "https://www.example.com/",
      final_url: "https://www.example.com/",
    };
    expect(() => parseMedia(blank)).toThrow(RfError);
    try {
      parseMedia(blank);
    } catch (error) {
      expect((error as RfError).payload.code).toBe("layout_unrecognized");
    }
  });

  it("is JSON-serializable", () => {
    const html = page(
      atfScript(
        [image("FAKEIMG0001", "MAIN")],
        [video("FAKEVID0001", "https://m.media-amazon.com/images/S/fake/a.mp4")],
      ),
    );
    const result = parseMedia(capture(html));
    const roundTrip = JSON.parse(JSON.stringify(result)) as { data: MediaData };
    expect(roundTrip.data).toEqual(result.data);
  });
});
