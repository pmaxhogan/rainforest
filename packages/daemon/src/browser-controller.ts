import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserSession,
  EmbeddedBroker,
  ExternalBroker,
  Pacer,
  emptyPacingState,
  portInUse,
  type Broker,
  type PacingState,
} from "@rainforest/browser";
import { classifyInterstitial } from "@rainforest/parsers";
import { RfError } from "@rainforest/core";
import type { DaemonConfig } from "./config.ts";
import { atomicWriteJson } from "./fsutil.ts";
import type { BrowserController, BrowserStatus } from "./interfaces.ts";
import type { Logger } from "./log.ts";
import type { AppPaths } from "./paths.ts";
import { loadSecrets } from "./secrets.ts";

/** How many 1.5 s polls to give a running browser before launching it again. */
const RUNNING_GRACE_POLLS = 12;

/** Is the browser process running? Unknown counts as running (wait before launching). */
export async function browserRunning(platform: NodeJS.Platform): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const run = (file: string, args: string[]): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        resolve({ code: typeof code === "number" ? code : 127, stdout: String(stdout ?? "") });
      });
    });
  try {
    if (platform === "darwin") {
      const result = await run("/usr/bin/pgrep", ["-x", "Google Chrome"]);
      return result.code !== 1; // 1 = no match
    }
    if (platform === "win32") {
      const result = await run("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"]);
      return result.code !== 0 || /chrome\.exe/i.test(result.stdout);
    }
    return (await run("pgrep", ["-f", "chrome"])).code !== 1;
  } catch {
    return true;
  }
}

/**
 * Owns the broker connection, the pacer and the single browser session of this computer.
 * Attach is on demand; the session detaches after `idle_detach_s` without a call.
 */

const INSTANCE_WAIT_MS = 45_000;

export interface SessionProvider {
  /** The session, created on first use. Throws a structured error when not set up. */
  session(): Promise<BrowserSession>;
  pacer(): Pacer;
  setSignedIn(value: boolean | null): void;
  /** Hand a page to the human: a normal, non-automation tab brought to the front. */
  showOnScreen(url: string): void;
}

export interface ControllerDeps {
  config: DaemonConfig;
  paths: AppPaths;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export function chromeLaunchCommand(
  platform: NodeJS.Platform,
  chrome: DaemonConfig["chrome"],
): { file: string; args: string[] } {
  const profile = `--profile-directory=${chrome.profile_directory}`;
  const extra = chrome.user_data_dir ? [`--user-data-dir=${chrome.user_data_dir}`] : [];
  if (platform === "darwin") {
    // -g: do not bring to the foreground; -j: launch hidden. With Chrome already
    // running this hands the arguments to it without activating the app.
    const app = chrome.executable_path ?? "Google Chrome";
    return {
      file: "/usr/bin/open",
      args: ["-g", "-j", "-n", "-a", app, "--args", profile, ...extra, "--no-first-run"],
    };
  }
  if (platform === "win32") {
    const exe = chrome.executable_path ?? "chrome.exe";
    // `start /min` launches minimized and does not take the foreground.
    return {
      file: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "start",
        '""',
        "/min",
        exe,
        profile,
        ...extra,
        "--no-first-run",
        "--start-minimized",
      ],
    };
  }
  return {
    file: chrome.executable_path ?? "google-chrome",
    args: [profile, ...extra, "--no-first-run"],
  };
}

/** Open a URL in a NORMAL tab of the configured profile and bring the browser forward. */
export function chromeOpenUrlCommand(
  platform: NodeJS.Platform,
  chrome: DaemonConfig["chrome"],
  url: string,
): { file: string; args: string[] } {
  const profile = `--profile-directory=${chrome.profile_directory}`;
  const extra = chrome.user_data_dir ? [`--user-data-dir=${chrome.user_data_dir}`] : [];
  if (platform === "darwin") {
    const binary =
      chrome.executable_path ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return { file: binary, args: [profile, ...extra, url] };
  }
  if (platform === "win32") {
    const exe = chrome.executable_path ?? "chrome.exe";
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "start", '""', exe, profile, ...extra, url],
    };
  }
  return { file: chrome.executable_path ?? "google-chrome", args: [profile, ...extra, url] };
}

export function createBrowserController(deps: ControllerDeps): BrowserController & SessionProvider {
  const { config, paths } = deps;
  const log = deps.log.child({ part: "browser" });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pacingFile = join(paths.root, "pacing.json");
  let state: PacingState = emptyPacingState();
  if (existsSync(pacingFile)) {
    try {
      state = {
        ...emptyPacingState(),
        ...(JSON.parse(readFileSync(pacingFile, "utf8")) as PacingState),
      };
    } catch {
      state = emptyPacingState();
    }
  }
  const pacer = new Pacer({ state });
  let broker: Broker | null = null;
  let embedded: EmbeddedBroker | null = null;
  let session: BrowserSession | null = null;
  let profileConnected = false;
  let signedIn: boolean | null = null;

  const savePacing = (): void => {
    try {
      atomicWriteJson(pacingFile, pacer.state, 0o600);
    } catch (error) {
      log.warn("could not persist pacing state", { error: String((error as Error).message) });
    }
  };

  const token = (): string => {
    const secrets = loadSecrets(paths);
    if (!secrets)
      throw new RfError(
        "browser_offline",
        "this computer is not set up yet: run `rainforestd setup`",
      );
    return secrets.extension_token;
  };

  const getBroker = async (): Promise<Broker> => {
    if (broker) return broker;
    if (config.broker.mode === "embedded") {
      embedded = new EmbeddedBroker({
        port: config.broker.port,
        allowedExtensionIds: [config.chrome.extension_id],
        log: (line) => log.debug(line),
      });
      await embedded.listen();
      broker = embedded;
      return broker;
    }
    if (!(await portInUse(config.broker.port)) && config.broker.start_command) {
      // Start the operator-configured broker. Never kill or restart a running one.
      const [file, ...args] = config.broker.start_command;
      spawn(file!, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      for (let i = 0; i < 40 && !(await portInUse(config.broker.port)); i++) await sleep(100);
    }
    broker = new ExternalBroker(config.broker.port);
    return broker;
  };

  const refreshConnected = async (): Promise<boolean> => {
    try {
      profileConnected = await (await getBroker()).hasInstance(token());
    } catch {
      profileConnected = false;
    }
    return profileConnected;
  };

  const ensureInstance = async (): Promise<void> => {
    if (await refreshConnected()) return;
    // A browser that is already running usually just needs a moment for its extension
    // to reconnect. Launching again can disturb other tools that share it, so wait first
    // and only fall back to a launch (which opens the configured profile) after that.
    if (await browserRunning(paths.platform)) {
      log.info("the browser is running but its extension is not connected; waiting for it");
      for (let i = 0; i < RUNNING_GRACE_POLLS; i++) {
        await sleep(1500);
        if (await refreshConnected()) return;
      }
    }
    const command = chromeLaunchCommand(paths.platform, config.chrome);
    log.info("the browser profile is not connected; starting the browser quietly");
    spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    const deadline = Date.now() + INSTANCE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await refreshConnected()) return;
    }
    throw new RfError(
      "browser_offline",
      "the browser did not come up with the automation extension connected",
    );
  };

  const getSession = async (): Promise<BrowserSession> => {
    if (session) return session;
    const b = await getBroker();
    session = new BrowserSession({
      broker: b,
      token: token(),
      extensionId: config.chrome.extension_id,
      name: "rainforest",
      pacer,
      idleDetachMs: config.idle_detach_s * 1000,
      ensureInstance,
      classify: (capture) => {
        const hit = classifyInterstitial(capture);
        return hit ? { kind: hit.kind, evidence: hit.evidence } : null;
      },
      onPacingChange: savePacing,
      log: (line) => log.debug(line),
    });
    return session;
  };

  return {
    async start() {
      if (config.broker.mode === "embedded") await getBroker();
      void refreshConnected();
    },
    async stop() {
      await session?.detach().catch(() => {});
      await embedded?.close().catch(() => {});
      broker = null;
      session = null;
    },
    async detach() {
      await session?.detach().catch(() => {});
    },
    status(): BrowserStatus {
      void refreshConnected();
      const until = pacer.state.coolingDownUntil;
      return {
        profile_connected: profileConnected,
        amazon_signed_in: signedIn,
        cooling_down_until: until > Date.now() ? until : null,
        budget: pacer.budget(),
      };
    },
    session: getSession,
    pacer: () => pacer,
    setSignedIn(value) {
      signedIn = value;
    },
    showOnScreen(url) {
      const command = chromeOpenUrlCommand(paths.platform, config.chrome, url);
      spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    },
  };
}
