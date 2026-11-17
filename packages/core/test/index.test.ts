import { describe, expect, test } from "vitest";
import {
  PROTOCOL_VERSION,
  RfError,
  TOOLS,
  TOOL_NAMES,
  annotationsFor,
  authTranscript,
  clampMaxChars,
  compareVersions,
  daemonMessage,
  getTool,
  hubMessage,
  inputJsonSchema,
  toErrorPayload,
  wrapUntrusted,
} from "../src/index.ts";

// Hardcoded on purpose: removing or renaming a tool must fail this test.
const EXPECTED_TOOLS = [
  "list_browsers",
  "select_browser",
  "show_on_screen",
  "search",
  "get_product",
  "get_variants",
  "get_buying_options",
  "get_media",
  "get_reviews",
  "get_review_summary",
  "get_price_history",
  "get_cart",
  "list_orders",
  "get_order",
  "get_invoice",
  "list_subscriptions",
  "list_lists",
  "get_list",
  "get_browsing_history",
  "get_search_history",
  "add_to_cart",
  "set_cart_quantity",
  "remove_from_cart",
  "save_for_later",
  "move_to_cart",
  "delete_saved_item",
  "create_list",
  "update_list",
  "delete_list",
  "add_to_list",
  "remove_from_list",
  "update_list_item",
  "move_list_item",
  "get_status",
  "get_audit_log",
];

const EXPECTED_WRITES = [
  "show_on_screen",
  "add_to_cart",
  "set_cart_quantity",
  "remove_from_cart",
  "save_for_later",
  "move_to_cart",
  "delete_saved_item",
  "create_list",
  "update_list",
  "delete_list",
  "add_to_list",
  "remove_from_list",
  "update_list_item",
  "move_list_item",
];

describe("tool registry", () => {
  test("has exactly the expected tools", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const name of EXPECTED_TOOLS) expect(getTool(name)).toBeDefined();
  });

  test("write tools are exactly the expected set and never read-only", () => {
    const writes = TOOLS.filter((t) => t.kind === "write").map((t) => t.name);
    expect(writes.sort()).toEqual([...EXPECTED_WRITES].sort());
    for (const name of EXPECTED_WRITES) {
      expect(annotationsFor(getTool(name)!).readOnlyHint).toBe(false);
    }
    expect(annotationsFor(getTool("select_browser")!).readOnlyHint).toBe(false);
    expect(annotationsFor(getTool("search")!).readOnlyHint).toBe(true);
    expect(annotationsFor(getTool("remove_from_cart")!).destructiveHint).toBe(true);
  });

  test("every daemon tool accepts an optional browser argument", () => {
    for (const t of TOOLS.filter((t) => t.kind !== "hub")) {
      expect(Object.keys(t.input.shape)).toContain("browser");
    }
  });

  test("input schemas convert to JSON Schema objects", () => {
    for (const t of TOOLS) {
      const schema = inputJsonSchema(t);
      expect(schema.type).toBe("object");
    }
  });

  test("add_to_cart requires an offer id", () => {
    const add = getTool("add_to_cart")!;
    expect(add.input.safeParse({}).success).toBe(false);
    expect(add.input.safeParse({ offer_id: "x".repeat(20) }).success).toBe(true);
    expect(add.input.safeParse({ offer_id: "x".repeat(20), acknowledge: ["bogus"] }).success).toBe(
      false,
    );
  });
});

describe("wire protocol", () => {
  test("protocol version is a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test("rejects unknown message types", () => {
    expect(hubMessage.safeParse({ type: "eval", code: "1" }).success).toBe(false);
    expect(daemonMessage.safeParse({ type: "result" }).success).toBe(false);
  });

  test("auth transcript binds nonce, device and protocol", () => {
    const a = authTranscript("n".repeat(32), "device-1", 1);
    expect(a).not.toEqual(authTranscript("m".repeat(32), "device-1", 1));
    expect(a).not.toEqual(authTranscript("n".repeat(32), "device-2", 1));
    expect(a).not.toEqual(authTranscript("n".repeat(32), "device-1", 2));
  });

  test("compareVersions orders dotted versions", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});

describe("results and errors", () => {
  test("wrapper uses the per-call id and refuses a weak one", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const out = wrapUntrusted('{"a":1}', id);
    expect(out).toContain(`<untrusted-external-content-from-amazon-${id}>`);
    expect(out.trimEnd().endsWith(`</untrusted-external-content-from-amazon-${id}>`)).toBe(true);
    expect(() => wrapUntrusted("{}", "x")).toThrow();
  });

  test("max chars clamps to the hard cap", () => {
    expect(clampMaxChars(undefined)).toBe(40_000);
    expect(clampMaxChars(10_000_000)).toBe(120_000);
    expect(clampMaxChars(1)).toBe(2000);
  });

  test("unknown errors do not leak their message", () => {
    expect(toErrorPayload(new Error("secret path"))).toEqual({
      code: "internal",
      message: "internal error",
    });
    expect(toErrorPayload(new RfError("busy", "queue full", { retry_after_s: 5 }))).toEqual({
      code: "busy",
      message: "queue full",
      retry_after_s: 5,
    });
  });
});
