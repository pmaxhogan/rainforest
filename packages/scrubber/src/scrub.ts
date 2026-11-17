/**
 * scrubCapture: raw Capture -> synthetic Capture plus a report. Deterministic: the output
 * depends only on the input and `seed`, so re-scrubbing a capture is byte-identical.
 */
import type { Capture } from "@rainforest/core";
import { auditScrubbed } from "./audit.ts";
import { createContext, SYNTHETIC_CAPTURED_AT, type Category } from "./context.ts";
import { scrubHtml } from "./html.ts";
import { scrubUrl } from "./url.ts";

export const DEFAULT_SEED = "rainforest-scrubber-v1";

export interface ScrubOptions {
  /** Changes every synthetic choice. Default DEFAULT_SEED. */
  seed?: string;
}

export interface ReportFinding {
  /** "url", "final_url", "page.html" or "fragment:<name>". */
  where: string;
  rule: string;
  line: number;
}

export interface ScrubReport {
  /** Replacement counts per category, sorted by name. */
  counts: Record<string, number>;
  /** Residual-risk findings from auditScrubbed over the output. Empty means clean. */
  findings: ReportFinding[];
}

export interface ScrubResult {
  capture: Capture;
  report: ScrubReport;
}

const FRAGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function scrubCapture(capture: Capture, opts: ScrubOptions = {}): ScrubResult {
  const seed = opts.seed ?? DEFAULT_SEED;
  const fragNames = Object.keys(capture.fragments ?? {}).sort();
  for (const name of fragNames) {
    if (!FRAGMENT_NAME.test(name)) throw new Error("fragment names must match [A-Za-z0-9_-]");
  }
  const material = JSON.stringify([
    seed,
    capture.kind,
    capture.url,
    capture.final_url,
    capture.captured_at,
    capture.html,
    fragNames.map((n) => [n, capture.fragments?.[n] ?? ""]),
  ]);
  const ctx = createContext(material, capture.captured_at);

  // Fixed processing order so the first-appearance numbering is stable.
  const url = scrubUrl(capture.url, ctx, "page");
  const finalUrl = scrubUrl(capture.final_url, ctx, "page");
  const html = scrubHtml(capture.html, ctx);
  const fragments: Record<string, string> = {};
  for (const name of fragNames) fragments[name] = scrubHtml(capture.fragments?.[name] ?? "", ctx);

  const out: Capture = {
    kind: capture.kind,
    url,
    final_url: finalUrl,
    captured_at: SYNTHETIC_CAPTURED_AT,
    html,
  };
  if (capture.fragments !== undefined) out.fragments = fragments;

  const findings: ReportFinding[] = [];
  const add = (where: string, text: string, html: boolean) => {
    const list = html ? auditScrubbed(text) : auditScrubbed(text, { html: false });
    for (const f of list) findings.push({ where, rule: f.rule, line: f.line });
  };
  add("url", url, false);
  add("final_url", finalUrl, false);
  add("page.html", html, true);
  for (const name of fragNames) add(`fragment:${name}`, fragments[name] ?? "", true);

  const counts: Record<string, number> = {};
  for (const k of [...ctx.counts.keys()].sort() as Category[]) counts[k] = ctx.counts.get(k) ?? 0;
  return { capture: out, report: { counts, findings } };
}
