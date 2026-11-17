// Stable launcher. Copied next to the `current` pointer by `rainforestd install` and run by
// the autostart service. It must stay tiny and dependency-free (Node built-ins only, no
// imports from a versioned directory) because it is the one file that does not change when
// the daemon updates. It reads `current`, resolves versions/<v>/ and imports that version's
// entry; the entry then runs the CLI with this process's argv.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENTRY_CANDIDATES = ["src/main.ts", "dist/main.mjs"];
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
