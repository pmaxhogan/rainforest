import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonConfig } from "../config.ts";
import type { Exec } from "../exec.ts";
import type { UpdateOutcome, Updater, UpdateTrigger } from "../interfaces.ts";
import { readCurrent, readState, writeCurrent, writeState, markVersionBad } from "../layout.ts";
import type { Logger } from "../log.ts";
import { versionDir, type AppPaths } from "../paths.ts";
import { loadSecrets } from "../secrets.ts";
import { RELEASE_PUBLIC_KEYS } from "./release-key.ts";
import {
  UpdateRejected,
  checkUpgrade,
  readReleaseTarball,
  verifyManifest,
  verifyTarball,
  type Manifest,
} from "./verify.ts";

/**
 * Self-update from signed GitHub releases.
 *
 *   poll -> fetch manifest + signature -> verify against keys embedded in THIS build ->
 *   refuse anything not strictly newer -> download tarball -> verify size and hash ->
 *   unpack to a staging directory -> run the new version's selftest -> switch the
 *   pointer -> restart. After the restart the new version must report healthy within
 *   HEALTH_WINDOW_MS, otherwise the previous version is restored and the new one is
 *   marked bad. The launcher covers the case where the new version cannot even start.
 */

export const HEALTH_WINDOW_MS = 60_000;
const MAX_MANIFEST_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 256;

export interface UpdaterDeps {
  config: DaemonConfig;
  paths: AppPaths;
  log: Logger;
  exec: Exec;
  /** Version of the running daemon. */
  version: string;
  requestRestart(reason: string): void;
  /** True once this process is connected to the hub (the health signal). */
  isHealthy(): boolean;
  fetchFn?: typeof fetch;
  publicKeys?: readonly string[];
  nodeVersion?: string;
  nodePath?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

function timer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
}

export function createUpdater(
  deps: UpdaterDeps,
): Updater & { confirmOrRollback(): "confirmed" | "rolled_back" | "none" } {
  const log = deps.log.child({ part: "updater" });
  const fetchFn = deps.fetchFn ?? fetch;
  const keys = deps.publicKeys ?? RELEASE_PUBLIC_KEYS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? timer;
  let poll: { cancel(): void } | null = null;
  let health: { cancel(): void } | null = null;
  let running = false;
  let stopped = true;

  const headers = (accept: string): Record<string, string> => {
    const token = loadSecrets(deps.paths)?.update_token;
    return {
      accept,
      "user-agent": "rainforestd-updater",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  };

  const download = async (asset: ReleaseAsset, maxBytes: number): Promise<Uint8Array> => {
    if (asset.size > maxBytes)
      throw new UpdateRejected("too_large", `${asset.name} is larger than allowed`);
    // The token goes to the API host only. The API answers with a redirect to a storage
    // host; that hop is followed by hand, once, over https and without the token.
    let response = await fetchFn(asset.url, {
      headers: headers("application/octet-stream"),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const parse = (): URL | null => {
        try {
          return location ? new URL(location, asset.url) : null;
        } catch {
          return null;
        }
      };
      const next = parse();
      if (!next || next.protocol !== "https:")
        throw new UpdateRejected("download_failed", `${asset.name}: bad redirect`);
      response = await fetchFn(next.toString(), {
        headers: { accept: "application/octet-stream", "user-agent": "rainforestd-updater" },
        redirect: "error",
      });
    }
    if (!response.ok)
      throw new UpdateRejected("download_failed", `${asset.name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes)
      throw new UpdateRejected("too_large", `${asset.name} is larger than allowed`);
    return bytes;
  };

  const latestAssets = async (): Promise<Map<string, ReleaseAsset> | null> => {
    const url = `https://api.github.com/repos/${deps.config.update.repo}/releases/latest`;
    const response = await fetchFn(url, { headers: headers("application/vnd.github+json") });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new UpdateRejected("list_failed", `release lookup failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      assets?: { name?: unknown; url?: unknown; size?: unknown }[];
    };
    const assets = new Map<string, ReleaseAsset>();
    for (const asset of body.assets ?? []) {
      if (
        typeof asset.name === "string" &&
        typeof asset.url === "string" &&
        typeof asset.size === "number"
      ) {
        // Asset downloads only ever go to the GitHub API host.
        if (new URL(asset.url).hostname === "api.github.com")
          assets.set(asset.name, { name: asset.name, url: asset.url, size: asset.size });
      }
    }
    return assets;
  };

  const stage = (manifest: Manifest, tarball: Uint8Array): string => {
    const files = readReleaseTarball(tarball, `rainforestd-${manifest.version}`);
    const version = files.find((f) => f.path === "VERSION");
    if (!version || Buffer.from(version.data).toString("utf8").trim() !== manifest.version) {
      throw new UpdateRejected("bad_archive", "archive VERSION does not match the manifest");
    }
    const staging = join(deps.paths.versionsDir, `.staging-${manifest.version}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    for (const file of files) {
      const target = join(staging, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.data, { mode: 0o644 });
    }
    return staging;
  };

  const apply = async (trigger: UpdateTrigger): Promise<UpdateOutcome> => {
    if (!deps.config.update.enabled && trigger !== "manual") return { status: "disabled" };
    const assets = await latestAssets();
    if (!assets) return { status: "up_to_date", version: deps.version };
    const manifestAsset = assets.get("manifest.json");
    const signatureAsset = assets.get("manifest.sig");
    if (!manifestAsset || !signatureAsset) return { status: "up_to_date", version: deps.version };
    const manifestBytes = await download(manifestAsset, MAX_MANIFEST_BYTES);
    const signature = Buffer.from(await download(signatureAsset, MAX_SIGNATURE_BYTES)).toString(
      "utf8",
    );
    const manifest = verifyManifest(manifestBytes, signature, keys);
    const state = readState(deps.paths);
    try {
      checkUpgrade(
        manifest,
        deps.version,
        deps.nodeVersion ?? process.version,
        Object.keys(state.bad_versions),
      );
    } catch (error) {
      if (error instanceof UpdateRejected && error.code === "not_newer")
        return { status: "up_to_date", version: deps.version };
      throw error;
    }
    const tarballAsset = assets.get(manifest.tarball);
    if (!tarballAsset)
      throw new UpdateRejected("missing_asset", "the release has no tarball for its manifest");
    const tarball = await download(tarballAsset, manifest.size);
    verifyTarball(tarball, manifest);

    const staging = stage(manifest, tarball);
    try {
      const selftest = await deps.exec(
        deps.nodePath ?? process.execPath,
        [join(staging, "rainforestd.mjs"), "selftest"],
        {
          timeout_ms: 60_000,
          env: { RAINFOREST_HOME: deps.paths.root },
        },
      );
      if (selftest.code !== 0)
        throw new UpdateRejected("selftest_failed", "the new version failed its selftest");
      const finalDir = versionDir(deps.paths, manifest.version);
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(staging, finalDir);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (error instanceof UpdateRejected && error.code === "selftest_failed") {
        markVersionBad(deps.paths, manifest.version, "selftest failed before switching", now());
      }
      throw error;
    }
    const previous = readCurrent(deps.paths) ?? deps.version;
    writeState(deps.paths, {
      ...readState(deps.paths),
      previous_version: previous,
      pending: { version: manifest.version, previous, since: now(), boots: 0 },
    });
    writeCurrent(deps.paths, manifest.version);
    log.info("switched to a new version", { from: deps.version, to: manifest.version, trigger });
    return { status: "updated", from: deps.version, to: manifest.version, restart_required: true };
  };

  const checkNow = async (trigger: UpdateTrigger): Promise<UpdateOutcome> => {
    if (running) return { status: "failed", reason: "an update check is already running" };
    running = true;
    try {
      return await apply(trigger);
    } catch (error) {
      const reason =
        error instanceof UpdateRejected ? `${error.code}: ${error.message}` : "update check failed";
      log.warn("update rejected", { reason });
      return { status: "failed", reason };
    } finally {
      running = false;
    }
  };

  /** Decide the fate of an update this process is the first run of. */
  const confirmOrRollback = (): "confirmed" | "rolled_back" | "none" => {
    const state = readState(deps.paths);
    const pending = state.pending;
    if (!pending || pending.version !== deps.version) return "none";
    if (deps.isHealthy()) {
      const next = { ...state };
      delete next.pending;
      writeState(deps.paths, next);
      log.info("update confirmed healthy", { version: deps.version });
      return "confirmed";
    }
    if (existsSync(versionDir(deps.paths, pending.previous))) {
      markVersionBad(
        deps.paths,
        pending.version,
        "did not connect to the hub after the update",
        now(),
      );
      const next = readState(deps.paths);
      delete next.pending;
      writeState(deps.paths, next);
      writeCurrent(deps.paths, pending.previous);
      log.error("update failed its health check; rolling back", {
        from: pending.version,
        to: pending.previous,
      });
      deps.requestRestart(`rollback to ${pending.previous}`);
      return "rolled_back";
    }
    return "none";
  };

  const schedule = (): void => {
    if (stopped) return;
    poll = setTimer(() => {
      void checkNow("schedule").then((outcome) => {
        if (outcome.status === "updated" && outcome.restart_required)
          deps.requestRestart(`updated to ${outcome.to}`);
        schedule();
      });
    }, deps.config.update.check_interval_s * 1000);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      const pending = readState(deps.paths).pending;
      if (pending && pending.version === deps.version) {
        // Confirm as soon as healthy; the deadline decides otherwise.
        const startedAt = now();
        const tick = (): void => {
          if (stopped) return;
          if (deps.isHealthy()) {
            confirmOrRollback();
            return;
          }
          if (now() - startedAt >= HEALTH_WINDOW_MS) {
            confirmOrRollback();
            return;
          }
          health = setTimer(tick, 2000);
        };
        health = setTimer(tick, 2000);
      }
      // First check soon after start, then on the interval.
      poll = setTimer(() => {
        void checkNow("schedule").then((outcome) => {
          if (outcome.status === "updated" && outcome.restart_required)
            deps.requestRestart(`updated to ${outcome.to}`);
          schedule();
        });
      }, 20_000);
    },
    stop() {
      stopped = true;
      poll?.cancel();
      health?.cancel();
    },
    checkNow,
    confirmOrRollback,
  };
}
