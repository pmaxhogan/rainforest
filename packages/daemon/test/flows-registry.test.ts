import { describe, expect, test } from "vitest";
import { TOOL_NAMES } from "@rainforest/core";
import { FLOWS } from "../src/flows/index.ts";

// Hardcoded on purpose: the tools the hub answers itself. Every other tool needs a daemon flow.
const HUB_TOOLS = ["list_browsers", "select_browser", "get_status", "get_audit_log"];

describe("daemon flows cover the registry", () => {
  test("every registered tool is a hub tool or has a flow, and nothing else has one", () => {
    const flowNames = Object.keys(FLOWS).sort();
    const expected = TOOL_NAMES.filter((n) => !HUB_TOOLS.includes(n)).sort();
    expect(flowNames).toEqual(expected);
    expect(flowNames).toHaveLength(32);
  });

  test("the list write tools have flows", () => {
    for (const name of [
      "create_list",
      "update_list",
      "delete_list",
      "add_to_list",
      "update_list_item",
      "move_list_item",
    ]) {
      expect(Object.hasOwn(FLOWS, name), name).toBe(true);
    }
  });
});
