import { execFile } from "node:child_process";

export interface ExecResult {
  /** Process exit code; 127 when the program could not be started at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeout_ms?: number;
  /** Extra environment variables for the child (merged over this process's environment). */
  env?: Record<string, string>;
}

/**
 * Run a program WITHOUT a shell and never reject on a non-zero exit. Every OS probe and
 * service-manager call goes through this injected seam so tests never touch launchd,
 * schtasks or the real process list.
 */
export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const defaultExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: opts.timeout_ms ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        resolve({
          code: typeof code === "number" ? code : 127,
          stdout: stdout ?? "",
          stderr: stderr || error.message,
        });
      },
    );
  });
