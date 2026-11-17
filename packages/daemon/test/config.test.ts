import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  DEFAULT_BROKER_PORT,
  DEFAULT_IDLE_DETACH_S,
  loadConfig,
  parseConfig,
  saveConfig,
  summarizeConfig,
} from "../src/config.ts";
import { tmpPaths } from "./helpers.ts";

const minimal = {
  hub_url: "https://hub.example.com",
  device_id: "device-0001",
  device_name: "desk",
  chrome: { profile_directory: "Default", extension_id: "abcdefghijklmnop" },
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
      pacing: { search: { min_gap_s: 4 } },
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
