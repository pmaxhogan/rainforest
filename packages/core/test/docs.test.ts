import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TOOL_NAMES } from "../src/index.ts";

/**
 * docs/TOOLS.md must document exactly the registered tools. A tool is documented by a
 * level-3 heading made of its name in backticks; that heading form is reserved for tools.
 */
const text = readFileSync(new URL("../../../docs/TOOLS.md", import.meta.url), "utf8");
const documented = [...text.matchAll(/^### `([A-Za-z0-9_]+)`[ \t]*$/gm)].map((m) => m[1] as string);

describe("docs/TOOLS.md", () => {
  test("has a heading for every registered tool", () => {
    const missing = TOOL_NAMES.filter((name) => !documented.includes(name));
    expect(missing).toEqual([]);
  });

  test("lists no tool that is not registered", () => {
    const extra = documented.filter((name) => !TOOL_NAMES.includes(name));
    expect(extra).toEqual([]);
  });

  test("documents each tool once", () => {
    const duplicates = documented.filter((name, i) => documented.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });
});
