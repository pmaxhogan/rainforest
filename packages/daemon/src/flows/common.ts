import { randomUUID } from "node:crypto";
import {
  clampMaxChars,
  RfError,
  type Capture,
  type PageKind,
  type ParseResult,
  type Parser,
} from "@rainforest/core";
import type { LoadNeeds, PacedType, PageContext, PageType } from "@rainforest/browser";
import type { SessionProvider } from "../browser-controller.ts";

export const AMAZON = "https://www.amazon.com";

export interface FlowContext {
  browser: SessionProvider;
  now: () => number;
  signal: AbortSignal;
}

export type Flow = (args: Record<string, unknown>, ctx: FlowContext) => Promise<unknown>;

const SETTLE_MS = 1200;

/**
 * Recent captures, so several tools that read the same page (product, variants, media,
 * review summary, price history) share one page load instead of five. Short-lived and
 * in memory only: raw pages are never written to disk by the daemon.
 */
const CAPTURE_CACHE_MS = 120_000;
const captureCache = new Map<string, { at: number; capture: Capture }>();

function cachedCapture(url: string, now: number): Capture | null {
  for (const [key, entry] of captureCache)
    if (now - entry.at > CAPTURE_CACHE_MS) captureCache.delete(key);
  return captureCache.get(url)?.capture ?? null;
}

/** Forget cached captures (after any write, so reads never show a stale page). */
export function clearCaptureCache(): void {
  captureCache.clear();
}

/** Keep a capture of `url` for the tools that share one page load. */
export function rememberCapture(url: string, capture: Capture): void {
  captureCache.set(url, { at: Date.now(), capture });
}

/**
 * The recent capture of `url`, but only while the tab still shows that very page. A flow
 * that needs the live page (to fetch a fragment from it) can then skip loading it again.
 */
export function openCapture(page: PageContext, url: string): Capture | null {
  const hit = cachedCapture(url, Date.now());
  return hit && page.page.url() === hit.final_url ? hit : null;
}

/** Load one page through the rails and the pacer, capture it and parse it. */
export async function readPage<T>(
  page: PageContext,
  url: string,
  type: PageType,
  kind: PageKind,
  parser: Parser<T>,
  options: {
    settleMs?: number;
    beforeCapture?: (page: PageContext) => Promise<void>;
    /** Reuse a capture of this exact URL taken in the last two minutes. */
    shareCapture?: boolean;
  } = {},
): Promise<{ result: ParseResult<T>; capture: Capture }> {
  if (options.shareCapture) {
    const hit = cachedCapture(url, Date.now());
    if (hit) return { result: parser({ ...hit, kind }), capture: { ...hit, kind } };
  }
  await page.goto(url, type);
  await page.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, options.settleMs ?? SETTLE_MS));
  await options.beforeCapture?.(page);
  const capture = await page.capture(kind);
  if (options.shareCapture) captureCache.set(url, { at: Date.now(), capture });
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

/**
 * Cut order for a body: every top-level array that is not in `keep`, largest first, then
 * the `keep` lists in the order given (so the last one named survives longest).
 */
export function arrayKeys(body: Record<string, unknown>, keep: string[] = []): string[] {
  const others = Object.keys(body)
    .filter((key) => Array.isArray(body[key]) && !keep.includes(key))
    .sort((a, b) => JSON.stringify(body[b]).length - JSON.stringify(body[a]).length);
  return [...others, ...keep.filter((key) => Array.isArray(body[key]))];
}

export function maxCharsOf(args: Record<string, unknown>): number | undefined {
  return typeof args.max_chars === "number" ? args.max_chars : undefined;
}

/**
 * Refuse to start a multi-step flow unless every page load it needs fits the pacing
 * budget right now. A write that could not read the result back would be worse than a
 * write that never started. `retry_after_s` is the real wait, computed from the recorded
 * load times. `note` may add a sentence that depends on that wait.
 */
export function requireBudget(
  ctx: FlowContext,
  needs: LoadNeeds,
  note?: (waitMs: number) => string | undefined,
): void {
  const pacer = ctx.browser.pacer();
  const wait = pacer.waitFor(needs);
  if (wait === 0) return;
  const wanted = (Object.entries(needs) as [PacedType, number | undefined][]).filter(
    (entry): entry is [PacedType, number] => (entry[1] ?? 0) > 0,
  );
  const loads = wanted.reduce((sum, [, n]) => sum + n, 0);
  // How many of these loads fit now: the room across page types, and no more of each type
  // than its own caps leave. When a type's own cap is what falls short, name it, so the
  // refusal never reads as if there were room.
  const overall = pacer.summary().loads_left;
  const perType = wanted.map(([type, n]) => ({ type, n, room: pacer.headroom(type) }));
  const available = Math.min(
    overall,
    perType.reduce((sum, t) => sum + Math.min(t.n, t.room), 0),
  );
  const limitedBy = perType.find((t) => t.room < t.n && t.room < overall)?.type;
  const details = {
    needed: loads,
    available,
    ...(limitedBy ? { limited_by: limitedBy } : {}),
  };
  if (wait === null) {
    throw new RfError(
      "throttled",
      `this action needs ${loads} page loads at once, more than this computer's pacing caps allow`,
      { details },
    );
  }
  const cooling = pacer.plan("none");
  if (!cooling.ok) {
    throw new RfError("throttled", "this browser is cooling down after an account prompt", {
      retry_after_s: Math.ceil(wait / 1000),
      details: { ...details, reason: pacer.state.coolDownReason },
    });
  }
  const retry = Math.ceil(wait / 1000);
  const extra = note?.(wait);
  throw new RfError(
    "throttled",
    `this action needs ${loads} page loads and only ${available} fit the pacing budget right now` +
      (limitedBy ? ` (the ${limitedBy} page cap is what limits it)` : "") +
      `; all ${loads} fit in ${retry} s` +
      (extra ? `. ${extra}` : ""),
    { retry_after_s: retry, details },
  );
}

/**
 * Run a multi-step flow with the browser to itself. The budget is checked twice: once
 * before the browser is touched (a cheap refusal), and again once this call holds the
 * browser, because calls queued ahead of it may have spent the budget in the meantime.
 * Nothing else loads a page while the call holds the browser, so the second check holds
 * for the whole flow.
 */
export async function runWithBudget<T>(
  ctx: FlowContext,
  needs: LoadNeeds,
  work: (page: PageContext) => Promise<T>,
  note?: (waitMs: number) => string | undefined,
): Promise<T> {
  requireBudget(ctx, needs, note);
  const session = await ctx.browser.session();
  return await session.run(async (page) => {
    requireBudget(ctx, needs, note);
    return await work(page);
  });
}
