import type { DaemonResult, HubCall, ImageBlock, Presence, ToolDef } from "@rainforest/core";
import type { DaemonConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { Logger } from "./log.ts";
import type { AppPaths } from "./paths.ts";

/**
 * The narrow seams between the daemon shell and the security-critical parts (hub client
 * and device key, browser controller, policy rails and flows, updater). The shell codes
 * against these and `src/wiring.ts` is the ONE place that builds concrete instances, so
 * a real implementation drops in by replacing `createServices`.
 */

// ---- hub client (src/hub-client.ts, src/keys.ts) ------------------------------------

export interface HubWelcome {
  protocol: number;
  min_daemon_version?: string;
}

export interface HubClientDeps {
  config: DaemonConfig;
  paths: AppPaths;
  log: Logger;
  /** Called for the signed `auth` frame and whenever the client needs fresh presence. */
  getPresence(): Promise<Presence>;
  /** A validated-by-the-hub `call` frame. The client does not validate tool args. */
  onCall(call: HubCall): void;
  onUpdateHint(): void;
  onWelcome?(welcome: HubWelcome): void;
  onConnectionChange?(connected: boolean): void;
}

/** One outbound WebSocket to the hub with signed-challenge auth and reconnect. */
export interface HubClient {
  /** Begin connecting; reconnects with backoff until `stop`. Does not block. */
  start(): void;
  stop(): Promise<void>;
  /** Returns false when the frame could not be sent (not connected). */
  sendResult(result: DaemonResult): boolean;
  sendPresence(presence: Presence): boolean;
  isConnected(): boolean;
}

export type HubClientFactory = (deps: HubClientDeps) => HubClient;

// ---- browser controller (src/browser/*) ---------------------------------------------

export interface BrowserStatus {
  profile_connected: boolean;
  /** null = unknown (not checked yet). */
  amazon_signed_in: boolean | null;
  /** Epoch ms until which the rails refuse new Amazon page loads; null = not cooling down. */
  cooling_down_until: number | null;
  /** Remaining pacing budget per page type. */
  budget?: Record<string, { hour_left: number; day_left: number }>;
  /** The burst window and the loads still inside it (epoch ms). */
  burst?: { cap: number; window_s: number; used_at: number[] };
}

export interface BrowserController {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drop the debugging attachment after `idle_detach_s` without calls. Idempotent. */
  detach(): Promise<void>;
  status(): BrowserStatus;
  /** How many page loads fit right now, and when one more does. Sent with paced results. */
  pacingSummary?(): { loads_left: number; next_free_in_s?: number };
  /**
   * What the browser session did since `sinceMs` (navigations, refusals, captures), one
   * line each with a clock time. Paths only, never page content. Logged when a call fails.
   */
  trace?(sinceMs: number): string[];
}

// ---- tool router (rails + flows + browser, src/rails/*, src/flows/*) ----------------

export interface ToolContext {
  /** Call id from the hub, for correlation in logs only. */
  id: string;
  /** Absolute time budget for this call in ms (already capped at CALL_DEADLINE_MS). */
  deadline_ms: number;
  /** Aborted when the deadline passes or the daemon is shutting down. */
  signal: AbortSignal;
}

export interface ToolOutput {
  data?: unknown;
  images?: ImageBlock[];
}

/**
 * Executes ONE validated daemon tool (kind read or write). `args` already passed the core
 * registry schema. Failures are reported by throwing `RfError` from `@rainforest/core`;
 * anything else is mapped to `internal`. The router owns policy rails, pacing, flows and
 * the browser; the shell never sees page content.
 */
export interface ToolRouter {
  call(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

// ---- updater (src/updater/*) --------------------------------------------------------

export type UpdateTrigger = "schedule" | "hint" | "manual";

export type UpdateOutcome =
  | { status: "disabled" }
  | { status: "up_to_date"; version: string }
  | { status: "updated"; from: string; to: string; restart_required: boolean }
  | { status: "failed"; reason: string };

export interface Updater {
  /** Start the periodic check (config.update.check_interval_s). Does not block. */
  start(): void;
  stop(): void;
  /** Check once and, if a newer verified release exists, stage and switch to it. */
  checkNow(trigger: UpdateTrigger): Promise<UpdateOutcome>;
}

// ---- operator commands (pair, setup, doctor, capture) -------------------------------

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface SetupOptions {
  hub_url?: string;
  device_name?: string;
  aliases: string[];
  profile_directory?: string;
  extension_id?: string;
  user_data_dir?: string;
  executable_path?: string;
  update_repo?: string;
  broker_mode?: "external" | "embedded";
  broker_port?: number;
  non_interactive: boolean;
}

export interface PairOptions {
  /** One-time pairing code shown by the hub, when given on the command line. */
  code?: string;
}

export interface CaptureOptions {
  kind?: string;
  url?: string;
  out?: string;
}

/** Each returns a process exit code. */
export interface OperatorCommands {
  setup(options: SetupOptions, io: CliIo): Promise<number>;
  pair(options: PairOptions, io: CliIo): Promise<number>;
  doctor(options: { live: boolean }, io: CliIo): Promise<number>;
  capture(options: CaptureOptions, io: CliIo): Promise<number>;
  /** `rainforestd update [--check]` */
  update(options: { check_only: boolean }, io: CliIo): Promise<number>;
}

// ---- assembly -----------------------------------------------------------------------

export interface WiringDeps {
  paths: AppPaths;
  log: Logger;
  exec: Exec;
  version: string;
  /** Present for `run`; absent for operator commands that run without a config. */
  config?: DaemonConfig;
  /** The updater calls this after switching versions so the supervisor can exit cleanly. */
  requestRestart(reason: string): void;
}

export interface DaemonServices {
  hubClient: HubClientFactory;
  browser: BrowserController;
  router: ToolRouter;
  updater: Updater;
  commands: OperatorCommands;
}

/** The single seam: `src/wiring.ts` exports one of these. */
export type CreateServices = (deps: WiringDeps) => DaemonServices;
