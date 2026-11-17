import { hostname } from "node:os";
import type { CliIo, PairOptions } from "./interfaces.ts";
import { createDeviceKey, loadDeviceKey } from "./keys.ts";
import type { AppPaths } from "./paths.ts";
import type { SecretWriteDeps } from "./fsutil.ts";

/**
 * `rainforestd pair`: create the device key (once), register its PUBLIC half with the hub,
 * print the short code, and wait for the owner to approve that code on the hub's admin
 * page. The hub never receives the private key.
 */

export interface PairDeps {
  paths: AppPaths;
  secretDeps: SecretWriteDeps;
  /** Hub base URL (https). */
  hubUrl: string;
  deviceName?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for approval. */
  timeoutMs?: number;
}

export type PairResult = { ok: true; deviceId: string } | { ok: false; reason: string };

function osName(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "macos"
    : platform === "win32"
      ? "windows"
      : platform.replace(/[^a-z0-9]/g, "");
}

export function defaultDeviceName(): string {
  const cleaned = hostname()
    .split(".")[0]
    ?.replace(/[^\w .()'-]/g, "")
    .slice(0, 60);
  return cleaned && cleaned.length > 0 ? cleaned : "computer";
}

export function pairStatusTranscript(deviceId: string, timestamp: number): string {
  return `rainforest-pair-status-v1\n${deviceId}\n${timestamp}`;
}

export async function pair(deps: PairDeps, _options: PairOptions, io: CliIo): Promise<PairResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const base = deps.hubUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) return { ok: false, reason: "the hub URL must be https" };

  const key = loadDeviceKey(deps.paths) ?? (await createDeviceKey(deps.paths, deps.secretDeps));
  const name = (deps.deviceName ?? defaultDeviceName()).slice(0, 60);
  const start = await fetchFn(`${base}/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_key: key.publicKey, name, os: osName(deps.paths.platform) }),
  });
  const started = (await start.json().catch(() => null)) as
    | { ok: true; device_id: string; code: string; expires_at: number }
    | { ok: false; error: string }
    | null;
  if (!start.ok || !started || !started.ok) {
    return {
      ok: false,
      reason: `the hub refused the pairing (${started && !started.ok ? started.error : start.status})`,
    };
  }
  io.out(`Pairing code: ${started.code}`);
  io.out(`Approve this code on the hub's admin page (${base}/admin) within 10 minutes.`);
  io.out(`Device name: ${name}`);

  const deadline = now() + (deps.timeoutMs ?? 10 * 60_000);
  while (now() < deadline) {
    await sleep(3000);
    const timestamp = now();
    let status: { status?: string } | null;
    try {
      const response = await fetchFn(`${base}/pair/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_id: started.device_id,
          timestamp,
          signature: key.sign(pairStatusTranscript(started.device_id, timestamp)),
        }),
      });
      status = (await response.json().catch(() => null)) as { status?: string } | null;
    } catch {
      continue;
    }
    if (status?.status === "approved") return { ok: true, deviceId: started.device_id };
    if (status?.status === "rejected") return { ok: false, reason: "the pairing was rejected" };
    if (status?.status === "expired") return { ok: false, reason: "the pairing code expired" };
  }
  return { ok: false, reason: "timed out waiting for approval" };
}
