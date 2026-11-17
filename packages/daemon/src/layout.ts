import { existsSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compareVersions } from "@rainforest/core";
import { atomicWriteFile, atomicWriteJson, ensureDir, readTextIfExists } from "./fsutil.ts";
import { pathFlavor, versionDir, type AppPaths } from "./paths.ts";

/**
 * On-disk layout helpers: installed versions, the `current` pointer (a plain text file so
 * Windows needs no symlink privilege) and `state.json` (bad-version marks).
 *
 * `src/launcher.ts` re-implements the tiny read side of this on purpose: the launcher is
 * copied next to `current` and must not import anything from a versioned directory.
 */

/** Entry point inside a version directory, tried in order. */
export const VERSION_ENTRY_CANDIDATES: readonly string[] = [
  "rainforestd.mjs",
  "src/main.ts",
  "dist/main.mjs",
];

/** A version name is a single safe path segment: no separators, no leading dot, bounded. */
export function isValidVersionName(name: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(name) && !name.includes("..");
}

export function listVersions(paths: AppPaths): string[] {
  if (!existsSync(paths.versionsDir)) return [];
  const names = readdirSync(paths.versionsDir).filter(
    (name) =>
      isValidVersionName(name) &&
      statSync(pathFlavor(paths.platform).join(paths.versionsDir, name)).isDirectory(),
  );
  return names.sort((a, b) => compareVersions(a, b) || a.localeCompare(b));
}

export function readCurrent(paths: AppPaths): string | null {
  const text = readTextIfExists(paths.currentFile);
  if (text === null) return null;
  const name = text.trim();
  return isValidVersionName(name) ? name : null;
}

export function writeCurrent(paths: AppPaths, version: string): void {
  if (!isValidVersionName(version)) throw new Error(`invalid version name: ${version}`);
  atomicWriteFile(paths.currentFile, `${version}\n`);
}

export function resolveVersionEntry(paths: AppPaths, version: string): string | null {
  const p = pathFlavor(paths.platform);
  const dir = versionDir(paths, version);
  for (const candidate of VERSION_ENTRY_CANDIDATES) {
    const full = p.join(dir, ...candidate.split("/"));
    if (existsSync(full)) return full;
  }
  return null;
}

// ---- state.json ---------------------------------------------------------------------

export interface BadVersionMark {
  /** Epoch ms. */
  at: number;
  reason: string;
}

export interface DaemonState {
  bad_versions: Record<string, BadVersionMark>;
  /** Version that was current before the last switch; the updater rolls back to it. */
  previous_version?: string;
}

export function readState(paths: AppPaths): DaemonState {
  const text = readTextIfExists(paths.stateFile);
  const empty: DaemonState = { bad_versions: {} };
  if (text === null) return empty;
  try {
    const raw = JSON.parse(text) as Partial<DaemonState>;
    const bad: Record<string, BadVersionMark> = {};
    for (const [version, mark] of Object.entries(raw.bad_versions ?? {})) {
      if (typeof mark?.at === "number" && typeof mark.reason === "string") bad[version] = mark;
    }
    const state: DaemonState = { bad_versions: bad };
    if (typeof raw.previous_version === "string") state.previous_version = raw.previous_version;
    return state;
  } catch {
    return empty;
  }
}

export function writeState(paths: AppPaths, state: DaemonState): void {
  atomicWriteJson(paths.stateFile, state);
}

export function markVersionBad(
  paths: AppPaths,
  version: string,
  reason: string,
  now: number = Date.now(),
): void {
  const state = readState(paths);
  state.bad_versions[version] = { at: now, reason: reason.slice(0, 500) };
  writeState(paths, state);
}

export function isVersionBad(paths: AppPaths, version: string): boolean {
  return Object.hasOwn(readState(paths).bad_versions, version);
}

/**
 * Dev convenience: create `versions/<name>/src/main.ts` that re-exports a source checkout's
 * entry, then point `current` at it. Lets `rainforestd install --link-dev` run end to end
 * from a clone without a release artifact.
 */
export function linkDevVersion(paths: AppPaths, entryFile: string, name = "dev"): string {
  const p = pathFlavor(paths.platform);
  const dir = versionDir(paths, name);
  ensureDir(p.join(dir, "src"));
  const href = pathToFileURL(entryFile).href;
  atomicWriteFile(p.join(dir, "src", "main.ts"), `import ${JSON.stringify(href)};\n`);
  writeCurrent(paths, name);
  return name;
}
