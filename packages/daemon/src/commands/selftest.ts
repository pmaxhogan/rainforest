import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOOLS, getTool } from "@rainforest/core";
import { parseConfig } from "../config.ts";
import { ensureDir } from "../fsutil.ts";
import type { AppPaths } from "../paths.ts";
import { IS_BUNDLED } from "../version.ts";

export interface SelftestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export const MIN_NODE_MAJOR = 22;

/** Synthetic config used only to prove the schema loads; example.com is reserved for docs. */
export const SAMPLE_CONFIG = {
  hub_url: "https://hub.example.com",
  device_id: "device-selftest-0001",
  device_name: "selftest",
  chrome: { profile_directory: "Default", extension_id: "a".repeat(32) },
  update: { repo: "example/rainforest" },
};

/** Modules that must not be imported by the self test (they run the CLI on import). */
const SKIP_MODULES = new Set(["main.ts"]);

export function listSourceModules(srcDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(srcDir);
  return out
    .filter((file) => !SKIP_MODULES.has(relative(srcDir, file).replaceAll("\\", "/")))
    .sort();
}

export async function runSelftest(
  paths: AppPaths,
  nodeVersion: string = process.versions.node,
  srcDir: string | null = IS_BUNDLED ? null : fileURLToPath(new URL("../", import.meta.url)),
): Promise<SelftestCheck[]> {
  const checks: SelftestCheck[] = [];

  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.push({
    name: "node version",
    ok: major >= MIN_NODE_MAJOR,
    detail: `node ${nodeVersion}, need >= ${MIN_NODE_MAJOR}`,
  });

  try {
    parseConfig(SAMPLE_CONFIG);
    checks.push({ name: "config schema", ok: true });
  } catch (error) {
    checks.push({ name: "config schema", ok: false, detail: (error as Error).message });
  }

  checks.push({
    name: "tool registry",
    ok: TOOLS.length > 0 && getTool("search") !== undefined,
    detail: `${TOOLS.length} tools`,
  });

  try {
    ensureDir(paths.root);
    const probe = join(paths.root, `.selftest-${randomBytes(4).toString("hex")}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    checks.push({ name: "paths writable", ok: true, detail: paths.root });
  } catch (error) {
    checks.push({ name: "paths writable", ok: false, detail: (error as Error).message });
  }

  // The release bundle is one file with no source tree; loading it already proved it imports.
  const root = srcDir ?? "";
  for (const file of srcDir === null ? [] : listSourceModules(srcDir)) {
    const name = `import ${relative(root, file).replaceAll("\\", "/")}`;
    try {
      await import(pathToFileURL(file).href);
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, detail: (error as Error).message });
    }
  }
  return checks;
}

export function selftestPassed(checks: SelftestCheck[]): boolean {
  return checks.every((c) => c.ok);
}
