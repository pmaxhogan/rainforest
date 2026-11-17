import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Two ways to reach the quiet Playwright extension fork:
 *
 *  - ExternalBroker: another process already owns the loopback broker port and exposes
 *    HTTP `GET /status` and `POST /open`. We only ever talk to it; never start, stop or
 *    restart it here except through an operator-configured start command.
 *  - EmbeddedBroker: we listen on the loopback port ourselves and speak the fork's `/ext`
 *    WebSocket protocol. Hardened: loopback bind, upgrade only from an allowlisted
 *    extension origin, no HTTP endpoints at all, silent clients dropped.
 */

export interface OpenRequest {
  url: string;
  token: string;
  name?: string;
  minimized?: boolean;
  bounds?: { width?: number; height?: number; left?: number; top?: number };
}

export interface OpenResult {
  windowId?: number;
  tabId?: number;
}

export interface ExtensionInstance {
  extensionId: string;
  version?: string;
  hasToken: boolean;
}

export interface Broker {
  /** Instances currently connected. Tokens are never returned. */
  instances(): Promise<ExtensionInstance[]>;
  /** True when an instance holding exactly this token is connected. */
  hasInstance(token: string): Promise<boolean>;
  /** Ask the instance holding `token` to open `url` in an unfocused window. */
  open(request: OpenRequest, timeoutMs?: number): Promise<OpenResult>;
  close(): Promise<void>;
}

export class BrokerError extends Error {
  readonly code: "unreachable" | "no_instance" | "declined" | "timeout";
  constructor(code: BrokerError["code"], message: string) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function requireToken(token: string): void {
  // A tokenless open would be offered to every connected profile. Never send one.
  if (typeof token !== "string" || token.length < 16)
    throw new BrokerError("declined", "refusing an open without a token");
}

export class ExternalBroker implements Broker {
  readonly #base: string;

  constructor(port: number) {
    this.#base = `http://127.0.0.1:${port}`;
  }

  async #status(): Promise<{
    extensions: { token?: string; extensionId?: string; version?: string }[];
  }> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new BrokerError("unreachable", "broker is not reachable");
    }
    if (!response.ok) throw new BrokerError("unreachable", `broker status ${response.status}`);
    return (await response.json()) as {
      extensions: { token?: string; extensionId?: string; version?: string }[];
    };
  }

  async instances(): Promise<ExtensionInstance[]> {
    const status = await this.#status();
    return status.extensions.map((e) => ({
      extensionId: String(e.extensionId ?? ""),
      version: e.version,
      hasToken: typeof e.token === "string" && e.token.length > 0,
    }));
  }

  async hasInstance(token: string): Promise<boolean> {
    requireToken(token);
    const status = await this.#status();
    return status.extensions.some((e) => e.token === token);
  }

  async open(request: OpenRequest, timeoutMs = 4000): Promise<OpenResult> {
    requireToken(request.token);
    let response: Response;
    try {
      response = await fetch(`${this.#base}/open`, {
        method: "POST",
        body: JSON.stringify({
          url: request.url,
          token: request.token,
          name: request.name,
          minimized: request.minimized === true,
          bounds: request.bounds,
          app: false,
          timeout: timeoutMs,
        }),
        signal: AbortSignal.timeout(timeoutMs + 2000),
      });
    } catch {
      throw new BrokerError("unreachable", "broker is not reachable");
    }
    const body = (await response.json().catch(() => ({}))) as {
      opened?: boolean;
      error?: string;
    } & OpenResult;
    if (body.opened) return { windowId: body.windowId, tabId: body.tabId };
    if (response.status === 504) throw new BrokerError("timeout", "extension did not answer");
    if (response.status === 503 && /no extension/.test(String(body.error))) {
      throw new BrokerError("no_instance", "no extension instance with that token is connected");
    }
    throw new BrokerError("declined", "extension declined to open the connect page");
  }

  async close(): Promise<void> {}
}

interface Client {
  socket: WebSocket;
  hello: { token?: string; extensionId: string; version?: string } | null;
  missed: number;
}

export interface EmbeddedBrokerOptions {
  port: number;
  /** Extension ids allowed to connect, e.g. the fork's Web Store id. */
  allowedExtensionIds: readonly string[];
  pingIntervalMs?: number;
  log?: (line: string) => void;
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedExtensionIds: readonly string[],
): boolean {
  if (typeof origin !== "string") return false;
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match !== null && allowedExtensionIds.includes(match[1]!);
}

export class EmbeddedBroker implements Broker {
  readonly #options: EmbeddedBrokerOptions;
  readonly #clients = new Set<Client>();
  readonly #pending = new Map<
    string,
    {
      resolve: (r: OpenResult) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      left: number;
    }
  >();
  #server: Server | null = null;
  #wss: WebSocketServer | null = null;
  #ping: NodeJS.Timeout | null = null;

  constructor(options: EmbeddedBrokerOptions) {
    this.#options = options;
  }

  async listen(): Promise<void> {
    const server = createServer((_req, res) => {
      // No HTTP surface at all.
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (
        path !== "/ext" ||
        !isAllowedOrigin(req.headers.origin, this.#options.allowedExtensionIds)
      ) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, "127.0.0.1", () => resolve());
    });
    this.#server = server;
    this.#wss = wss;
    this.#ping = setInterval(() => this.#pingAll(), this.#options.pingIntervalMs ?? 20_000);
    this.#ping.unref();
  }

  /** Port actually bound (useful when 0 was requested in tests). */
  get port(): number {
    const address = this.#server?.address();
    return typeof address === "object" && address ? address.port : this.#options.port;
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  #pingAll(): void {
    for (const client of this.#clients) {
      if (++client.missed > 2) {
        this.#log("dropping silent extension client");
        client.socket.terminate();
        continue;
      }
      client.socket.send(JSON.stringify({ type: "ping" }));
    }
  }

  #onConnection(socket: WebSocket): void {
    const client: Client = { socket, hello: null, missed: 0 };
    this.#clients.add(client);
    socket.on("close", () => this.#clients.delete(client));
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message === null || typeof message !== "object") return;
      switch (message.type) {
        case "pong":
          client.missed = 0;
          break;
        case "hello":
          client.hello = {
            token: typeof message.token === "string" ? message.token : undefined,
            extensionId: String(message.extensionId ?? "").slice(0, 64),
            version: typeof message.version === "string" ? message.version.slice(0, 32) : undefined,
          };
          break;
        case "opened":
        case "declined": {
          const pending = this.#pending.get(String(message.id));
          if (!pending) break;
          if (message.type === "opened") {
            clearTimeout(pending.timer);
            this.#pending.delete(String(message.id));
            pending.resolve({
              windowId: typeof message.windowId === "number" ? message.windowId : undefined,
              tabId: typeof message.tabId === "number" ? message.tabId : undefined,
            });
          } else if (--pending.left <= 0) {
            clearTimeout(pending.timer);
            this.#pending.delete(String(message.id));
            pending.reject(
              new BrokerError("declined", "extension declined to open the connect page"),
            );
          }
          break;
        }
        case "log":
          this.#log(
            `ext ${String(message.line)
              .replace(/[\r\n]+/g, " | ")
              .slice(0, 500)}`,
          );
          break;
        default:
          break;
      }
    });
  }

  async instances(): Promise<ExtensionInstance[]> {
    return [...this.#clients]
      .filter((c) => c.hello)
      .map((c) => ({
        extensionId: c.hello!.extensionId,
        version: c.hello!.version,
        hasToken: Boolean(c.hello!.token),
      }));
  }

  async hasInstance(token: string): Promise<boolean> {
    requireToken(token);
    return [...this.#clients].some((c) => c.hello?.token === token);
  }

  /** Tokens are only handed to the local setup command, never over any network surface. */
  tokensForSetup(): { extensionId: string; token: string }[] {
    return [...this.#clients]
      .filter((c) => c.hello?.token)
      .map((c) => ({ extensionId: c.hello!.extensionId, token: c.hello!.token! }));
  }

  async open(request: OpenRequest, timeoutMs = 4000): Promise<OpenResult> {
    requireToken(request.token);
    const targets = [...this.#clients].filter((c) => c.hello?.token === request.token);
    if (targets.length === 0)
      throw new BrokerError("no_instance", "no extension instance with that token is connected");
    const id = randomUUID();
    return await new Promise<OpenResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrokerError("timeout", "extension did not answer"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, left: targets.length });
      for (const client of targets) {
        client.socket.send(
          JSON.stringify({
            type: "open",
            id,
            url: request.url,
            token: request.token,
            minimized: request.minimized === true,
            bounds: request.bounds,
            name: request.name,
            app: false,
          }),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.#ping) clearInterval(this.#ping);
    for (const client of this.#clients) client.socket.terminate();
    this.#wss?.close();
    await new Promise<void>((resolve) =>
      this.#server ? this.#server.close(() => resolve()) : resolve(),
    );
    this.#server = null;
  }
}

/** Is something already listening on the broker port? */
export async function portInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
