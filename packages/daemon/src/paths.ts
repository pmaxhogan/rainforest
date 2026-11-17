import os from "node:os";
import nodePath from "node:path";

export type Platform = NodeJS.Platform;

export interface PathEnv {
  platform: Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

/** Every file and directory the daemon owns, derived from one per-user root. */
export interface AppPaths {
  platform: Platform;
  /** Per-user application directory. */
  root: string;
  /** versions/<v>/ - one directory per installed daemon version. */
  versionsDir: string;
  /** Text file holding the active version string (not a symlink: Windows friendly). */
  currentFile: string;
  configFile: string;
  /** Mode 0600 (icacls-restricted on Windows). */
  deviceKeyFile: string;
  /** Mode 0600: extension token and optional update token. */
  secretsFile: string;
  logsDir: string;
  logFile: string;
  auditFile: string;
  /** Mode 0700: the bounded local archive of pages the daemon read (diagnostics). */
  pagesDir: string;
  stateFile: string;
  /** Stable launcher copy the autostart service runs. */
  launcherFile: string;
}

export function currentPathEnv(): PathEnv {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

/** The path module matching a platform, so Windows paths can be built on any host. */
export function pathFlavor(platform: Platform): typeof nodePath.posix {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/**
 * Per-user app directory.
 *  - RAINFOREST_HOME overrides everything (tests and side-by-side installs use this)
 *  - macOS:   ~/Library/Application Support/rainforest
 *  - Windows: %LOCALAPPDATA%\rainforest
 *  - Linux:   $XDG_DATA_HOME/rainforest or ~/.local/share/rainforest
 */
export function resolveRoot(pe: PathEnv = currentPathEnv()): string {
  const p = pathFlavor(pe.platform);
  const override = pe.env.RAINFOREST_HOME;
  if (override && override.trim() !== "") return p.resolve(override);
  if (pe.platform === "darwin") {
    return p.join(pe.homedir, "Library", "Application Support", "rainforest");
  }
  if (pe.platform === "win32") {
    const base = pe.env.LOCALAPPDATA || p.join(pe.homedir, "AppData", "Local");
    return p.join(base, "rainforest");
  }
  const xdg = pe.env.XDG_DATA_HOME;
  const base = xdg && p.isAbsolute(xdg) ? xdg : p.join(pe.homedir, ".local", "share");
  return p.join(base, "rainforest");
}

export function resolvePaths(pe: PathEnv = currentPathEnv()): AppPaths {
  const p = pathFlavor(pe.platform);
  const root = resolveRoot(pe);
  const logsDir = p.join(root, "logs");
  return {
    platform: pe.platform,
    root,
    versionsDir: p.join(root, "versions"),
    currentFile: p.join(root, "current"),
    configFile: p.join(root, "config.json"),
    deviceKeyFile: p.join(root, "device-key.json"),
    secretsFile: p.join(root, "secrets.json"),
    logsDir,
    logFile: p.join(logsDir, "daemon.log"),
    auditFile: p.join(root, "audit.jsonl"),
    pagesDir: p.join(root, "pages"),
    stateFile: p.join(root, "state.json"),
    launcherFile: p.join(root, "launcher.ts"),
  };
}

export function versionDir(paths: AppPaths, version: string): string {
  return pathFlavor(paths.platform).join(paths.versionsDir, version);
}
