/**
 * Strategy runner: a field is extracted by trying several independent strategies in order
 * (stable id, data attribute, visible label, text anchor, ...). The one that hit is recorded
 * in `meta.strategies[field]` so parser health can show when a page drifts from the primary
 * strategy to a fallback before the fallback breaks too.
 */
import type { ParseMeta } from "@rainforest/core";

/** Conventional strategy names, most to least stable. Any other string is allowed. */
export const STRATEGY_NAMES = ["id", "data-attr", "label", "text-anchor", "blob"] as const;

export type Strategy<T> = readonly [name: string, run: () => T | null | undefined];

export interface FirstOfOptions {
  /** The field may legitimately be absent: no warning when nothing hits. */
  optional?: boolean;
}

/** A fresh, empty meta object. */
export function newMeta(): ParseMeta {
  return { strategies: {}, warnings: [], unparsed_text_chars: 0 };
}

/** undefined, null, NaN, blank strings and empty arrays count as a miss. */
export function isMiss(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return Number.isNaN(value);
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Run strategies in order and return the first hit. Records the winning strategy name in
 * `meta.strategies[field]`; a strategy that throws becomes a warning and the next one runs.
 * Never throws.
 */
export function firstOf<T>(
  field: string,
  strategies: readonly Strategy<T>[],
  meta: ParseMeta,
  opts: FirstOfOptions = {},
): T | undefined {
  for (const [name, run] of strategies) {
    let value: T | null | undefined;
    try {
      value = run();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      meta.warnings.push(`${field}: strategy "${name}" threw: ${why}`);
      continue;
    }
    if (!isMiss(value)) {
      meta.strategies[field] = name;
      return value as T;
    }
  }
  if (opts.optional !== true) {
    const tried = strategies.map(([name]) => name).join(", ") || "none";
    meta.warnings.push(`${field}: no strategy matched (tried ${tried})`);
  }
  return undefined;
}
