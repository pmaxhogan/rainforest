import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  DEFAULT_BROKER_PORT,
  DEFAULT_IDLE_DETACH_S,
  loadConfig,
  pacingOverrides,
  parseConfig,
  saveConfig,
  summarizeConfig,
} from "../src/config.ts";
import { tmpPaths } from "./helpers.ts";

const minimal = {
  hub_url: "https://hub.example.com",
  device_id: "device-0001",
  device_name: "desk",
  chrome: { profile_directory: "Default", extension_id: "abcdefghijklmnopabcdefghijklmnop" },
  update: { repo: "example/rainforest" },
};

describe("config", () => {
  test("applies neutral defaults", () => {
    const c = parseConfig(minimal);
    expect(c.aliases).toEqual([]);
    expect(c.broker).toEqual({ mode: "external", port: DEFAULT_BROKER_PORT });
    expect(c.idle_detach_s).toBe(DEFAULT_IDLE_DETACH_S);
    expect(c.update).toMatchObject({ channel: "stable", enabled: true, check_interval_s: 21600 });
  });

  test("round-trips through save and load, atomically", () => {
    const paths = tmpPaths();
    const saved = saveConfig(paths, {
      ...minimal,
      aliases: ["laptop"],
      broker: { mode: "embedded", port: 5000, start_command: ["node", "broker.js"] },
      pacing: { burst: { loads: 12 }, all: { per_hour: 30 }, search: { per_day: 50 } },
    });
    expect(loadConfig(paths)).toEqual(saved);
    expect(readdirSync(paths.root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(paths.configFile, "utf8").endsWith("\n")).toBe(true);
  });

  test("keeps unknown keys written by a newer version", () => {
    const paths = tmpPaths();
    saveConfig(paths, { ...minimal, future_knob: 7 });
    expect(loadConfig(paths)).toMatchObject({ future_knob: 7 });
  });

  test.each([
    ["http hub_url", { ...minimal, hub_url: "http://hub.example.com" }, "hub_url"],
    ["non-url hub_url", { ...minimal, hub_url: "nope" }, "hub_url"],
    ["short device_id", { ...minimal, device_id: "x" }, "device_id"],
    ["missing chrome", { ...minimal, chrome: undefined }, "chrome"],
    ["bad repo", { ...minimal, update: { repo: "no-slash" } }, "update.repo"],
    ["bad port", { ...minimal, broker: { port: 70000 } }, "broker.port"],
    ["bad broker mode", { ...minimal, broker: { mode: "other" } }, "broker.mode"],
    [
      "tiny interval",
      { ...minimal, update: { repo: "a/b", check_interval_s: 5 } },
      "check_interval_s",
    ],
    ["negative idle", { ...minimal, idle_detach_s: -1 }, "idle_detach_s"],
  ])("rejects %s", (_name, value, path) => {
    let error: unknown;
    try {
      parseConfig(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join("\n")).toContain(path);
  });

  test("pacing caps: accepted up to the ceilings and mapped for the pacer", () => {
    const c = parseConfig({
      ...minimal,
      pacing: {
        burst: { loads: 20 },
        all: { per_hour: 40, per_day: 400 },
        product: { per_hour: 20 },
        price_history: { per_day: 10 },
      },
    });
    expect(pacingOverrides(c.pacing)).toEqual({
      burst: { loads: 20 },
      global: { perHour: 40, perDay: 400 },
      caps: { product: { perHour: 20 }, price_history: { perDay: 10 } },
    });
    expect(pacingOverrides(parseConfig(minimal).pacing)).toEqual({});
    expect(pacingOverrides(parseConfig({ ...minimal, pacing: {} }).pacing)).toEqual({});
  });

  // Hardcoded on purpose: one above each ceiling, and every shape that could loosen a
  // limit by accident, must be a config error.
  test.each([
    ["burst above the ceiling", { burst: { loads: 21 } }, "pacing.burst.loads"],
    ["hourly cap above the ceiling", { all: { per_hour: 41 } }, "pacing.all.per_hour"],
    ["daily cap above the ceiling", { all: { per_day: 401 } }, "pacing.all.per_day"],
    ["a type's hourly cap above the ceiling", { cart: { per_hour: 41 } }, "pacing.cart.per_hour"],
    ["a zero cap", { burst: { loads: 0 } }, "pacing.burst.loads"],
    ["a fractional cap", { all: { per_hour: 12.5 } }, "pacing.all.per_hour"],
    ["a cap that is not a number", { all: { per_hour: "30" } }, "pacing.all.per_hour"],
    ["an unknown page type", { checkout: { per_hour: 5 } }, "pacing"],
    ["an unknown knob", { search: { min_gap_s: 1 } }, "pacing.search"],
    ["a burst window", { burst: { loads: 6, window_s: 60 } }, "pacing.burst"],
    ["the page type none", { none: { per_hour: 5 } }, "pacing"],
  ])("rejects pacing with %s", (_name, pacing, path) => {
    let error: unknown;
    try {
      parseConfig({ ...minimal, pacing });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join("\n")).toContain(path);
  });

  test("pacing caps are clamped again when they reach the pacer", () => {
    const tooHigh = {
      burst: { loads: 500 },
      all: { per_hour: 500, per_day: 5000 },
      cart: { per_hour: 500 },
    };
    expect(pacingOverrides(tooHigh)).toEqual({
      burst: { loads: 20 },
      global: { perHour: 40, perDay: 400 },
      caps: { cart: { perHour: 40 } },
    });
  });

  test("the page archive is on by default at 200 pages and 2 GB, and can be changed or turned off", () => {
    // Hardcoded on purpose: these are the limits the owner chose.
    expect(parseConfig(minimal).page_archive).toEqual({
      enabled: true,
      max_pages: 200,
      max_mb: 2048,
    });
    expect(parseConfig({ ...minimal, page_archive: { enabled: false } }).page_archive).toEqual({
      enabled: false,
      max_pages: 200,
      max_mb: 2048,
    });
    expect(
      parseConfig({ ...minimal, page_archive: { max_pages: 50, max_mb: 100 } }).page_archive,
    ).toEqual({ enabled: true, max_pages: 50, max_mb: 100 });
    for (const bad of [{ max_pages: 0 }, { max_mb: 0 }, { max_pages: 1.5 }, { keep: true }]) {
      expect(() => parseConfig({ ...minimal, page_archive: bad }), JSON.stringify(bad)).toThrow(
        ConfigError,
      );
    }
  });

  test("the automation window fits the screen by default and can keep the fixed size", () => {
    expect(parseConfig(minimal).window).toEqual({ fit_screen: true });
    expect(parseConfig({ ...minimal, window: { fit_screen: false } }).window).toEqual({
      fit_screen: false,
    });
    for (const bad of [{ fit_screen: "yes" }, { width: 1280 }, { fit_screen: true, size: 1 }]) {
      expect(() => parseConfig({ ...minimal, window: bad }), JSON.stringify(bad)).toThrow(
        ConfigError,
      );
    }
  });

  test("validation errors never echo the offending value", () => {
    let message = "";
    try {
      parseConfig({ ...minimal, hub_url: "http://secret-host.invalid" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("secret-host");
  });

  test("a missing or corrupt file raises ConfigError", () => {
    const paths = tmpPaths();
    expect(() => loadConfig(paths)).toThrow(/setup/);
    writeFileSync(paths.configFile, "{not json");
    expect(() => loadConfig(paths)).toThrow(/not valid JSON/);
  });

  test("saveConfig refuses an invalid config and writes nothing", () => {
    const paths = tmpPaths();
    expect(() => saveConfig(paths, { ...minimal, hub_url: "ftp://x" })).toThrow(ConfigError);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  test("summary has the expected shape and no key material", () => {
    const summary = JSON.stringify(summarizeConfig(parseConfig(minimal)));
    expect(summary).toContain("device_name");
    expect(summary).not.toMatch(/token|secret|key/i);
  });
});
