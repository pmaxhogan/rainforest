import { readFileSync, statSync } from "node:fs";
import { loadConfig, summarizeConfig, ConfigError } from "../config.ts";
import { listVersions, readCurrent, readState } from "../layout.ts";
import type { ServiceStatus } from "../service/types.ts";
import type { CliContext } from "./context.ts";

const TAIL_LINES = 10;

/** Last `n` non-empty lines of a text file, reading at most the final 64 KiB. */
export function tailLines(file: string, n: number): string[] {
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, "utf8");
    const slice = size > 65_536 ? text.slice(-65_536) : text;
    return slice
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-n);
  } catch {
    return [];
  }
}

export async function statusCommand(ctx: CliContext, options: { json: boolean }): Promise<number> {
  const { paths, io } = ctx;
  let config: Record<string, unknown> | { error: string };
  try {
    config = summarizeConfig(loadConfig(paths));
  } catch (error) {
    config = { error: error instanceof ConfigError ? error.message : "config unreadable" };
  }
  let service: ServiceStatus | { error: string };
  try {
    service = await ctx.makeServiceManager().status();
  } catch (error) {
    service = { error: (error as Error).message };
  }
  const state = readState(paths);
  const report = {
    version: ctx.version,
    platform: ctx.platform,
    home: paths.root,
    active_version: readCurrent(paths),
    installed_versions: listVersions(paths),
    bad_versions: Object.keys(state.bad_versions),
    service,
    config,
    log_tail: tailLines(paths.logFile, TAIL_LINES),
  };
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return 0;
  }
  io.out(`rainforestd ${report.version} (${report.platform})`);
  io.out(`home: ${report.home}`);
  io.out(
    `active version: ${report.active_version ?? "(none)"}; installed: ${report.installed_versions.join(", ") || "(none)"}`,
  );
  if (report.bad_versions.length > 0) io.out(`marked bad: ${report.bad_versions.join(", ")}`);
  if ("error" in service) {
    io.out(`service: ${service.error}`);
  } else {
    io.out(
      `service: ${service.installed ? (service.running ? "running" : "installed, not running") : "not installed"}` +
        (service.pid !== undefined ? ` (pid ${service.pid})` : ""),
    );
  }
  if ("error" in config) {
    io.out(`config: ${config.error}`);
  } else {
    io.out(`config: ${JSON.stringify(config)}`);
  }
  io.out("last log lines:");
  for (const line of report.log_tail) io.out(`  ${line}`);
  if (report.log_tail.length === 0) io.out("  (none)");
  return 0;
}
