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
  "search_orders",
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

describe("tool descriptions tell the truth", () => {
  test("every tool is implemented: no description says it is not", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).not.toMatch(
        /not implemented yet in this version|answers unsupported\.$/i,
      );
    }
  });

  test("the list write tools describe their real results", () => {
    const expected: Record<string, RegExp> = {
      create_list: /Returns \{changed, list, before, after\}/,
      update_list: /Returns \{changed, before, after\}/,
      delete_list: /cannot be undone/,
      add_to_list: /Returns \{changed, added, before_count, after_count\}/,
      update_list_item: /Returns \{changed, before, after\}/,
      move_list_item: /copy: true answers unsupported/,
    };
    for (const [name, re] of Object.entries(expected)) {
      expect(getTool(name)!.description, name).toMatch(re);
    }
  });

  test("inputs nothing reads are not advertised", () => {
    const keys = (name: string) => Object.keys(getTool(name)!.input.shape);
    expect(keys("search")).not.toContain("prime_only");
    expect(keys("search")).not.toContain("min_rating");
    expect(keys("search")).not.toContain("condition");
    for (const name of ["get_media", "get_price_history"]) {
      expect(keys(name), name).not.toContain("with_images");
      expect(keys(name), name).not.toContain("max_images");
    }
    expect(keys("get_status")).toEqual([]);
  });

  test("add_to_cart says what it refuses and what it returns", () => {
    const d = getTool("add_to_cart")!.description;
    expect(d).toContain("subscribe_and_save is always refused");
    expect(d).toContain("show_on_screen");
    expect(d).toContain("not applied yet");
    expect(d).not.toContain("Never subscribes unless");
    for (const field of [
      "changed",
      "before",
      "after",
      "added",
      "acknowledged_flags",
      "declined_upsells",
      "quantity_note",
      "offer_gone",
      "price_changed",
      "seller_changed",
      "out_of_stock",
    ]) {
      expect(d, field).toContain(field);
    }
  });

  test("get_price_history says keepa is a chart URL only", () => {
    const d = getTool("get_price_history")!.description;
    expect(d).toContain("series_available: false");
  });

  test("list_orders describes archived, cancelled and its two cursors", () => {
    const d = getTool("list_orders")!.description;
    expect(d).toContain("archived (answers unsupported");
    expect(d).toContain("next_page_cursor");
    expect(d).toContain("next_cursor");
    expect(getTool("list_orders")!.input.safeParse({ filter: "archived" }).success).toBe(true);
  });

  test("search_orders pages by number and bounds its query", () => {
    const t = getTool("search_orders")!;
    expect(t.kind).toBe("read");
    expect(t.pacing).toBe("account");
    expect(t.description).toContain("next_page");
    expect(t.input.safeParse({ query: "desk lamp" }).success).toBe(true);
    expect(t.input.safeParse({ query: "desk lamp", page: 3 }).success).toBe(true);
    expect(t.input.safeParse({}).success).toBe(false);
    expect(t.input.safeParse({ query: "" }).success).toBe(false);
    expect(t.input.safeParse({ query: "   " }).success).toBe(false);
    expect(t.input.safeParse({ query: "x".repeat(121) }).success).toBe(false);
    expect(t.input.safeParse({ query: "desk lamp", page: 0 }).success).toBe(false);
  });

  // Hardcoded: only these flows redeem a cursor (cursorOrThrow). Every other read tool can
  // return a next_cursor it cannot redeem, so its description must say how to get the rest.
  const WITH_CURSOR = [
    "get_product",
    "get_variants",
    "get_cart",
    "list_subscriptions",
    "get_list",
    "get_browsing_history",
    "list_orders",
  ];
  const CAN_CUT_WITHOUT_CURSOR = [
    "search",
    "get_buying_options",
    "get_reviews",
    "search_orders",
    "get_order",
    "get_invoice",
    "list_lists",
    "get_media",
    "get_review_summary",
  ];

  test("exactly the redeemable tools take a cursor", () => {
    const withCursor = TOOLS.filter((t) => "cursor" in t.input.shape).map((t) => t.name);
    expect(withCursor.sort()).toEqual([...WITH_CURSOR].sort());
  });

  test("tools that can be cut but take no cursor say how to get the rest", () => {
    for (const name of CAN_CUT_WITHOUT_CURSOR) {
      const t = getTool(name)!;
      expect("cursor" in t.input.shape, name).toBe(false);
      expect(t.description, name).toContain("truncated: true");
      expect(t.description, name).toMatch(
        "max_chars" in t.input.shape ? /raise max_chars/ : /neither cursor nor max_chars/,
      );
    }
  });

  test("get_search_history is paced under the class its flow loads", () => {
    expect(getTool("get_search_history")!.pacing).toBe("search");
  });

  test("item id patterns match what the daemon enforces", () => {
    const cartTools = ["remove_from_cart", "save_for_later", "move_to_cart", "delete_saved_item"];
    for (const name of [...cartTools, "set_cart_quantity"]) {
      const shape = getTool(name)!.input;
      const args = (id: string) => ({ item_id: id, quantity: 1 });
      expect(shape.safeParse(args("ABCDEF-1")).success, name).toBe(true);
      expect(shape.safeParse(args("A".repeat(64))).success, name).toBe(true);
      expect(shape.safeParse(args("ABCDEF1")).success, name).toBe(false);
      expect(shape.safeParse(args("A".repeat(65))).success, name).toBe(false);
      expect(shape.safeParse(args("ABCDEF 1")).success, name).toBe(false);
    }
    for (const name of ["remove_from_list", "update_list_item", "move_list_item"]) {
      const shape = getTool(name)!.input;
      const args = (id: string) => ({
        item_id: id,
        list_id: "ABCDEFGH",
        to_list_id: "ABCDEFGH",
      });
      expect(shape.safeParse(args("ABC-12")).success, name).toBe(true);
      expect(shape.safeParse(args("A".repeat(64))).success, name).toBe(true);
      expect(shape.safeParse(args("ABC12")).success, name).toBe(false);
      expect(shape.safeParse(args("A".repeat(65))).success, name).toBe(false);
      expect(shape.safeParse(args("ABC_12")).success, name).toBe(false);
    }
  });
});

describe("wire protocol", () => {
  const presenceFrame = {
    idle_s: 1,
    locked: false,
    chrome_running: true,
    profile_connected: true,
    amazon_signed_in: true,
    cooling_down_until: null,
    version: "0.1.0",
  };

  test("presence carries the burst window and results carry the pacing left", () => {
    const presence = daemonMessage.safeParse({
      type: "presence",
      presence: { ...presenceFrame, burst: { cap: 6, window_s: 600, used_at: [1000, 2000] } },
    });
    expect(presence.success && presence.data).toMatchObject({
      presence: { burst: { cap: 6, window_s: 600, used_at: [1000, 2000] } },
    });
    const result = daemonMessage.safeParse({
      type: "result",
      id: "call-0001",
      ok: false,
      error: { code: "throttled", message: "wait", retry_after_s: 575 },
      duration_ms: 1,
      pacing: { loads_left: 0, next_free_in_s: 546 },
    });
    expect(result.success && result.data).toMatchObject({
      pacing: { loads_left: 0, next_free_in_s: 546 },
    });
    expect(
      daemonMessage.safeParse({
        type: "result",
        id: "call-0001",
        ok: true,
        duration_ms: 1,
        pacing: { loads_left: -1 },
      }).success,
    ).toBe(false);
  });

  // Daemons and the hub update separately. A field one side does not know yet must be
  // dropped, never a reason to refuse the frame: that would cut a newer daemon off from an
  // older hub.
  test("fields a peer does not know are dropped, not refused", () => {
    const presence = daemonMessage.safeParse({
      type: "presence",
      presence: { ...presenceFrame, a_later_field: { anything: true } },
    });
    expect(presence.success).toBe(true);
    expect(JSON.stringify(presence.data)).not.toContain("a_later_field");
    const result = daemonMessage.safeParse({
      type: "result",
      id: "call-0001",
      ok: true,
      data: {},
      duration_ms: 1,
      a_later_field: 1,
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("a_later_field");
  });

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
