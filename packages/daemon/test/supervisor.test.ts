import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RfError } from "@rainforest/core";
import { join } from "node:path";
import { createAudit } from "../src/audit.ts";
import { createLogger, nullLogger } from "../src/log.ts";
import { createSupervisor } from "../src/supervisor.ts";
import { RESTART_EXIT_CODE } from "../src/version.ts";
import { call, fakeServices, presence, sampleConfig } from "./fakes.ts";
import { tmpDir } from "./helpers.ts";

// The presence interval keeps the process alive on purpose, so every supervisor is stopped.
const created: Array<ReturnType<typeof createSupervisor>> = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((s) => s.stop()));
});

function setup(config = sampleConfig({ idle_detach_s: 0 }), log = nullLogger()) {
  const services = fakeServices();
  const file = join(tmpDir(), "audit.jsonl");
  const audit = createAudit({ file });
  const getPresence = vi.fn(async () => presence());
  const supervisor = createSupervisor({
    config,
    paths: {} as never,
    log,
    audit,
    services,
    getPresence,
    version: "0.0.0",
    presenceIntervalMs: 45_000,
  });
  created.push(supervisor);
  return { services, audit, supervisor, getPresence, hub: services.hub };
}

describe("supervisor call handling", () => {
  test("a valid read call is routed with parsed args and its result is sent", async () => {
    const { supervisor, services, hub, audit } = setup();
    await supervisor.start();
    services.router.handler = async () => ({ data: { items: [1, 2] } });
    await supervisor.handleCall(call({ tool: "get_cart", args: { max_chars: 5000 } }));
    expect(services.router.calls).toEqual([{ tool: "get_cart", args: { max_chars: 5000 } }]);
    expect(hub.results).toHaveLength(1);
    expect(hub.results[0]).toMatchObject({
      type: "result",
      id: "call-0001",
      ok: true,
      data: { items: [1, 2] },
    });
    expect(hub.results[0]?.error).toBeUndefined();
    const row = audit.recent(1)[0];
    expect(row).toMatchObject({ tool: "get_cart", outcome: "ok" });
    expect(row).not.toHaveProperty("args");
  });

  test("an unknown tool is rejected with a structured error and never routed", async () => {
    const { supervisor, services, hub, audit } = setup();
    await supervisor.start();
    await supervisor.handleCall(call({ tool: "place_order", args: { x: 1 } }));
    expect(services.router.calls).toEqual([]);
    expect(hub.results[0]).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(audit.recent(1)[0]).toMatchObject({
      tool: "place_order",
      outcome: "error",
      error_code: "unsupported",
    });
    expect(audit.recent(1)[0]).not.toHaveProperty("args");
  });

  test("hub-kind tools are rejected", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    await supervisor.handleCall(call({ tool: "list_browsers" }));
    expect(services.router.calls).toEqual([]);
    expect(hub.results[0]).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  test("invalid arguments are rejected with invalid_arguments and no value echo", async () => {
    const { supervisor, services, hub, audit } = setup();
    await supervisor.start();
    await supervisor.handleCall(
      call({ tool: "add_to_list", args: { list_id: "lowercase-secret", asin: "B0FAKE0001" } }),
    );
    expect(services.router.calls).toEqual([]);
    const result = hub.results[0];
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    const text = JSON.stringify(result);
    expect(text).toContain("list_id");
    expect(text).not.toContain("lowercase-secret");
    // Unvalidated arguments are never audited, even for a write tool.
    expect(audit.recent(1)[0]).toMatchObject({ error_code: "invalid_arguments" });
    expect(audit.recent(1)[0]).not.toHaveProperty("args");
  });

  test("a valid write call is audited with its (validated) args", async () => {
    const { supervisor, hub, audit } = setup();
    await supervisor.start();
    await supervisor.handleCall(
      call({ tool: "add_to_list", args: { list_id: "ABCDEFGH12", asin: "B0FAKE0001" } }),
    );
    expect(hub.results[0]).toMatchObject({ ok: true });
    expect(audit.recent(1)[0]).toMatchObject({
      tool: "add_to_list",
      outcome: "ok",
      args: { list_id: "ABCDEFGH12", asin: "B0FAKE0001" },
    });
  });

  test("RfError from the router becomes the error payload", async () => {
    const { supervisor, services, hub, audit } = setup();
    await supervisor.start();
    services.router.handler = async () => {
      throw new RfError("throttled", "slow down", { retry_after_s: 30 });
    };
    await supervisor.handleCall(call({ tool: "search", args: { query: "invented widget" } }));
    expect(hub.results[0]).toMatchObject({
      ok: false,
      error: { code: "throttled", message: "slow down", retry_after_s: 30 },
    });
    const row = audit.recent(1)[0];
    expect(row).toMatchObject({ outcome: "error", error_code: "throttled" });
    expect(JSON.stringify(row)).not.toContain("invented widget");
  });

  test("a paced tool's result carries the pacing left, and presence follows at once", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.browser.pacingSummary = () => ({ loads_left: 2, next_free_in_s: 540 });
    await supervisor.handleCall(call({ tool: "search", args: { query: "invented widget" } }));
    expect(hub.results[0]).toMatchObject({
      ok: true,
      pacing: { loads_left: 2, next_free_in_s: 540 },
    });
    await vi.waitFor(() => expect(hub.presences).toHaveLength(1));
  });

  test("a refusal carries the pacing left too", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.browser.pacingSummary = () => ({ loads_left: 0, next_free_in_s: 546 });
    services.router.handler = async () => {
      throw new RfError("throttled", "wait", { retry_after_s: 575 });
    };
    await supervisor.handleCall(call({ tool: "get_cart" }));
    expect(hub.results[0]).toMatchObject({
      ok: false,
      error: { code: "throttled", retry_after_s: 575 },
      pacing: { loads_left: 0, next_free_in_s: 546 },
    });
  });

  test("an unpaced tool, or a browser that reports no summary, sends no pacing", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    await supervisor.handleCall(call({ tool: "get_cart" }));
    expect(hub.results[0]).not.toHaveProperty("pacing");
    services.browser.pacingSummary = () => ({ loads_left: 6 });
    await supervisor.handleCall(
      call({ id: "call-0002", tool: "show_on_screen", args: { target: { type: "cart" } } }),
    );
    expect(hub.results[1]).toMatchObject({ ok: true });
    expect(hub.results[1]).not.toHaveProperty("pacing");
    expect(hub.presences).toHaveLength(0);
  });

  test("a failing pacing summary does not fail the call", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.browser.pacingSummary = () => {
      throw new Error("boom");
    };
    await supervisor.handleCall(call({ tool: "get_cart" }));
    expect(hub.results[0]).toMatchObject({ ok: true });
    expect(hub.results[0]).not.toHaveProperty("pacing");
  });

  test("every call leaves one log line; a failed one also leaves what the browser did", async () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({ sink: (line) => lines.push(JSON.parse(line)) });
    const { supervisor, services } = setup(sampleConfig({ idle_detach_s: 0 }), log);
    await supervisor.start();
    services.browser.pacingSummary = () => ({ loads_left: 3 });
    const asked: number[] = [];
    services.browser.trace = (sinceMs) => {
      asked.push(sinceMs);
      return ["18:00:01.000 goto product /dp/B0FAKE0001", "18:00:02.000 landed /dp/B0FAKE0001"];
    };
    await supervisor.handleCall(call({ tool: "search", args: { query: "invented widget" } }));
    services.router.handler = async () => {
      throw new RfError("layout_unrecognized", "the all-offers panel did not open", {
        details: { page: { visibility: "hidden", add_controls: 0 } },
      });
    };
    await supervisor.handleCall(call({ id: "call-0002", tool: "get_cart" }));
    const calls = lines.filter((l) => l.msg === "call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      id: "call-0001",
      tool: "search",
      outcome: "ok",
      loads_left: 3,
      level: "info",
    });
    expect(calls[0]).not.toHaveProperty("error_code");
    expect(calls[1]).toMatchObject({
      id: "call-0002",
      tool: "get_cart",
      outcome: "error",
      error_code: "layout_unrecognized",
      error_message: "the all-offers panel did not open",
      error_details: JSON.stringify({ page: { visibility: "hidden", add_controls: 0 } }),
    });
    // The trace is logged for the failed call only, and only from that call's start.
    const traces = lines.filter((l) => l.msg === "call trace");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      id: "call-0002",
      tool: "get_cart",
      trace: ["18:00:01.000 goto product /dp/B0FAKE0001", "18:00:02.000 landed /dp/B0FAKE0001"],
    });
    expect(asked).toHaveLength(1);
    // What was searched for never reaches the log.
    expect(JSON.stringify(lines)).not.toContain("invented widget");
  });

  test("an unexpected error becomes internal without leaking its message", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.router.handler = async () => {
      throw new Error("path /home/someone/leak");
    };
    await supervisor.handleCall(call({ tool: "get_cart" }));
    expect(hub.results[0]).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify(hub.results[0])).not.toContain("leak");
  });

  test("a call that outlives its deadline fails with timeout and aborts the signal", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    let signal: AbortSignal | undefined;
    services.router.handler = (_t, _a, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    };
    await supervisor.handleCall(call({ tool: "get_cart", deadline_ms: 20 }));
    expect(hub.results[0]).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(signal?.aborted).toBe(true);
  });

  test("the daemon-side deadline is capped at CALL_DEADLINE_MS", async () => {
    const { supervisor, services } = setup();
    await supervisor.start();
    let seen = 0;
    services.router.handler = async (_t, _a, ctx) => {
      seen = ctx.deadline_ms;
      return {};
    };
    await supervisor.handleCall(call({ tool: "get_cart", deadline_ms: 9_999_999 }));
    expect(seen).toBe(225_000);
  });

  test("an oversized result frame is replaced by an internal error", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.router.handler = async () => ({
      images: [{ mime_type: "image/png", data_base64: "A".repeat(1_500_001) }],
    });
    await supervisor.handleCall(call({ tool: "get_media", args: { asin: "B0FAKE0001" } }));
    expect(hub.results[0]).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  test("a dropped result (hub disconnected) does not throw", async () => {
    const { supervisor, hub, audit } = setup();
    await supervisor.start();
    hub.connected = false;
    await expect(supervisor.handleCall(call({ tool: "get_cart" }))).resolves.toBeUndefined();
    expect(audit.recent(1)).toHaveLength(1);
  });

  test("calls arriving through the hub client reach the router", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    hub.deps.onCall(call({ tool: "get_cart" }));
    await vi.waitFor(() => expect(hub.results).toHaveLength(1));
    expect(services.router.calls[0]?.tool).toBe("get_cart");
  });
});

describe("supervisor lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("start wires every component; stop shuts them down and resolves done(0)", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    expect(hub.started).toBe(true);
    expect(services.updater.started).toBe(true);
    expect(services.browser.start).toHaveBeenCalled();
    await supervisor.stop();
    expect(hub.stopped).toBe(true);
    expect(services.browser.stop).toHaveBeenCalled();
    await expect(supervisor.done).resolves.toBe(0);
  });

  test("sends presence every 45 seconds while connected", async () => {
    const { supervisor, hub, getPresence } = setup();
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(hub.presences).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.presences).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(hub.presences).toHaveLength(3);
    hub.connected = false;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(hub.presences).toHaveLength(3);
    expect(getPresence).toHaveBeenCalledTimes(3);
    await supervisor.stop();
  });

  test("an update hint triggers a check; a restart-requiring update exits with the restart code", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    services.updater.checkNow.mockResolvedValueOnce({
      status: "updated",
      from: "0.1.0",
      to: "0.2.0",
      restart_required: true,
    });
    hub.deps.onUpdateHint();
    await expect(supervisor.done).resolves.toBe(RESTART_EXIT_CODE);
    expect(services.updater.checkNow).toHaveBeenCalledWith("hint");
    expect(hub.stopped).toBe(true);
  });

  test("an up-to-date hint does not restart", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    hub.deps.onUpdateHint();
    await vi.advanceTimersByTimeAsync(10);
    expect(services.updater.checkNow).toHaveBeenCalledTimes(1);
    expect(hub.stopped).toBe(false);
    await supervisor.stop();
  });

  test("a hub that requires a newer daemon triggers an update check", async () => {
    const { supervisor, services, hub } = setup();
    await supervisor.start();
    hub.deps.onWelcome?.({ protocol: 1, min_daemon_version: "9.0.0" });
    await vi.advanceTimersByTimeAsync(10);
    expect(services.updater.checkNow).toHaveBeenCalledWith("hint");
    services.updater.checkNow.mockClear();
    hub.deps.onWelcome?.({ protocol: 1, min_daemon_version: "0.0.0" });
    await vi.advanceTimersByTimeAsync(10);
    expect(services.updater.checkNow).not.toHaveBeenCalled();
    await supervisor.stop();
  });

  test("the browser detaches after idle_detach_s without calls", async () => {
    const { supervisor, services } = setup(sampleConfig({ idle_detach_s: 120 }));
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(services.browser.detach).not.toHaveBeenCalled();
    // Activity resets the idle clock.
    await supervisor.handleCall(call({ tool: "get_cart" }));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(services.browser.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(services.browser.detach).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });

  test("a browser start failure does not stop the daemon", async () => {
    const { supervisor, services, hub } = setup();
    services.browser.start.mockRejectedValueOnce(new Error("no chrome"));
    await supervisor.start();
    expect(hub.started).toBe(true);
    await supervisor.stop();
  });
});
