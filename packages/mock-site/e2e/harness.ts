import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  BrowserSession,
  EmbeddedBroker,
  Pacer,
  type PacingDecision,
  type PageType,
} from "@rainforest/browser";
import { RfError, TOOLS, type ToolDef } from "@rainforest/core";
import { classifyInterstitial } from "@rainforest/parsers";
import type { SessionProvider } from "../../daemon/src/browser-controller.ts";
import { createRouter } from "../../daemon/src/flows/index.ts";
import type { ToolRouter } from "../../daemon/src/interfaces.ts";
import { createMockSite, type MockSite } from "../src/index.ts";
import { makeEphemeralCert } from "./tls.ts";

/**
 * End-to-end harness: a real Chromium with the quiet extension fork, the daemon's embedded
 * broker, the REAL BrowserSession and the REAL typed flows, all pointed at the mock
 * storefront.
 *
 * Host mapping happens INSIDE THE TEST BROWSER ONLY. Chromium is started with
 * `--host-resolver-rules` that send the storefront hostname to the loopback mock and make
 * every other hostname fail to resolve, so nothing can reach the real site even if a flow
 * misbehaves. TLS is an ephemeral self-signed certificate made in memory at startup and
 * trusted by its public key hash. The production URL policy is untouched: the flows still
 * navigate to `https://www.amazon.com/...` and the rails see exactly that.
 *
 * The extension fork dials a FIXED broker port. When that port is taken (another tool's
 * broker on a developer machine), the suite skips: it never touches whatever holds it.
 * Set RAINFOREST_E2E_PATCHED_EXTENSION=1 to run anyway against a temporary COPY of the
 * extension build whose port constant is rewritten to an ephemeral one.
 */

export const STOREFRONT_HOST = "www.amazon.com";
export const STOREFRONT = `https://${STOREFRONT_HOST}`;
/** The port the extension fork dials (`ws://127.0.0.1:<port>/ext`). */
export const EXTENSION_BROKER_PORT = 47117;

export interface Harness {
  site: MockSite;
  session: BrowserSession;
  pacer: Pacer;
  router: ToolRouter;
  provider: SessionProvider & { shown: string[] };
  /** Run a registry tool through the router (arguments validated like the supervisor does). */
  call(tool: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Like `call`, but returns the structured error a refusal raises. */
  callError(tool: string, args?: Record<string, unknown>): Promise<RfError>;
  state(): Promise<MockStateView>;
  reset(): Promise<void>;
  /** Forget any cool-down the pacer is in (between rails tests). */
  clearCoolDown(): void;
  log: string[];
  mode: "fixed-port" | "patched-copy";
  /** The throwaway profile directory of the test browser. */
  userDataDir: string;
  close(): Promise<void>;
}

export interface MockStateView {
  session: {
    cart: {
      active: { item_id: string; asin: string; quantity: number }[];
      saved: { item_id: string; asin: string }[];
      subtotal_cents: number;
    };
    lists: { id: string; name: string; items: { itemId: string; asin: string }[] }[];
  } | null;
  trap_counts: Record<string, number>;
  traps: { trap: string; method: string; path: string }[];
  hits: { method: string; path: string; search: string; at: number }[];
}

/**
 * Pacing with the gaps and caps switched off, but cool-downs still enforced. Set `fast`
 * to false to get the real pacer's behavior (gaps and caps) for a pacing test.
 */
export class FastPacer extends Pacer {
  fast = true;

  override headroom(type: Exclude<PageType, "none">): number {
    if (!this.fast) return super.headroom(type);
    return Date.now() < this.state.coolingDownUntil ? 0 : 1000;
  }

  override plan(type: PageType): PacingDecision {
    const decision = super.plan(type);
    if (!this.fast) return decision;
    if (!decision.ok && decision.reason === "cooling_down") return decision;
    return { ok: true, waitMs: 0 };
  }
}

/** Chrome's extension id for a manifest `key`: sha256 of the DER key, first 32 hex digits as a-p. */
export function extensionIdFromKey(keyBase64: string): string {
  const hex = createHash("sha256")
    .update(Buffer.from(keyBase64, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function defaultExtensionDir(): string | null {
  const fromEnv = process.env.RAINFOREST_E2E_EXTENSION_DIR;
  if (fromEnv) return fromEnv;
  const local = join(homedir(), "code", "playwright-extension-quiet", "dist");
  return existsSync(join(local, "manifest.json")) ? local : null;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/**
 * Copy the extension build to a temp dir and rewrite ONLY the broker port constant. The
 * original directory is never modified.
 */
export function patchedExtensionCopy(source: string, port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rf-e2e-ext-"));
  cpSync(source, dir, { recursive: true });
  let replaced = 0;
  for (const file of filesUnder(dir)) {
    if (!/\.(m?js|html|json)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes(`127.0.0.1:${EXTENSION_BROKER_PORT}`)) continue;
    const next = text.split(`127.0.0.1:${EXTENSION_BROKER_PORT}`).join(`127.0.0.1:${port}`);
    replaced += text.split(`127.0.0.1:${EXTENSION_BROKER_PORT}`).length - 1;
    writeFileSync(file, next);
  }
  const leftover = filesUnder(dir).filter(
    (f) =>
      /\.(m?js|html|json)$/.test(f) &&
      readFileSync(f, "utf8").includes(String(EXTENSION_BROKER_PORT)),
  );
  if (replaced === 0 || leftover.length > 0)
    throw new Error(
      `could not patch the broker port in the extension copy (replaced ${replaced}, leftover ${leftover.length})`,
    );
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fail with a message naming the stage instead of hanging forever. */
export async function withTimeout<T>(
  label: string,
  ms: number,
  work: Promise<T>,
  detail: () => string = () => "",
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`E2E harness: "${label}" did not finish within ${ms} ms. ${detail()}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open one URL in the freshly started test browser through its DevTools endpoint, then
 * disconnect. Only the harness's own browser is ever addressed (found through the
 * profile directory it created).
 */
async function openOnce(userDataDir: string, url: string): Promise<void> {
  const file = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(file); i++) await sleep(100);
  const [port, path] = readFileSync(file, "utf8").split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
      if (message.id !== 1) return;
      if (message.error)
        reject(new Error(`could not open ${url}: ${JSON.stringify(message.error)}`));
      else resolve();
    };
    socket.onerror = () =>
      reject(new Error("could not reach the test browser's DevTools endpoint"));
  });
  socket.close();
}

/**
 * A NORMAL tab in the test browser, outside the automation session (what the owner's own
 * browsing is in real life). Driven over the test browser's DevTools endpoint; used to
 * get the storefront's service worker installed the way a human visit would.
 */
export class PlainTab {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #id = 0;
  #session = "";
  targetId = "";

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      const waiter = m.id === undefined ? undefined : this.#pending.get(m.id);
      if (!waiter) return;
      this.#pending.delete(m.id!);
      if (m.error) waiter.reject(new Error(JSON.stringify(m.error)));
      else waiter.resolve(m.result);
    };
  }

  static async open(userDataDir: string, url: string): Promise<PlainTab> {
    const [port, path] = readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8").split("\n");
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(new Error("could not reach the test browser's DevTools endpoint"));
    });
    const tab = new PlainTab(socket);
    const { targetId } = (await tab.#send("Target.createTarget", { url })) as { targetId: string };
    tab.targetId = targetId;
    const { sessionId } = (await tab.#send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    tab.#session = sessionId;
    return tab;
  }

  #send(method: string, params: Record<string, unknown>, session?: string): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(
        JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }),
      );
    });
  }

  /**
   * Let paused service workers of the storefront run. A worker first started from the
   * automation tab is held "waiting for debugger" by the extension relay's auto-attach,
   * which leaves its registration installing forever; a normal visit has no such hold.
   */
  async resumeWorkers(): Promise<number> {
    const { targetInfos } = (await this.#send("Target.getTargets", {})) as {
      targetInfos: { targetId: string; type: string; url: string }[];
    };
    let resumed = 0;
    for (const t of targetInfos) {
      if (t.type !== "service_worker" || !t.url.startsWith(`https://${STOREFRONT_HOST}/`)) continue;
      const { sessionId } = (await this.#send("Target.attachToTarget", {
        targetId: t.targetId,
        flatten: true,
      })) as { sessionId: string };
      await this.#send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      await this.#send("Target.detachFromTarget", { sessionId }).catch(() => {});
      resumed++;
    }
    return resumed;
  }

  /** Evaluate an expression (promises are awaited) in the tab. */
  async evaluate(expression: string): Promise<unknown> {
    const r = (await this.#send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.#session,
    )) as { result?: { value?: unknown } };
    return r.result?.value;
  }

  async navigate(url: string): Promise<void> {
    await this.#send("Page.navigate", { url }, this.#session);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if ((await this.evaluate("document.readyState").catch(() => "")) === "complete") return;
    }
  }

  async close(): Promise<void> {
    await this.#send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    this.#socket.close();
  }
}

function controlRequest(
  site: MockSite,
  cert: string,
  method: string,
  path: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: site.port, path, method, ca: cert, servername: STOREFRONT_HOST },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface HarnessOptions {
  /** Pacer to drive the session with (default: a FastPacer). */
  pacer?: Pacer;
  seed?: number;
}

export type HarnessStart = { ok: true; harness: Harness } | { ok: false; skip: string };

/**
 * Start the harness, or say why it cannot run here. With RAINFOREST_E2E_REQUIRE=1 (CI) a
 * reason to skip is an error instead, so a misconfigured runner never passes silently.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<HarnessStart> {
  const start = await tryStart(options);
  if (!start.ok && process.env.RAINFOREST_E2E_REQUIRE === "1")
    throw new Error(`the E2E suite is required here but cannot run: ${start.skip}`);
  return start;
}

async function tryStart(options: HarnessOptions): Promise<HarnessStart> {
  const extensionSource = defaultExtensionDir();
  if (!extensionSource)
    return {
      ok: false,
      skip: "no build of the quiet extension fork found (set RAINFOREST_E2E_EXTENSION_DIR)",
    };
  const manifest = JSON.parse(readFileSync(join(extensionSource, "manifest.json"), "utf8")) as {
    key?: string;
  };
  if (!manifest.key)
    return { ok: false, skip: "the extension build has no manifest key, so its id is not stable" };
  const extensionId = extensionIdFromKey(manifest.key);
  const patched = process.env.RAINFOREST_E2E_PATCHED_EXTENSION === "1";
  const log: string[] = [];
  const broker = new EmbeddedBroker({
    port: patched ? 0 : EXTENSION_BROKER_PORT,
    allowedExtensionIds: [extensionId],
    log: (line) => log.push(line),
  });
  try {
    // Binding is the only probe: nothing is sent to, or done to, a process holding the port.
    await broker.listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return {
        ok: false,
        skip: `port ${EXTENSION_BROKER_PORT} is already in use (another broker owns it); the extension fork dials that fixed port, so the E2E suite is skipped. Set RAINFOREST_E2E_PATCHED_EXTENSION=1 to run against a port-patched temporary copy of the extension.`,
      };
    }
    throw error;
  }
  const cleanups: (() => Promise<void> | void)[] = [() => broker.close()];
  const cleanup = async (): Promise<void> => {
    for (const fn of cleanups.reverse()) await Promise.resolve(fn()).catch(() => {});
  };
  try {
    const extensionDir = patched
      ? patchedExtensionCopy(extensionSource, broker.port)
      : extensionSource;
    if (patched) cleanups.push(() => rmSync(extensionDir, { recursive: true, force: true }));
    const cert = makeEphemeralCert(STOREFRONT_HOST);
    const site = await createMockSite({
      seed: options.seed ?? 1,
      tls: { key: cert.key, cert: cert.cert },
    });
    cleanups.push(() => site.close());
    const userDataDir = mkdtempSync(join(tmpdir(), "rf-e2e-profile-"));
    // Chromium can still be writing its profile for a moment after it exits: retry.
    cleanups.push(() =>
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    );
    const headed = process.env.RAINFOREST_E2E_HEADED === "1";
    const args = [
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--no-pings",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-proxy-server",
      // Hosted Linux runners restrict the user namespaces Chromium's sandbox needs.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      // The storefront host goes to the mock; every other name fails to resolve. Loopback
      // stays reachable for the extension's broker socket and Playwright's relay socket
      // (the relay may listen on ::1, written without brackets here).
      `--host-resolver-rules=MAP ${STOREFRONT_HOST} 127.0.0.1:${site.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ::1`,
      `--ignore-certificate-errors-spki-list=${cert.spkiHash}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // The fork opens connect pages at fixed bounds that must lie on screen: give the
      // headless screen a desktop size (under xvfb, size the virtual screen instead).
      ...(headed ? [] : ["--headless=new", "--screen-info={1920x1200}"]),
      // Used ONCE, below, to open the extension's own page; then the connection is closed.
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const child: ChildProcess = spawn(chromium.executablePath(), args, { stdio: "ignore" });
    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    });
    // Opening the extension's own token page once mints and stores its token (a page given
    // on the command line is not opened for an extension that is still loading). Newer
    // builds call it manage.html, older ones status.html.
    const tokenPage = ["manage.html", "status.html"].find((p) => existsSync(join(extensionDir, p)));
    if (!tokenPage) throw new Error("the extension build has neither manage.html nor status.html");
    await withTimeout(
      "open the extension token page",
      30_000,
      openOnce(userDataDir, `chrome-extension://${extensionId}/${tokenPage}`),
    );
    let token: string | undefined;
    for (let i = 0; i < 150 && !token; i++) {
      token = broker.tokensForSetup().find((t) => t.extensionId === extensionId)?.token;
      if (!token) await sleep(200);
    }
    if (!token)
      throw new Error(
        `the extension never reported a token to the broker (instances: ${JSON.stringify(await broker.instances())})`,
      );
    // Whole-run watchdog: a wedged browser or flow must fail loudly, never hang the suite.
    const maxMs = Number(process.env.RAINFOREST_E2E_MAX_MS ?? 900_000);
    const watchdog = setTimeout(() => {
      console.error(
        `[e2e] watchdog: the run exceeded ${maxMs} ms; exiting. harness log tail: ${JSON.stringify(log.slice(-10))}`,
      );
      void cleanup().finally(() => process.exit(1));
    }, maxMs);
    watchdog.unref();
    cleanups.push(() => clearTimeout(watchdog));
    const pacer = options.pacer ?? new FastPacer();
    const session = new BrowserSession({
      broker,
      token,
      extensionId,
      name: "rainforest-e2e",
      pacer,
      idleDetachMs: 600_000,
      classify: (capture) => {
        const hit = classifyInterstitial(capture);
        return hit ? { kind: hit.kind, evidence: hit.evidence } : null;
      },
      log: (line) => log.push(line),
    });
    cleanups.push(() => session.detach());
    const shown: string[] = [];
    const provider: SessionProvider & { shown: string[] } = {
      session: async () => session,
      pacer: () => pacer,
      setSignedIn: () => {},
      // Never open anything outside the test browser.
      showOnScreen: (url) => void shown.push(url),
      shown,
    };
    const router = createRouter(provider);
    const tool = (name: string): ToolDef => {
      const def = TOOLS.find((t) => t.name === name);
      if (!def) throw new Error(`no tool ${name}`);
      return def;
    };
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const def = tool(name);
      const parsed = def.input.parse(args) as Record<string, unknown>;
      const output = await router.call(def, parsed, {
        id: `e2e-${name}`,
        deadline_ms: 120_000,
        signal: new AbortController().signal,
      });
      return output.data;
    };
    const harness: Harness = {
      site,
      session,
      pacer,
      router,
      provider,
      call,
      async callError(name, args = {}) {
        try {
          await call(name, args);
        } catch (error) {
          if (error instanceof RfError) return error;
          throw error;
        }
        throw new Error(`${name} succeeded but a refusal was expected`);
      },
      state: async () =>
        JSON.parse(await controlRequest(site, cert.cert, "GET", "/__mock/state")) as MockStateView,
      reset: async () => {
        await controlRequest(site, cert.cert, "POST", "/__mock/reset");
      },
      clearCoolDown: () => {
        pacer.state.coolingDownUntil = 0;
        delete pacer.state.coolDownReason;
      },
      log,
      mode: patched ? "patched-copy" : "fixed-port",
      userDataDir,
      close: cleanup,
    };
    // Canary: the storefront hostname must resolve to the mock through the real rails.
    await withTimeout(
      "canary navigation through the session",
      60_000,
      session.run(async (ctx) => {
        await ctx.goto(`${STOREFRONT}/`, "none");
      }),
      () => `harness log tail: ${JSON.stringify(log.slice(-10))}`,
    );
    const st = await harness.state();
    if (!st.hits.some((h) => h.path === "/"))
      throw new Error("the browser did not reach the mock storefront (host mapping failed)");
    return { ok: true, harness };
  } catch (error) {
    await cleanup();
    if (error instanceof Error) error.message += `\nharness log:\n${log.slice(-20).join("\n")}`;
    throw error;
  }
}
