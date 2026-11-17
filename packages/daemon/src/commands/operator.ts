import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EmbeddedBroker, portInUse } from "@rainforest/browser";
import { chromeLaunchCommand } from "../browser-controller.ts";
import {
  DEFAULT_BROKER_PORT,
  loadConfig,
  saveConfig,
  type DaemonConfig,
  type DaemonConfigInput,
} from "../config.ts";
import type { Exec } from "../exec.ts";
import type { CliIo, PairOptions, SetupOptions } from "../interfaces.ts";
import { defaultDeviceName, pair } from "../pairing.ts";
import type { AppPaths } from "../paths.ts";
import { loadSecrets, saveSecrets } from "../secrets.ts";

/** Device ids before pairing start with this prefix; the hub never knows them. */
export const UNPAIRED_PREFIX = "unpaired-";

export interface OperatorDeps {
  paths: AppPaths;
  exec: Exec;
  sleep?: (ms: number) => Promise<void>;
}

function tryConfig(paths: AppPaths): DaemonConfig | null {
  try {
    return loadConfig(paths);
  } catch {
    return null;
  }
}

/**
 * Find the token of the extension instance with the configured extension id.
 * External mode asks the already running local broker; embedded mode listens for the
 * extension itself. If the instance has no token yet, its token page is opened once.
 */
async function discoverToken(
  deps: OperatorDeps,
  config: DaemonConfig,
  io: CliIo,
): Promise<string | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const extensionId = config.chrome.extension_id;
  const port = config.broker.port;
  let embedded: EmbeddedBroker | null = null;
  const read = async (): Promise<{ present: boolean; token: string | null }> => {
    if (embedded) {
      const hit = embedded.tokensForSetup().find((t) => t.extensionId === extensionId);
      const present = (await embedded.instances()).some((i) => i.extensionId === extensionId);
      return { present, token: hit?.token ?? null };
    }
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as {
      extensions?: { extensionId?: string; token?: string }[];
    };
    const matches = (body.extensions ?? []).filter((e) => e.extensionId === extensionId);
    return { present: matches.length > 0, token: matches.find((e) => e.token)?.token ?? null };
  };
  try {
    if (config.broker.mode === "embedded") {
      if (await portInUse(port)) {
        io.err(
          `port ${port} is in use: stop the running daemon first (rainforestd uninstall or stop the service)`,
        );
        return null;
      }
      embedded = new EmbeddedBroker({ port, allowedExtensionIds: [extensionId] });
      await embedded.listen();
    } else if (!(await portInUse(port))) {
      io.err(`no broker is listening on port ${port}`);
      return null;
    }
    const launch = (extraUrl?: string): void => {
      const command = chromeLaunchCommand(deps.paths.platform, config.chrome);
      const args = extraUrl ? [...command.args, extraUrl] : command.args;
      spawn(command.file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    };
    let opened = false;
    let launched = false;
    for (let i = 0; i < 60; i++) {
      const state = await read().catch(() => ({ present: false, token: null }));
      if (state.token) return state.token;
      if (!state.present && !launched && i >= 2) {
        io.out("starting the browser profile so its extension can connect...");
        launch();
        launched = true;
      }
      if (state.present && !opened) {
        io.out("opening the extension's token page once (the browser may come to the front)...");
        launch(`chrome-extension://${extensionId}/manage.html`);
        opened = true;
      }
      await sleep(1500);
    }
    return null;
  } finally {
    await embedded?.close().catch(() => {});
  }
}

export async function setupCommand(
  deps: OperatorDeps,
  options: SetupOptions,
  io: CliIo,
): Promise<number> {
  const existing = tryConfig(deps.paths);
  const hubUrl = options.hub_url ?? existing?.hub_url;
  const profile = options.profile_directory ?? existing?.chrome.profile_directory;
  const extensionId = options.extension_id ?? existing?.chrome.extension_id;
  const repo = options.update_repo ?? existing?.update.repo;
  const missing = [
    !hubUrl && "--hub-url",
    !profile && "--profile",
    !extensionId && "--extension-id",
    !repo && "--repo",
  ].filter(Boolean);
  if (missing.length > 0) {
    io.err(`setup needs: ${missing.join(", ")}`);
    return 2;
  }
  const input: DaemonConfigInput = {
    ...(existing ?? {}),
    hub_url: hubUrl!,
    device_id: existing?.device_id ?? `${UNPAIRED_PREFIX}${randomUUID()}`,
    device_name: options.device_name ?? existing?.device_name ?? defaultDeviceName(),
    aliases: options.aliases.length > 0 ? options.aliases : (existing?.aliases ?? []),
    chrome: {
      ...(existing?.chrome ?? {}),
      profile_directory: profile!,
      extension_id: extensionId!,
      ...(options.user_data_dir ? { user_data_dir: options.user_data_dir } : {}),
      ...(options.executable_path ? { executable_path: options.executable_path } : {}),
    },
    broker: {
      ...(existing?.broker ?? {}),
      mode: options.broker_mode ?? existing?.broker.mode ?? "embedded",
      port: options.broker_port ?? existing?.broker.port ?? DEFAULT_BROKER_PORT,
    },
    update: {
      ...(existing?.update ?? {}),
      repo: repo!,
      check_interval_s: existing?.update.check_interval_s ?? 600,
    },
  };
  const config = saveConfig(deps.paths, input);
  io.out(`config written: ${deps.paths.configFile}`);

  const token = await discoverToken(deps, config, io);
  if (!token) {
    io.err(
      "could not obtain the extension token: is the extension installed in that browser profile?",
    );
    return 1;
  }
  const secrets = loadSecrets(deps.paths);
  await saveSecrets(
    deps.paths,
    { ...(secrets ?? {}), extension_token: token },
    { platform: deps.paths.platform, exec: deps.exec },
  );
  io.out("extension token stored");
  io.out(
    config.device_id.startsWith(UNPAIRED_PREFIX) ? "next: rainforestd pair" : "setup complete",
  );
  return 0;
}

export async function pairCommand(
  deps: OperatorDeps,
  options: PairOptions,
  io: CliIo,
): Promise<number> {
  const config = tryConfig(deps.paths);
  if (!config) {
    io.err("run `rainforestd setup` first");
    return 2;
  }
  const result = await pair(
    {
      paths: deps.paths,
      secretDeps: { platform: deps.paths.platform, exec: deps.exec },
      hubUrl: config.hub_url,
      deviceName: config.device_name,
    },
    options,
    io,
  );
  if (!result.ok) {
    io.err(`pairing failed: ${result.reason}`);
    return 1;
  }
  saveConfig(deps.paths, { ...config, device_id: result.deviceId });
  io.out("paired. Start the daemon with `rainforestd install`.");
  return 0;
}
