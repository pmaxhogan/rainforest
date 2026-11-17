import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { getTool, type ErrorCode } from "@rainforest/core";
import { atomicWriteFile, ensureDir, readTextIfExists } from "./fsutil.ts";
import { redact } from "./log.ts";

export const AUDIT_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

export interface AuditRow {
  /** Epoch milliseconds. */
  ts: number;
  tool: string;
  outcome: "ok" | "error";
  duration_ms: number;
  error_code?: ErrorCode;
  /** Present ONLY for write tools. Never page content. */
  args?: Record<string, unknown>;
}

export interface AuditInput {
  tool: string;
  outcome: "ok" | "error";
  duration_ms: number;
  error_code?: ErrorCode;
  args?: Record<string, unknown>;
}

export interface Audit {
  record(input: AuditInput): void;
  /** Most recent `n` rows, newest last. */
  recent(n: number): AuditRow[];
  /** Drop rows older than the retention window. Returns how many were removed. */
  prune(): number;
  /** Prune now and then daily. Returns a stop function. */
  startPruning(): () => void;
}

export interface AuditOptions {
  file: string;
  now?: () => number;
  retentionDays?: number;
}

function parseRows(text: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as AuditRow;
      if (typeof row.ts === "number" && typeof row.tool === "string") rows.push(row);
    } catch {
      // Skip a torn or corrupt line; the log is best-effort local history.
    }
  }
  return rows;
}

export function createAudit(options: AuditOptions): Audit {
  const now = options.now ?? Date.now;
  const retentionMs = (options.retentionDays ?? AUDIT_RETENTION_DAYS) * DAY_MS;

  function record(input: AuditInput): void {
    const row: AuditRow = {
      ts: now(),
      tool: input.tool,
      outcome: input.outcome,
      duration_ms: Math.max(0, Math.round(input.duration_ms)),
    };
    if (input.error_code !== undefined) row.error_code = input.error_code;
    // Arguments are kept for write tools only; reads (and unknown tools) never store them.
    if (input.args !== undefined && getTool(input.tool)?.kind === "write") {
      row.args = redact(input.args) as Record<string, unknown>;
    }
    ensureDir(dirname(options.file));
    appendFileSync(options.file, `${JSON.stringify(row)}\n`);
  }

  function recent(n: number): AuditRow[] {
    const text = readTextIfExists(options.file);
    if (text === null || n <= 0) return [];
    return parseRows(text).slice(-n);
  }

  function prune(): number {
    const text = readTextIfExists(options.file);
    if (text === null) return 0;
    const rows = parseRows(text);
    const cutoff = now() - retentionMs;
    const kept = rows.filter((row) => row.ts >= cutoff);
    const removed = rows.length - kept.length;
    if (removed > 0) {
      atomicWriteFile(options.file, kept.map((row) => `${JSON.stringify(row)}\n`).join(""));
    }
    return removed;
  }

  function startPruning(): () => void {
    prune();
    const timer = setInterval(() => {
      try {
        prune();
      } catch {
        // Retry on the next tick.
      }
    }, DAY_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { record, recent, prune, startPruning };
}
