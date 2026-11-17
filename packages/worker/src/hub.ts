import { DurableObject } from "cloudflare:workers";
import {
  PROTOCOL_VERSION,
  MIN_PEER_PROTOCOL,
  authTranscript,
  compareVersions,
  daemonMessage,
  getTool,
  presenceSchema,
  type DaemonResult,
  type ErrorPayload,
  type Presence,
} from "@rainforest/core";
import type { Env } from "./env.ts";

/**
 * The Hub: one Durable Object holding the device registry, pairing, per-grant browser
 * selection, the audit log and the daemons' WebSockets (hibernatable).
 *
 * It never stores page content. Tool results pass through a short-lived `calls` row so a
 * waiting caller survives eviction of this object; the row is deleted when the result is
 * collected and swept shortly after its deadline otherwise.
 */

const AUTH_GRACE_MS = 10_000;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PENDING_PAIRINGS = 5;
const AUDIT_RETENTION_MS = 90 * 24 * 3600 * 1000;
const MAX_RESULT_CHARS = 1_800_000;
const PASSWORD_WINDOW_MS = 15 * 60_000;
const PASSWORD_MAX_FAILURES = 5;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface SocketState {
  nonce: string;
  authed: boolean;
  deviceId: string | null;
  connectedAt: number;
}

export interface BrowserRow {
  id: string;
  name: string;
  aliases: string[];
  os: string;
  online: boolean;
  last_seen: number | null;
  last_active: number | null;
  idle_s: number | null;
  locked: boolean | null;
  chrome_running: boolean | null;
  profile_connected: boolean | null;
  amazon_signed_in: boolean | null;
  cooling_down_until: number | null;
  daemon_version: string | null;
  selected: boolean;
}

export type StartCallResult =
  | { ok: true; callId: string; browser: { id: string; name: string; note?: string } }
  | { ok: false; error: ErrorPayload };

export type SelectResult =
  { ok: true; selected: BrowserRow | null } | { ok: false; error: ErrorPayload };

export interface AdminState {
  devices: (BrowserRow & { created_at: number; key_fingerprint: string })[];
  pairings: {
    device_id: string;
    code: string;
    name: string;
    os: string;
    created_at: number;
    expires_at: number;
    key_fingerprint: string;
  }[];
  audit: AuditRow[];
}

export interface AuditRow {
  ts: number;
  client: string;
  tool: string;
  device_id: string | null;
  browser: string | null;
  outcome: string;
  duration_ms: number;
  error_code: string | null;
  args: string | null;
}

export type AwaitCallResult = { done: false } | { done: true; result: DaemonResult };

interface DeviceRecord {
  id: string;
  name: string;
  aliases: string;
  os: string;
  public_key: string;
  created_at: number;
  revoked_at: number | null;
  last_seen: number | null;
  presence: string | null;
  presence_at: number | null;
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomCode(length: number): string {
  // Rejection sampling keeps the code uniform over the alphabet.
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (
        byte < CODE_ALPHABET.length * Math.floor(256 / CODE_ALPHABET.length) &&
        out.length < length
      ) {
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return out;
}

/** Verify an Ed25519 signature (base64url) with a raw public key (base64url). Never throws. */
export async function verifyEd25519(
  publicKeyB64: string,
  signatureB64: string,
  message: string,
): Promise<boolean> {
  try {
    const raw = b64urlToBytes(publicKeyB64);
    if (raw.length !== 32) return false;
    const signature = b64urlToBytes(signatureB64);
    if (signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

export function pairStatusTranscript(deviceId: string, timestamp: number): string {
  return `rainforest-pair-status-v1\n${deviceId}\n${timestamp}`;
}

export class Hub extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #waiters = new Map<string, Set<(result: DaemonResult) => void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', os TEXT NOT NULL,
        public_key TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
        last_seen INTEGER, presence TEXT, presence_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairings (
        device_id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, os TEXT NOT NULL,
        public_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, tool TEXT NOT NULL, client TEXT NOT NULL,
        args TEXT, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, deadline INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL,
        device_id TEXT, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, error_code TEXT, args TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts);
      CREATE TABLE IF NOT EXISTS prefs (grant_key TEXT PRIMARY KEY, device_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS password_failures (ts INTEGER NOT NULL);
    `);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ------------------------------------------------------------------ sockets

  /** WebSocket upgrade for daemons. Authentication happens on the socket. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const state: SocketState = {
      nonce: randomHex(32),
      authed: false,
      deviceId: null,
      connectedAt: Date.now(),
    };
    server.serializeAttachment(state);
    server.send(JSON.stringify({ type: "challenge", nonce: state.nonce }));
    await this.#scheduleAlarm(Date.now() + AUTH_GRACE_MS + 500);
    return new Response(null, { status: 101, webSocket: client });
  }

  #state(ws: WebSocket): SocketState | null {
    const state = ws.deserializeAttachment() as SocketState | null;
    return state && typeof state.nonce === "string" ? state : null;
  }

  #socketFor(deviceId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.#state(ws);
      if (state?.authed && state.deviceId === deviceId && ws.readyState === WebSocket.OPEN)
        return ws;
    }
    return null;
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const state = this.#state(ws);
    if (!state || typeof raw !== "string" || raw.length > MAX_RESULT_CHARS + 100_000) {
      ws.close(1008, "bad frame");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ws.close(1008, "bad json");
      return;
    }
    const message = daemonMessage.safeParse(parsed);
    if (!message.success) {
      ws.close(1008, "bad message");
      return;
    }
    const msg = message.data;

    if (!state.authed) {
      if (msg.type !== "auth") {
        ws.close(1008, "authenticate first");
        return;
      }
      if (msg.protocol < MIN_PEER_PROTOCOL) {
        ws.close(4001, "daemon_outdated");
        return;
      }
      if (msg.protocol > PROTOCOL_VERSION) {
        ws.close(4002, "hub_outdated");
        return;
      }
      const device = this.#device(msg.device_id);
      const ok =
        device !== null &&
        device.revoked_at === null &&
        (await verifyEd25519(
          device.public_key,
          msg.signature,
          authTranscript(state.nonce, msg.device_id, msg.protocol),
        ));
      if (!ok) {
        ws.close(1008, "unauthorized");
        return;
      }
      // One socket per device: a newer authenticated connection replaces the older one.
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const otherState = this.#state(other);
        if (otherState?.authed && otherState.deviceId === msg.device_id)
          other.close(4000, "replaced");
      }
      // The nonce is single use: it is cleared the moment it authenticates a socket.
      ws.serializeAttachment({
        ...state,
        nonce: "",
        authed: true,
        deviceId: msg.device_id,
      } satisfies SocketState);
      this.#recordPresence(msg.device_id, msg.presence);
      ws.send(
        JSON.stringify({
          type: "welcome",
          protocol: PROTOCOL_VERSION,
          min_daemon_version: this.env.MIN_DAEMON_VERSION || undefined,
        }),
      );
      return;
    }

    const deviceId = state.deviceId!;
    const device = this.#device(deviceId);
    if (!device || device.revoked_at !== null) {
      ws.close(1008, "revoked");
      return;
    }
    if (msg.type === "presence") {
      this.#recordPresence(deviceId, msg.presence);
    } else if (msg.type === "result") {
      this.#onResult(deviceId, msg);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const state = this.#state(ws);
    if (state?.authed && state.deviceId) {
      this.#sql.exec("UPDATE devices SET last_seen = ? WHERE id = ?", Date.now(), state.deviceId);
    }
  }

  override async webSocketError(): Promise<void> {}

  #recordPresence(deviceId: string, presence: Presence): void {
    const now = Date.now();
    this.#sql.exec(
      "UPDATE devices SET presence = ?, presence_at = ?, last_seen = ? WHERE id = ?",
      JSON.stringify(presence),
      now,
      now,
      deviceId,
    );
  }

  #onResult(deviceId: string, msg: DaemonResult): void {
    const row = this.#sql
      .exec(
        "SELECT device_id, status, tool, client, args, created_at FROM calls WHERE id = ?",
        msg.id,
      )
      .toArray()[0] as
      | {
          device_id: string;
          status: string;
          tool: string;
          client: string;
          args: string | null;
          created_at: number;
        }
      | undefined;
    // Only the device the call was sent to may answer it, and only once.
    if (!row || row.device_id !== deviceId || row.status !== "pending") return;
    const serialized = JSON.stringify(msg);
    const result: DaemonResult =
      serialized.length > MAX_RESULT_CHARS
        ? {
            type: "result",
            id: msg.id,
            ok: false,
            error: { code: "internal", message: "result too large" },
            duration_ms: msg.duration_ms,
          }
        : msg;
    this.#sql.exec(
      "UPDATE calls SET status = 'done', result = ? WHERE id = ?",
      JSON.stringify(result),
      msg.id,
    );
    this.#audit({
      client: row.client,
      tool: row.tool,
      deviceId,
      outcome: result.ok ? "ok" : "error",
      durationMs: Date.now() - row.created_at,
      errorCode: result.ok ? null : (result.error?.code ?? "internal"),
      args: row.args,
    });
    const waiters = this.#waiters.get(msg.id);
    if (waiters) {
      this.#waiters.delete(msg.id);
      for (const resolve of waiters) resolve(result);
    }
  }

  // ------------------------------------------------------------------ alarm

  async #scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let next = now + 6 * 3600 * 1000;
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.#state(ws);
      if (state && !state.authed) {
        if (now - state.connectedAt >= AUTH_GRACE_MS) ws.close(1008, "authentication timeout");
        else next = Math.min(next, state.connectedAt + AUTH_GRACE_MS + 500);
      }
    }
    // Calls whose caller never collected the result: record a timeout once, then drop.
    const stale = this.#sql
      .exec(
        "SELECT id, device_id, tool, client, args, status, created_at FROM calls WHERE deadline < ?",
        now - 30_000,
      )
      .toArray() as {
      id: string;
      device_id: string;
      tool: string;
      client: string;
      args: string | null;
      status: string;
      created_at: number;
    }[];
    for (const row of stale) {
      if (row.status === "pending") {
        this.#audit({
          client: row.client,
          tool: row.tool,
          deviceId: row.device_id,
          outcome: "error",
          durationMs: now - row.created_at,
          errorCode: "timeout",
          args: row.args,
        });
      }
      this.#sql.exec("DELETE FROM calls WHERE id = ?", row.id);
    }
    const pending = this.#sql.exec("SELECT MIN(deadline) AS d FROM calls").toArray()[0] as
      { d: number | null } | undefined;
    if (pending?.d) next = Math.min(next, pending.d + 31_000);
    this.#sql.exec("DELETE FROM audit WHERE ts < ?", now - AUDIT_RETENTION_MS);
    this.#sql.exec("DELETE FROM pairings WHERE expires_at < ?", now - 24 * 3600 * 1000);
    this.#sql.exec("DELETE FROM password_failures WHERE ts < ?", now - PASSWORD_WINDOW_MS);
    await this.ctx.storage.setAlarm(next);
  }

  // ------------------------------------------------------------------ devices

  #device(id: string): DeviceRecord | null {
    return (
      (this.#sql.exec("SELECT * FROM devices WHERE id = ?", id).toArray()[0] as unknown as
        DeviceRecord | undefined) ?? null
    );
  }

  #devices(): DeviceRecord[] {
    return this.#sql
      .exec("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at")
      .toArray() as unknown as DeviceRecord[];
  }

  #browserRow(device: DeviceRecord, selectedId: string | null): BrowserRow {
    let presence: Presence | null = null;
    if (device.presence) {
      const parsed = presenceSchema.safeParse(JSON.parse(device.presence));
      if (parsed.success) presence = parsed.data;
    }
    const online = this.#socketFor(device.id) !== null;
    let aliases: string[];
    try {
      aliases = JSON.parse(device.aliases) as string[];
    } catch {
      aliases = [];
    }
    return {
      id: device.id,
      name: device.name,
      aliases,
      os: device.os,
      online,
      last_seen: device.last_seen,
      last_active:
        presence && device.presence_at ? device.presence_at - presence.idle_s * 1000 : null,
      idle_s:
        online && presence && device.presence_at
          ? Math.round(presence.idle_s + (Date.now() - device.presence_at) / 1000)
          : null,
      locked: online ? (presence?.locked ?? null) : null,
      chrome_running: online ? (presence?.chrome_running ?? null) : null,
      profile_connected: online ? (presence?.profile_connected ?? null) : null,
      amazon_signed_in: presence?.amazon_signed_in ?? null,
      cooling_down_until: presence?.cooling_down_until ?? null,
      daemon_version: presence?.version ?? null,
      selected: selectedId === device.id,
    };
  }

  #selection(grantKey: string): string | null {
    const row = this.#sql
      .exec("SELECT device_id FROM prefs WHERE grant_key = ?", grantKey)
      .toArray()[0] as { device_id: string } | undefined;
    return row?.device_id ?? null;
  }

  async listBrowsers(grantKey: string): Promise<BrowserRow[]> {
    const selected = this.#selection(grantKey);
    return this.#devices().map((d) => this.#browserRow(d, selected));
  }

  #match(name: string, rows: BrowserRow[]): BrowserRow | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    return (
      rows.find((r) => r.id.toLowerCase() === wanted) ??
      rows.find((r) => r.name.toLowerCase() === wanted) ??
      rows.find((r) => r.aliases.some((a) => a.toLowerCase() === wanted)) ??
      null
    );
  }

  async selectBrowser(grantKey: string, name: string | null): Promise<SelectResult> {
    if (name === null) {
      this.#sql.exec("DELETE FROM prefs WHERE grant_key = ?", grantKey);
      return { ok: true, selected: null };
    }
    const rows = await this.listBrowsers(grantKey);
    const match = this.#match(name, rows);
    if (!match) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: "no browser with that id, name or alias",
          details: { browsers: rows.map((r) => r.name) },
        },
      };
    }
    this.#sql.exec(
      "INSERT INTO prefs (grant_key, device_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (grant_key) DO UPDATE SET device_id = excluded.device_id, updated_at = excluded.updated_at",
      grantKey,
      match.id,
      Date.now(),
    );
    return { ok: true, selected: { ...match, selected: true } };
  }

  /**
   * Resolution order: explicit argument, then this grant's selection, then the most
   * recently active online computer. An explicitly named offline browser is an error; an
   * offline selection falls back and says so.
   */
  #resolve(
    grantKey: string,
    explicit: string | undefined,
  ): { ok: true; row: BrowserRow; note?: string } | { ok: false; error: ErrorPayload } {
    const selected = this.#selection(grantKey);
    const rows = this.#devices().map((d) => this.#browserRow(d, selected));
    const online = rows.filter((r) => r.online);
    const onlineNames = online.map((r) => r.name);
    if (explicit !== undefined) {
      const match = this.#match(explicit, rows);
      if (!match)
        return {
          ok: false,
          error: {
            code: "not_found",
            message: "no browser with that id, name or alias",
            details: { browsers: rows.map((r) => r.name) },
          },
        };
      if (!match.online)
        return {
          ok: false,
          error: {
            code: "browser_offline",
            message: `browser "${match.name}" is offline`,
            details: { online: onlineNames },
          },
        };
      return { ok: true, row: match };
    }
    if (online.length === 0) {
      return {
        ok: false,
        error: {
          code: "no_browser_online",
          message: "no computer is online",
          details: { browsers: rows.map((r) => r.name) },
        },
      };
    }
    const byActivity = [...online].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
    if (selected) {
      const chosen = rows.find((r) => r.id === selected);
      if (chosen?.online) return { ok: true, row: chosen };
      const fallback = byActivity[0]!;
      return {
        ok: true,
        row: fallback,
        note: `the selected browser${chosen ? ` "${chosen.name}"` : ""} is offline; used "${fallback.name}" instead`,
      };
    }
    return { ok: true, row: byActivity[0]! };
  }

  // ------------------------------------------------------------------ calls

  async startCall(input: {
    grantKey: string;
    client: string;
    tool: string;
    args: Record<string, unknown>;
    deadlineMs: number;
  }): Promise<StartCallResult> {
    const def = getTool(input.tool);
    if (!def || def.kind === "hub")
      return { ok: false, error: { code: "invalid_arguments", message: "unknown tool" } };
    const explicit = typeof input.args.browser === "string" ? input.args.browser : undefined;
    const resolved = this.#resolve(input.grantKey, explicit);
    const argsForAudit = def.kind === "write" ? JSON.stringify(input.args).slice(0, 4000) : null;
    if (!resolved.ok) {
      this.#audit({
        client: input.client,
        tool: input.tool,
        deviceId: null,
        outcome: "error",
        durationMs: 0,
        errorCode: resolved.error.code,
        args: argsForAudit,
      });
      return resolved;
    }
    const row = resolved.row;
    const ws = this.#socketFor(row.id);
    if (!ws)
      return {
        ok: false,
        error: { code: "browser_offline", message: `browser "${row.name}" is offline` },
      };
    const minVersion = this.env.MIN_DAEMON_VERSION;
    if (minVersion && row.daemon_version && compareVersions(row.daemon_version, minVersion) < 0) {
      ws.send(JSON.stringify({ type: "update_hint" }));
      this.#audit({
        client: input.client,
        tool: input.tool,
        deviceId: row.id,
        outcome: "error",
        durationMs: 0,
        errorCode: "daemon_outdated",
        args: argsForAudit,
      });
      return {
        ok: false,
        error: {
          code: "daemon_outdated",
          message: `the daemon on "${row.name}" is updating; retry in a minute`,
          retry_after_s: 60,
        },
      };
    }
    const callId = crypto.randomUUID();
    const now = Date.now();
    const args = { ...input.args };
    delete args.browser;
    this.#sql.exec(
      "INSERT INTO calls (id, device_id, tool, client, args, status, created_at, deadline) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      callId,
      row.id,
      input.tool,
      input.client,
      argsForAudit,
      now,
      now + input.deadlineMs,
    );
    ws.send(
      JSON.stringify({
        type: "call",
        id: callId,
        tool: input.tool,
        args,
        deadline_ms: input.deadlineMs,
      }),
    );
    await this.#scheduleAlarm(now + input.deadlineMs + 31_000);
    return {
      ok: true,
      callId,
      browser: { id: row.id, name: row.name, ...(resolved.note ? { note: resolved.note } : {}) },
    };
  }

  #takeResult(callId: string): DaemonResult | null {
    const row = this.#sql
      .exec("SELECT status, result FROM calls WHERE id = ?", callId)
      .toArray()[0] as { status: string; result: string | null } | undefined;
    if (!row || row.status !== "done" || !row.result) return null;
    this.#sql.exec("DELETE FROM calls WHERE id = ?", callId);
    return JSON.parse(row.result) as DaemonResult;
  }

  /**
   * Wait up to `waitMs` for the result of a call. The stored row is the source of truth
   * (it survives eviction); the in-memory waiter is only the fast path.
   */
  async awaitCall(callId: string, waitMs: number): Promise<AwaitCallResult> {
    const ready = this.#takeResult(callId);
    if (ready) return { done: true, result: ready };
    const result = await new Promise<DaemonResult | null>((resolve) => {
      const set = this.#waiters.get(callId) ?? new Set();
      const onResult = (r: DaemonResult): void => {
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => {
          set.delete(onResult);
          if (set.size === 0) this.#waiters.delete(callId);
          resolve(null);
        },
        Math.max(0, Math.min(waitMs, 30_000)),
      );
      set.add(onResult);
      this.#waiters.set(callId, set);
    });
    if (result) {
      this.#sql.exec("DELETE FROM calls WHERE id = ?", callId);
      return { done: true, result };
    }
    const late = this.#takeResult(callId);
    return late ? { done: true, result: late } : { done: false };
  }

  /** The caller gave up (deadline reached). Records the timeout once. */
  async abandonCall(callId: string): Promise<void> {
    const row = this.#sql
      .exec(
        "SELECT device_id, tool, client, args, status, created_at FROM calls WHERE id = ?",
        callId,
      )
      .toArray()[0] as
      | {
          device_id: string;
          tool: string;
          client: string;
          args: string | null;
          status: string;
          created_at: number;
        }
      | undefined;
    if (!row) return;
    if (row.status === "pending") {
      this.#audit({
        client: row.client,
        tool: row.tool,
        deviceId: row.device_id,
        outcome: "error",
        durationMs: Date.now() - row.created_at,
        errorCode: "timeout",
        args: row.args,
      });
    }
    this.#sql.exec("DELETE FROM calls WHERE id = ?", callId);
  }

  // ------------------------------------------------------------------ audit

  #audit(row: {
    client: string;
    tool: string;
    deviceId: string | null;
    outcome: string;
    durationMs: number;
    errorCode: string | null;
    args: string | null;
  }): void {
    this.#sql.exec(
      "INSERT INTO audit (ts, client, tool, device_id, outcome, duration_ms, error_code, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(),
      row.client.slice(0, 120),
      row.tool,
      row.deviceId,
      row.outcome,
      Math.round(row.durationMs),
      row.errorCode,
      row.args,
    );
  }

  /** Audit a tool answered by the hub itself. */
  async auditHubTool(
    client: string,
    tool: string,
    outcome: "ok" | "error",
    durationMs: number,
    errorCode: string | null,
    args: string | null,
  ): Promise<void> {
    this.#audit({ client, tool, deviceId: null, outcome, durationMs, errorCode, args });
  }

  async getAuditLog(filter: {
    limit?: number;
    before?: number;
    tool?: string;
    writes_only?: boolean;
  }): Promise<AuditRow[]> {
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const clauses: string[] = ["ts < ?"];
    const params: (string | number)[] = [filter.before ?? Date.now() + 1];
    if (filter.tool) {
      clauses.push("tool = ?");
      params.push(filter.tool);
    }
    if (filter.writes_only) clauses.push("args IS NOT NULL");
    const rows = this.#sql
      .exec(
        `SELECT a.ts, a.client, a.tool, a.device_id, d.name AS browser, a.outcome, a.duration_ms, a.error_code, a.args
             FROM audit a LEFT JOIN devices d ON d.id = a.device_id WHERE ${clauses.join(" AND ")} ORDER BY a.ts DESC, a.id DESC LIMIT ?`,
        ...params,
        limit,
      )
      .toArray();
    return rows as unknown as AuditRow[];
  }

  async getStatus(grantKey: string): Promise<{
    hub: { protocol: number; min_daemon_version: string | null; pending_calls: number };
    browsers: BrowserRow[];
  }> {
    const pendingCalls = this.#sql
      .exec("SELECT COUNT(*) AS n FROM calls WHERE status = 'pending'")
      .toArray()[0] as { n: number };
    return {
      hub: {
        protocol: PROTOCOL_VERSION,
        min_daemon_version: this.env.MIN_DAEMON_VERSION ?? null,
        pending_calls: pendingCalls.n,
      },
      browsers: await this.listBrowsers(grantKey),
    };
  }

  // ------------------------------------------------------------------ pairing

  async pairStart(input: {
    public_key: string;
    name: string;
    os: string;
  }): Promise<
    { ok: true; device_id: string; code: string; expires_at: number } | { ok: false; error: string }
  > {
    const now = Date.now();
    let raw: Uint8Array;
    try {
      raw = b64urlToBytes(input.public_key);
    } catch {
      return { ok: false, error: "bad public key" };
    }
    if (raw.length !== 32) return { ok: false, error: "bad public key" };
    const name = input.name.trim().slice(0, 60);
    const os = input.os.trim().slice(0, 20);
    if (!name || !/^[\w .()'-]+$/.test(name) || !/^[a-z0-9]+$/.test(os))
      return { ok: false, error: "bad name or os" };
    this.#sql.exec(
      "UPDATE pairings SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
      now,
    );
    const pending = this.#sql
      .exec("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending'")
      .toArray()[0] as { n: number };
    if (pending.n >= MAX_PENDING_PAIRINGS) return { ok: false, error: "too many pending pairings" };
    const known = this.#sql
      .exec("SELECT id FROM devices WHERE public_key = ? AND revoked_at IS NULL", input.public_key)
      .toArray();
    if (known.length > 0) return { ok: false, error: "this key is already paired" };
    const deviceId = crypto.randomUUID();
    const code = randomCode(8);
    this.#sql.exec(
      "INSERT INTO pairings (device_id, code, name, os, public_key, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
      deviceId,
      code,
      name,
      os,
      input.public_key,
      now,
      now + PAIRING_TTL_MS,
    );
    return { ok: true, device_id: deviceId, code, expires_at: now + PAIRING_TTL_MS };
  }

  /** Polled by the daemon; it must prove possession of the key it registered. */
  async pairStatus(input: {
    device_id: string;
    timestamp: number;
    signature: string;
  }): Promise<{ status: "pending" | "approved" | "rejected" | "expired" | "unknown" }> {
    const row = this.#sql
      .exec(
        "SELECT public_key, status, expires_at FROM pairings WHERE device_id = ?",
        input.device_id,
      )
      .toArray()[0] as { public_key: string; status: string; expires_at: number } | undefined;
    if (!row) return { status: "unknown" };
    if (Math.abs(Date.now() - input.timestamp) > 5 * 60_000) return { status: "unknown" };
    if (
      !(await verifyEd25519(
        row.public_key,
        input.signature,
        pairStatusTranscript(input.device_id, input.timestamp),
      ))
    )
      return { status: "unknown" };
    if (row.status === "pending" && row.expires_at < Date.now()) return { status: "expired" };
    return { status: row.status as "pending" | "approved" | "rejected" | "expired" };
  }

  // ------------------------------------------------------------------ admin (callers verify Access first)

  async adminState(): Promise<AdminState> {
    const now = Date.now();
    const devices = await Promise.all(
      this.#devices().map(async (d) => ({
        ...this.#browserRow(d, null),
        created_at: d.created_at,
        key_fingerprint: await fingerprint(d.public_key),
      })),
    );
    const pairingRows = this.#sql
      .exec(
        "SELECT device_id, code, name, os, public_key, created_at, expires_at FROM pairings WHERE status = 'pending' AND expires_at >= ? ORDER BY created_at",
        now,
      )
      .toArray() as {
      device_id: string;
      code: string;
      name: string;
      os: string;
      public_key: string;
      created_at: number;
      expires_at: number;
    }[];
    const pairings = await Promise.all(
      pairingRows.map(async ({ public_key, ...rest }) => ({
        ...rest,
        key_fingerprint: await fingerprint(public_key),
      })),
    );
    return { devices, pairings, audit: await this.getAuditLog({ limit: 100 }) };
  }

  async approvePairing(code: string): Promise<boolean> {
    const now = Date.now();
    const row = this.#sql
      .exec(
        "SELECT * FROM pairings WHERE code = ? AND status = 'pending' AND expires_at >= ?",
        code.trim().toUpperCase(),
        now,
      )
      .toArray()[0] as
      { device_id: string; name: string; os: string; public_key: string } | undefined;
    if (!row) return false;
    this.#sql.exec(
      "INSERT INTO devices (id, name, os, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
      row.device_id,
      row.name,
      row.os,
      row.public_key,
      now,
    );
    this.#sql.exec("UPDATE pairings SET status = 'approved' WHERE device_id = ?", row.device_id);
    return true;
  }

  async rejectPairing(code: string): Promise<boolean> {
    this.#sql.exec(
      "UPDATE pairings SET status = 'rejected' WHERE code = ? AND status = 'pending'",
      code.trim().toUpperCase(),
    );
    return true;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    this.#sql.exec(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      Date.now(),
      deviceId,
    );
    this.#sql.exec("DELETE FROM prefs WHERE device_id = ?", deviceId);
    for (const ws of this.ctx.getWebSockets()) {
      if (this.#state(ws)?.deviceId === deviceId) ws.close(1008, "revoked");
    }
    return true;
  }

  async updateDevice(deviceId: string, name: string, aliases: string[]): Promise<boolean> {
    const cleanName = name.trim().slice(0, 60);
    const cleanAliases = aliases
      .map((a) => a.trim().slice(0, 40))
      .filter((a) => a.length > 0)
      .slice(0, 8);
    if (!cleanName) return false;
    this.#sql.exec(
      "UPDATE devices SET name = ?, aliases = ? WHERE id = ? AND revoked_at IS NULL",
      cleanName,
      JSON.stringify(cleanAliases),
      deviceId,
    );
    return true;
  }

  // ------------------------------------------------------------------ password lockout

  /** True when too many wrong passwords were entered recently. */
  async passwordLocked(): Promise<boolean> {
    const row = this.#sql
      .exec(
        "SELECT COUNT(*) AS n FROM password_failures WHERE ts >= ?",
        Date.now() - PASSWORD_WINDOW_MS,
      )
      .toArray()[0] as { n: number };
    return row.n >= PASSWORD_MAX_FAILURES;
  }

  async recordPasswordAttempt(success: boolean): Promise<void> {
    if (success) this.#sql.exec("DELETE FROM password_failures");
    else this.#sql.exec("INSERT INTO password_failures (ts) VALUES (?)", Date.now());
  }
}

async function fingerprint(publicKeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKeyB64));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}
