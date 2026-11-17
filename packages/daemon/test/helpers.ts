import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Exec, ExecResult } from "../src/exec.ts";
import { resolvePaths, type AppPaths } from "../src/paths.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

export function tmpDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "rf-daemon-test-"));
  dirs.push(dir);
  return dir;
}

/** App paths rooted in a fresh temp dir via RAINFOREST_HOME; never the real home. */
export function tmpPaths(platform: NodeJS.Platform = "darwin"): AppPaths {
  const root = tmpDir();
  return resolvePaths({ platform, env: { RAINFOREST_HOME: root }, homedir: root });
}

export interface FakeExec {
  exec: Exec;
  calls: Array<{ file: string; args: string[] }>;
}

/** Scripted exec: `reply` maps a call to a result (default: exit 0, empty output). */
export function fakeExec(
  reply: (file: string, args: string[]) => Partial<ExecResult> = () => ({}),
): FakeExec {
  const calls: FakeExec["calls"] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "", ...reply(file, args) };
  };
  return { exec, calls };
}
