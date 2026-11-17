import { describe, expect, test } from "vitest";
import type { Capture } from "@rainforest/core";
import { parseSearchHistory } from "../../src/pages/search-history.ts";

function capture(body: string): Capture {
  return {
    kind: "search_history",
    url: "https://www.example.com/",
    final_url: "https://www.example.com/",
    captured_at: "2020-07-01T12:00:00.000Z",
    html: `<html><body>${body}</body></html>`,
  };
}

describe("search history", () => {
  test("reads recent searches from the open dropdown and skips plain suggestions", () => {
    const result = parseSearchHistory(
      capture(`<div id="nav-flyout-searchAjax"><div class="autocomplete-results-container">
        <div id="sac-suggestion-row-1" class="s-suggestion-container"><div class="s-suggestion s-recent-search" aria-label="blue widget">blue widget</div><button aria-label="Remove">x</button></div>
        <div id="sac-suggestion-row-2" class="s-suggestion-container"><div class="s-suggestion" aria-label="green widget">green widget</div><span role="button" aria-label="Delete green widget"></span></div>
        <div id="sac-suggestion-row-3" class="s-suggestion-container"><div class="s-suggestion" aria-label="trending gadget">trending gadget</div></div>
      </div></div>`),
    );
    expect(result.data.supported).toBe(true);
    expect(result.data.entries.map((e) => e.query)).toEqual(["blue widget", "green widget"]);
  });

  test("says unsupported when the dropdown is missing, empty or has no recent entries", () => {
    expect(parseSearchHistory(capture("<p>nothing</p>")).data).toMatchObject({
      supported: false,
      entries: [],
    });
    expect(
      parseSearchHistory(capture('<div class="autocomplete-results-container"></div>')).data.note,
    ).toMatch(/empty/);
    const onlySuggestions = parseSearchHistory(
      capture(
        '<div class="autocomplete-results-container"><div class="s-suggestion">plain suggestion</div></div>',
      ),
    );
    expect(onlySuggestions.data.supported).toBe(false);
    expect(onlySuggestions.data.note).toMatch(/none was marked/);
  });
});
