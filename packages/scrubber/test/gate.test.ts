import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { checkFixturesTree } from "../src/rules.mjs";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-fixtures.mjs", import.meta.url));

const CLEAN_MANIFEST = {
  kind: "product",
  url: "https://www.example.com/dp/B0FAKE0000",
  final_url: "https://www.example.com/dp/B0FAKE0000",
  captured_at: "2020-07-01T12:00:00.000Z",
  fragments: { aod: "aod.html" },
};
const CLEAN_PAGE =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' +
  '<div id="ppd" data-asin="B0FAKE0000" data-rf-hidden="1">Lorem ipsum $14.66</div>' +
  '<a href="https://www.example.com/gp/your-account/order-details?orderID=000-0000000-0000001">x</a>' +
  '<img src="https://images.example.com/placeholder.png" alt="Lorem">' +
  "<span>user1@example.com 555-555-0100 Exampleville, ZZ 00001</span>" +
  '<script type="application/json">{"asin":"B0FAKE0001"}</script>' +
  "</body></html>";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a fixtures tree with one clean case; `mutate` adds the violation under test. */
function tree(mutate?: (caseDir: string, root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "rf-gate-"));
  dirs.push(root);
  const caseDir = join(root, "product", "basic");
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "capture.json"), JSON.stringify(CLEAN_MANIFEST, null, 2));
  writeFileSync(join(caseDir, "page.html"), CLEAN_PAGE);
  writeFileSync(join(caseDir, "aod.html"), '<div id="aod">Lorem $14.66</div>');
  writeFileSync(join(caseDir, "expected.json"), JSON.stringify({ data: { asin: "B0FAKE0000" } }));
  mutate?.(caseDir, root);
  return root;
}

function rulesOf(root: string): string[] {
  return checkFixturesTree(root).violations.map((v) => v.rule);
}

function runScript(root: string) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
}

describe("gate 2: check-fixtures", () => {
  test("a missing fixtures dir passes", () => {
    const r = checkFixturesTree(join(tmpdir(), "rf-gate-does-not-exist-xyz"));
    expect(r.violations).toEqual([]);
    const run = runScript(join(tmpdir(), "rf-gate-does-not-exist-xyz"));
    expect(run.status).toBe(0);
  });

  test("a clean tree passes, in-process and as a script", () => {
    const root = tree();
    expect(checkFixturesTree(root).violations).toEqual([]);
    expect(checkFixturesTree(root).cases).toBe(1);
    const run = runScript(root);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  const page = (body: string) => (c: string) =>
    writeFileSync(join(c, "page.html"), CLEAN_PAGE.replace("</body>", `${body}</body>`));

  const violations: [string, (c: string, root: string) => void, string][] = [
    ["real ASIN", page("<b>B0ABCD1234</b>"), "asin"],
    ["real order id", page("<b>123-1234567-1234567</b>"), "order-id"],
    ["foreign email", page("<b>zed.placeholder@mail.invalid</b>"), "email"],
    ["foreign phone", page("<b>(999) 555-1234</b>"), "phone"],
    ["foreign ZIP", page("<b>Nowhere Falls, ZZ 99999</b>"), "zip"],
    ["opaque blob", page('<input value="hGxM3Y8cH8Z5aBcDeFgHiJkL0mNoPq12345=">'), "opaque-blob"],
    ["foreign image host", page('<img src="https://img.invalid/x.jpg">'), "url-host"],
    ["foreign link host", page('<a href="https://shop.invalid/x">x</a>'), "url-host"],
    ["live script", page("<script>alert(1)</script>"), "script"],
    ["comment", page("<!-- note -->"), "comment"],
    [
      "leak in expected.json",
      (c) => writeFileSync(join(c, "expected.json"), '{"seller":"zed@mail.invalid"}'),
      "email",
    ],
    [
      "leak in capture.json",
      (c) =>
        writeFileSync(
          join(c, "capture.json"),
          JSON.stringify({ ...CLEAN_MANIFEST, url: "https://shop.invalid/dp/B0ABCD1234" }),
        ),
      "url-host",
    ],
    ["missing page.html", (c) => rmSync(join(c, "page.html")), "missing-file"],
    ["missing capture.json", (c) => rmSync(join(c, "capture.json")), "missing-file"],
    ["missing fragment file", (c) => rmSync(join(c, "aod.html")), "missing-file"],
    [
      "html inside the manifest",
      (c) =>
        writeFileSync(join(c, "capture.json"), JSON.stringify({ ...CLEAN_MANIFEST, html: "<p>" })),
      "manifest",
    ],
    ["unparseable manifest", (c) => writeFileSync(join(c, "capture.json"), "{"), "manifest"],
    ["binary file", (c) => writeFileSync(join(c, "shot.png"), "x"), "file-type"],
    ["file outside a case", (_c, root) => writeFileSync(join(root, "loose.json"), "{}"), "layout"],
    ["too deep", (c) => mkdirSync(join(c, "nested")), "layout"],
    ["symlink", (c) => symlinkSync("/etc/hosts", join(c, "link.html")), "symlink"],
    [
      "leaky path name",
      (_c, root) => {
        const d = join(root, "product", "B0ABCD1234");
        mkdirSync(d);
        writeFileSync(join(d, "capture.json"), JSON.stringify(CLEAN_MANIFEST));
        writeFileSync(join(d, "page.html"), CLEAN_PAGE);
        writeFileSync(join(d, "aod.html"), "<p>x</p>");
      },
      "path:asin",
    ],
  ];

  for (const [label, mutate, rule] of violations) {
    test(`fails on ${label}`, () => {
      const root = tree(mutate);
      expect(rulesOf(root)).toContain(rule);
    });
  }

  test("the script exits 1 on a violation and never prints the value", () => {
    const root = tree((c) => {
      page("<b>zed.placeholder@mail.invalid B0ABCD1234</b>")(c);
      const d = join(c, "..", "B0WXYZ9876");
      mkdirSync(d);
    });
    const run = runScript(root);
    expect(run.status).toBe(1);
    const out = run.stdout + run.stderr;
    expect(out).toContain("product/basic/page.html");
    expect(out).not.toContain("zed.placeholder");
    expect(out).not.toContain("B0ABCD1234");
    expect(out).not.toContain("B0WXYZ9876");
  });
});
