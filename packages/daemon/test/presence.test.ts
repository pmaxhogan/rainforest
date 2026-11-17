import { describe, expect, test } from "vitest";
import {
  WINDOWS_IDLE_CACHE_MS,
  WINDOWS_IDLE_SCRIPT,
  createPresenceProbe,
  createPresenceProvider,
  encodePowerShell,
  parseMacIdleSeconds,
  parseMacScreenLocked,
  parsePgrepRunning,
  parseWindowsChromeRunning,
  parseWindowsIdleSeconds,
  parseWindowsLocked,
} from "../src/presence.ts";
import { fakeExec } from "./helpers.ts";

const IOREG_IDLE = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000321, registered, matched, active, busy 0 (0 ms), retain 12>
    {
      "HIDParameters" = {"HIDClickTime"=500000000}
      "HIDIdleTime" = 4310226500
      "IOClass" = "IOHIDSystem"
    }
`;

const IOREG_LOCKED = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 28>
  {
    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionLoginDoneKey"=Yes})
  }
`;

const IOREG_UNLOCKED = `
+-o Root  <class IORegistryEntry, id 0x100000100, retain 28>
  {
    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionLoginDoneKey"=Yes})
  }
`;

const IOREG_OFF_CONSOLE = `"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No,"kCGSSessionLoginDoneKey"=Yes})`;

describe("macOS parsers", () => {
  test("idle seconds from HIDIdleTime nanoseconds", () => {
    expect(parseMacIdleSeconds(IOREG_IDLE)).toBe(4);
    expect(parseMacIdleSeconds('"HIDIdleTime" = 0')).toBe(0);
  });

  test("the smallest HIDIdleTime wins when several devices report", () => {
    expect(parseMacIdleSeconds('"HIDIdleTime" = 90000000000\n"HIDIdleTime" = 2000000000')).toBe(2);
  });

  test("no HIDIdleTime means unknown", () => {
    expect(parseMacIdleSeconds("nothing here")).toBeNull();
  });

  test("screen lock detection", () => {
    expect(parseMacScreenLocked(IOREG_LOCKED)).toBe(true);
    expect(parseMacScreenLocked(IOREG_UNLOCKED)).toBe(false);
    expect(parseMacScreenLocked(IOREG_OFF_CONSOLE)).toBe(true);
    expect(parseMacScreenLocked("")).toBe(false);
  });

  test("pgrep output", () => {
    expect(parsePgrepRunning("1234\n5678\n")).toBe(true);
    expect(parsePgrepRunning("")).toBe(false);
    expect(parsePgrepRunning("pgrep: error\n")).toBe(false);
  });
});

describe("Windows parsers", () => {
  test("idle seconds from the helper's millisecond output", () => {
    expect(parseWindowsIdleSeconds("125432\r\n")).toBe(125);
    expect(parseWindowsIdleSeconds("\r\nWARNING: noise\r\n7000\r\n")).toBe(7);
    expect(parseWindowsIdleSeconds("error")).toBeNull();
  });

  test("lock screen is LogonUI.exe in tasklist", () => {
    const running = "LogonUI.exe                   1234 Console                    1     41,032 K";
    const none = "INFO: No tasks are running which match the specified criteria.";
    expect(parseWindowsLocked(running)).toBe(true);
    expect(parseWindowsLocked(none)).toBe(false);
  });

  test("chrome.exe in tasklist", () => {
    expect(parseWindowsChromeRunning("chrome.exe  4321 Console  1  120,000 K")).toBe(true);
    expect(
      parseWindowsChromeRunning("INFO: No tasks are running which match the specified criteria."),
    ).toBe(false);
  });

  test("the idle helper script is ASCII and encodes as UTF-16LE base64", () => {
    expect(/^[\x20-\x7e]+$/.test(WINDOWS_IDLE_SCRIPT)).toBe(true);
    expect(WINDOWS_IDLE_SCRIPT).toContain("GetLastInputInfo");
    const decoded = Buffer.from(encodePowerShell("ab"), "base64");
    expect(decoded).toEqual(Buffer.from([0x61, 0x00, 0x62, 0x00]));
  });
});

describe("probe", () => {
  test("macOS runs ioreg x2 and pgrep and composes the snapshot", async () => {
    const { exec, calls } = fakeExec((file, args) => {
      if (file === "ioreg" && args.includes("IOHIDSystem")) return { stdout: IOREG_IDLE };
      if (file === "ioreg") return { stdout: IOREG_LOCKED };
      return { stdout: "99\n" };
    });
    const probe = createPresenceProbe({ platform: "darwin", exec });
    expect(await probe.snapshot()).toEqual({ idle_s: 4, locked: true, chrome_running: true });
    expect(calls.map((c) => c.file).sort()).toEqual(["ioreg", "ioreg", "pgrep"]);
    expect(calls.find((c) => c.file === "pgrep")?.args).toEqual(["-x", "Google Chrome"]);
  });

  test("macOS: pgrep exit 1 means Chrome is not running; command failures degrade safely", async () => {
    const { exec } = fakeExec((file) =>
      file === "pgrep" ? { code: 1 } : { code: 127, stderr: "missing" },
    );
    const probe = createPresenceProbe({ platform: "darwin", exec });
    expect(await probe.snapshot()).toEqual({ idle_s: 0, locked: false, chrome_running: false });
  });

  test("Windows caches the idle helper for 30 seconds", async () => {
    let clock = 1_000;
    const { exec, calls } = fakeExec((file) => {
      if (file === "powershell.exe") return { stdout: "45000\r\n" };
      return { stdout: "INFO: No tasks are running which match the specified criteria." };
    });
    const probe = createPresenceProbe({ platform: "win32", exec, now: () => clock });
    const first = await probe.snapshot();
    expect(first).toEqual({ idle_s: 45, locked: false, chrome_running: false });
    clock += WINDOWS_IDLE_CACHE_MS - 1;
    await probe.snapshot();
    const psCalls = () => calls.filter((c) => c.file === "powershell.exe").length;
    expect(psCalls()).toBe(1);
    clock += 2;
    await probe.snapshot();
    expect(psCalls()).toBe(2);
    const ps = calls.find((c) => c.file === "powershell.exe");
    expect(ps?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  });

  test("Windows reads lock and chrome from tasklist", async () => {
    const { exec } = fakeExec((file, args) => {
      if (file === "powershell.exe") return { stdout: "1000" };
      return args.join(" ").includes("LogonUI")
        ? { stdout: "LogonUI.exe 1 Console 1 1 K" }
        : { stdout: "chrome.exe 2 Console 1 1 K" };
    });
    const probe = createPresenceProbe({ platform: "win32", exec });
    expect(await probe.snapshot()).toEqual({ idle_s: 1, locked: true, chrome_running: true });
  });
});

describe("provider", () => {
  test("passes the pacing budget and the burst window on when the browser reports them", async () => {
    const provider = createPresenceProvider({
      probe: { snapshot: async () => ({ idle_s: 0, locked: false, chrome_running: true }) },
      browser: {
        status: () => ({
          profile_connected: true,
          amazon_signed_in: true,
          cooling_down_until: null,
          budget: { all: { hour_left: 9, day_left: 150 } },
          burst: { cap: 6, window_s: 600, used_at: [1000, 9000] },
        }),
      },
      version: "0.1.0",
    });
    expect(await provider()).toMatchObject({
      budget: { all: { hour_left: 9, day_left: 150 } },
      burst: { cap: 6, window_s: 600, used_at: [1000, 9000] },
    });
  });

  test("composes OS facts with browser state and the version", async () => {
    const provider = createPresenceProvider({
      probe: { snapshot: async () => ({ idle_s: 9, locked: false, chrome_running: true }) },
      browser: {
        status: () => ({
          profile_connected: true,
          amazon_signed_in: null,
          cooling_down_until: 123,
        }),
      },
      version: "0.1.0",
    });
    expect(await provider()).toEqual({
      idle_s: 9,
      locked: false,
      chrome_running: true,
      profile_connected: true,
      amazon_signed_in: null,
      cooling_down_until: 123,
      version: "0.1.0",
    });
  });
});
