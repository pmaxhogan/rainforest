import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isValidVersionName,
  isVersionBad,
  linkDevVersion,
  listVersions,
  markVersionBad,
  readCurrent,
  readState,
  resolveVersionEntry,
  writeCurrent,
} from "../src/layout.ts";
import { launcherRoot, resolveLaunchTarget } from "../src/launcher.ts";
import { versionDir } from "../src/paths.ts";
import { tmpPaths } from "./helpers.ts";

function makeVersion(paths: ReturnType<typeof tmpPaths>, name: string, entry = "src/main.ts") {
  const dir = versionDir(paths, name);
  mkdirSync(join(dir, ...entry.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, ...entry.split("/")), "export {};\n");
}

describe("version names", () => {
  test("accepts release-style names and rejects traversal", () => {
    for (const ok of ["0.1.0", "1.2.3-rc.1", "dev", "v2+build5"])
      expect(isValidVersionName(ok)).toBe(true);
    for (const bad of ["", ".hidden", "../x", "a/b", "a\\b", "a..b", "x".repeat(65), "a b"]) {
      expect(isValidVersionName(bad)).toBe(false);
    }
  });
});

describe("release bundle entry", () => {
  test("a release version directory resolves to rainforestd.mjs before any source entry", () => {
    const paths = tmpPaths();
    makeVersion(paths, "0.1.5", "rainforestd.mjs");
    expect(resolveVersionEntry(paths, "0.1.5")).toBe(
      join(versionDir(paths, "0.1.5"), "rainforestd.mjs"),
    );
    makeVersion(paths, "0.1.6", "src/main.ts");
    makeVersion(paths, "0.1.6", "rainforestd.mjs");
    expect(resolveVersionEntry(paths, "0.1.6")).toBe(
      join(versionDir(paths, "0.1.6"), "rainforestd.mjs"),
    );
    writeCurrent(paths, "0.1.5");
    expect(resolveLaunchTarget(paths.root)).toEqual({
      ok: true,
      version: "0.1.5",
      entry: join(versionDir(paths, "0.1.5"), "rainforestd.mjs"),
    });
  });
});

describe("pointer and versions", () => {
  test("lists installed versions in numeric order and ignores junk", () => {
    const paths = tmpPaths();
    expect(listVersions(paths)).toEqual([]);
    for (const v of ["0.1.10", "0.1.2", "0.2.0"]) makeVersion(paths, v);
    writeFileSync(join(paths.versionsDir, "stray-file"), "x");
    mkdirSync(join(paths.versionsDir, ".tmp-staging"));
    expect(listVersions(paths)).toEqual(["0.1.2", "0.1.10", "0.2.0"]);
  });

  test("current pointer round-trips atomically and rejects bad names", () => {
    const paths = tmpPaths();
    expect(readCurrent(paths)).toBeNull();
    writeCurrent(paths, "0.1.2");
    expect(readFileSync(paths.currentFile, "utf8")).toBe("0.1.2\n");
    writeCurrent(paths, "0.1.3");
    expect(readCurrent(paths)).toBe("0.1.3");
    expect(() => writeCurrent(paths, "../evil")).toThrow(/invalid version/);
    writeFileSync(paths.currentFile, "../evil\n");
    expect(readCurrent(paths)).toBeNull();
  });

  test("bad-version marks persist in state.json", () => {
    const paths = tmpPaths();
    expect(isVersionBad(paths, "0.1.3")).toBe(false);
    markVersionBad(paths, "0.1.3", "selftest failed", 1234);
    expect(isVersionBad(paths, "0.1.3")).toBe(true);
    expect(isVersionBad(paths, "0.1.2")).toBe(false);
    expect(readState(paths).bad_versions["0.1.3"]).toEqual({ at: 1234, reason: "selftest failed" });
  });

  test("a corrupt state file reads as empty", () => {
    const paths = tmpPaths();
    writeFileSync(paths.stateFile, "{oops");
    expect(readState(paths)).toEqual({ bad_versions: {} });
  });

  test("resolves the entry point of a version", () => {
    const paths = tmpPaths();
    makeVersion(paths, "0.1.0");
    makeVersion(paths, "0.2.0", "dist/main.mjs");
    expect(resolveVersionEntry(paths, "0.1.0")).toBe(
      join(versionDir(paths, "0.1.0"), "src", "main.ts"),
    );
    expect(resolveVersionEntry(paths, "0.2.0")).toBe(
      join(versionDir(paths, "0.2.0"), "dist", "main.mjs"),
    );
    expect(resolveVersionEntry(paths, "9.9.9")).toBeNull();
  });

  test("linkDevVersion creates a shim that imports the checkout entry", () => {
    const paths = tmpPaths();
    const entry = join(paths.root, "checkout", "main.ts");
    linkDevVersion(paths, entry);
    expect(readCurrent(paths)).toBe("dev");
    const shim = readFileSync(join(versionDir(paths, "dev"), "src", "main.ts"), "utf8");
    expect(shim).toContain(JSON.stringify(pathToFileURL(entry).href));
  });
});

describe("launcher", () => {
  test("resolves the active version's entry", () => {
    const paths = tmpPaths();
    makeVersion(paths, "0.1.0");
    writeCurrent(paths, "0.1.0");
    expect(resolveLaunchTarget(paths.root)).toEqual({
      ok: true,
      version: "0.1.0",
      entry: join(paths.root, "versions", "0.1.0", "src", "main.ts"),
    });
  });

  test("agrees with layout.resolveVersionEntry", () => {
    const paths = tmpPaths();
    makeVersion(paths, "0.3.0", "dist/main.mjs");
    writeCurrent(paths, "0.3.0");
    const target = resolveLaunchTarget(paths.root);
    expect(target.ok && target.entry).toBe(resolveVersionEntry(paths, "0.3.0"));
  });

  test("fails when the pointer is missing", () => {
    const paths = tmpPaths();
    expect(resolveLaunchTarget(paths.root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pointer is missing/),
    });
  });

  test("fails when the pointer names a missing directory or an invalid name", () => {
    const paths = tmpPaths();
    writeCurrent(paths, "0.9.9");
    expect(resolveLaunchTarget(paths.root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/directory is missing/),
    });
    writeFileSync(paths.currentFile, "../../etc\n");
    expect(resolveLaunchTarget(paths.root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/valid version/),
    });
  });

  test("fails when the version has no entry point", () => {
    const paths = tmpPaths();
    mkdirSync(versionDir(paths, "0.1.0"), { recursive: true });
    writeCurrent(paths, "0.1.0");
    expect(resolveLaunchTarget(paths.root)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no entry point/),
    });
  });

  test("root is RAINFOREST_HOME when set, else the launcher's own directory", () => {
    expect(launcherRoot({ RAINFOREST_HOME: "/data" }, "/elsewhere/launcher.ts")).toBe("/data");
    expect(launcherRoot({}, "/app/dir/launcher.ts")).toBe("/app/dir");
    expect(launcherRoot({ RAINFOREST_HOME: " " }, "/app/dir/launcher.ts")).toBe("/app/dir");
  });
});
