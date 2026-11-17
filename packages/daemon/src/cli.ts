import { parseArgs } from "node:util";
import { createAudit } from "./audit.ts";
import { installCommand, uninstallCommand } from "./commands/install.ts";
import type { CliContext } from "./commands/context.ts";
import { runSelftest, selftestPassed } from "./commands/selftest.ts";
import { statusCommand } from "./commands/status.ts";
import { ConfigError, loadConfig, type DaemonConfig } from "./config.ts";
import type { DaemonServices, SetupOptions } from "./interfaces.ts";
import { createPresenceProbe, createPresenceProvider } from "./presence.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

export const COMMANDS = [
  "install",
  "uninstall",
  "pair",
  "setup",
  "status",
  "doctor",
  "capture",
  "update",
  "selftest",
  "run",
  "version",
] as const;
export type CommandName = (typeof COMMANDS)[number];

export const USAGE = [
  "usage: rainforestd <command> [options]",
  "",
  "commands:",
  "  install [--link-dev] [--no-start]   register autostart (launchd / Scheduled Task)",
  "  uninstall                           remove autostart; keeps config, keys and logs",
  "  setup [flags]                       write config.json (hub url, device name, Chrome profile, ...)",
  "  pair [--code <code>]                pair this computer with the hub",
  "  status [--json]                     config summary, service state, version, recent logs",
  "  doctor [--live]                     diagnose this installation",
  "  capture [--kind --url --out]        dev only: save a page capture",
  "  update [--check]                    check for and apply a release",
  "  selftest [--json]                   verify this build can run (exit 0/1)",
  "  run                                 run the daemon in the foreground (the service does this)",
  "  version                             print the daemon version",
].join("\n");

function isCommand(value: string | undefined): value is CommandName {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function tryLoadConfig(ctx: CliContext): DaemonConfig | undefined {
  try {
    return loadConfig(ctx.paths);
  } catch {
    return undefined;
  }
}

function buildServices(
  ctx: CliContext,
  config: DaemonConfig | undefined,
  restart: (r: string) => void,
) {
  const log = ctx.makeLogger(ctx.paths);
  const services = ctx.createServices({
    paths: ctx.paths,
    log,
    exec: ctx.exec,
    version: ctx.version,
    ...(config ? { config } : {}),
    requestRestart: restart,
  });
  return { log, services };
}

async function runCommand(ctx: CliContext): Promise<number> {
  let config: DaemonConfig;
  try {
    config = loadConfig(ctx.paths);
  } catch (error) {
    ctx.io.err(error instanceof ConfigError ? error.message : "config unreadable");
    return 1;
  }
  // The updater needs a restart hook before the supervisor exists, so it goes through a holder.
  const holder: { supervisor?: Supervisor } = {};
  const { log, services } = buildServices(ctx, config, (reason) =>
    holder.supervisor?.requestRestart(reason),
  );
  const audit = createAudit({ file: ctx.paths.auditFile, now: ctx.now });
  const probe = createPresenceProbe({ platform: ctx.platform, exec: ctx.exec, now: ctx.now });
  const sup = createSupervisor({
    config,
    paths: ctx.paths,
    log,
    audit,
    services: services as DaemonServices,
    getPresence: createPresenceProvider({
      probe,
      browser: services.browser,
      version: ctx.version,
      aliases: config.aliases,
    }),
    version: ctx.version,
    now: ctx.now,
  });
  holder.supervisor = sup;
  const unregister = ctx.onShutdownSignal(() => {
    log.info("shutdown signal received");
    void sup.stop(0);
  });
  try {
    await sup.start();
    return await sup.done;
  } finally {
    unregister();
  }
}

function setupOptionsFrom(values: Record<string, unknown>): SetupOptions {
  const str = (key: string): string | undefined =>
    typeof values[key] === "string" ? (values[key] as string) : undefined;
  const mode = str("broker-mode");
  const port = str("broker-port");
  const options: SetupOptions = {
    aliases: Array.isArray(values.alias) ? (values.alias as string[]) : [],
    non_interactive: values["non-interactive"] === true,
  };
  const assign = <K extends keyof SetupOptions>(key: K, value: SetupOptions[K] | undefined) => {
    if (value !== undefined) options[key] = value;
  };
  assign("hub_url", str("hub-url"));
  assign("device_name", str("device-name"));
  assign("profile_directory", str("profile"));
  assign("extension_id", str("extension-id"));
  assign("user_data_dir", str("user-data-dir"));
  assign("executable_path", str("executable-path"));
  assign("update_repo", str("repo"));
  if (mode === "external" || mode === "embedded") assign("broker_mode", mode);
  if (port !== undefined && /^\d+$/.test(port)) assign("broker_port", Number(port));
  return options;
}

/** Dispatch one CLI invocation. Returns the process exit code; never calls process.exit. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    (first === undefined ? ctx.io.err : ctx.io.out)(USAGE);
    return first === undefined ? 2 : 0;
  }
  if (!isCommand(first)) {
    ctx.io.err(`unknown command: ${first}`);
    ctx.io.err(USAGE);
    return 2;
  }

  try {
    switch (first) {
      case "version":
        ctx.io.out(ctx.version);
        return 0;

      case "install": {
        const { values } = parseArgs({
          args: rest,
          options: { "link-dev": { type: "boolean" }, "no-start": { type: "boolean" } },
          strict: true,
        });
        return await installCommand(ctx, {
          link_dev: values["link-dev"] === true,
          no_start: values["no-start"] === true,
        });
      }

      case "uninstall":
        parseArgs({ args: rest, options: {}, strict: true });
        return await uninstallCommand(ctx);

      case "status": {
        const { values } = parseArgs({
          args: rest,
          options: { json: { type: "boolean" } },
          strict: true,
        });
        return await statusCommand(ctx, { json: values.json === true });
      }

      case "selftest": {
        const { values } = parseArgs({
          args: rest,
          options: { json: { type: "boolean" } },
          strict: true,
        });
        const checks = await runSelftest(ctx.paths);
        if (values.json === true) {
          ctx.io.out(JSON.stringify(checks, null, 2));
        } else {
          for (const check of checks) {
            ctx.io.out(
              `${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`,
            );
          }
        }
        return selftestPassed(checks) ? 0 : 1;
      }

      case "run":
        parseArgs({ args: rest, options: {}, strict: true });
        return await runCommand(ctx);

      case "doctor": {
        const { values } = parseArgs({
          args: rest,
          options: { live: { type: "boolean" } },
          strict: true,
        });
        const { services } = buildServices(ctx, tryLoadConfig(ctx), () => {});
        return await services.commands.doctor({ live: values.live === true }, ctx.io);
      }

      case "pair": {
        const { values } = parseArgs({
          args: rest,
          options: { code: { type: "string" } },
          strict: true,
        });
        const { services } = buildServices(ctx, tryLoadConfig(ctx), () => {});
        return await services.commands.pair(
          values.code !== undefined ? { code: values.code } : {},
          ctx.io,
        );
      }

      case "setup": {
        const { values } = parseArgs({
          args: rest,
          options: {
            "hub-url": { type: "string" },
            "device-name": { type: "string" },
            alias: { type: "string", multiple: true },
            profile: { type: "string" },
            "extension-id": { type: "string" },
            "user-data-dir": { type: "string" },
            "executable-path": { type: "string" },
            repo: { type: "string" },
            "broker-mode": { type: "string" },
            "broker-port": { type: "string" },
            "non-interactive": { type: "boolean" },
          },
          strict: true,
        });
        const { services } = buildServices(ctx, tryLoadConfig(ctx), () => {});
        return await services.commands.setup(setupOptionsFrom(values), ctx.io);
      }

      case "capture": {
        const { values } = parseArgs({
          args: rest,
          options: { kind: { type: "string" }, url: { type: "string" }, out: { type: "string" } },
          strict: true,
        });
        const { services } = buildServices(ctx, tryLoadConfig(ctx), () => {});
        return await services.commands.capture(
          {
            ...(values.kind !== undefined ? { kind: values.kind } : {}),
            ...(values.url !== undefined ? { url: values.url } : {}),
            ...(values.out !== undefined ? { out: values.out } : {}),
          },
          ctx.io,
        );
      }

      case "update": {
        const { values } = parseArgs({
          args: rest,
          options: { check: { type: "boolean" } },
          strict: true,
        });
        const { services } = buildServices(ctx, tryLoadConfig(ctx), () => {});
        return await services.commands.update({ check_only: values.check === true }, ctx.io);
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      ctx.io.err((error as Error).message);
      ctx.io.err(USAGE);
      return 2;
    }
    ctx.io.err(`${first} failed: ${(error as Error).message}`);
    return 1;
  }
}
