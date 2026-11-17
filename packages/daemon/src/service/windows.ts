import { rmSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { ensureDir } from "../fsutil.ts";
import { pathFlavor } from "../paths.ts";
import { xmlEscape } from "./macos.ts";
import {
  ServiceError,
  WINDOWS_TASK_NAME,
  type ServiceDeps,
  type ServiceManager,
  type ServiceStatus,
} from "./types.ts";

/**
 * Hidden-window decision (Windows 11): the task runs `conhost.exe --headless node.exe
 * launcher.ts run`. Why:
 *  - A Scheduled Task with `Hidden` true only hides the task in the Task Scheduler UI; a
 *    console program started in the user's interactive session (which this task needs, so
 *    it can start Chrome on the owner's screen) still opens a console window.
 *  - `conhost.exe --headless` is the console host in "no window" mode (the mode ConPTY and
 *    Windows Terminal use). It ships in every Windows 10 1809+ / Windows 11 install, needs no
 *    extra file and no script, and the child sees a normal console so Node behaves normally.
 *  - Alternatives rejected: `wscript.exe` + a .vbs shim (VBScript is being removed as an
 *    on-demand feature in recent Windows 11 builds, and the owner dislikes script shims);
 *    `powershell -WindowStyle Hidden` still flashes a window and adds PowerShell; a custom
 *    GUI-subsystem node.exe means shipping our own binary.
 *  - `hiddenLaunch: "direct"` runs node.exe itself (visible console); kept as a fallback if
 *    a future Windows build drops `--headless`.
 * UNVERIFIED: `--headless` is an undocumented switch (Windows Terminal passes it; security
 * vendors flag it as a window-hiding trick). Public reports say a brief window flash can
 * still happen, and nothing confirms that conhost propagates the child's exit code to Task
 * Scheduler, which matters for RestartOnFailure after a crash or an update restart. Prove
 * both on a real Windows 11 host (`schtasks /Query /V` "Last Result" after a forced exit
 * code) and fall back to "direct" or a GUI-subsystem shim if either fails.
 */
export type HiddenLaunch = "conhost" | "direct";

export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function windowsCommandLine(options: {
  nodePath: string;
  launcherPath: string;
  hiddenLaunch: HiddenLaunch;
  systemRoot: string;
}): { command: string; args: string } {
  const run = [options.nodePath, options.launcherPath, "run"];
  if (options.hiddenLaunch === "direct") {
    return { command: run[0] as string, args: run.slice(1).map(quoteWindowsArg).join(" ") };
  }
  return {
    command: win32.join(options.systemRoot, "System32", "conhost.exe"),
    args: ["--headless", ...run].map(quoteWindowsArg).join(" "),
  };
}

export interface TaskXmlOptions {
  /** "DOMAIN\\user" or "user" - the account the task logs on as. Runtime value, never stored in the repo. */
  userId: string;
  command: string;
  args: string;
  workingDirectory: string;
  description?: string;
}

/** Task Scheduler 1.4 XML. Written as UTF-16LE with a BOM by `encodeTaskXml`. */
export function renderTaskXml(options: TaskXmlOptions): string {
  const user = xmlEscape(options.userId);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(options.description ?? "rainforest local daemon")}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${user}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(options.command)}</Command>`,
    `      <Arguments>${xmlEscape(options.args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(options.workingDirectory)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** schtasks /XML requires UTF-16LE with a byte order mark. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

/** Parse `schtasks /Query /TN <name> /FO LIST /V` (English labels; other locales fall back to "installed"). */
export function parseSchtasksList(output: string): ServiceStatus {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  const state = fields.get("status");
  const result = fields.get("last result");
  const status: ServiceStatus = { installed: true, running: state?.toLowerCase() === "running" };
  if (result !== undefined) status.last_exit = result;
  if (state !== undefined) status.detail = `status=${state}`;
  return status;
}

export interface WindowsServiceDeps extends ServiceDeps {
  /** Runtime account, e.g. from USERDOMAIN and the OS user name. */
  userId: string;
  systemRoot?: string;
  hiddenLaunch?: HiddenLaunch;
  taskName?: string;
}

export function createWindowsService(deps: WindowsServiceDeps): ServiceManager {
  const taskName = deps.taskName ?? WINDOWS_TASK_NAME;
  const xmlPath = pathFlavor(deps.paths.platform).join(deps.paths.root, "service-task.xml");

  async function schtasks(args: string[]) {
    return deps.exec("schtasks", args);
  }

  async function run(): Promise<void> {
    const res = await schtasks(["/Run", "/TN", taskName]);
    if (res.code !== 0) throw new ServiceError(`schtasks /Run failed: ${res.stderr.trim()}`);
  }

  return {
    kind: "schtasks",

    async install(options = {}) {
      ensureDir(deps.paths.logsDir);
      const { command, args } = windowsCommandLine({
        nodePath: deps.nodePath,
        launcherPath: deps.launcherPath,
        hiddenLaunch: deps.hiddenLaunch ?? "conhost",
        systemRoot: deps.systemRoot ?? "C:\\Windows",
      });
      const xml = renderTaskXml({
        userId: deps.userId,
        command,
        args,
        workingDirectory: deps.paths.root,
      });
      writeFileSync(xmlPath, encodeTaskXml(xml));
      try {
        const res = await schtasks(["/Create", "/XML", xmlPath, "/TN", taskName, "/F"]);
        if (res.code !== 0) throw new ServiceError(`schtasks /Create failed: ${res.stderr.trim()}`);
      } finally {
        rmSync(xmlPath, { force: true });
      }
      if (options.start !== false) await run();
    },

    async uninstall() {
      await schtasks(["/End", "/TN", taskName]);
      const res = await schtasks(["/Delete", "/TN", taskName, "/F"]);
      if (res.code !== 0 && !/cannot find|does not exist/i.test(res.stderr)) {
        throw new ServiceError(`schtasks /Delete failed: ${res.stderr.trim()}`);
      }
    },

    start: run,

    async stop() {
      const res = await schtasks(["/End", "/TN", taskName]);
      if (res.code !== 0 && !/not currently running|cannot find/i.test(res.stderr)) {
        throw new ServiceError(`schtasks /End failed: ${res.stderr.trim()}`);
      }
    },

    async status() {
      const res = await schtasks(["/Query", "/TN", taskName, "/FO", "LIST", "/V"]);
      if (res.code !== 0) return { installed: false, running: false };
      return parseSchtasksList(res.stdout);
    },
  };
}
