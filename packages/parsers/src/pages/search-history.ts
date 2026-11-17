import type { Capture, ParseResult, Parser } from "@rainforest/core";
import { attr, parseDocument, text, type DomElement } from "../dom.ts";
import { newMeta } from "../strategy.ts";

/**
 * Recent searches. Amazon exposes them only in the search box dropdown: with the box
 * focused and empty, the suggestion list shows the account's recent searches. This parser
 * reads that dropdown from a capture taken while it is open. Best effort: when the
 * dropdown is absent or has no recent entries the result says so instead of guessing.
 */

export interface SearchHistoryEntry {
  query: string;
  /** True when the row is marked as a recent search (as opposed to a generic suggestion). */
  recent: boolean;
}

export interface SearchHistoryPage {
  supported: boolean;
  entries: SearchHistoryEntry[];
  /** Why nothing was returned, when nothing was. */
  note?: string;
}

const CONTAINERS = [
  "#nav-flyout-searchAjax",
  ".autocomplete-results-container",
  "#sac-autocomplete-results-container",
];
const ROWS = ["[id^='sac-suggestion-row']", ".s-suggestion-container", ".s-suggestion"];

function rawAll(
  root: DomElement | { querySelectorAll(sel: string): unknown },
  selector: string,
): DomElement[] {
  try {
    return Array.from(root.querySelectorAll(selector) as Iterable<DomElement>);
  } catch {
    return [];
  }
}

function isRecent(row: DomElement): boolean {
  const cls = `${attr(row, "class") ?? ""} ${rawAll(row, "[class]")
    .map((e) => attr(e, "class") ?? "")
    .join(" ")}`;
  if (/recent/i.test(cls)) return true;
  // A recent search carries its own delete control.
  return rawAll(row, "[aria-label], button, [role=button]").some((e) =>
    /remove|delete|clear/i.test(`${attr(e, "aria-label") ?? ""} ${text(e)}`),
  );
}

export const parseSearchHistory: Parser<SearchHistoryPage> = (
  capture: Capture,
): ParseResult<SearchHistoryPage> => {
  const meta = newMeta();
  const doc = parseDocument(capture.html);
  let container: DomElement | undefined;
  for (const selector of CONTAINERS) {
    // The dropdown is rendered on demand, so read it from the raw DOM.
    container = rawAll(doc, selector)[0];
    if (container) {
      meta.strategies.container = selector;
      break;
    }
  }
  if (!container) {
    return {
      data: {
        supported: false,
        entries: [],
        note: "the search box dropdown was not present in the page",
      },
      other_sections: [],
      meta: { ...meta, warnings: ["search dropdown not found"] },
    };
  }
  let rows: DomElement[] = [];
  for (const selector of ROWS) {
    rows = rawAll(container, selector);
    if (rows.length > 0) {
      meta.strategies.rows = selector;
      break;
    }
  }
  const seen = new Set<string>();
  const entries: SearchHistoryEntry[] = [];
  for (const row of rows) {
    // The query text lives on the suggestion element itself; the row also holds controls.
    const suggestion = /(^|\s)s-suggestion(\s|$)/.test(attr(row, "class") ?? "")
      ? row
      : (rawAll(row, ".s-suggestion")[0] ?? row);
    const label = (attr(suggestion, "aria-label") ?? "").trim();
    const query = (label || text(suggestion)).replace(/\s+/g, " ").trim();
    if (!query || query.length > 200 || seen.has(query)) continue;
    seen.add(query);
    entries.push({ query, recent: isRecent(row) });
  }
  const recent = entries.filter((e) => e.recent);
  const data: SearchHistoryPage =
    recent.length > 0
      ? { supported: true, entries: recent }
      : {
          supported: false,
          entries: [],
          note:
            entries.length > 0
              ? "the dropdown showed suggestions but none was marked as a recent search (browsing history may be turned off)"
              : "the dropdown was empty",
        };
  return { data, other_sections: [], meta: { ...meta, unparsed_text_chars: 0 } };
};
