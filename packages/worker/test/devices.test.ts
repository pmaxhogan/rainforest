import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_VERSION } from "@rainforest/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authFrame,
  closeAllSockets,
  connectDevice,
  freshIp,
  hubStub,
  makeDeviceKey,
  openSocket,
  pairDevice,
  pairStart,
  pairStatus,
  presence,
  request,
  sign,
  useFreshIp,
} from "./helpers.ts";
import { pairStatusTranscript } from "../src/hub.ts";

beforeEach(() => {
  useFreshIp();
});

afterEach(async () => {
  closeAllSockets();
  vi.useRealTimers();
  await reset();
});

describe("/pair/start", () => {
  it("starts a pairing with a 32-byte key and a valid name", async () => {
    const key = await makeDeviceKey();
    const response = await pairStart({ public_key: key.publicKey, name: "Desk Mac", os: "macos" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.device_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });

  it("rejects keys that are not 32 bytes", async () => {
    const key = await makeDeviceKey();
    const short = key.publicKey.slice(0, 42); // 31 bytes
    const long = `${key.publicKey}AAAA`; // 35 bytes, still within the length bound
    for (const public_key of [short, long, "!".repeat(43), "A".repeat(39)]) {
      const response = await pairStart({ public_key, name: "Desk Mac", os: "macos" }, freshIp());
      expect(response.status, public_key).toBe(400);
    }
  });

  it("rejects bad names and os values", async () => {
    const key = await makeDeviceKey();
    for (const [name, os] of [
      ["<script>", "macos"],
      ["a<b", "macos"],
      ["a>b", "macos"],
      ['say "hi"', "macos"],
      ["semi;colon", "macos"],
      ["   ", "macos"],
      ["", "macos"],
      ["x".repeat(61), "macos"],
      ["Desk Mac", "Mac OS"],
      ["Desk Mac", "MACOS"],
      ["Desk Mac", ""],
    ]) {
      const response = await pairStart({ public_key: key.publicKey, name, os }, freshIp());
      expect(response.status, `${name}/${os}`).toBe(400);
    }
  });

  it("rejects non-JSON and non-POST", async () => {
    expect((await request("/pair/start")).status).toBe(405);
    const response = await request("/pair/start", { method: "POST", body: "nope" });
    expect(response.status).toBe(400);
  });

  it("caps pending pairings at 5", async () => {
    for (let i = 0; i < 5; i++) {
      const key = await makeDeviceKey();
      const response = await pairStart(
        { public_key: key.publicKey, name: `Box ${i}`, os: "linux" },
        freshIp(),
      );
      expect(response.status).toBe(200);
    }
    const key = await makeDeviceKey();
    const sixth = await pairStart(
      { public_key: key.publicKey, name: "Box 6", os: "linux" },
      freshIp(),
    );
    expect(sixth.status).toBe(400);
    expect(await sixth.json()).toMatchObject({ ok: false, error: "too many pending pairings" });
  });

  it("refuses to pair a key that is already an active device", async () => {
    const device = await pairDevice("Desk Mac");
    const again = await pairStart(
      { public_key: device.key.publicKey, name: "Again", os: "macos" },
      freshIp(),
    );
    expect(again.status).toBe(400);
  });

  // BUG (hub.ts pairStart): only active devices are checked, so one key can hold several
  // pending pairings and both can be approved, giving two device ids for one key.
  it.fails("refuses a second pending pairing for the same key", async () => {
    const key = await makeDeviceKey();
    const first = await pairStart(
      { public_key: key.publicKey, name: "One", os: "macos" },
      freshIp(),
    );
    expect(first.status).toBe(200);
    const second = await pairStart(
      { public_key: key.publicKey, name: "Two", os: "macos" },
      freshIp(),
    );
    expect(second.status).toBe(400);
  });

  it("is rate limited per IP", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const response = await pairStart({ public_key: "x", name: "n", os: "o" }, ip);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe("/pair/status", () => {
  it("reports pending, then approved, only to the holder of the key", async () => {
    const key = await makeDeviceKey();
    const start = (await (
      await pairStart({ public_key: key.publicKey, name: "Desk Mac", os: "macos" })
    ).json()) as { device_id: string; code: string };
    expect(await (await pairStatus(key, start.device_id)).json()).toEqual({ status: "pending" });

    const other = await makeDeviceKey();
    expect(await (await pairStatus(other, start.device_id)).json()).toEqual({ status: "unknown" });

    expect(await hubStub().approvePairing(start.code.toLowerCase())).toBe(true);
    expect(await (await pairStatus(key, start.device_id)).json()).toEqual({ status: "approved" });
  });

  it("requires a fresh timestamp", async () => {
    const key = await makeDeviceKey();
    const start = (await (
      await pairStart({ public_key: key.publicKey, name: "Desk Mac", os: "macos" })
    ).json()) as { device_id: string };
    const stale = Date.now() - 6 * 60_000;
    expect(await (await pairStatus(key, start.device_id, stale)).json()).toEqual({
      status: "unknown",
    });
    const future = Date.now() + 6 * 60_000;
    expect(await (await pairStatus(key, start.device_id, future)).json()).toEqual({
      status: "unknown",
    });
  });

  it("refuses a signature over a different timestamp", async () => {
    const key = await makeDeviceKey();
    const start = (await (
      await pairStart({ public_key: key.publicKey, name: "Desk Mac", os: "macos" })
    ).json()) as { device_id: string };
    const now = Date.now();
    const response = await request("/pair/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: start.device_id,
        timestamp: now,
        signature: await sign(key, pairStatusTranscript(start.device_id, now - 1000)),
      }),
    });
    expect(await response.json()).toEqual({ status: "unknown" });
  });

  it("validates the body shape", async () => {
    for (const body of [{}, { device_id: "not-a-uuid", timestamp: 1, signature: "x".repeat(86) }]) {
      const response = await request("/pair/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it("reports rejected and expired pairings", async () => {
    const key = await makeDeviceKey();
    const start = (await (
      await pairStart({ public_key: key.publicKey, name: "Desk Mac", os: "macos" })
    ).json()) as { device_id: string; code: string };
    await hubStub().rejectPairing(start.code);
    expect(await (await pairStatus(key, start.device_id)).json()).toEqual({ status: "rejected" });
    expect(await hubStub().approvePairing(start.code)).toBe(false);

    const key2 = await makeDeviceKey();
    const start2 = (await (
      await pairStart({ public_key: key2.publicKey, name: "Old Box", os: "linux" }, freshIp())
    ).json()) as { device_id: string; code: string };
    await runInDurableObject(hubStub(), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE pairings SET expires_at = ? WHERE device_id = ?",
        Date.now() - 1,
        start2.device_id,
      );
    });
    expect(await (await pairStatus(key2, start2.device_id)).json()).toEqual({ status: "expired" });
    expect(await hubStub().approvePairing(start2.code)).toBe(false);
  });
});

describe("device WebSocket authentication", () => {
  it("challenge -> signed auth -> welcome", async () => {
    const device = await pairDevice("Desk Mac");
    const { socket, nonce } = await openSocket();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    socket.send(await authFrame(device, nonce));
    const welcome = await socket.next();
    expect(welcome).toMatchObject({ type: "welcome", protocol: PROTOCOL_VERSION });
    const browsers = await hubStub().listBrowsers("grant-key-000000001");
    expect(browsers[0]).toMatchObject({ id: device.deviceId, online: true });
  });

  it("each socket gets a different nonce", async () => {
    const a = await openSocket();
    const b = await openSocket();
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("refuses a bad signature", async () => {
    const device = await pairDevice("Desk Mac");
    const { socket, nonce } = await openSocket();
    const frame = await authFrame(device, nonce);
    const sig = frame.signature as string;
    frame.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    socket.send(frame);
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "unauthorized" });
  });

  it("refuses a signature by another key", async () => {
    const device = await pairDevice("Desk Mac");
    const { socket, nonce } = await openSocket();
    socket.send(await authFrame({ ...device, key: await makeDeviceKey() }, nonce));
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "unauthorized" });
  });

  it("refuses a signature over another socket's nonce (replay)", async () => {
    const device = await pairDevice("Desk Mac");
    const first = await openSocket();
    const second = await openSocket();
    second.socket.send(await authFrame(device, first.nonce));
    expect(await second.socket.closed).toMatchObject({ code: 1008, reason: "unauthorized" });
    // And a transcript captured from an authenticated socket cannot be reused either.
    const frame = await authFrame(device, first.nonce);
    first.socket.send(frame);
    expect((await first.socket.next()).type).toBe("welcome");
    const third = await openSocket();
    third.socket.send(frame);
    expect(await third.socket.closed).toMatchObject({ code: 1008 });
  });

  it("refuses a signature over a different protocol number", async () => {
    const device = await pairDevice("Desk Mac");
    const { socket, nonce } = await openSocket();
    const frame = await authFrame(device, nonce, { protocol: PROTOCOL_VERSION });
    frame.signature = (
      await authFrame(device, nonce, { protocol: PROTOCOL_VERSION + 5 })
    ).signature;
    socket.send(frame);
    expect(await socket.closed).toMatchObject({ code: 1008 });
  });

  it("refuses an unknown device", async () => {
    const device = await pairDevice("Desk Mac");
    const { socket, nonce } = await openSocket();
    socket.send(await authFrame(device, nonce, { deviceId: crypto.randomUUID() }));
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "unauthorized" });
  });

  it("refuses a pending (not yet approved) device", async () => {
    const key = await makeDeviceKey();
    const start = (await (
      await pairStart({ public_key: key.publicKey, name: "Pending", os: "macos" })
    ).json()) as { device_id: string };
    const { socket, nonce } = await openSocket();
    socket.send(await authFrame({ deviceId: start.device_id, key, name: "Pending" }, nonce));
    expect(await socket.closed).toMatchObject({ code: 1008 });
  });

  it("refuses a revoked device and closes its live socket on revoke", async () => {
    const device = await pairDevice("Desk Mac");
    const live = await connectDevice(device);
    await hubStub().revokeDevice(device.deviceId);
    expect(await live.closed).toMatchObject({ code: 1008, reason: "revoked" });
    const { socket, nonce } = await openSocket();
    socket.send(await authFrame(device, nonce));
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "unauthorized" });
    expect(await hubStub().listBrowsers("grant-key-000000001")).toEqual([]);
  });

  it("closes on a non-auth frame before auth", async () => {
    for (const frame of [
      { type: "presence", presence: presence() },
      { type: "result", id: "call-id-0001", ok: true, data: {}, duration_ms: 1 },
    ]) {
      const { socket } = await openSocket();
      socket.send(frame);
      expect(await socket.closed).toMatchObject({ code: 1008, reason: "authenticate first" });
    }
  });

  it("closes on malformed frames", async () => {
    for (const raw of [
      "not json",
      JSON.stringify({ type: "auth" }),
      JSON.stringify({ type: "nope" }),
    ]) {
      const { socket } = await openSocket();
      socket.send(raw);
      expect((await socket.closed).code).toBe(1008);
    }
    const { socket } = await openSocket();
    socket.ws.send(new Uint8Array([1, 2, 3]));
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "bad frame" });
  });

  it("closes an unauthenticated socket after the 10 s grace", async () => {
    const { socket } = await openSocket();
    // Not yet: the alarm runs early but the socket is still inside its grace.
    await runDurableObjectAlarm(hubStub());
    expect(await socket.closedWithin(200)).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_500);
    expect(await runDurableObjectAlarm(hubStub())).toBe(true);
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "authentication timeout" });
  });

  it("schedules the grace alarm on connect", async () => {
    await openSocket();
    const alarm = await runInDurableObject(hubStub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(10_500);
  });

  it("an authenticated socket survives the grace alarm", async () => {
    const device = await pairDevice("Desk Mac");
    const socket = await connectDevice(device);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    await runDurableObjectAlarm(hubStub());
    expect(await socket.closedWithin(200)).toBeNull();
  });

  it("a second connection for the same device replaces the first", async () => {
    const device = await pairDevice("Desk Mac");
    const first = await connectDevice(device);
    const second = await connectDevice(device);
    expect(await first.closed).toMatchObject({ code: 4000, reason: "replaced" });
    expect(await second.closedWithin(200)).toBeNull();
    const browsers = await hubStub().listBrowsers("grant-key-000000001");
    expect(browsers).toHaveLength(1);
    expect(browsers[0]!.online).toBe(true);
  });

  it("refuses a protocol that is too old or too new", async () => {
    const device = await pairDevice("Desk Mac");
    const old = await openSocket();
    old.socket.send(await authFrame(device, old.nonce, { protocol: 0 }));
    expect(await old.socket.closed).toMatchObject({ code: 4001, reason: "daemon_outdated" });
    const future = await openSocket();
    future.socket.send(await authFrame(device, future.nonce, { protocol: PROTOCOL_VERSION + 1 }));
    expect(await future.socket.closed).toMatchObject({ code: 4002, reason: "hub_outdated" });
  });

  it("answers ping with pong without authentication", async () => {
    const { socket } = await openSocket();
    socket.ws.send("ping");
    expect(await socket.next()).toEqual({ type: "raw", data: "pong" });
  });

  it("non-upgrade requests to /devices/ws are refused", async () => {
    expect((await request("/devices/ws")).status).toBe(426);
  });
});
