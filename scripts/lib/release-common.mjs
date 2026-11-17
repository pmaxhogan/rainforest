// Shared helpers for the release scripts (package-daemon, sign-manifest, verify-release).
// Node built-ins only, so the signing and verification steps never need third-party code.
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MANIFEST_SCHEMA = 1;
export const MIN_NODE = "22.0.0";
export const PLACEHOLDER_KEY = "REPLACE_WITH_PUBLIC_KEY";
export const KEY_FILE = join(REPO_ROOT, "packages", "daemon", "src", "updater", "release-key.ts");

/** A version is also a directory name under versions/, so it must satisfy the daemon's rule. */
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const BASE_VERSION = /^[0-9]+(\.[0-9]+)*$/;

export function isValidVersion(version) {
  return typeof version === "string" && VERSION_NAME.test(version) && !version.includes("..");
}

export function tarballName(version) {
  return `rainforestd-${version}.tgz`;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** `<VERSION file>.<commit count on HEAD>`: deterministic, so re-runs are idempotent. */
export function computeVersion(root = REPO_ROOT) {
  const base = readFileSync(join(root, "VERSION"), "utf8").trim();
  if (!BASE_VERSION.test(base)) throw new Error("VERSION must look like 0.1 (digits and dots)");
  if (git(root, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error("shallow clone: the commit count is wrong, fetch full history");
  }
  const count = git(root, ["rev-list", "--count", "HEAD"]);
  const version = `${base}.${count}`;
  if (!isValidVersion(version)) throw new Error(`computed version is not valid: ${version}`);
  return version;
}

export function headCommit(root = REPO_ROOT) {
  return git(root, ["rev-parse", "HEAD"]);
}

/** Committer time of HEAD in UTC, or SOURCE_DATE_EPOCH: re-runs are byte-identical. */
export function createdAt(root = REPO_ROOT, env = process.env) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch && /^[0-9]+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date(git(root, ["show", "-s", "--format=%cI", "HEAD"])).toISOString();
}

/** Manifest as the exact bytes that get signed (compact JSON, no trailing newline). */
export function buildManifest(fields) {
  const manifest = {
    schema: MANIFEST_SCHEMA,
    version: fields.version,
    tarball: tarballName(fields.version),
    sha256: sha256Hex(fields.tarballBytes),
    size: fields.tarballBytes.length,
    min_node: MIN_NODE,
    created_at: fields.createdAt,
    commit: fields.commit,
  };
  return { manifest, bytes: Buffer.from(JSON.stringify(manifest), "utf8") };
}

// ---- release public keys ------------------------------------------------------------

/** Pull the quoted strings out of the `RELEASE_PUBLIC_KEYS` array literal in release-key.ts. */
export function parsePublicKeys(source) {
  const match = /export const RELEASE_PUBLIC_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(source);
  if (!match) throw new Error("RELEASE_PUBLIC_KEYS array not found");
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

export function readPublicKeys(file = KEY_FILE) {
  return parsePublicKeys(readFileSync(file, "utf8"));
}

/** Real Ed25519 SPKI keys only; the placeholder and anything malformed is dropped. */
export function usablePublicKeys(keys) {
  const usable = [];
  for (const key of keys) {
    if (key === PLACEHOLDER_KEY) continue;
    try {
      const keyObject = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      if (keyObject.asymmetricKeyType === "ed25519") usable.push(key);
    } catch {
      // Not a key: ignore it.
    }
  }
  return usable;
}

/** Refuse a release build that has no real public key to verify against. */
export function assertReleaseKeys(keys) {
  if (usablePublicKeys(keys).length === 0) {
    throw new Error(
      "no usable release public key (only the placeholder is committed): " +
        "run scripts/release-keygen.mjs and paste the public key into release-key.ts",
    );
  }
}

// ---- build-path leak check ----------------------------------------------------------

/** Strings that must never appear inside a release artifact. */
export function buildPathNeedles(root = REPO_ROOT, extra = []) {
  const candidates = [
    root,
    homedir(),
    process.env.GITHUB_WORKSPACE,
    process.env.RUNNER_WORKSPACE,
    process.env.RUNNER_TEMP,
    ...extra,
  ];
  const needles = new Set();
  for (const candidate of candidates) {
    if (!candidate || candidate.length < 5) continue;
    const trimmed = candidate.replace(/[\\/]+$/, "");
    needles.add(trimmed);
    needles.add(trimmed.replaceAll("\\", "/"));
    needles.add(trimmed.replaceAll("/", "\\"));
    needles.add(pathToFileURL(candidate).href.replace(/^file:\/+/, ""));
  }
  return [...needles].filter((n) => n.length >= 5);
}

/** Returns the needles found in the decompressed tarball (names and contents). Never the content. */
export function findBuildPathLeaks(tarball, needles) {
  const raw = gunzipSync(tarball);
  return needles.filter((needle) => raw.includes(Buffer.from(needle, "utf8")));
}
