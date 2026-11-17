import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import type { SeenPage } from "@rainforest/browser";
import { createPageArchive } from "../src/page-archive.ts";
import { tmpDir } from "./helpers.ts";

function page(over: Partial<SeenPage> = {}): SeenPage {
  return {
    kind: "product",
    url: "https://www.amazon.com/dp/B0FAKE0001",
    final_url: "https://www.amazon.com/dp/B0FAKE0001",
    captured_at: "2026-01-10T18:00:00.000Z",
    html: "<html><body>Example widget</body></html>",
    ...over,
  };
}

function clock(start = Date.parse("2026-01-10T18:00:00.000Z")) {
  let t = start;
  return () => new Date((t += 1000));
}

const read = (dir: string, name: string): Record<string, unknown> =>
  JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString("utf8")) as Record<string, unknown>;

describe("page archive", () => {
  test("keeps each page as one gzipped file that reads back whole", () => {
    const dir = join(tmpDir(), "pages");
    const archive = createPageArchive({ dir, now: clock() });
    archive.save(page());
    archive.save(page({ kind: "failure", note: "layout_unrecognized: the panel did not open" }));
    const names = readdirSync(dir).sort();
    expect(names).toEqual([
      "20260110T180001000Z-0001-product.json.gz",
      "20260110T180002000Z-0002-failure.json.gz",
    ]);
    expect(read(dir, names[0]!)).toEqual({ v: 1, ...page() });
    expect(read(dir, names[1]!)).toMatchObject({
      kind: "failure",
      note: "layout_unrecognized: the panel did not open",
    });
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, names[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  test("drops the oldest pages past the page limit", () => {
    const dir = join(tmpDir(), "pages");
    const archive = createPageArchive({ dir, maxPages: 3, now: clock() });
    for (let i = 1; i <= 5; i++) archive.save(page({ html: `<p>page ${i}</p>` }));
    const names = readdirSync(dir).sort();
    expect(names).toHaveLength(3);
    expect(names.map((n) => read(dir, n).html)).toEqual([
      "<p>page 3</p>",
      "<p>page 4</p>",
      "<p>page 5</p>",
    ]);
  });

  test("drops the oldest pages past the size limit, but always keeps the newest", () => {
    const dir = join(tmpDir(), "pages");
    // Incompressible bodies of about 3 kB each against a 7 kB limit: two fit, three do not.
    const noise = (seed: number): string =>
      Array.from({ length: 3000 }, (_, i) =>
        String.fromCharCode(33 + ((i * 7919 + seed * 104729 + ((i * i) % 89)) % 90)),
      ).join("");
    const archive = createPageArchive({ dir, maxBytes: 7000, now: clock() });
    for (let i = 1; i <= 4; i++) archive.save(page({ html: noise(i) }));
    const names = readdirSync(dir).sort();
    expect(names.length).toBeLessThan(4);
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(read(dir, names[names.length - 1]!).html).toBe(noise(4));
    const total = names.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);
    expect(total).toBeLessThanOrEqual(7000);
    // One page larger than the whole limit is still kept: the newest page is never dropped.
    const tiny = createPageArchive({ dir: join(tmpDir(), "pages"), maxBytes: 10, now: clock() });
    tiny.save(page({ html: noise(9) }));
  });

  test("leaves files it did not write alone and names odd kinds safely", () => {
    const dir = join(tmpDir(), "pages");
    const archive = createPageArchive({ dir, maxPages: 1, now: clock() });
    archive.save(page());
    writeFileSync(join(dir, "notes.txt"), "mine");
    archive.save(page({ kind: "../Weird Kind!" }));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["20260110T180002000Z-0002-___weird_kind_.json.gz", "notes.txt"]);
  });

  test("a directory it cannot write to never throws into the call", () => {
    const blocker = join(tmpDir(), "not-a-directory");
    writeFileSync(blocker, "x");
    const warnings: string[] = [];
    const archive = createPageArchive({
      dir: join(blocker, "pages"),
      log: {
        debug: () => {},
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        child() {
          return this;
        },
      },
    });
    expect(() => archive.save(page())).not.toThrow();
    expect(warnings).toEqual(["could not keep a page in the archive"]);
  });
});
