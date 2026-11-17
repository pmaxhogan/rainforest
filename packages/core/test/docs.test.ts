import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TOOLS, TOOL_NAMES } from "../src/index.ts";

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

  test("quotes each tool's registry description verbatim", () => {
    const wrong: string[] = [];
    for (const tool of TOOLS) {
      const start = text.indexOf(`### \`${tool.name}\``);
      const section = text.slice(start).split(/^### /m)[1] ?? "";
      const quoted = section
        .split("\n")
        .filter((line) => line.startsWith(">"))
        .map((line) => line.replace(/^>\s?/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (quoted !== tool.description.replace(/\s+/g, " ").trim()) wrong.push(tool.name);
    }
    expect(wrong).toEqual([]);
  });
});
