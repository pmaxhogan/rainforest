import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { checkFixturesTree } from "../src/rules.mjs";
import { readRawCapture, toManifest } from "../src/index.ts";
import { AOD_HTML, PAGE_HTML, PLANTED, sampleCapture } from "./samples.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rf-cli-"));
  dirs.push(d);
  return d;
}

function rawCapture(page = PAGE_HTML): string {
  const dir = tmp();
  const { html: _html, fragments: _f, ...meta } = sampleCapture();
  writeFileSync(
    join(dir, "capture.json"),
    JSON.stringify({ ...meta, fragments: { aod: "aod.html" } }),
  );
  writeFileSync(join(dir, "page.html"), page);
  writeFileSync(join(dir, "aod.html"), AOD_HTML);
  return dir;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("cli", () => {
  test("writes a clean fixture case that passes gate 2", () => {
    const raw = rawCapture();
    const root = join(tmp(), "fixtures");
    const caseDir = join(root, "product", "basic");
    const r = run([raw, caseDir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scrub report:");
    for (const f of ["capture.json", "page.html", "aod.html"]) {
      expect(existsSync(join(caseDir, f)), f).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(caseDir, "capture.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest.html).toBeUndefined();
    expect(manifest.fragments).toEqual({ aod: "aod.html" });
    expect(checkFixturesTree(root).violations).toEqual([]);
    const written = ["capture.json", "page.html", "aod.html"]
      .map((f) => readFileSync(join(caseDir, f), "utf8"))
      .join("");
    for (const v of [...PLANTED.asins, ...PLANTED.orderIds, ...PLANTED.emails, ...PLANTED.zips]) {
      expect(written).not.toContain(v);
    }
  });

  test("re-running gives byte-identical files", () => {
    const raw = rawCapture();
    const a = join(tmp(), "a");
    const b = join(tmp(), "b");
    expect(run([raw, a]).status).toBe(0);
    expect(run([raw, b]).status).toBe(0);
    for (const f of ["capture.json", "page.html", "aod.html"]) {
      expect(readFileSync(join(a, f), "utf8")).toBe(readFileSync(join(b, f), "utf8"));
    }
  });

  test("exits 1 and writes nothing when the self-audit finds residual risk", () => {
    // A URL in a kept structural value (id) only gets the token pass, so it survives
    // and the audit must stop the write.
    const raw = rawCapture('<div id="https://evil.invalid/x">x</div>');
    const caseDir = join(tmp(), "out");
    const r = run([raw, caseDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("url-host");
    expect(r.stderr + r.stdout).not.toContain("evil.invalid");
    expect(existsSync(caseDir)).toBe(false);
  });

  test("usage errors exit 4", () => {
    expect(run([]).status).toBe(4);
    const raw = rawCapture();
    expect(run([raw, raw]).status).toBe(4);
    expect(run([raw, join(tmp(), "x"), "--bogus"]).status).toBe(4);
  });

  test("raw captures may inline html and fragments", () => {
    const dir = tmp();
    const c = sampleCapture();
    writeFileSync(join(dir, "capture.json"), JSON.stringify(c));
    const back = readRawCapture(dir);
    expect(back.html).toBe(c.html);
    expect(back.fragments).toEqual(c.fragments);
  });

  test("manifests refuse fragment names that shadow case files", () => {
    const c = sampleCapture();
    expect(() => toManifest({ ...c, fragments: { page: "<p>x</p>" } })).toThrow(/fragment/);
    expect(toManifest(c, "note").note).toBe("note");
  });
});
