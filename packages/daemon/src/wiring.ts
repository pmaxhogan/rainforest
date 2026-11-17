import { RfError } from "@rainforest/core";
import type {
  BrowserController,
  CreateServices,
  HubClient,
  HubClientFactory,
  OperatorCommands,
  ToolRouter,
  Updater,
} from "./interfaces.ts";
import { createBrowserController } from "./browser-controller.ts";
import { pairCommand, setupCommand } from "./commands/operator.ts";
import { createRouter } from "./flows/index.ts";
import { hubClientFactory } from "./hub-client.ts";

/**
 * Shell wiring: stub implementations of every seam. The real hub client, browser
 * controller, rails/flows router and updater replace the matching entry here; nothing else
 * in the shell changes. Stubs fail closed: the router refuses every call.
 */

const NOT_IMPLEMENTED = "not implemented in the shell";

const stubHubClient: HubClientFactory = (deps) => {
  const client: HubClient = {
    start: () => deps.log.warn(`hub client ${NOT_IMPLEMENTED}; the daemon will not connect`),
    stop: async () => {},
    sendResult: () => false,
    sendPresence: () => false,
    isConnected: () => false,
  };
  return client;
};

const stubBrowser: BrowserController = {
  start: async () => {},
  stop: async () => {},
  detach: async () => {},
  status: () => ({ profile_connected: false, amazon_signed_in: null, cooling_down_until: null }),
};

const stubRouter: ToolRouter = {
  call: async () => {
    throw new RfError("unsupported", `tool execution ${NOT_IMPLEMENTED}`);
  },
};

const stubUpdater: Updater = {
  start: () => {},
  stop: () => {},
  checkNow: async () => ({ status: "failed", reason: `updater ${NOT_IMPLEMENTED}` }),
};

const stubCommands: OperatorCommands = {
  setup: async (_options, io) => {
    io.err(`setup: ${NOT_IMPLEMENTED}`);
    return 1;
  },
  pair: async (_options, io) => {
    io.err(`pair: ${NOT_IMPLEMENTED}`);
    return 1;
  },
  doctor: async (_options, io) => {
    io.err(`doctor: ${NOT_IMPLEMENTED}`);
    return 1;
  },
  capture: async (_options, io) => {
    io.err(`capture: ${NOT_IMPLEMENTED}`);
    return 1;
  },
  update: async (_options, io) => {
    io.err(`update: ${NOT_IMPLEMENTED}`);
    return 1;
  },
};

export const createServices: CreateServices = (deps) => {
  const operator = { paths: deps.paths, exec: deps.exec };
  const commands: OperatorCommands = {
    ...stubCommands,
    setup: (options, io) => setupCommand(operator, options, io),
    pair: (options, io) => pairCommand(operator, options, io),
  };
  if (!deps.config) {
    return {
      hubClient: stubHubClient,
      browser: stubBrowser,
      router: stubRouter,
      updater: stubUpdater,
      commands,
    };
  }
  const browser = createBrowserController({
    config: deps.config,
    paths: deps.paths,
    log: deps.log,
  });
  return {
    hubClient: hubClientFactory,
    browser,
    router: createRouter(browser),
    updater: stubUpdater,
    commands,
  };
};
