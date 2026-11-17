import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createMacosService,
  parseLaunchctlPrint,
  renderLaunchAgentPlist,
  xmlEscape,
} from "../src/service/macos.ts";
import {
  createWindowsService,
  encodeTaskXml,
  parseSchtasksList,
  quoteWindowsArg,
  renderTaskXml,
  windowsCommandLine,
} from "../src/service/windows.ts";
import { SERVICE_LABEL, WINDOWS_TASK_NAME } from "../src/service/types.ts";
import { fakeExec, tmpDir, tmpPaths } from "./helpers.ts";

/** Minimal well-formedness check: tags nest and close. */
function assertBalancedXml(xml: string): void {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name as string);
  }
  expect(stack).toEqual([]);
}

describe("xmlEscape", () => {
  test("escapes the five XML metacharacters", () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("launchd plist", () => {
  const plist = renderLaunchAgentPlist({
    label: SERVICE_LABEL,
    programArguments: ["/opt/node & co/bin/node", "/data/<x>/launcher.ts", "run"],
    stdoutPath: "/logs/out.log",
    stderrPath: "/logs/err.log",
    workingDirectory: "/data",
    environment: { RAINFOREST_HOME: "/data" },
  });

  test("has the required keys", () => {
    for (const fragment of [
      `<key>Label</key>\n  <string>${SERVICE_LABEL}</string>`,
      "<key>RunAtLoad</key>\n  <true/>",
      "<key>KeepAlive</key>\n  <true/>",
      "<key>ProcessType</key>\n  <string>Interactive</string>",
      "<key>StandardOutPath</key>",
      "<key>StandardErrorPath</key>",
      "<key>RAINFOREST_HOME</key>",
    ]) {
      expect(plist).toContain(fragment);
    }
  });

  test("escapes program arguments and stays well formed", () => {
    expect(plist).toContain("<string>/opt/node &amp; co/bin/node</string>");
    expect(plist).toContain("<string>/data/&lt;x&gt;/launcher.ts</string>");
    expect(plist).toContain("<string>run</string>");
    assertBalancedXml(plist.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, ""));
  });

  test("omits optional blocks when not given", () => {
    const bare = renderLaunchAgentPlist({
      label: "x.y",
      programArguments: ["a"],
      stdoutPath: "/o",
      stderrPath: "/e",
    });
    expect(bare).not.toContain("WorkingDirectory");
    expect(bare).not.toContain("EnvironmentVariables");
  });

  test("parses launchctl print", () => {
    const out =
      "dev.rainforest.daemon = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}";
    expect(parseLaunchctlPrint(out)).toEqual({
      installed: true,
      running: true,
      pid: 4242,
      last_exit: "0",
      detail: "state=running",
    });
    expect(parseLaunchctlPrint("\tstate = waiting\n").running).toBe(false);
  });
});

describe("macOS service manager", () => {
  function setup(replies: Record<string, number> = {}) {
    const paths = tmpPaths("darwin");
    const home = tmpDir();
    const fake = fakeExec((file, args) => ({ code: replies[`${file} ${args[0]}`] ?? 0 }));
    const service = createMacosService({
      paths,
      exec: fake.exec,
      nodePath: "/usr/local/bin/node",
      launcherPath: paths.launcherFile,
      uid: 501,
      homedir: home,
    });
    const plistPath = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    return { service, calls: fake.calls, plistPath, paths };
  }

  test("install writes the plist then bootout, bootstrap, kickstart in the user's gui domain", async () => {
    const { service, calls, plistPath, paths } = setup();
    await service.install();
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain(`<string>${paths.launcherFile}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(calls.map((c) => c.args)).toEqual([
      ["bootout", `gui/501/${SERVICE_LABEL}`],
      ["bootstrap", "gui/501", plistPath],
      ["kickstart", "-k", `gui/501/${SERVICE_LABEL}`],
    ]);
  });

  test("install with start:false skips kickstart", async () => {
    const { service, calls } = setup();
    await service.install({ start: false });
    expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
  });

  test("a failing bootstrap surfaces as an error", async () => {
    const { service } = setup({ "launchctl bootstrap": 5 });
    await expect(service.install()).rejects.toThrow(/bootstrap/);
  });

  test("uninstall boots out and removes the plist", async () => {
    const { service, calls, plistPath } = setup();
    await service.install({ start: false });
    await service.uninstall();
    expect(existsSync(plistPath)).toBe(false);
    expect(calls.at(-1)?.args).toEqual(["bootout", `gui/501/${SERVICE_LABEL}`]);
  });

  test("start falls back to bootstrap when kickstart finds nothing loaded", async () => {
    const calls: string[][] = [];
    let kicked = 0;
    const paths = tmpPaths("darwin");
    const service = createMacosService({
      paths,
      exec: async (_file, args) => {
        calls.push(args);
        if (args[0] === "kickstart" && kicked++ === 0)
          return { code: 113, stdout: "", stderr: "x" };
        return { code: 0, stdout: "", stderr: "" };
      },
      nodePath: "/n",
      launcherPath: "/l",
      uid: 7,
      homedir: tmpDir(),
    });
    await service.start();
    expect(calls.map((a) => a[0])).toEqual(["kickstart", "bootstrap", "kickstart"]);
  });

  test("status maps a failed print to not loaded", async () => {
    const { service, plistPath } = setup({ "launchctl print": 113 });
    expect(await service.status()).toMatchObject({ installed: false, running: false });
    mkdirSync(join(plistPath, ".."), { recursive: true });
    writeFileSync(plistPath, "x");
    expect(await service.status()).toMatchObject({ installed: true, running: false });
  });
});

describe("Windows scheduled task", () => {
  const options = {
    userId: "HOST\\someone",
    command: "C:\\Windows\\System32\\conhost.exe",
    args: '--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\L\\launcher.ts" run',
    workingDirectory: "C:\\L",
  };
  const xml = renderTaskXml(options);

  test("has the required settings", () => {
    for (const fragment of [
      "<LogonTrigger>",
      "<LogonType>InteractiveToken</LogonType>",
      "<RunLevel>LeastPrivilege</RunLevel>",
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<Interval>PT1M</Interval>",
      "<Count>999</Count>",
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "<Hidden>true</Hidden>",
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<UserId>HOST\\someone</UserId>",
      "<Command>C:\\Windows\\System32\\conhost.exe</Command>",
    ]) {
      expect(xml).toContain(fragment);
    }
  });

  test("escapes quotes in arguments and is well formed", () => {
    expect(xml).toContain("--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot;");
    assertBalancedXml(xml.replace(/<\?xml[^>]*\?>/, ""));
  });

  test("uses CRLF line endings", () => {
    expect(xml).toContain("\r\n");
    expect(xml.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("encodes as UTF-16LE with a BOM", () => {
    const bytes = encodeTaskXml("<a/>");
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe("<a/>");
    expect(bytes.length).toBe(2 + 4 * 2);
  });

  test("builds the headless command line, with a direct fallback", () => {
    const base = {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      launcherPath: "C:\\L\\launcher.ts",
      systemRoot: "C:\\Windows",
    };
    expect(windowsCommandLine({ ...base, hiddenLaunch: "conhost" })).toEqual({
      command: "C:\\Windows\\System32\\conhost.exe",
      args: '--headless "C:\\Program Files\\nodejs\\node.exe" C:\\L\\launcher.ts run',
    });
    expect(windowsCommandLine({ ...base, hiddenLaunch: "direct" })).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: "C:\\L\\launcher.ts run",
    });
  });

  test("quotes arguments the way CommandLineToArgvW expects", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("has space")).toBe('"has space"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg("")).toBe('""');
  });

  test("parses schtasks /Query LIST /V", () => {
    const out = [
      "Folder: \\",
      "TaskName:                             \\rainforest-daemon",
      "Status:                               Running",
      "Last Result:                          267009",
    ].join("\r\n");
    expect(parseSchtasksList(out)).toEqual({
      installed: true,
      running: true,
      last_exit: "267009",
      detail: "status=Running",
    });
    expect(parseSchtasksList("Status:   Ready\r\n").running).toBe(false);
  });

  test("manager drives schtasks with the right verbs and removes the temp XML", async () => {
    const paths = tmpPaths("linux");
    const seen: Array<{ args: string[]; xml?: Buffer }> = [];
    const service = createWindowsService({
      paths,
      exec: async (_file, args) => {
        const xmlIdx = args.indexOf("/XML");
        seen.push({
          args,
          ...(xmlIdx >= 0 ? { xml: readFileSync(args[xmlIdx + 1] as string) } : {}),
        });
        return { code: 0, stdout: "", stderr: "" };
      },
      nodePath: "C:\\node\\node.exe",
      launcherPath: "C:\\L\\launcher.ts",
      userId: "HOST\\someone",
    });
    await service.install();
    const create = seen[0] as { args: string[]; xml: Buffer };
    expect(create.args.slice(0, 1)).toEqual(["/Create"]);
    expect(create.args).toContain("/F");
    expect(create.args[create.args.indexOf("/TN") + 1]).toBe(WINDOWS_TASK_NAME);
    expect([...create.xml.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(seen[1]?.args).toEqual(["/Run", "/TN", WINDOWS_TASK_NAME]);
    expect(existsSync(join(paths.root, "service-task.xml"))).toBe(false);

    seen.length = 0;
    await service.stop();
    await service.uninstall();
    await service.status();
    expect(seen.map((s) => s.args[0])).toEqual(["/End", "/End", "/Delete", "/Query"]);
    expect(seen[2]?.args).toEqual(["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  });

  test("a failing /Create is reported", async () => {
    const service = createWindowsService({
      paths: tmpPaths("linux"),
      exec: async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." }),
      nodePath: "n",
      launcherPath: "l",
      userId: "u",
    });
    await expect(service.install()).rejects.toThrow(/Create failed/);
  });
});
