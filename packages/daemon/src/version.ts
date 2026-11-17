import { readFileSync } from "node:fs";

/** Daemon version: the `version` field of this package, stamped by the release build. */
export function readDaemonVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const DAEMON_VERSION = readDaemonVersion();

/** Exit code the supervisor uses after an update so the service manager restarts it. */
export const RESTART_EXIT_CODE = 75;
