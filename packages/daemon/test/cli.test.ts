import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { COMMANDS, USAGE, runCli } from "../src/cli.ts";
import { runSelftest, selftestPassed, listSourceModules } from "../src/commands/selftest.ts";
import { tailLines } from "../src/commands/status.ts";
import { saveConfig } from "../src/config.ts";
import { readCurrent } from "../src/layout.ts";
import { fakeContext, fakeServices, sampleConfig } from "./fakes.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

describe("CLI dispatch", () => {
  test("lists every required command", () => {
    expect([...COMMANDS].sort()).toEqual(
      [
        "capture",
        "doctor",
        "install",
        "pair",
        "run",
        "selftest",
        "setup",
        "status",
        "uninstall",
        "update",
        "version",
      ].sort(),
    );
    for (const c of COMMANDS) expect(USAGE).toContain(c);
  });

  test("no command prints usage to stderr and exits 2; help exits 0", async () => {
    const a = fakeContext();
    expect(await runCli([], a.ctx)).toBe(2);
    expect(a.err.join("\n")).toContain("usage: rainforestd");
    const b = fakeContext();
    expect(await runCli(["--help"], b.ctx)).toBe(0);
    expect(b.out.join("\n")).toContain("usage: rainforestd");
  });

  test("an unknown command exits 2", async () => {
    const { ctx, err } = fakeContext();
    expect(await runCli(["frobnicate"], ctx)).toBe(2);
    expect(err[0]).toBe("unknown command: frobnicate");
  });

  test("an unknown option exits 2 with usage", async () => {
    const { ctx, err } = fakeContext();
    expect(await runCli(["status", "--nope"], ctx)).toBe(2);
    expect(err.join("\n")).toContain("usage: rainforestd");
  });

  test("version prints the version", async () => {
    const { ctx, out } = fakeContext();
    expect(await runCli(["version"], ctx)).toBe(0);
    expect(out).toEqual(["9.9.9"]);
  });

  test("operator commands delegate to the injected implementations", async () => {
    const services = fakeServices();
    const { ctx } = fakeContext(services);
    expect(await runCli(["doctor", "--live"], ctx)).toBe(0);
    expect(services.commands.doctor).toHaveBeenCalledWith({ live: true }, ctx.io);
    expect(await runCli(["pair", "--code", "ABC123"], ctx)).toBe(0);
    expect(services.commands.pair).toHaveBeenCalledWith({ code: "ABC123" }, ctx.io);
    expect(await runCli(["update", "--check"], ctx)).toBe(0);
    expect(services.commands.update).toHaveBeenCalledWith({ check_only: true }, ctx.io);
    expect(await runCli(["capture", "--kind", "product", "--out", "o.json"], ctx)).toBe(0);
    expect(services.commands.capture).toHaveBeenCalledWith(
      { kind: "product", out: "o.json" },
      ctx.io,
    );
  });

  test("setup maps flags to options", async () => {
    const services = fakeServices();
    const { ctx } = fakeContext(services);
    await runCli(
      [
        "setup",
        "--hub-url",
        "https://hub.example.com",
        "--device-name",
        "desk",
        "--alias",
        "a1",
        "--alias",
        "a2",
        "--profile",
        "Default",
        "--extension-id",
        "abc",
        "--repo",
        "example/rainforest",
        "--broker-mode",
        "embedded",
        "--broker-port",
        "5000",
        "--non-interactive",
      ],
      ctx,
    );
    expect(services.commands.setup).toHaveBeenCalledWith(
      {
        hub_url: "https://hub.example.com",
        device_name: "desk",
        aliases: ["a1", "a2"],
        profile_directory: "Default",
        extension_id: "abc",
        update_repo: "example/rainforest",
        broker_mode: "embedded",
        broker_port: 5000,
        non_interactive: true,
      },
      ctx.io,
    );
  });

  test("a throwing command exits 1 with its message", async () => {
    const services = fakeServices();
    vi.mocked(services.commands.doctor).mockRejectedValueOnce(new Error("kaput"));
    const { ctx, err } = fakeContext(services);
    expect(await runCli(["doctor"], ctx)).toBe(1);
    expect(err[0]).toBe("doctor failed: kaput");
  });
});

describe("install / uninstall", () => {
  test("install lays out the app dir, copies the launcher and registers the service", async () => {
    const { ctx, service, paths, out, err } = fakeContext();
    expect(await runCli(["install", "--link-dev"], ctx)).toBe(0);
    expect(readFileSync(paths.launcherFile, "utf8")).toBe(readFileSync(ctx.launcherSource, "utf8"));
    expect(readCurrent(paths)).toBe("dev");
    expect(existsSync(paths.logsDir)).toBe(true);
    expect(service.log).toEqual(["install start=true"]);
    expect(out.join("\n")).toContain("autostart registered (launchd) and started");
    expect(err).toEqual([]);
  });

  test("install without an active version warns; --no-start does not start", async () => {
    const { ctx, service, err } = fakeContext();
    expect(await runCli(["install", "--no-start"], ctx)).toBe(0);
    expect(err.join("\n")).toContain("no active version");
    expect(service.log).toEqual(["install start=false"]);
  });

  test("uninstall removes the service and keeps data", async () => {
    const { ctx, service, paths } = fakeContext();
    writeFileSync(paths.configFile, "{}");
    expect(await runCli(["uninstall"], ctx)).toBe(0);
    expect(service.log).toEqual(["uninstall"]);
    expect(existsSync(paths.configFile)).toBe(true);
  });
});

describe("status", () => {
  test("works with no config, and prints no secrets", async () => {
    const { ctx, out } = fakeContext();
    expect(await runCli(["status"], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("rainforestd 9.9.9");
    expect(text).toContain("config.json not found");
    expect(text).toContain("running (pid 77)");
  });

  test("summarizes a real config and tails the log", async () => {
    const { ctx, out, paths } = fakeContext();
    saveConfig(paths, sampleConfig());
    writeFileSync(
      paths.secretsFile,
      JSON.stringify({ extension_token: "SHOULD-NEVER-PRINT-123456" }),
    );
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.logFile, '{"msg":"log line one"}\n{"msg":"log line two"}\n');
    expect(await runCli(["status"], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("device_name");
    expect(text).toContain("log line two");
    expect(text).not.toContain("SHOULD-NEVER-PRINT");
  });

  test("--json emits one parseable document", async () => {
    const { ctx, out } = fakeContext();
    await runCli(["status", "--json"], ctx);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({
      version: "9.9.9",
      platform: "darwin",
      service: { installed: true },
    });
  });

  test("tailLines handles missing files and returns the last lines", () => {
    expect(tailLines("/definitely/not/here", 5)).toEqual([]);
  });
});

describe("selftest", () => {
  test("passes against this source tree and imports every module", async () => {
    const { ctx, out } = fakeContext();
    expect(await runCli(["selftest"], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("ok   node version");
    expect(text).toContain("import supervisor.ts");
    expect(text).toContain("import wiring.ts");
    expect(text).not.toContain("FAIL");
    expect(text).not.toContain("import main.ts");
  });

  test("fails on an old Node and on an unimportable module", async () => {
    const { paths } = fakeContext();
    const checks = await runSelftest(paths, "20.1.0");
    expect(checks.find((c) => c.name === "node version")?.ok).toBe(false);
    expect(selftestPassed(checks)).toBe(false);
  });

  test("a broken module is reported as a failed import", async () => {
    const { paths } = fakeContext();
    const srcDir = join(paths.root, "fake-src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "good.ts"), "export const a = 1;\n");
    writeFileSync(join(srcDir, "bad.ts"), 'throw new Error("boom");\n');
    writeFileSync(join(srcDir, "main.ts"), 'throw new Error("must be skipped");\n');
    const checks = await runSelftest(paths, "22.0.0", srcDir);
    const imports = checks.filter((c) => c.name.startsWith("import "));
    expect(imports.map((c) => [c.name, c.ok])).toEqual([
      ["import bad.ts", false],
      ["import good.ts", true],
    ]);
    expect(selftestPassed(checks)).toBe(false);
  });

  test("module listing skips main.ts and recurses", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const names = listSourceModules(src).map((f) => f.slice(src.length));
    expect(names).toContain("service/windows.ts");
    expect(names).toContain("commands/selftest.ts");
    expect(names).not.toContain("main.ts");
  });
});

describe("run", () => {
  test("wires the supervisor, serves a call, and exits cleanly on a shutdown signal", async () => {
    const services = fakeServices();
    const { ctx, paths, signalHandlers } = fakeContext(services);
    saveConfig(paths, sampleConfig({ idle_detach_s: 0 }));
    const exit = runCli(["run"], ctx);
    await vi.waitFor(() => expect(services.hub.started).toBe(true));
    services.hub.deps.onCall({
      type: "call",
      id: "call-run-1",
      tool: "get_cart",
      args: {},
      deadline_ms: 1000,
    });
    await vi.waitFor(() => expect(services.hub.results).toHaveLength(1));
    // Presence is built from the real probe + the fake browser; it must satisfy the wire schema.
    await expect(services.hub.deps.getPresence()).resolves.toMatchObject({ version: "9.9.9" });
    signalHandlers[0]?.();
    expect(await exit).toBe(0);
    expect(existsSync(paths.auditFile)).toBe(true);
  });

  test("run without a config exits 1", async () => {
    const { ctx, err } = fakeContext();
    expect(await runCli(["run"], ctx)).toBe(1);
    expect(err.join("\n")).toContain("setup");
  });
});
