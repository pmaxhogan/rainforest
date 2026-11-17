/**
 * Fixture helpers for tests. Exported from the "./testing" subpath only, so production code
 * never pulls in node:fs.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_KINDS } from "@rainforest/core";
import type { Capture, FixtureManifest, PageKind, ParseResult } from "@rainforest/core";
import { parseDocument } from "./dom.ts";
import { type LosslessOptions, visibleTextChars } from "./lossless.ts";

/** The repository's top-level fixtures/ directory. */
export const DEFAULT_FIXTURES_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPageKind(v: unknown): v is PageKind {
  return typeof v === "string" && (PAGE_KINDS as readonly string[]).includes(v);
}

/**
 * Read one fixture case directory (capture.json + page.html + fragment files) into a
 * Capture. Throws with a precise message on a malformed case.
 */
export function loadFixture(dir: string): Capture {
  const manifestPath = join(dir, "capture.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<FixtureManifest>;
  if (!isPageKind(manifest.kind)) throw new Error(`${manifestPath}: unknown kind`);
  for (const key of ["url", "final_url", "captured_at"] as const) {
    if (typeof manifest[key] !== "string") throw new Error(`${manifestPath}: missing ${key}`);
  }
  const capture: Capture = {
    kind: manifest.kind,
    url: manifest.url as string,
    final_url: manifest.final_url as string,
    captured_at: manifest.captured_at as string,
    html: readFileSync(join(dir, "page.html"), "utf8"),
  };
  if (manifest.fragments !== undefined) {
    const fragments: Record<string, string> = {};
    for (const [name, file] of Object.entries(manifest.fragments)) {
      if (!SAFE_FILE.test(file)) throw new Error(`${manifestPath}: bad fragment file name`);
      fragments[name] = readFileSync(join(dir, file), "utf8");
    }
    capture.fragments = fragments;
  }
  return capture;
}

/** The case's expected.json, or undefined when the case has none yet. */
export function loadExpected<T = unknown>(dir: string): ParseResult<T> | undefined {
  const path = join(dir, "expected.json");
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ParseResult<T>;
}

/** Absolute case directories for a page kind, sorted by name. [] when none exist yet. */
export function listFixtureCases(kind: PageKind, root: string = DEFAULT_FIXTURES_ROOT): string[] {
  const base = join(root, kind);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .map((name) => join(base, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, "capture.json")));
}

/**
 * Assert that a parse result accounts for at least `minRatio` of the capture's visible text
 * (main document only; fragments are not counted). Returns the ratio. The total is
 * recomputed with the same counter and options the parser used, so pass the parser's
 * LosslessOptions when it overrides the defaults.
 */
export function expectLosslessCoverage(
  result: ParseResult<unknown>,
  capture: Capture,
  minRatio: number,
  opts: LosslessOptions = {},
): number {
  const total = visibleTextChars(parseDocument(capture.html), opts);
  const unparsed = result.meta.unparsed_text_chars;
  if (!Number.isInteger(unparsed) || unparsed < 0 || unparsed > total) {
    throw new Error(`unparsed_text_chars ${unparsed} is not within 0..${total}`);
  }
  const keys = new Set<string>();
  for (const s of result.other_sections) {
    if (s.text.trim() === "") throw new Error(`other_sections "${s.key}" has empty text`);
    if (keys.has(s.key)) throw new Error(`other_sections key "${s.key}" is duplicated`);
    keys.add(s.key);
  }
  const ratio = total === 0 ? 1 : 1 - unparsed / total;
  if (ratio < minRatio) {
    throw new Error(
      `lossless coverage ${ratio.toFixed(3)} is below ${minRatio} (${unparsed} of ${total} visible chars unparsed)`,
    );
  }
  return ratio;
}
