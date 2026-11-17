import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  atomicWriteFile,
  atomicWriteJson,
  icaclsArgs,
  readTextIfExists,
  writeSecretFile,
} from "../src/fsutil.ts";
import { loadSecrets, saveSecrets } from "../src/secrets.ts";
import { fakeExec, tmpDir, tmpPaths } from "./helpers.ts";

describe("atomic writes", () => {
  test("replaces the target and leaves no temp files", () => {
    const dir = tmpDir();
    const file = join(dir, "sub", "a.json");
    atomicWriteJson(file, { v: 1 });
    atomicWriteJson(file, { v: 2 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 2 });
    expect(readdirSync(join(dir, "sub"))).toEqual(["a.json"]);
  });

  test("readTextIfExists returns null for a missing file", () => {
    expect(readTextIfExists(join(tmpDir(), "nope"))).toBeNull();
  });

  test("honours a file mode", () => {
    const file = join(tmpDir(), "m");
    atomicWriteFile(file, "x", 0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("secret files", () => {
  test("POSIX: mode 0600 and no icacls call", async () => {
    const dir = tmpDir();
    const file = join(dir, "device-key.json");
    const { exec, calls } = fakeExec();
    await writeSecretFile(file, '{"k":1}', { platform: "darwin", exec });
    expect(readFileSync(file, "utf8")).toBe('{"k":1}');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls).toEqual([]);
    expect(readdirSync(dir)).toEqual(["device-key.json"]);
  });

  test("an overwrite stays 0600", async () => {
    const file = join(tmpDir(), "s.json");
    writeFileSync(file, "old", { mode: 0o644 });
    await writeSecretFile(file, "new", { platform: "linux", exec: fakeExec().exec });
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("Windows: restricts the temp file with icacls BEFORE the secret is written", async () => {
    const file = join(tmpDir(), "device-key.json");
    let sizeAtIcacls = -1;
    const calls: string[][] = [];
    await writeSecretFile(file, "SECRET-BYTES", {
      platform: "win32",
      account: "HOST\\someone",
      exec: async (_f, args) => {
        calls.push(args);
        sizeAtIcacls = statSync(args[0] as string).size;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(sizeAtIcacls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(1)).toEqual(["/inheritance:r", "/grant:r", "HOST\\someone:(F)"]);
    expect(readFileSync(file, "utf8")).toBe("SECRET-BYTES");
  });

  test("a failing icacls aborts without leaving the secret behind", async () => {
    const dir = tmpDir();
    await expect(
      writeSecretFile(join(dir, "k.json"), "SECRET", {
        platform: "win32",
        account: "u",
        exec: async () => ({ code: 5, stdout: "", stderr: "denied" }),
      }),
    ).rejects.toThrow(/icacls/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("icaclsArgs strips inheritance and grants only the account", () => {
    expect(icaclsArgs("f", "a\\b")).toEqual(["f", "/inheritance:r", "/grant:r", "a\\b:(F)"]);
  });

  test("secrets.json round-trips and validates", async () => {
    const paths = tmpPaths();
    expect(loadSecrets(paths)).toBeNull();
    await saveSecrets(
      paths,
      { extension_token: "e".repeat(32), update_token: "u-token" },
      { platform: "darwin", exec: fakeExec().exec },
    );
    expect(loadSecrets(paths)).toMatchObject({ update_token: "u-token" });
    expect(statSync(paths.secretsFile).mode & 0o777).toBe(0o600);
    await expect(
      saveSecrets(
        paths,
        { extension_token: "short" },
        { platform: "darwin", exec: fakeExec().exec },
      ),
    ).rejects.toThrow();
  });
});
