import type { Presence } from "@rainforest/core";
import type { Exec } from "./exec.ts";
import type { BrowserController } from "./interfaces.ts";
import type { Platform } from "./paths.ts";

/**
 * Presence pieces per OS. Every parser is a pure function over canned command output;
 * the exec layer is injected. The hub uses presence to route calls to the computer the
 * owner is (or is not) sitting at.
 */

// ---- pure parsers -------------------------------------------------------------------

/** macOS: `ioreg -c IOHIDSystem` prints `"HIDIdleTime" = 123456789` in nanoseconds. */
export function parseMacIdleSeconds(output: string): number | null {
  const matches = [...output.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)];
  if (matches.length === 0) return null;
  // Several HID devices can report; the smallest value is the most recent input.
  const ns = Math.min(...matches.map((m) => Number(m[1])));
  return Math.floor(ns / 1e9);
}

/**
 * macOS: `ioreg -n Root -d1` carries the console session dictionary. A locked screen has
 * `"CGSSessionScreenIsLocked"=Yes`; a session that is not on the console (fast user
 * switching) is also treated as locked because nobody is at this screen.
 */
export function parseMacScreenLocked(output: string): boolean {
  if (/"CGSSessionScreenIsLocked"\s*=\s*(Yes|1|true)/i.test(output)) return true;
  return /"kCGSSessionOnConsoleKey"\s*=\s*(No|0|false)/i.test(output);
}

/** `pgrep` prints one pid per line for a match and nothing otherwise. */
export function parsePgrepRunning(stdout: string): boolean {
  return stdout.split("\n").some((line) => /^\s*\d+\s*$/.test(line));
}

/** Windows: stdout of the GetLastInputInfo helper, milliseconds since the last input. */
export function parseWindowsIdleSeconds(output: string): number | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\d+$/.test(trimmed)) return Math.floor(Number(trimmed) / 1000);
  }
  return null;
}

/** Windows: LogonUI.exe runs while the workstation is locked or at the sign-in screen. */
export function parseWindowsLocked(tasklistOutput: string): boolean {
  return /\bLogonUI\.exe\b/i.test(tasklistOutput);
}

/** Windows: `tasklist /FI "IMAGENAME eq chrome.exe"` lists rows only when it is running. */
export function parseWindowsChromeRunning(tasklistOutput: string): boolean {
  return /\bchrome\.exe\b/i.test(tasklistOutput);
}

// ---- probe --------------------------------------------------------------------------

/**
 * Windows idle time, decision record: Node has no built-in for GetLastInputInfo and the
 * project avoids native add-ons, so one internal `powershell.exe -NoProfile
 * -NonInteractive -EncodedCommand` invocation P/Invokes user32 via Add-Type. It is a
 * single helper call, not an install script, and its result is cached for 30 s so it
 * runs at most twice a minute (Add-Type compiles C#, ~0.5 s).
 */
export const WINDOWS_IDLE_SCRIPT = [
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;",
  "public static class RfIdle{",
  "[StructLayout(LayoutKind.Sequential)]public struct LII{public uint cbSize;public uint dwTime;}",
  '[DllImport("user32.dll")]public static extern bool GetLastInputInfo(ref LII p);',
  "public static long Ms(){LII l=new LII();l.cbSize=(uint)Marshal.SizeOf(l);",
  "if(!GetLastInputInfo(ref l)){return 0;}",
  "return (long)(uint)((uint)Environment.TickCount-l.dwTime);}}';",
  "[RfIdle]::Ms()",
].join("");

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export const WINDOWS_IDLE_CACHE_MS = 30_000;

export interface OsSnapshot {
  idle_s: number;
  locked: boolean;
  chrome_running: boolean;
}

export interface PresenceProbe {
  snapshot(): Promise<OsSnapshot>;
}

export interface ProbeDeps {
  platform: Platform;
  exec: Exec;
  now?: () => number;
}

export function createPresenceProbe(deps: ProbeDeps): PresenceProbe {
  const now = deps.now ?? Date.now;
  let winIdle: { at: number; value: number } | null = null;

  async function mac(): Promise<OsSnapshot> {
    const [idle, lock, chrome] = await Promise.all([
      deps.exec("ioreg", ["-c", "IOHIDSystem"]),
      deps.exec("ioreg", ["-n", "Root", "-d1"]),
      deps.exec("pgrep", ["-x", "Google Chrome"]),
    ]);
    return {
      idle_s: (idle.code === 0 ? parseMacIdleSeconds(idle.stdout) : null) ?? 0,
      locked: lock.code === 0 ? parseMacScreenLocked(lock.stdout) : false,
      chrome_running: chrome.code === 0 && parsePgrepRunning(chrome.stdout),
    };
  }

  async function windows(): Promise<OsSnapshot> {
    const idlePromise =
      winIdle !== null && now() - winIdle.at < WINDOWS_IDLE_CACHE_MS
        ? Promise.resolve(winIdle.value)
        : deps
            .exec(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encodePowerShell(WINDOWS_IDLE_SCRIPT),
              ],
              { timeout_ms: 20_000 },
            )
            .then((res) => {
              const value = (res.code === 0 ? parseWindowsIdleSeconds(res.stdout) : null) ?? 0;
              winIdle = { at: now(), value };
              return value;
            });
    const [idle_s, lock, chrome] = await Promise.all([
      idlePromise,
      deps.exec("tasklist", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"]),
      deps.exec("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"]),
    ]);
    return {
      idle_s,
      locked: lock.code === 0 && parseWindowsLocked(lock.stdout),
      chrome_running: chrome.code === 0 && parseWindowsChromeRunning(chrome.stdout),
    };
  }

  async function other(): Promise<OsSnapshot> {
    const chrome = await deps.exec("pgrep", ["-x", "chrome"]);
    return {
      idle_s: 0,
      locked: false,
      chrome_running: chrome.code === 0 && parsePgrepRunning(chrome.stdout),
    };
  }

  return {
    snapshot: () =>
      deps.platform === "darwin" ? mac() : deps.platform === "win32" ? windows() : other(),
  };
}

export interface PresenceProviderDeps {
  probe: PresenceProbe;
  browser: Pick<BrowserController, "status">;
  version: string;
}

/** Compose OS facts and browser state into the wire `Presence`. */
export function createPresenceProvider(deps: PresenceProviderDeps): () => Promise<Presence> {
  return async () => {
    const os = await deps.probe.snapshot();
    const browser = deps.browser.status();
    return {
      idle_s: os.idle_s,
      locked: os.locked,
      chrome_running: os.chrome_running,
      profile_connected: browser.profile_connected,
      amazon_signed_in: browser.amazon_signed_in,
      cooling_down_until: browser.cooling_down_until,
      version: deps.version,
    };
  };
}
