import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Platform } from "../paths.ts";
import { createMacosService } from "./macos.ts";
import { ServiceError, type ServiceDeps, type ServiceManager } from "./types.ts";
import { createWindowsService } from "./windows.ts";

export * from "./types.ts";

export interface PlatformServiceDeps extends ServiceDeps {
  platform: Platform;
}

/**
 * The account the logon task runs as. `whoami` is authoritative; in a remote (ssh)
 * session USERDOMAIN can name a workgroup that Task Scheduler cannot resolve.
 */
export function windowsAccount(
  run: () => string = () => execFileSync("whoami", { encoding: "utf8", windowsHide: true }),
  env: Record<string, string | undefined> = process.env,
): string {
  try {
    const name = run().trim();
    if (/^[^\s"]+\\[^\s"]+$/.test(name)) return name;
  } catch {
    // fall through to the environment
  }
  const user = os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/** Pick the autostart implementation for this OS. Linux is not a supported target. */
export function createServiceManager(deps: PlatformServiceDeps): ServiceManager {
  if (deps.platform === "darwin") {
    return createMacosService({ ...deps, uid: process.getuid?.() ?? os.userInfo().uid });
  }
  if (deps.platform === "win32") {
    return createWindowsService({
      ...deps,
      userId: windowsAccount(),
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    });
  }
  throw new ServiceError(`autostart is not supported on ${deps.platform}`);
}
