import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { getTool } from "@rainforest/core";
import { defaultContext } from "../src/commands/context.ts";
import { defaultExec } from "../src/exec.ts";
import { writeCurrent } from "../src/layout.ts";
import { nullLogger } from "../src/log.ts";
import { versionDir } from "../src/paths.ts";
import { createServiceManager } from "../src/service/index.ts";
import { createServices } from "../src/wiring.ts";
import { fakeExec, tmpPaths } from "./helpers.ts";

const launcherSource = fileURLToPath(new URL("../src/launcher.ts", import.meta.url));

describe("launcher process", () => {
  function runLauncher(root: string, ...args: string[]) {
    const launcher = join(root, "launcher.ts");
    copyFileSync(launcherSource, launcher);
    return spawnSync(process.execPath, [launcher, ...args], {
      env: { ...process.env, RAINFOREST_HOME: root },
      encoding: "utf8",
    });
  }

  test("imports the active version's entry with the original argv", () => {
    const paths = tmpPaths();
    const dir = versionDir(paths, "0.1.0");
    mkdirSync(join(dir, "src"), { recursive: true });
    const marker = join(paths.root, "ran.txt");
    writeFileSync(
      join(dir, "src", "main.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(","));\n`,
    );
    writeCurrent(paths, "0.1.0");
    const res = runLauncher(paths.root, "run", "--x");
    expect(res.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("run,--x");
  });

  test("exits non-zero and logs when there is no pointer", () => {
    const paths = tmpPaths();
    const res = runLauncher(paths.root, "run");
    expect(res.status).toBe(78);
    expect(res.stderr).toContain("current pointer is missing");
    expect(readFileSync(join(paths.logsDir, "launcher.log"), "utf8")).toContain("launcher");
  });

  test("exits non-zero when the version directory is missing", () => {
    const paths = tmpPaths();
    writeCurrent(paths, "0.9.9");
    const res = runLauncher(paths.root, "run");
    expect(res.status).toBe(78);
    expect(res.stderr).toContain("version directory is missing");
  });

  test("exits non-zero when the version's entry throws on load", () => {
    const paths = tmpPaths();
    const dir = versionDir(paths, "0.2.0");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), 'throw new Error("bad build");\n');
    writeCurrent(paths, "0.2.0");
    const res = runLauncher(paths.root, "run");
    expect(res.status).toBe(70);
    expect(res.stderr).toContain("bad build");
  });
});

describe("shell stubs fail closed", () => {
  test("the stub router refuses every call", async () => {
    const services = createServices({
      paths: tmpPaths(),
      log: nullLogger(),
      exec: fakeExec().exec,
      version: "0.0.0",
      requestRestart: () => {},
    });
    const tool = getTool("get_cart");
    expect(tool).toBeDefined();
    await expect(
      services.router.call(
        tool as never,
        {},
        { id: "x", deadline_ms: 1, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ payload: { code: "unsupported" } });
    expect(services.browser.status()).toEqual({
      profile_connected: false,
      amazon_signed_in: null,
      cooling_down_until: null,
    });
    expect(await services.updater.checkNow("manual")).toMatchObject({ status: "failed" });
    const errs: string[] = [];
    const io = { out: () => {}, err: (l: string) => errs.push(l) };
    expect(await services.commands.setup({ aliases: [], non_interactive: true }, io)).toBe(1);
    expect(await services.commands.pair({}, io)).toBe(1);
    expect(await services.commands.capture({}, io)).toBe(1);
    expect(errs.every((l) => l.includes("not implemented in the shell"))).toBe(true);
  });

  test("the stub hub client never connects", () => {
    const warnings: string[] = [];
    const log = { ...nullLogger(), warn: (m: string) => warnings.push(m) };
    const services = createServices({
      paths: tmpPaths(),
      log,
      exec: fakeExec().exec,
      version: "0.0.0",
      requestRestart: () => {},
    });
    const hub = services.hubClient({
      config: {} as never,
      paths: tmpPaths(),
      log,
      getPresence: async () => ({}) as never,
      onCall: () => {},
      onUpdateHint: () => {},
    });
    hub.start();
    expect(hub.isConnected()).toBe(false);
    expect(hub.sendResult({} as never)).toBe(false);
    expect(warnings[0]).toContain("not implemented in the shell");
  });
});

describe("misc", () => {
  test("defaultExec captures output and reports failures without throwing", async () => {
    const ok = await defaultExec(process.execPath, ["-e", 'process.stdout.write("hi")']);
    expect(ok).toMatchObject({ code: 0, stdout: "hi" });
    const bad = await defaultExec(process.execPath, ["-e", "process.exit(3)"]);
    expect(bad.code).toBe(3);
    const missing = await defaultExec("definitely-not-a-program-xyz", []);
    expect(missing.code).toBe(127);
  });

  test("autostart is refused on unsupported platforms", () => {
    expect(() =>
      createServiceManager({
        platform: "linux",
        paths: tmpPaths("linux"),
        exec: fakeExec().exec,
        nodePath: "n",
        launcherPath: "l",
      }),
    ).toThrow(/not supported/);
  });

  test("the default context points at this checkout and does not touch disk", () => {
    const ctx = defaultContext(() => nullLogger());
    expect(ctx.mainEntry.endsWith("main.ts")).toBe(true);
    expect(ctx.launcherSource.endsWith("launcher.ts")).toBe(true);
    expect(ctx.nodePath).toBe(process.execPath);
  });
});

describe("version resolution", () => {
  test("from source it reads this package, not a bundle sibling", async () => {
    const { IS_BUNDLED, readDaemonVersion } = await import("../src/version.ts");
    expect(IS_BUNDLED).toBe(false);
    expect(readDaemonVersion()).toBe("0.0.0");
  });
});
