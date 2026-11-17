/**
 * Reading raw captures and writing fixture cases in the FixtureManifest layout:
 *
 *   <case>/capture.json   manifest (Capture without html, fragments as file names)
 *   <case>/page.html      scrubbed DOM
 *   <case>/<name>.html    one per fragment
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capture, FixtureManifest } from "@rainforest/core";

const FRAGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function readJson(path: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("capture.json must be a JSON object");
  }
  return v as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") throw new Error(`capture.json: ${key} must be a string`);
  return v;
}

/**
 * Read a raw capture directory: capture.json plus page.html (or an inline `html`), and
 * fragments given either inline or as `<name>.html` file names next to capture.json.
 */
export function readRawCapture(dir: string): Capture {
  const meta = readJson(join(dir, "capture.json"));
  const kind = str(meta, "kind") as Capture["kind"];
  const url = str(meta, "url");
  const finalUrl = str(meta, "final_url");
  const capturedAt = str(meta, "captured_at");
  const html =
    typeof meta.html === "string" ? meta.html : readFileSync(join(dir, "page.html"), "utf8");
  const capture: Capture = { kind, url, final_url: finalUrl, captured_at: capturedAt, html };
  const frags = meta.fragments;
  if (frags !== undefined) {
    if (frags === null || typeof frags !== "object" || Array.isArray(frags)) {
      throw new Error("capture.json: fragments must be an object");
    }
    capture.fragments = {};
    for (const [name, value] of Object.entries(frags as Record<string, unknown>)) {
      if (typeof value !== "string")
        throw new Error(`capture.json: fragment ${name} is not a string`);
      const asFile =
        /^[A-Za-z0-9][A-Za-z0-9_-]*\.html$/.test(value) && existsSync(join(dir, value));
      capture.fragments[name] = asFile ? readFileSync(join(dir, value), "utf8") : value;
    }
  }
  return capture;
}

export function toManifest(capture: Capture, note?: string): FixtureManifest {
  const manifest: FixtureManifest = {
    kind: capture.kind,
    url: capture.url,
    final_url: capture.final_url,
    captured_at: capture.captured_at,
  };
  if (capture.fragments !== undefined) {
    manifest.fragments = {};
    for (const name of Object.keys(capture.fragments).sort()) {
      if (
        !FRAGMENT_NAME.test(name) ||
        name === "page" ||
        name === "capture" ||
        name === "expected"
      ) {
        throw new Error("fragment names must match [A-Za-z0-9_-] and not shadow a case file");
      }
      manifest.fragments[name] = `${name}.html`;
    }
  }
  if (note !== undefined) manifest.note = note;
  return manifest;
}

/** Write a scrubbed capture as a fixture case. Leaves expected.json alone. */
export function writeFixtureCase(dir: string, capture: Capture, note?: string): string[] {
  const manifest = toManifest(capture, note);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const put = (name: string, content: string) => {
    writeFileSync(join(dir, name), content.endsWith("\n") ? content : `${content}\n`);
    written.push(name);
  };
  put("capture.json", JSON.stringify(manifest, null, 2));
  put("page.html", capture.html);
  for (const [name, file] of Object.entries(manifest.fragments ?? {})) {
    put(file, capture.fragments?.[name] ?? "");
  }
  return written;
}
