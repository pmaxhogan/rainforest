import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AUDIT_RETENTION_DAYS, createAudit } from "../src/audit.ts";
import { tmpDir } from "./helpers.ts";

const DAY = 86_400_000;

function setup(now = 1_900_000_000_000) {
  const clock = { now };
  const file = join(tmpDir(), "audit.jsonl");
  const audit = createAudit({ file, now: () => clock.now });
  return { audit, file, clock };
}

describe("audit", () => {
  test("write tools keep their args (after redaction)", () => {
    const { audit } = setup();
    audit.record({
      tool: "add_to_list",
      outcome: "ok",
      duration_ms: 12.4,
      args: { list_id: "ABCDEFGH12", asin: "B0FAKE0001", token: "never" },
    });
    expect(audit.recent(5)).toEqual([
      {
        ts: 1_900_000_000_000,
        tool: "add_to_list",
        outcome: "ok",
        duration_ms: 12,
        args: { list_id: "ABCDEFGH12", asin: "B0FAKE0001" },
      },
    ]);
  });

  test("read tools never store args", () => {
    const { audit, file } = setup();
    audit.record({
      tool: "search",
      outcome: "ok",
      duration_ms: 5,
      args: { query: "invented query" },
    });
    expect(audit.recent(1)[0]).not.toHaveProperty("args");
    expect(readFileSync(file, "utf8")).not.toContain("invented query");
  });

  test("unknown and hub tools never store args", () => {
    const { audit } = setup();
    audit.record({
      tool: "nope",
      outcome: "error",
      duration_ms: 1,
      error_code: "unsupported",
      args: { a: 1 },
    });
    audit.record({ tool: "list_browsers", outcome: "error", duration_ms: 1, args: { a: 1 } });
    const rows = audit.recent(10);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty("args");
    expect(rows[0]).toMatchObject({ error_code: "unsupported" });
  });

  test("recent returns the last N rows, oldest first, and tolerates corrupt lines", () => {
    const { audit, file } = setup();
    for (let i = 0; i < 5; i++) {
      audit.record({ tool: "get_cart", outcome: "ok", duration_ms: i });
    }
    appendFileSync(file, "{torn line\n");
    audit.record({ tool: "get_cart", outcome: "ok", duration_ms: 99 });
    const rows = audit.recent(3);
    expect(rows.map((r) => r.duration_ms)).toEqual([3, 4, 99]);
    expect(audit.recent(0)).toEqual([]);
  });

  test("prunes rows older than 90 days, keeps newer ones", () => {
    const { audit, clock } = setup();
    const t0 = clock.now;
    audit.record({ tool: "get_cart", outcome: "ok", duration_ms: 1 });
    clock.now = t0 + 60 * DAY;
    audit.record({ tool: "get_cart", outcome: "ok", duration_ms: 2 });
    clock.now = t0 + AUDIT_RETENTION_DAYS * DAY + 1;
    expect(audit.prune()).toBe(1);
    expect(audit.recent(10).map((r) => r.duration_ms)).toEqual([2]);
    expect(audit.prune()).toBe(0);
  });

  test("prune on a missing file is a no-op", () => {
    const { audit } = setup();
    expect(audit.prune()).toBe(0);
    expect(audit.recent(5)).toEqual([]);
  });
});
