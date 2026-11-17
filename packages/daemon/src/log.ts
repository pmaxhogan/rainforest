import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { ensureDir } from "./fsutil.ts";
import { dirname } from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Field names that are dropped (not masked) from every log line and audit row. */
const SENSITIVE_KEY = /token|secret|password|signature|authorization|cookie/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4000;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Deep copy with every sensitive-looking field removed, errors flattened and size bounded. */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const cleaned = redact(inner, depth + 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

export interface LoggerOptions {
  /** Log file path; omit for an in-memory sink (tests) via `sink`. */
  file?: string;
  level?: LogLevel;
  /** Rotate when the file would exceed this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** Total files kept (daemon.log, daemon.log.1, ...). Default 3. */
  maxFiles?: number;
  now?: () => Date;
  /** Extra line sink, e.g. stderr when running in the foreground. */
  sink?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

class FileLogWriter {
  private size: number;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(file: string, maxBytes: number, maxFiles: number) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.maxFiles = Math.max(1, maxFiles);
    ensureDir(dirname(file));
    this.size = existsSync(file) ? statSync(file).size : 0;
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.file, line);
    this.size += bytes;
  }

  /** daemon.log -> daemon.log.1 -> daemon.log.2; the oldest is dropped. */
  private rotate(): void {
    const last = this.maxFiles - 1;
    if (last === 0) {
      rmSync(this.file, { force: true });
    } else {
      rmSync(`${this.file}.${last}`, { force: true });
      for (let i = last - 1; i >= 1; i--) {
        if (existsSync(`${this.file}.${i}`))
          renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    }
    this.size = 0;
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? "info");
  const now = options.now ?? (() => new Date());
  const writer =
    options.file !== undefined
      ? new FileLogWriter(
          options.file,
          options.maxBytes ?? DEFAULT_MAX_BYTES,
          options.maxFiles ?? DEFAULT_MAX_FILES,
        )
      : null;

  function make(bindings: Record<string, unknown>): Logger {
    function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      const entry = {
        ...(redact(bindings) as Record<string, unknown>),
        ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
        ts: now().toISOString(),
        level,
        msg,
      };
      const line = `${JSON.stringify(entry)}\n`;
      try {
        writer?.write(line);
      } catch {
        // Logging must never take the daemon down.
      }
      options.sink?.(line);
    }
    return {
      debug: (msg, fields) => emit("debug", msg, fields),
      info: (msg, fields) => emit("info", msg, fields),
      warn: (msg, fields) => emit("warn", msg, fields),
      error: (msg, fields) => emit("error", msg, fields),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  }
  return make(options.bindings ?? {});
}

/** A logger that discards everything (tests, selftest). */
export function nullLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}
