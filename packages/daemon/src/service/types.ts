import type { Exec } from "../exec.ts";
import type { AppPaths } from "../paths.ts";

/** Reverse-DNS label and task name for the autostart service. Neutral, not owner-specific. */
export const SERVICE_LABEL = "dev.rainforest.daemon";
export const WINDOWS_TASK_NAME = "rainforest-daemon";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  /** Last exit code or last-run result when the OS reports one. */
  last_exit?: string;
  detail?: string;
}

export interface ServiceManager {
  readonly kind: "launchd" | "schtasks";
  /** Write the service definition and register it with the OS. Starts it unless told not to. */
  install(options?: { start?: boolean }): Promise<void>;
  /** Stop it and remove the registration. Leaves config, keys and logs alone. */
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export interface ServiceDeps {
  paths: AppPaths;
  exec: Exec;
  /** Absolute path of the node binary the service runs. */
  nodePath: string;
  /** Absolute path of the stable launcher. */
  launcherPath: string;
  /** Pass RAINFOREST_HOME into the service environment when the app dir is non-default. */
  homeOverride?: string;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}
