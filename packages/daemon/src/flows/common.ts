import { randomUUID } from "node:crypto";
import {
  clampMaxChars,
  RfError,
  type Capture,
  type PageKind,
  type ParseResult,
  type Parser,
} from "@rainforest/core";
import type { PageContext, PageType } from "@rainforest/browser";
import type { SessionProvider } from "../browser-controller.ts";

export const AMAZON = "https://www.amazon.com";

export interface FlowContext {
  browser: SessionProvider;
  now: () => number;
  signal: AbortSignal;
}

export type Flow = (args: Record<string, unknown>, ctx: FlowContext) => Promise<unknown>;

const SETTLE_MS = 1200;

/** Load one page through the rails and the pacer, capture it and parse it. */
export async function readPage<T>(
  page: PageContext,
  url: string,
  type: PageType,
  kind: PageKind,
  parser: Parser<T>,
  options: { settleMs?: number; beforeCapture?: (page: PageContext) => Promise<void> } = {},
): Promise<{ result: ParseResult<T>; capture: Capture }> {
  await page.goto(url, type);
  await page.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, options.settleMs ?? SETTLE_MS));
  await options.beforeCapture?.(page);
  const capture = await page.capture(kind);
  return { result: parser(capture), capture };
}

/** Metadata every read result carries next to its data. */
export function resultMeta(
  result: ParseResult<unknown>,
  capture: Capture,
): Record<string, unknown> {
  return {
    url: capture.final_url,
    retrieved_at: capture.captured_at,
    warnings: result.meta.warnings,
    unparsed_text_chars: result.meta.unparsed_text_chars,
    ...(result.meta.unknown_blobs?.length ? { unknown_blobs: result.meta.unknown_blobs } : {}),
  };
}

// ---- explicit truncation with resumable cursors

interface Stored {
  body: Record<string, unknown>;
  listKeys: string[];
  offsets: Record<string, number>;
  expires: number;
}

const CURSOR_TTL_MS = 15 * 60_000;
const store = new Map<string, Stored>();

function sweep(now: number): void {
  for (const [id, entry] of store) if (entry.expires < now) store.delete(id);
  while (store.size > 40) store.delete(store.keys().next().value as string);
}

function size(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Fit a result into the character budget. `listKeys` name the top-level arrays that may
 * be paged, in the order they should be cut: the first one named is cut first, so name
 * the least important list first and the primary list last. Truncation is never silent:
 * the result says `truncated: true` and carries a `next_cursor` that continues the same
 * parsed page without loading it again.
 */
export function fitToBudget(
  body: Record<string, unknown>,
  listKeys: string[],
  maxChars: number | undefined,
  now: number,
  offsets: Record<string, number> = {},
): Record<string, unknown> {
  const budget = clampMaxChars(maxChars);
  const out: Record<string, unknown> = { ...body };
  const next: Record<string, number> = {};
  let cut = false;
  for (const key of listKeys) {
    const list = Array.isArray(body[key]) ? (body[key] as unknown[]) : null;
    if (!list) continue;
    out[key] = list.slice(offsets[key] ?? 0);
  }
  if (Object.keys(offsets).length > 0) {
    // A continuation returns only the paged lists, not the page-level fields again.
    for (const key of Object.keys(out))
      if (!listKeys.includes(key) && key !== "meta") delete out[key];
  }
  for (const key of listKeys) {
    const list = out[key] as unknown[] | undefined;
    if (!Array.isArray(list)) continue;
    const start = offsets[key] ?? 0;
    next[key] = start + list.length;
    while (list.length > 0 && size(out) > budget) {
      list.pop();
      cut = true;
      next[key] = start + list.length;
    }
    if (size(out) <= budget) break;
  }
  for (const key of listKeys)
    if (next[key] === undefined)
      next[key] = (offsets[key] ?? 0) + ((out[key] as unknown[])?.length ?? 0);
  if (cut) {
    sweep(now);
    const id = randomUUID();
    store.set(id, { body, listKeys, offsets: next, expires: now + CURSOR_TTL_MS });
    out.truncated = true;
    out.next_cursor = id;
  } else if (size(out) > budget) {
    // Nothing left to page: cut the largest strings explicitly rather than fail.
    out.truncated = true;
    out.truncation_note = "result exceeded the budget; pass a larger max_chars";
    const text = JSON.stringify(out).slice(0, budget);
    return { truncated: true, truncation_note: out.truncation_note, partial_json: text };
  } else {
    out.truncated = false;
  }
  return out;
}

/** Continue a truncated result. Returns null when the cursor is unknown or expired. */
export function continueFromCursor(
  cursor: string,
  maxChars: number | undefined,
  now: number,
): Record<string, unknown> | null {
  const entry = store.get(cursor);
  if (!entry || entry.expires < now) return null;
  return fitToBudget(entry.body, entry.listKeys, maxChars, now, entry.offsets);
}

export function cursorOrThrow(
  cursor: unknown,
  maxChars: unknown,
  now: number,
): Record<string, unknown> | null {
  if (typeof cursor !== "string") return null;
  const continued = continueFromCursor(
    cursor,
    typeof maxChars === "number" ? maxChars : undefined,
    now,
  );
  if (!continued)
    throw new RfError("not_found", "that cursor expired; repeat the call without a cursor");
  return continued;
}

/** Parsed data plus lossless leftovers and metadata, as a plain record. */
export function pageBody(result: ParseResult<unknown>, capture: Capture): Record<string, unknown> {
  return {
    ...(result.data as Record<string, unknown>),
    other_sections: result.other_sections,
    meta: resultMeta(result, capture),
  };
}

/** Top-level arrays of a body, largest last, as paging candidates. */
export function arrayKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body)
    .filter((key) => Array.isArray(body[key]))
    .sort((a, b) => JSON.stringify(body[a]).length - JSON.stringify(body[b]).length);
}

export function maxCharsOf(args: Record<string, unknown>): number | undefined {
  return typeof args.max_chars === "number" ? args.max_chars : undefined;
}
