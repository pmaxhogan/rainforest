import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createLogger, isSensitiveKey, redact } from "../src/log.ts";
import { tmpDir } from "./helpers.ts";

describe("redact", () => {
  test("drops fields named like secrets, at any depth and case", () => {
    const out = redact({
      ok: 1,
      extension_token: "t",
      Authorization: "Bearer x",
      nested: { password: "p", Cookie: "c", fine: true, list: [{ signature: "s", keep: 2 }] },
      client_secret: "z",
    });
    expect(out).toEqual({ ok: 1, nested: { fine: true, list: [{ keep: 2 }] } });
  });

  test("matches the intended key families", () => {
    for (const key of [
      "token",
      "update_token",
      "secret",
      "password",
      "signature",
      "authorization",
      "cookie",
      "Set-Cookie",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ["tool", "duration_ms", "path"]) expect(isSensitiveKey(key)).toBe(false);
  });

  test("flattens errors, survives cycles and bounds depth", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redact({ err: new Error("boom"), cyclic }) as {
      err: unknown;
      cyclic: { self: unknown };
    };
    expect(out.err).toEqual({ name: "Error", message: "boom" });
    expect(out.cyclic.self).toBe("[circular]");
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) deep = (deep.n = {}) as Record<string, unknown>;
    expect(JSON.stringify(redact(root))).toContain("[truncated]");
  });
});

describe("logger", () => {
  test("writes JSON lines with level, bindings and redaction", () => {
    const dir = tmpDir();
    const file = join(dir, "logs", "daemon.log");
    const log = createLogger({
      file,
      now: () => new Date("2030-01-02T03:04:05.000Z"),
      bindings: { component: "x" },
    });
    log.info("hello", { token: "nope", n: 1 });
    log.child({ call: "c1" }).warn("careful", { cookie: "nope" });
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      component: "x",
      n: 1,
      ts: "2030-01-02T03:04:05.000Z",
      level: "info",
      msg: "hello",
    });
    expect(lines[1]).toMatchObject({ level: "warn", call: "c1", component: "x" });
    expect(readFileSync(file, "utf8")).not.toContain("nope");
  });

  test("respects the level threshold", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", sink: (l) => lines.push(l) });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });

  test("a caller cannot override ts, level or msg through fields", () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l) });
    log.info("real", { level: "fake", msg: "fake", ts: "fake" });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "info", msg: "real" });
  });

  test("rotates by size and keeps three files", () => {
    const dir = tmpDir();
    const file = join(dir, "daemon.log");
    const log = createLogger({ file, maxBytes: 300, maxFiles: 3 });
    for (let i = 0; i < 40; i++) log.info("line", { i, pad: "x".repeat(40) });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const f of [file, `${file}.1`, `${file}.2`])
      expect(statSync(f).size).toBeLessThanOrEqual(300);
    const newest = readFileSync(file, "utf8").trim().split("\n").pop() as string;
    expect(JSON.parse(newest).i).toBe(39);
  });

  test("never throws when the log file cannot be written", () => {
    const dir = tmpDir();
    const log = createLogger({ file: join(dir, "logs", "daemon.log") });
    // Removing the directory out from under the writer must not take the daemon down.
    rmSync(join(dir, "logs"), { recursive: true, force: true });
    expect(() => log.info("ok")).not.toThrow();
  });
});
