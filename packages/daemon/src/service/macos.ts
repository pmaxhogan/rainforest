import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir } from "../fsutil.ts";
import {
  SERVICE_LABEL,
  ServiceError,
  type ServiceDeps,
  type ServiceManager,
  type ServiceStatus,
} from "./types.ts";

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export interface PlistOptions {
  label: string;
  programArguments: string[];
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
}

/** LaunchAgent plist: runs at login and is kept alive, in the user's GUI session. */
export function renderLaunchAgentPlist(options: PlistOptions): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(options.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...options.programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>LimitLoadToSessionType</key>",
    "  <string>Aqua</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(options.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(options.stderrPath)}</string>`,
  ];
  if (options.workingDirectory !== undefined) {
    lines.push(
      "  <key>WorkingDirectory</key>",
      `  <string>${xmlEscape(options.workingDirectory)}</string>`,
    );
  }
  const env = Object.entries(options.environment ?? {});
  if (env.length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [key, value] of env) {
      lines.push(`    <key>${xmlEscape(key)}</key>`, `    <string>${xmlEscape(value)}</string>`);
    }
    lines.push("  </dict>");
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

/**
 * Parse `launchctl print gui/<uid>/<label>`. Not loaded -> launchctl exits non-zero and the
 * caller never gets here. Loaded: `state = running` plus `pid = N` while a process exists.
 */
export function parseLaunchctlPrint(output: string): ServiceStatus {
  const state = /^\s*state\s*=\s*(\S+)/m.exec(output)?.[1];
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(output)?.[1];
  const exit = /^\s*last exit (?:code|status)\s*=\s*(\S+)/m.exec(output)?.[1];
  const status: ServiceStatus = { installed: true, running: state === "running" };
  if (pid !== undefined) status.pid = Number(pid);
  if (exit !== undefined) status.last_exit = exit;
  if (state !== undefined) status.detail = `state=${state}`;
  return status;
}

export interface MacosServiceDeps extends ServiceDeps {
  uid: number;
  homedir?: string;
  label?: string;
}

export function createMacosService(deps: MacosServiceDeps): ServiceManager {
  const label = deps.label ?? SERVICE_LABEL;
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${label}`;
  const plistPath = join(deps.homedir ?? homedir(), "Library", "LaunchAgents", `${label}.plist`);

  async function launchctl(args: string[]) {
    return deps.exec("launchctl", args);
  }

  async function bootstrap(): Promise<void> {
    const res = await launchctl(["bootstrap", domain, plistPath]);
    if (res.code !== 0) throw new ServiceError(`launchctl bootstrap failed: ${res.stderr.trim()}`);
  }

  return {
    kind: "launchd",

    async install(options = {}) {
      ensureDir(deps.paths.logsDir);
      ensureDir(dirname(plistPath));
      const plist = renderLaunchAgentPlist({
        label,
        programArguments: [deps.nodePath, deps.launcherPath, "run"],
        stdoutPath: join(deps.paths.logsDir, "launchd.out.log"),
        stderrPath: join(deps.paths.logsDir, "launchd.err.log"),
        workingDirectory: deps.paths.root,
        ...(deps.homeOverride !== undefined
          ? { environment: { RAINFOREST_HOME: deps.homeOverride } }
          : {}),
      });
      writeFileSync(plistPath, plist, { mode: 0o644 });
      // A stale registration makes bootstrap fail with EIO; remove it first, ignore "not loaded".
      await launchctl(["bootout", target]);
      await bootstrap();
      if (options.start !== false) {
        const res = await launchctl(["kickstart", "-k", target]);
        if (res.code !== 0)
          throw new ServiceError(`launchctl kickstart failed: ${res.stderr.trim()}`);
      }
    },

    async uninstall() {
      await launchctl(["bootout", target]);
      rmSync(plistPath, { force: true });
    },

    async start() {
      const kick = await launchctl(["kickstart", "-k", target]);
      if (kick.code === 0) return;
      await bootstrap();
      const again = await launchctl(["kickstart", "-k", target]);
      if (again.code !== 0)
        throw new ServiceError(`launchctl kickstart failed: ${again.stderr.trim()}`);
    },

    /** bootout unloads the job so KeepAlive does not respawn it; it loads again at next login. */
    async stop() {
      const res = await launchctl(["bootout", target]);
      if (res.code !== 0 && !/not find|no such|not loaded/i.test(res.stderr)) {
        throw new ServiceError(`launchctl bootout failed: ${res.stderr.trim()}`);
      }
    },

    async status() {
      const res = await launchctl(["print", target]);
      if (res.code !== 0) {
        return { installed: existsSync(plistPath), running: false, detail: "not loaded" };
      }
      return parseLaunchctlPrint(res.stdout);
    },
  };
}
