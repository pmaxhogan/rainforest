import { vi } from "vitest";
import type { DaemonResult, HubCall, Presence, ToolDef } from "@rainforest/core";
import type { CliContext } from "../src/commands/context.ts";
import { parseConfig, type DaemonConfig } from "../src/config.ts";
import type {
  BrowserController,
  DaemonServices,
  HubClient,
  HubClientDeps,
  OperatorCommands,
  ToolContext,
  ToolOutput,
  ToolRouter,
  Updater,
  UpdateOutcome,
} from "../src/interfaces.ts";
import { nullLogger } from "../src/log.ts";
import type { ServiceManager } from "../src/service/types.ts";
import { fakeExec, tmpPaths } from "./helpers.ts";

export const sampleConfig = (overrides: Record<string, unknown> = {}): DaemonConfig =>
  parseConfig({
    hub_url: "https://hub.example.com",
    device_id: "device-0001",
    device_name: "desk",
    chrome: { profile_directory: "Default", extension_id: "abcdefghijklmnopabcdefghijklmnop" },
    update: { repo: "example/rainforest" },
    ...overrides,
  });

export function presence(overrides: Partial<Presence> = {}): Presence {
  return {
    idle_s: 1,
    locked: false,
    chrome_running: true,
    profile_connected: true,
    amazon_signed_in: true,
    cooling_down_until: null,
    version: "0.0.0",
    ...overrides,
  };
}

export function call(overrides: Partial<HubCall> & { tool: string }): HubCall {
  return { type: "call", id: "call-0001", args: {}, deadline_ms: 5000, ...overrides };
}

export class FakeHub implements HubClient {
  deps!: HubClientDeps;
  connected = true;
  started = false;
  stopped = false;
  results: DaemonResult[] = [];
  presences: Presence[] = [];
  start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  sendResult(result: DaemonResult) {
    if (!this.connected) return false;
    this.results.push(result);
    return true;
  }
  sendPresence(p: Presence) {
    if (!this.connected) return false;
    this.presences.push(p);
    return true;
  }
  isConnected() {
    return this.connected;
  }
}

export interface FakeServices extends DaemonServices {
  hub: FakeHub;
  router: ToolRouter & {
    handler: (
      tool: ToolDef,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ) => Promise<ToolOutput>;
    calls: Array<{ tool: string; args: Record<string, unknown> }>;
  };
  browser: BrowserController & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
  updater: Updater & { checkNow: ReturnType<typeof vi.fn>; started: boolean };
}

export function fakeServices(): FakeServices {
  const hub = new FakeHub();
  const router = {
    calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
    handler: (async () => ({ data: { fake: true } })) as (
      tool: ToolDef,
      args: Record<string, unknown>,
      ctx: ToolContext,
    ) => Promise<ToolOutput>,
    call(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext) {
      router.calls.push({ tool: tool.name, args });
      return router.handler(tool, args, ctx);
    },
  };
  const browser = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    status: () => ({ profile_connected: true, amazon_signed_in: true, cooling_down_until: null }),
  };
  const updater = {
    started: false,
    start() {
      updater.started = true;
    },
    stop() {},
    checkNow: vi.fn(async (): Promise<UpdateOutcome> => ({
      status: "up_to_date",
      version: "0.0.0",
    })),
  };
  const commands: OperatorCommands = {
    setup: vi.fn(async () => 0),
    pair: vi.fn(async () => 0),
    doctor: vi.fn(async () => 0),
    capture: vi.fn(async () => 0),
    update: vi.fn(async () => 0),
  };
  return {
    hub,
    hubClient: (deps) => {
      hub.deps = deps;
      return hub;
    },
    browser,
    router,
    updater,
    commands,
  };
}

export class FakeServiceManager implements ServiceManager {
  readonly kind = "launchd" as const;
  log: string[] = [];
  async install(options?: { start?: boolean }) {
    this.log.push(`install start=${options?.start !== false}`);
  }
  async uninstall() {
    this.log.push("uninstall");
  }
  async start() {
    this.log.push("start");
  }
  async stop() {
    this.log.push("stop");
  }
  async status() {
    return { installed: true, running: true, pid: 77 };
  }
}

export function fakeContext(services: DaemonServices = fakeServices()) {
  const paths = tmpPaths("darwin");
  const out: string[] = [];
  const err: string[] = [];
  const service = new FakeServiceManager();
  const signalHandlers: Array<() => void> = [];
  const ctx: CliContext = {
    paths,
    platform: "darwin",
    env: { RAINFOREST_HOME: paths.root },
    exec: fakeExec().exec,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    version: "9.9.9",
    nodePath: "/usr/local/bin/node",
    mainEntry: new URL("../src/main.ts", import.meta.url).pathname,
    launcherSource: new URL("../src/launcher.ts", import.meta.url).pathname,
    createServices: () => services,
    makeServiceManager: () => service,
    makeLogger: () => nullLogger(),
    onShutdownSignal: (handler) => {
      signalHandlers.push(handler);
      return () => {};
    },
    now: Date.now,
  };
  return { ctx, out, err, service, services, paths, signalHandlers };
}
