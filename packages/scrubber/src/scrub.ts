/**
 * scrubCapture: raw Capture -> synthetic Capture plus a report. Deterministic: the output
 * depends only on the input and `seed`, so re-scrubbing a capture is byte-identical.
 */
import type { Capture } from "@rainforest/core";
import { ID_PARAMS } from "./allowlists.ts";
import { auditScrubbed } from "./audit.ts";
import { createContext, SYNTHETIC_CAPTURED_AT, type Category } from "./context.ts";
import { scrubHtml } from "./html.ts";
import { scrubUrl } from "./url.ts";

export const DEFAULT_SEED = "rainforest-scrubber-v1";

export interface ScrubOptions {
  /** Changes every synthetic choice. Default DEFAULT_SEED. */
  seed?: string;
  /**
   * Structure-preserving size reduction (default off): drop site chrome and hidden
   * subtrees parsers do not read, and collapse whitespace. Check parsers still agree.
   */
  reduce?: boolean;
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
  collectKnownIds(
    [
      capture.url,
      capture.final_url,
      capture.html,
      ...fragNames.map((n) => capture.fragments?.[n] ?? ""),
    ],
    ctx.knownIds,
  );

  // Fixed processing order so the first-appearance numbering is stable.
  const url = scrubUrl(capture.url, ctx, "page");
  const finalUrl = scrubUrl(capture.final_url, ctx, "page");
  const hopts = { reduce: opts.reduce === true };
  const html = scrubHtml(capture.html, ctx, hopts);
  const fragments: Record<string, string> = {};
  for (const name of fragNames) {
    fragments[name] = scrubHtml(capture.fragments?.[name] ?? "", ctx, hopts);
  }

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

const ORDER_OR_ASIN = /^(?:[0-9D]\d{2}-\d{7}-\d{7}|[BX]0[A-Z0-9]{8}|\d{9}[\dX])$/i;
const ID_PARAM_RE = new RegExp(`[?&](?:amp;)?(?:${ID_PARAMS.join("|")})=([A-Za-z0-9._-]{6,})`, "g");

/** Every value an id-bearing query parameter carries anywhere in the raw documents. */
function collectKnownIds(docs: string[], out: Set<string>): void {
  for (const d of docs) {
    for (const m of d.matchAll(ID_PARAM_RE)) {
      const v = m[1];
      // Order ids and ASINs have their own consistent fakes; leave them to those rules.
      if (v === undefined || ORDER_OR_ASIN.test(v)) continue;
      out.add(v);
    }
  }
}
