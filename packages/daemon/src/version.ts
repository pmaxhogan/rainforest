import { readFileSync } from "node:fs";

/**
 * True when running from the release bundle (`rainforestd.mjs`, one esbuild output file),
 * false when running from source (`src/*.ts`). The bundle has no `src/` tree beside it.
 */
export const IS_BUNDLED = import.meta.url.endsWith(".mjs");

/**
 * Daemon version: the `version` field of the package.json next to the bundle (written by the
 * release build) or, from source, of this package.
 */
export function readDaemonVersion(): string {
  try {
    const url = new URL(IS_BUNDLED ? "./package.json" : "../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const DAEMON_VERSION = readDaemonVersion();

/** Exit code the supervisor uses after an update so the service manager restarts it. */
export const RESTART_EXIT_CODE = 75;
