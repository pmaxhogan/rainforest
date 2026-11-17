import { describe, expect, test } from "vitest";
import { resolvePaths, resolveRoot, versionDir } from "../src/paths.ts";

describe("resolveRoot", () => {
  test("macOS uses Application Support", () => {
    expect(resolveRoot({ platform: "darwin", env: {}, homedir: "/hd" })).toBe(
      "/hd/Library/Application Support/rainforest",
    );
  });

  test("Windows uses LOCALAPPDATA", () => {
    expect(
      resolveRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
        homedir: "C:\\Users\\test",
      }),
    ).toBe("C:\\Users\\test\\AppData\\Local\\rainforest");
  });

  test("Windows falls back to homedir AppData\\Local", () => {
    expect(resolveRoot({ platform: "win32", env: {}, homedir: "C:\\Users\\test" })).toBe(
      "C:\\Users\\test\\AppData\\Local\\rainforest",
    );
  });

  test("Linux honours XDG_DATA_HOME, else ~/.local/share", () => {
    expect(
      resolveRoot({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, homedir: "/home/test" }),
    ).toBe("/data/rainforest");
    expect(resolveRoot({ platform: "linux", env: {}, homedir: "/home/test" })).toBe(
      "/home/test/.local/share/rainforest",
    );
  });

  test("Linux ignores a relative XDG_DATA_HOME", () => {
    expect(
      resolveRoot({ platform: "linux", env: { XDG_DATA_HOME: "rel" }, homedir: "/home/test" }),
    ).toBe("/home/test/.local/share/rainforest");
  });

  test("RAINFOREST_HOME overrides every platform", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveRoot({ platform, env: { RAINFOREST_HOME: "/override" }, homedir: "/h" })).toBe(
        "/override",
      );
    }
    expect(
      resolveRoot({ platform: "win32", env: { RAINFOREST_HOME: "D:\\rf" }, homedir: "C:\\h" }),
    ).toBe("D:\\rf");
  });

  test("an empty override is ignored", () => {
    expect(resolveRoot({ platform: "darwin", env: { RAINFOREST_HOME: "  " }, homedir: "/u" })).toBe(
      "/u/Library/Application Support/rainforest",
    );
  });
});

describe("resolvePaths", () => {
  test("lays out every file under the root", () => {
    const p = resolvePaths({ platform: "linux", env: { RAINFOREST_HOME: "/r" }, homedir: "/h" });
    expect(p).toMatchObject({
      root: "/r",
      versionsDir: "/r/versions",
      currentFile: "/r/current",
      configFile: "/r/config.json",
      deviceKeyFile: "/r/device-key.json",
      secretsFile: "/r/secrets.json",
      logsDir: "/r/logs",
      logFile: "/r/logs/daemon.log",
      auditFile: "/r/audit.jsonl",
      pagesDir: "/r/pages",
      stateFile: "/r/state.json",
      launcherFile: "/r/launcher.ts",
    });
    expect(versionDir(p, "1.2.3")).toBe("/r/versions/1.2.3");
  });

  test("Windows paths use backslashes", () => {
    const p = resolvePaths({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\L" },
      homedir: "C:\\h",
    });
    expect(p.logFile).toBe("C:\\L\\rainforest\\logs\\daemon.log");
    expect(versionDir(p, "0.1.0")).toBe("C:\\L\\rainforest\\versions\\0.1.0");
  });
});
