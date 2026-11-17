import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { BrokerError, EmbeddedBroker, isAllowedOrigin } from "../src/broker.ts";

const EXT = "a".repeat(32);
const TOKEN = "t".repeat(24);
let broker: EmbeddedBroker | null = null;

afterEach(async () => {
  await broker?.close();
  broker = null;
});

async function start(): Promise<EmbeddedBroker> {
  broker = new EmbeddedBroker({ port: 0, allowedExtensionIds: [EXT], pingIntervalMs: 20 });
  await broker.listen();
  return broker;
}

function connect(port: number, origin: string | undefined, path = "/ext"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

test("origin allowlist", () => {
  expect(isAllowedOrigin(`chrome-extension://${EXT}`, [EXT])).toBe(true);
  expect(isAllowedOrigin(`chrome-extension://${"b".repeat(32)}`, [EXT])).toBe(false);
  expect(isAllowedOrigin(`chrome-extension://${EXT}/`, [EXT])).toBe(false);
  expect(isAllowedOrigin("https://www.example.com", [EXT])).toBe(false);
  expect(isAllowedOrigin(undefined, [EXT])).toBe(false);
  expect(isAllowedOrigin(`chrome-extension://${EXT}`, [])).toBe(false);
});

test("refuses upgrades from other origins, other paths and plain HTTP", async () => {
  const b = await start();
  await expect(connect(b.port, "https://www.example.com")).rejects.toThrow();
  await expect(connect(b.port, undefined)).rejects.toThrow();
  await expect(connect(b.port, `chrome-extension://${EXT}`, "/other")).rejects.toThrow();
  for (const path of ["/status", "/open", "/"]) {
    const res = await fetch(`http://127.0.0.1:${b.port}${path}`, {
      method: path === "/open" ? "POST" : "GET",
    });
    expect(res.status).toBe(404);
  }
});

test("routes an open only to the instance holding the token", async () => {
  const b = await start();
  const ws = await connect(b.port, `chrome-extension://${EXT}`);
  const other = await connect(b.port, `chrome-extension://${EXT}`);
  ws.send(JSON.stringify({ type: "hello", token: TOKEN, extensionId: EXT, version: "1" }));
  other.send(
    JSON.stringify({ type: "hello", token: "o".repeat(24), extensionId: EXT, version: "1" }),
  );
  let otherGotOpen = false;
  other.on("message", (raw) => {
    if (JSON.parse(String(raw)).type === "open") otherGotOpen = true;
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "open") {
      expect(m.app).toBe(false);
      expect(m.token).toBe(TOKEN);
      ws.send(JSON.stringify({ type: "opened", id: m.id, windowId: 7, tabId: 8 }));
    }
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(await b.hasInstance(TOKEN)).toBe(true);
  expect(await b.instances()).toHaveLength(2);
  const result = await b.open({ url: "chrome-extension://x/connect.html", token: TOKEN });
  expect(result).toEqual({ windowId: 7, tabId: 8 });
  expect(otherGotOpen).toBe(false);
});

test("an open without a token or for an unknown token is refused", async () => {
  const b = await start();
  await expect(b.open({ url: "x", token: "" })).rejects.toBeInstanceOf(BrokerError);
  await expect(b.open({ url: "x", token: "z".repeat(24) })).rejects.toMatchObject({
    code: "no_instance",
  });
});

test("a declined open rejects and a silent client is dropped", async () => {
  const b = await start();
  const ws = await connect(b.port, `chrome-extension://${EXT}`);
  ws.send(JSON.stringify({ type: "hello", token: TOKEN, extensionId: EXT }));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === "open") ws.send(JSON.stringify({ type: "declined", id: m.id, reason: "no" }));
  });
  await new Promise((r) => setTimeout(r, 10));
  await expect(b.open({ url: "x", token: TOKEN })).rejects.toMatchObject({ code: "declined" });
  // Never answers pings: dropped after two missed pongs.
  await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await new Promise((r) => setTimeout(r, 30));
  expect(await b.instances()).toHaveLength(0);
});
