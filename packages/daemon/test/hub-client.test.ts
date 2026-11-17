import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createHubClient } from "../src/hub-client.ts";
import type { HubClientDeps } from "../src/interfaces.ts";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log };
  const deps = {
    log,
    config: { hub_url: "https://hub.example.com", device_id: "dev-1" },
    paths: {},
    getPresence: async () => ({}),
    onCall() {},
    onUpdateHint() {},
  } as unknown as HubClientDeps;
  const client = createHubClient(deps, {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    key: { sign: () => "sig" } as never,
    random: () => 0,
  });
  const welcome = (socket: FakeSocket): void => {
    socket.emit("message", Buffer.from(JSON.stringify({ type: "welcome", protocol: 1 })), false);
  };
  return { client, sockets, welcome };
}

const result = (id: string) =>
  ({ type: "result", id, ok: true, duration_ms: 1, data: {} }) as never;
const results = (socket: FakeSocket): string[] =>
  socket.sent.filter((s) => s.includes('"type":"result"')).map((s) => JSON.parse(s).id as string);

describe("hub client result delivery", () => {
  test("a result written into a dying connection goes out again after the next welcome", () => {
    vi.useFakeTimers();
    try {
      const { client, sockets, welcome } = setup();
      client.start();
      welcome(sockets[0]!);
      expect(client.sendResult(result("call-1"))).toBe(true);
      expect(results(sockets[0]!)).toEqual(["call-1"]);

      // The connection dies; a result produced while it is down is not sent yet.
      sockets[0]!.readyState = 3;
      sockets[0]!.emit("close", 1006, Buffer.from(""));
      expect(client.sendResult(result("call-2"))).toBe(false);

      vi.advanceTimersByTime(2000);
      expect(sockets).toHaveLength(2);
      expect(results(sockets[1]!)).toEqual([]);
      welcome(sockets[1]!);
      expect(results(sockets[1]!)).toEqual(["call-1", "call-2"]);
      void client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("old results are not repeated", () => {
    vi.useFakeTimers();
    try {
      const { client, sockets, welcome } = setup();
      client.start();
      welcome(sockets[0]!);
      client.sendResult(result("old"));
      vi.advanceTimersByTime(241_000);
      sockets[0]!.readyState = 3;
      sockets[0]!.emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(2000);
      welcome(sockets.at(-1)!);
      expect(results(sockets.at(-1)!)).toEqual([]);
      void client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
