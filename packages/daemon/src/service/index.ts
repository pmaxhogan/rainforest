import os from "node:os";
import type { Platform } from "../paths.ts";
import { createMacosService } from "./macos.ts";
import { ServiceError, type ServiceDeps, type ServiceManager } from "./types.ts";
import { createWindowsService } from "./windows.ts";

export * from "./types.ts";

export interface PlatformServiceDeps extends ServiceDeps {
  platform: Platform;
}

/** Pick the autostart implementation for this OS. Linux is not a supported target. */
export function createServiceManager(deps: PlatformServiceDeps): ServiceManager {
  if (deps.platform === "darwin") {
    return createMacosService({ ...deps, uid: process.getuid?.() ?? os.userInfo().uid });
  }
  if (deps.platform === "win32") {
    const domain = process.env.USERDOMAIN;
    const user = os.userInfo().username;
    return createWindowsService({
      ...deps,
      userId: domain ? `${domain}\\${user}` : user,
      systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    });
  }
  throw new ServiceError(`autostart is not supported on ${deps.platform}`);
}
