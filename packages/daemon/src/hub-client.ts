import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  authTranscript,
  hubMessage,
  type DaemonResult,
  type Presence,
} from "@rainforest/core";
import type { HubClient, HubClientDeps, HubClientFactory } from "./interfaces.ts";
import { loadDeviceKey, type DeviceKey } from "./keys.ts";

/**
 * One outbound WebSocket to the hub. The hub sends a nonce; we answer with an Ed25519
 * signature over (nonce, device id, protocol version). Nothing is trusted from the hub
 * beyond the typed messages of the wire protocol: tool arguments are validated again by
 * the supervisor and the rails are enforced locally whatever the hub sends.
 */

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 75_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const MAX_FRAME_BYTES = 256 * 1024;

export function hubWebSocketUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol !== "https:") throw new Error("hub_url must be https");
  url.protocol = "wss:";
  url.pathname = "/devices/ws";
  url.search = "";
  return url.toString();
}

export interface HubClientOptions {
  /** Test seams. */
  createSocket?: (url: string) => WebSocket;
  key?: DeviceKey;
  random?: () => number;
}

export function createHubClient(deps: HubClientDeps, options: HubClientOptions = {}): HubClient {
  const log = deps.log.child({ part: "hub" });
  const url = hubWebSocketUrl(deps.config.hub_url);
  const random = options.random ?? Math.random;
  let socket: WebSocket | null = null;
  let connected = false;
  let stopped = true;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let lastPong = 0;

  const send = (message: unknown): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const setConnected = (value: boolean): void => {
    if (connected === value) return;
    connected = value;
    deps.onConnectionChange?.(value);
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, backoff) * (0.5 + random() * 0.5);
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const cleanup = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    setConnected(false);
    socket = null;
  };

  const connect = (): void => {
    if (stopped) return;
    const key = options.key ?? loadDeviceKey(deps.paths);
    if (!key) {
      log.error("no device key: run `rainforestd pair` first");
      scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = options.createSocket
        ? options.createSocket(url)
        : new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, handshakeTimeout: 20_000 });
    } catch (error) {
      log.warn("hub connect failed", { error: String((error as Error).message) });
      scheduleReconnect();
      return;
    }
    socket = ws;
    lastPong = Date.now();

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const text = raw.toString();
      if (text === "pong") {
        lastPong = Date.now();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const message = hubMessage.safeParse(parsed);
      if (!message.success) {
        log.warn("ignoring an unrecognized hub message");
        return;
      }
      const msg = message.data;
      switch (msg.type) {
        case "challenge":
          void deps
            .getPresence()
            .then((presence) => {
              send({
                type: "auth",
                device_id: deps.config.device_id,
                protocol: PROTOCOL_VERSION,
                signature: key.sign(
                  authTranscript(msg.nonce, deps.config.device_id, PROTOCOL_VERSION),
                ),
                presence,
              });
            })
            .catch((error: unknown) =>
              log.error("could not answer the challenge", { error: String(error) }),
            );
          break;
        case "welcome":
          backoff = BACKOFF_MIN_MS;
          setConnected(true);
          log.info("connected to the hub");
          deps.onWelcome?.({ protocol: msg.protocol, min_daemon_version: msg.min_daemon_version });
          break;
        case "call":
          // Only an authenticated, welcomed connection may deliver calls.
          if (connected) deps.onCall(msg);
          break;
        case "update_hint":
          deps.onUpdateHint();
          break;
      }
    });
    ws.on("open", () => {
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          log.warn("hub went silent; reconnecting");
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_INTERVAL_MS);
    });
    ws.on("close", (code, reason) => {
      const why = reason.toString().slice(0, 80);
      if (socket === ws) cleanup();
      if (code === 4001 || why === "daemon_outdated") deps.onUpdateHint();
      if (code !== 4000) log.info("hub connection closed", { code, why });
      // 4000 = replaced by a newer connection of this same device: back off, do not fight.
      if (code === 4000) backoff = BACKOFF_MAX_MS;
      scheduleReconnect();
    });
    ws.on("error", (error) => {
      log.debug("hub socket error", { error: String(error.message) });
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const ws = socket;
      cleanup();
      ws?.close(1000, "shutdown");
    },
    sendResult: (result: DaemonResult) => connected && send(result),
    sendPresence: (presence: Presence) => connected && send({ type: "presence", presence }),
    isConnected: () => connected,
  };
}

export const hubClientFactory: HubClientFactory = (deps) => createHubClient(deps);
