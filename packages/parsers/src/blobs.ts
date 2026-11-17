/**
 * Embedded data harvesting. Pages carry structured data next to the markup: JSON scripts,
 * Amazon's `a-state` scripts, JSON-valued attributes and object literals assigned inside
 * inline scripts. This module finds them generically; per-page parsers say which keys they
 * understand, and every other key is reported so `meta.unknown_blobs` shows what is left.
 *
 * Scripts are never "visible", so this reads the raw DOM (not q / qa). Nothing here throws:
 * malformed JSON yields an entry with `ok: false`.
 */
import { type DomElement, type DomRoot, attr } from "./dom.ts";

export type BlobSource = "json-script" | "a-state" | "attribute" | "inline-script";

export interface BlobEntry {
  /** Unique key. Repeats of the same base key get a "#2", "#3" suffix. */
  key: string;
  /** Key without the repeat suffix (what `known` matchers are tested against). */
  baseKey: string;
  source: BlobSource;
  ok: boolean;
  value: unknown;
}

export type KeyMatcher = string | RegExp;

export interface BlobOptions {
  /** Keys the caller understands. Everything else is reported in `unknownKeys`. */
  known?: readonly KeyMatcher[];
  /** JSON-valued attributes to harvest (default: DEFAULT_JSON_ATTRIBUTES). */
  attributes?: readonly string[];
  /** Name -> regex that matches just before an object or array literal in an inline script. */
  anchors?: Readonly<Record<string, RegExp>>;
}

export interface Harvest {
  /** Parsed values for understood keys. */
  known: Record<string, unknown>;
  /** Keys present but not understood (feed this to meta.unknown_blobs). */
  unknownKeys: string[];
  /** Keys whose payload failed to parse (understood or not). */
  malformed: string[];
}

/** Attributes whose value is JSON on Amazon-style pages. */
export const DEFAULT_JSON_ATTRIBUTES: readonly string[] = ["data-a-dynamic-image"];

const JSON_SCRIPT_TYPES: ReadonlySet<string> = new Set(["application/json", "application/ld+json"]);

/** JSON.parse that returns undefined instead of throwing. */
export function tryJson(s: string | null | undefined): unknown {
  if (s == null) return undefined;
  const trimmed = s.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The balanced `{...}` or `[...]` literal starting at the first non-space character at or
 * after `from`. Skips brackets inside single, double and backtick strings (with backslash
 * escapes) and inside comments. Returns undefined when no literal starts there or it never
 * closes.
 */
export function extractBalanced(src: string, from = 0): string | undefined {
  let i = from;
  while (i < src.length && /\s/.test(src[i] as string)) i++;
  const open = src[i];
  if (open !== "{" && open !== "[") return undefined;
  const start = i;
  const stack: string[] = [];
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i] as string;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return undefined;
      i = nl;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return undefined;
      i = end + 1;
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
    } else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return undefined;
      if (stack.length === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse the JSON literal that follows the first match of `anchor` in `src`. */
export function extractJsonAfter(src: string, anchor: RegExp): unknown {
  const re = new RegExp(anchor.source, anchor.flags.replace("g", ""));
  const m = re.exec(src);
  if (m === null) return undefined;
  const literal = extractBalanced(src, m.index + m[0].length);
  return literal === undefined ? undefined : tryJson(literal);
}

function matches(key: string, matchers: readonly KeyMatcher[]): boolean {
  return matchers.some((m) => (typeof m === "string" ? m === key : m.test(key)));
}

/** Every embedded blob in document order of discovery (scripts, then attributes, then anchors). */
export function collectBlobs(root: DomRoot, opts: BlobOptions = {}): BlobEntry[] {
  const out: BlobEntry[] = [];
  const counts = new Map<string, number>();
  const add = (baseKey: string, source: BlobSource, value: unknown): void => {
    const n = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, n);
    out.push({
      key: n === 1 ? baseKey : `${baseKey}#${n}`,
      baseKey,
      source,
      ok: value !== undefined,
      value,
    });
  };

  const scripts = Array.from(root.querySelectorAll("script"));
  scripts.forEach((script, index) => {
    const type = (attr(script, "type") ?? "").toLowerCase();
    const body = script.textContent ?? "";
    if (type === "a-state" || script.hasAttribute("data-a-state")) {
      const meta = tryJson(attr(script, "data-a-state"));
      const key =
        meta !== null &&
        typeof meta === "object" &&
        typeof (meta as { key?: unknown }).key === "string"
          ? (meta as { key: string }).key
          : `a-state:${index}`;
      add(key, "a-state", tryJson(body));
    } else if (JSON_SCRIPT_TYPES.has(type)) {
      add(
        script.id || `${type === "application/ld+json" ? "ld-json" : "json"}:${index}`,
        "json-script",
        tryJson(body),
      );
    }
  });

  for (const name of opts.attributes ?? DEFAULT_JSON_ATTRIBUTES) {
    let found: DomElement[];
    try {
      found = Array.from(root.querySelectorAll(`[${name}]`));
    } catch {
      continue;
    }
    found.forEach((el, index) => {
      const key = el.id ? `${name}#${el.id}` : `${name}:${index}`;
      add(key, "attribute", tryJson(el.getAttribute(name)));
    });
  }

  const anchors = Object.entries(opts.anchors ?? {});
  if (anchors.length > 0) {
    const inline = scripts.filter((s) => {
      const type = (attr(s, "type") ?? "").toLowerCase();
      return (
        !s.hasAttribute("src") && (type === "" || type === "text/javascript" || type === "module")
      );
    });
    for (const [name, anchor] of anchors) {
      let value: unknown;
      let seen = false;
      for (const s of inline) {
        const src = s.textContent ?? "";
        const re = new RegExp(anchor.source, anchor.flags.replace("g", ""));
        if (!re.test(src)) continue;
        seen = true;
        value = extractJsonAfter(src, anchor);
        break;
      }
      if (seen) add(name, "inline-script", value);
    }
  }
  return out;
}

/**
 * Split embedded blobs into understood values and unknown keys. With no `known` list every
 * key is unknown, which is the right default for a page nobody has written a parser for.
 */
export function harvestBlobs(root: DomRoot, opts: BlobOptions = {}): Harvest {
  const knownMatchers = opts.known ?? [];
  const harvest: Harvest = { known: {}, unknownKeys: [], malformed: [] };
  for (const entry of collectBlobs(root, opts)) {
    if (!entry.ok) harvest.malformed.push(entry.key);
    if (matches(entry.baseKey, knownMatchers) || opts.anchors?.[entry.baseKey] !== undefined) {
      if (entry.ok) harvest.known[entry.key] = entry.value;
    } else {
      harvest.unknownKeys.push(entry.key);
    }
  }
  return harvest;
}
