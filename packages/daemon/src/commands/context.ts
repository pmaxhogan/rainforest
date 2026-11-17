import { fileURLToPath } from "node:url";
import { defaultExec, type Exec } from "../exec.ts";
import type { CliIo, CreateServices } from "../interfaces.ts";
import type { Logger } from "../log.ts";
import { currentPathEnv, resolvePaths, type AppPaths, type Platform } from "../paths.ts";
import { createServiceManager } from "../service/index.ts";
import type { ServiceManager } from "../service/types.ts";
import { DAEMON_VERSION } from "../version.ts";
import { createServices } from "../wiring.ts";

/** Everything a command needs, injected so tests never touch the real home, launchd or schtasks. */
export interface CliContext {
  paths: AppPaths;
  platform: Platform;
  env: Record<string, string | undefined>;
  exec: Exec;
  io: CliIo;
  version: string;
  nodePath: string;
  /** This checkout's `src/main.ts`, for `install --link-dev`. */
  mainEntry: string;
  /** Source of the stable launcher copied into the app directory. */
  launcherSource: string;
  createServices: CreateServices;
  makeServiceManager(): ServiceManager;
  /** Build the logger for a command; tests pass a null logger. */
  makeLogger(paths: AppPaths): Logger;
  /** Register a shutdown handler for SIGINT/SIGTERM. Returns an unregister function. */
  onShutdownSignal(handler: () => void): () => void;
  now: () => number;
}

export function consoleIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

export function defaultContext(
  makeLogger: (paths: AppPaths) => Logger,
  io: CliIo = consoleIo(),
): CliContext {
  const pe = currentPathEnv();
  const paths = resolvePaths(pe);
  const exec = defaultExec;
  const launcherSource = fileURLToPath(new URL("../launcher.ts", import.meta.url));
  const ctx: CliContext = {
    paths,
    platform: pe.platform,
    env: pe.env,
    exec,
    io,
    version: DAEMON_VERSION,
    nodePath: process.execPath,
    mainEntry: fileURLToPath(new URL("../main.ts", import.meta.url)),
    launcherSource,
    createServices,
    makeServiceManager: () =>
      createServiceManager({
        platform: pe.platform,
        paths,
        exec,
        nodePath: process.execPath,
        launcherPath: paths.launcherFile,
        ...(pe.env.RAINFOREST_HOME ? { homeOverride: paths.root } : {}),
      }),
    makeLogger,
    onShutdownSignal: (handler) => {
      const signals: NodeJS.Signals[] =
        pe.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
      for (const signal of signals) process.once(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
    now: Date.now,
  };
  return ctx;
}
