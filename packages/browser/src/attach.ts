import childProcess from "node:child_process";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Broker } from "./broker.ts";

/**
 * Extension-mode attach through the broker.
 *
 * We stay on Playwright's own extension relay (the protocol is versioned and the fork
 * tracks upstream). The relay wants to launch a browser binary with its connect URL as
 * the last argument; that launch would activate the browser and steal focus. Instead the
 * launch is intercepted IN PROCESS: the connect URL goes to the broker, which has the
 * extension open it in an unfocused window. Nothing is ever exec'd for a connect, so the
 * path fails closed: if the broker cannot deliver, the attach times out and no browser
 * is started.
 */

const STOCK_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const CONNECT_PREFIX = `chrome-extension://${STOCK_EXTENSION_ID}/connect.html`;

export interface AttachOptions {
  broker: Broker;
  /** Token of the extension instance in the target profile. */
  token: string;
  /** Extension id actually installed (the fork's id). */
  extensionId: string;
  /** Name shown on the window's title tab and the tab group. */
  name?: string;
  /** Where and how large to open the window. Omitted: the extension's own default. */
  bounds?: WindowBounds;
  connectTimeoutMs?: number;
  log?: (line: string) => void;
}

/** A window's outer frame in screen coordinates (CSS pixels). */
export interface WindowBounds {
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * Accept only a plain, plausible rectangle: whole numbers, at least 640 x 480, nothing
 * absurd. Anything else is no bounds at all, so the extension's default applies.
 */
export function sanitizeBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const whole = (n: unknown, min: number, max: number): number | null =>
    typeof n === "number" && Number.isFinite(n) && Math.round(n) >= min && Math.round(n) <= max
      ? Math.round(n)
      : null;
  const width = whole(v.width, 640, 16_384);
  const height = whole(v.height, 480, 16_384);
  const left = whole(v.left ?? 0, -32_768, 32_768);
  const top = whole(v.top ?? 0, -32_768, 32_768);
  if (width === null || height === null || left === null || top === null) return null;
  return { width, height, left, top };
}

/**
 * The usable area of the screen the tab is on (the screen minus menu bar, dock or
 * taskbar), as the page itself reports it. A window with these bounds fills the screen the
 * way an ordinary maximized browser window does.
 */
export async function readScreenArea(page: Page): Promise<WindowBounds | null> {
  const raw = await page
    .evaluate(
      `({ width: screen.availWidth, height: screen.availHeight, left: screen.availLeft || 0, top: screen.availTop || 0 })`,
    )
    .catch(() => null);
  return sanitizeBounds(raw);
}

export interface Attachment {
  browser: Browser;
  context: BrowserContext;
  /** The first automation tab. */
  page: Page;
  close(): Promise<void>;
}

interface PendingConnect {
  options: AttachOptions;
  delivered: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

let pendingConnect: PendingConnect | null = null;
let patched = false;

/** A process that exits immediately; stands in for the browser the relay tried to launch. */
function noopChild(realSpawn: typeof childProcess.spawn): childProcess.ChildProcess {
  return realSpawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
}

function installSpawnInterceptor(): void {
  if (patched) return;
  patched = true;
  const realSpawn = childProcess.spawn;
  const intercept = function (this: unknown, ...spawnArgs: unknown[]): childProcess.ChildProcess {
    const args = spawnArgs[1];
    const last = Array.isArray(args) ? args[args.length - 1] : undefined;
    if (typeof last === "string" && last.startsWith(CONNECT_PREFIX)) {
      const pending = pendingConnect;
      if (!pending) {
        // A connect nobody asked for: swallow it. Never launch a browser.
        return noopChild(realSpawn);
      }
      const url = last.replace(STOCK_EXTENSION_ID, pending.options.extensionId);
      pending.options.broker
        .open({
          url,
          token: pending.options.token,
          // No window name: a named window gets an extra title tab that the automation
          // cannot close, so the window would outlive every detach. Without it the
          // automation tab is the window's only tab and closing it closes the window.
          minimized: false,
          ...(pending.options.bounds ? { bounds: pending.options.bounds } : {}),
        })
        .then(
          () => pending.resolve(),
          (error: Error) => pending.reject(error),
        );
      return noopChild(realSpawn);
    }
    return Reflect.apply(realSpawn, this, spawnArgs) as childProcess.ChildProcess;
  };
  childProcess.spawn = intercept as typeof childProcess.spawn;
}

interface CoreTools {
  createBrowserWithInfo(
    config: unknown,
    clientInfo: { clientName: string },
    cliOptions: Record<string, unknown>,
    bindOptions: { title: string; workspaceDir?: string },
  ): Promise<{ browser: Browser }>;
}

function loadCoreTools(): CoreTools {
  const require = createRequire(import.meta.url);
  const bundle = require("playwright-core/lib/coreBundle") as { tools?: Partial<CoreTools> };
  if (typeof bundle.tools?.createBrowserWithInfo !== "function") {
    throw new Error("playwright-core does not expose the extension-mode entry this build expects");
  }
  return bundle.tools as CoreTools;
}

/** Enable focus emulation so a background tab keeps rendering (clicks hang without it). */
export async function enableFocusEmulation(page: Page): Promise<void> {
  const client = rawClient(page);
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
}

export interface RawCdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  prependListener(event: string, listener: (payload: never) => void): unknown;
  removeListener(event: string, listener: (payload: never) => void): unknown;
}

/**
 * The page's own CDP session inside Playwright's server implementation. The extension
 * relay refuses newCDPSession(), so this in-process bridge is the only way to send raw
 * commands. It is private API: `attach` verifies it on every attach and fails loudly.
 */
export function rawClient(page: Page): RawCdpClient {
  const impl = (
    page as unknown as { _connection?: { toImpl?: (o: unknown) => unknown } }
  )._connection?.toImpl?.(page);
  const client = (
    impl as { delegate?: { _mainFrameSession?: { _client?: RawCdpClient } } } | undefined
  )?.delegate?._mainFrameSession?._client;
  if (
    !client ||
    typeof client.send !== "function" ||
    typeof client.prependListener !== "function"
  ) {
    throw new Error("cannot reach the page's CDP session (Playwright internals changed)");
  }
  return client;
}

let attaching = false;

export async function attach(options: AttachOptions): Promise<Attachment> {
  if (attaching) throw new Error("an attach is already in progress");
  attaching = true;
  const previousToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  const previousTimeout = process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT;
  try {
    installSpawnInterceptor();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const delivered = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    delivered.catch(() => {});
    pendingConnect = { options, delivered, resolve, reject };
    // The relay reads the token from the environment when it is constructed.
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = options.token;
    process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT = String(options.connectTimeoutMs ?? 20_000);
    const tools = loadCoreTools();
    const config = {
      extension: true,
      tabGroup: true,
      background: false,
      // Never used to launch anything: the spawn is intercepted above.
      browser: { launchOptions: { executablePath: process.execPath } },
      timeouts: {},
    };
    const created = tools.createBrowserWithInfo(
      config,
      { clientName: options.name ?? "rainforest" },
      {},
      { title: "rainforest" },
    );
    // Surface a broker refusal immediately instead of waiting for the relay timeout.
    const info = await Promise.race([
      created,
      delivered.then(
        () => created,
        (error: Error) => {
          created.then(
            (i) => i.browser.close().catch(() => {}),
            () => {},
          );
          throw error;
        },
      ),
    ]);
    const browser = info.browser;
    // createBrowserWithInfo binds a local Playwright endpoint; nothing here needs it.
    await (browser as unknown as { unbind?: () => Promise<void> }).unbind?.().catch(() => {});
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error("extension attach produced no browser context");
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await enableFocusEmulation(page);
    options.log?.("attached");
    return {
      browser,
      context,
      page,
      async close() {
        for (const p of context.pages()) await p.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  } finally {
    pendingConnect = null;
    attaching = false;
    if (previousToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = previousToken;
    if (previousTimeout === undefined) delete process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT;
    else process.env.PWTEST_EXTENSION_CONNECT_TIMEOUT = previousTimeout;
  }
}
