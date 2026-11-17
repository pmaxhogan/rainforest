import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import type { Exec } from "./exec.ts";
import type { Platform } from "./paths.ts";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function tempSibling(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename() that retries the transient EPERM/EBUSY/EACCES Windows throws while a scanner holds a file. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= 5) throw error;
      sleepSync(25 * (attempt + 1));
    }
  }
}

/** Write a file atomically: temp sibling in the same directory, then rename over the target. */
export function atomicWriteFile(path: string, data: string | Uint8Array, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = tempSibling(path);
  try {
    writeFileSync(tmp, data, mode === undefined ? {} : { mode });
    renameWithRetry(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function atomicWriteJson(path: string, value: unknown, mode?: number): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface SecretWriteDeps {
  platform: Platform;
  exec: Exec;
  /** Account name the ACL grant targets on Windows. Defaults to the current OS user. */
  account?: string;
}

/** Arguments for `icacls` that leave only `account` with access to `file`. */
export function icaclsArgs(file: string, account: string): string[] {
  return [file, "/inheritance:r", "/grant:r", `${account}:(F)`];
}

export function currentWindowsAccount(env: Record<string, string | undefined> = process.env) {
  const user = os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * Restrict a file to the current user. POSIX: chmod 0600 semantics come from the open
 * mode. Windows: strip inherited ACEs and grant only the current account via icacls.
 */
export async function restrictToCurrentUser(file: string, deps: SecretWriteDeps): Promise<void> {
  if (deps.platform !== "win32") return;
  // `whoami` is authoritative: in a remote (ssh) session USERDOMAIN can name a workgroup
  // that is not a valid account domain, and icacls then fails to resolve the account.
  let account = deps.account;
  if (!account) {
    const who = await deps.exec("whoami", []);
    const name = who.code === 0 ? who.stdout.trim() : "";
    account = /^[^\s"]+\\[^\s"]+$/.test(name) ? name : currentWindowsAccount();
  }
  const res = await deps.exec("icacls", icaclsArgs(file, account));
  if (res.code !== 0) throw new Error(`icacls failed (exit ${res.code})`);
}

/**
 * Atomically write a secret file (device key, tokens). The temp file is created owner-only
 * BEFORE any secret byte lands in it, then renamed; rename keeps the restricted ACL.
 */
export async function writeSecretFile(
  path: string,
  data: string,
  deps: SecretWriteDeps,
): Promise<void> {
  ensureDir(dirname(path));
  const tmp = tempSibling(path);
  try {
    const fd = openSync(tmp, "w", 0o600);
    closeSync(fd);
    await restrictToCurrentUser(tmp, deps);
    const fd2 = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd2, data);
    } finally {
      closeSync(fd2);
    }
    renameWithRetry(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
