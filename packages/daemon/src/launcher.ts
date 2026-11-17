// Stable launcher. Copied next to the `current` pointer by `rainforestd install` and run by
// the autostart service. It must stay tiny and dependency-free (Node built-ins only, no
// imports from a versioned directory) because it is the one file that does not change when
// the daemon updates. It reads `current`, resolves versions/<v>/ and imports that version's
// entry; the entry then runs the CLI with this process's argv.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY_CANDIDATES = ["rainforestd.mjs", "src/main.ts", "dist/main.mjs"];
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

export type LaunchTarget =
  { ok: true; version: string; entry: string } | { ok: false; reason: string };

export function resolveLaunchTarget(root: string): LaunchTarget {
  const pointer = join(root, "current");
  let text: string;
  try {
    text = readFileSync(pointer, "utf8");
  } catch {
    return { ok: false, reason: "no active version: the current pointer is missing" };
  }
  const version = text.trim();
  if (!VERSION_NAME.test(version) || version.includes("..")) {
    return { ok: false, reason: "the current pointer does not hold a valid version name" };
  }
  const dir = join(root, "versions", version);
  if (!existsSync(dir)) {
    return { ok: false, reason: `version directory is missing for ${version}` };
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const entry = join(dir, ...candidate.split("/"));
    if (existsSync(entry)) return { ok: true, version, entry };
  }
  return { ok: false, reason: `version ${version} has no entry point` };
}

/** A new version gets this many starts to prove itself before the launcher rolls back. */
export const MAX_PENDING_BOOTS = 3;

/**
 * Roll back an update that keeps failing to come up. The updater records a `pending`
 * entry when it switches versions and clears it once the new version is healthy; if the
 * launcher sees the same pending version start too many times, it restores the previous
 * version and marks the new one bad. Returns the version that was rolled back, if any.
 */
export function guardPendingUpdate(root: string, now: number = Date.now()): string | null {
  const stateFile = join(root, "state.json");
  let state: {
    bad_versions?: Record<string, { at: number; reason: string }>;
    previous_version?: string;
    pending?: { version: string; previous: string; since: number; boots: number };
  };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8")) as typeof state;
  } catch {
    return null;
  }
  const pending = state.pending;
  if (!pending || typeof pending.version !== "string" || typeof pending.previous !== "string")
    return null;
  let current = "";
  try {
    current = readFileSync(join(root, "current"), "utf8").trim();
  } catch {
    return null;
  }
  if (current !== pending.version) return null;
  const write = (value: unknown): void => {
    const tmp = `${stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, stateFile);
  };
  const boots = (typeof pending.boots === "number" ? pending.boots : 0) + 1;
  if (boots <= MAX_PENDING_BOOTS) {
    write({ ...state, pending: { ...pending, boots } });
    return null;
  }
  if (!VERSION_NAME.test(pending.previous) || !existsSync(join(root, "versions", pending.previous)))
    return null;
  const pointerTmp = join(root, `current.tmp-${process.pid}`);
  writeFileSync(pointerTmp, `${pending.previous}\n`);
  renameSync(pointerTmp, join(root, "current"));
  const bad = { ...(state.bad_versions ?? {}) };
  bad[pending.version] = { at: now, reason: "did not become healthy after an update" };
  const next = { ...state, bad_versions: bad };
  delete next.pending;
  write(next);
  return pending.version;
}

export function launcherRoot(env: Record<string, string | undefined>, here: string): string {
  const override = env.RAINFOREST_HOME;
  return override && override.trim() !== "" ? override : dirname(here);
}

function logLine(root: string, message: string): void {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level: "error", src: "launcher", msg: message })}\n`;
  process.stderr.write(line);
  try {
    const dir = join(root, "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "launcher.log"), line);
  } catch {
    // stderr already has it.
  }
}

async function main(): Promise<void> {
  const root = launcherRoot(process.env, fileURLToPath(import.meta.url));
  try {
    const rolledBack = guardPendingUpdate(root);
    if (rolledBack) logLine(root, `rolled back version ${rolledBack}: it did not become healthy`);
  } catch (error) {
    logLine(root, `update guard failed: ${(error as Error).message}`);
  }
  const target = resolveLaunchTarget(root);
  if (!target.ok) {
    logLine(root, target.reason);
    process.exit(78);
  }
  try {
    await import(pathToFileURL(target.entry).href);
  } catch (error) {
    logLine(root, `failed to start version ${target.version}: ${(error as Error).message}`);
    process.exit(70);
  }
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) await main();
