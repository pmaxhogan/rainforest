import {
  CALL_DEADLINE_MS,
  RfError,
  compareVersions,
  daemonResult,
  getTool,
  toErrorPayload,
  type DaemonResult,
  type ErrorPayload,
  type HubCall,
  type ImageBlock,
  type Presence,
} from "@rainforest/core";
import type { Audit } from "./audit.ts";
import type { DaemonConfig } from "./config.ts";
import type { DaemonServices, HubClient, HubWelcome, UpdateOutcome } from "./interfaces.ts";
import type { Logger } from "./log.ts";
import type { AppPaths } from "./paths.ts";
import { RESTART_EXIT_CODE } from "./version.ts";

export const PRESENCE_INTERVAL_MS = 45_000;
const DRAIN_GRACE_MS = 5_000;

export interface SupervisorDeps {
  config: DaemonConfig;
  paths: AppPaths;
  log: Logger;
  audit: Audit;
  services: DaemonServices;
  getPresence: () => Promise<Presence>;
  version: string;
  now?: () => number;
  presenceIntervalMs?: number;
}

export interface Supervisor {
  /** Start every component. Does not block. */
  start(): Promise<void>;
  /** Graceful shutdown; resolves the `done` promise with `exitCode`. */
  stop(exitCode?: number): Promise<void>;
  /** Resolves with the process exit code once shut down. */
  readonly done: Promise<number>;
  /** Exposed for tests and for the hub client wiring. */
  handleCall(call: HubCall): Promise<void>;
  handleUpdateHint(): Promise<void>;
  requestRestart(reason: string): void;
}

interface Executed {
  ok: boolean;
  data?: unknown;
  images?: ImageBlock[];
  error?: ErrorPayload;
  /** Validated args, only when validation passed (the audit decides whether to keep them). */
  args?: Record<string, unknown>;
}

function zodIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): Array<{ path: string; message: string }> {
  // Paths and rule text only: never echo the supplied values back.
  return error.issues
    .slice(0, 10)
    .map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { config, log, audit, services } = deps;
  const now = deps.now ?? Date.now;
  const presenceIntervalMs = deps.presenceIntervalMs ?? PRESENCE_INTERVAL_MS;

  let hub: HubClient | null = null;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopAuditPruning: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  const inflight = new Map<string, AbortController>();
  const active = new Set<string>();
  const settled = new Set<Promise<void>>();

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  function scheduleIdleDetach(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (config.idle_detach_s <= 0 || stopping) return;
    idleTimer = setTimeout(() => {
      if (inflight.size > 0) return;
      services.browser.detach().catch((error: unknown) => {
        log.warn("idle detach failed", { error });
      });
    }, config.idle_detach_s * 1000);
    idleTimer.unref();
  }

  async function execute(call: HubCall): Promise<Executed> {
    const def = getTool(call.tool);
    if (!def) {
      return { ok: false, error: { code: "unsupported", message: "unknown tool" } };
    }
    if (def.kind === "hub") {
      return {
        ok: false,
        error: { code: "unsupported", message: "hub tool: not served by the daemon" },
      };
    }
    const parsed = def.input.safeParse(call.args);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "arguments do not match the tool schema",
          details: { issues: zodIssues(parsed.error) },
        },
      };
    }
    const args = parsed.data as Record<string, unknown>;
    const budget = Math.min(call.deadline_ms, CALL_DEADLINE_MS);
    const controller = new AbortController();
    inflight.set(call.id, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RfError("timeout", "the tool call exceeded its deadline"));
        }, budget);
      });
      const out = await Promise.race([
        services.router.call(def, args, {
          id: call.id,
          deadline_ms: budget,
          signal: controller.signal,
        }),
        timeout,
      ]);
      const executed: Executed = { ok: true, args };
      if (out.data !== undefined) executed.data = out.data;
      if (out.images !== undefined) executed.images = out.images;
      return executed;
    } catch (error) {
      if (!(error instanceof RfError)) log.error("tool call failed", { tool: call.tool, error });
      return { ok: false, error: toErrorPayload(error), args };
    } finally {
      if (timer) clearTimeout(timer);
      inflight.delete(call.id);
    }
  }

  async function handleCall(call: HubCall): Promise<void> {
    if (active.has(call.id)) {
      log.warn("duplicate call id ignored", { id: call.id });
      return;
    }
    active.add(call.id);
    const started = now();
    let executed: Executed;
    try {
      executed = await execute(call);
    } finally {
      active.delete(call.id);
    }
    const duration_ms = Math.max(0, now() - started);

    try {
      audit.record({
        tool: call.tool,
        outcome: executed.ok ? "ok" : "error",
        duration_ms,
        ...(executed.error ? { error_code: executed.error.code } : {}),
        ...(executed.args ? { args: executed.args } : {}),
      });
    } catch (error) {
      log.error("audit write failed", { error });
    }

    // Paced tools report the budget that is left, on success and on refusal alike, so
    // the caller can plan its next calls instead of finding the limit by hitting it.
    const def = getTool(call.tool);
    let pacing: DaemonResult["pacing"];
    if (def && def.kind !== "hub" && def.pacing !== undefined && def.pacing !== "none") {
      try {
        pacing = services.browser.pacingSummary?.();
      } catch (error) {
        log.warn("pacing summary failed", { error });
      }
    }
    const frame: DaemonResult = {
      type: "result",
      id: call.id,
      ok: executed.ok,
      duration_ms,
      ...(executed.ok && executed.data !== undefined ? { data: executed.data } : {}),
      ...(executed.ok && executed.images ? { images: executed.images } : {}),
      ...(executed.error ? { error: executed.error } : {}),
      ...(pacing ? { pacing } : {}),
    };
    let toSend = frame;
    const check = daemonResult.safeParse(frame);
    if (!check.success) {
      log.error("result frame failed validation", { tool: call.tool });
      toSend = {
        type: "result",
        id: call.id,
        ok: false,
        duration_ms,
        error: { code: "internal", message: "result could not be encoded" },
      };
    }
    const sent = hub?.sendResult(toSend) ?? false;
    if (!sent) log.warn("result dropped: hub not connected", { id: call.id, tool: call.tool });
    // The budget just changed: tell the hub now rather than at the next presence tick, so
    // get_status and list_browsers do not show a stale one.
    if (pacing) void sendPresenceNow();
    scheduleIdleDetach();
  }

  async function sendPresenceNow(): Promise<void> {
    if (!hub?.isConnected()) return;
    try {
      hub.sendPresence(await deps.getPresence());
    } catch (error) {
      log.warn("presence send failed", { error });
    }
  }

  function applyOutcome(outcome: UpdateOutcome): void {
    log.info("update check finished", { status: outcome.status });
    if (outcome.status === "updated" && outcome.restart_required) {
      requestRestart(`updated to ${outcome.to}`);
    }
  }

  async function handleUpdateHint(): Promise<void> {
    try {
      applyOutcome(await services.updater.checkNow("hint"));
    } catch (error) {
      log.error("update check failed", { error });
    }
  }

  function onWelcome(welcome: HubWelcome): void {
    log.info("hub welcome", { protocol: welcome.protocol });
    if (
      welcome.min_daemon_version !== undefined &&
      compareVersions(deps.version, welcome.min_daemon_version) < 0
    ) {
      log.warn("daemon is older than the hub requires", {
        min_daemon_version: welcome.min_daemon_version,
      });
      void handleUpdateHint();
    }
  }

  function track(promise: Promise<void>): void {
    settled.add(promise);
    void promise.finally(() => settled.delete(promise));
  }

  async function start(): Promise<void> {
    stopAuditPruning = audit.startPruning();
    try {
      await services.browser.start();
    } catch (error) {
      // Presence reports profile_connected=false; calls fail with a structured error.
      log.error("browser controller failed to start", { error });
    }
    services.updater.start();
    hub = services.hubClient({
      config,
      paths: deps.paths,
      log,
      getPresence: deps.getPresence,
      onCall: (call) => track(handleCall(call)),
      onUpdateHint: () => track(handleUpdateHint()),
      onWelcome,
      onConnectionChange: (connected) => {
        log.info(connected ? "hub connected" : "hub disconnected");
      },
    });
    hub.start();
    presenceTimer = setInterval(() => void sendPresenceNow(), presenceIntervalMs);
    // Deliberately NOT unref'd: this interval is what keeps the daemon process alive.
    scheduleIdleDetach();
    log.info("daemon started", { version: deps.version, device_id: config.device_id });
  }

  async function shutdown(exitCode: number): Promise<void> {
    if (presenceTimer) clearInterval(presenceTimer);
    if (idleTimer) clearTimeout(idleTimer);
    presenceTimer = null;
    idleTimer = null;
    services.updater.stop();
    if (settled.size > 0) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...settled]),
        new Promise((resolve) => {
          grace = setTimeout(resolve, DRAIN_GRACE_MS);
        }),
      ]);
      if (grace) clearTimeout(grace);
    }
    for (const controller of inflight.values()) controller.abort();
    await hub?.stop().catch((error: unknown) => log.warn("hub stop failed", { error }));
    await services.browser
      .stop()
      .catch((error: unknown) => log.warn("browser stop failed", { error }));
    stopAuditPruning?.();
    log.info("daemon stopped", { exit_code: exitCode });
    resolveDone(exitCode);
  }

  function stop(exitCode = 0): Promise<void> {
    stopping ??= shutdown(exitCode);
    return stopping;
  }

  function requestRestart(reason: string): void {
    log.info("restart requested", { reason });
    void stop(RESTART_EXIT_CODE);
  }

  return { start, stop, done, handleCall, handleUpdateHint, requestRestart };
}
