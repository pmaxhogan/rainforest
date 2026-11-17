import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { compareVersions } from "@rainforest/core";

/**
 * Release verification. Pure functions: bytes in, verdict out. A release is accepted
 * only when the manifest signature verifies against a key embedded in the RUNNING
 * version, the tarball matches the manifest's size and SHA-256, the version is strictly
 * newer than the running one, and the archive contains nothing but regular files under
 * its single expected top-level directory.
 */

export const manifestSchema = z.object({
  schema: z.literal(1),
  version: z.string().regex(/^[0-9]+(\.[0-9]+){1,3}$/),
  tarball: z.string().regex(/^rainforestd-[0-9.]+\.tgz$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024),
  min_node: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  created_at: z.string().max(40),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export type Manifest = z.infer<typeof manifestSchema>;

export class UpdateRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UpdateRejected";
    this.code = code;
  }
}

/** True when `signatureB64` is a valid Ed25519 signature of `bytes` by any of the keys. */
export function signatureValid(
  bytes: Uint8Array,
  signatureB64: string,
  publicKeys: readonly string[],
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64.trim(), "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  for (const key of publicKeys) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      if (publicKey.asymmetricKeyType !== "ed25519") continue;
      if (edVerify(null, bytes, publicKey, signature)) return true;
    } catch {
      // Not a usable key (for example a placeholder): try the next one.
    }
  }
  return false;
}

/** Verify signature first, then parse. Never parses unauthenticated bytes into decisions. */
export function verifyManifest(
  bytes: Uint8Array,
  signatureB64: string,
  publicKeys: readonly string[],
): Manifest {
  if (publicKeys.length === 0)
    throw new UpdateRejected("no_keys", "no release keys are embedded in this build");
  if (bytes.length > 4096) throw new UpdateRejected("manifest_too_large", "manifest is too large");
  if (!signatureValid(bytes, signatureB64, publicKeys)) {
    throw new UpdateRejected("bad_signature", "manifest signature does not verify");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new UpdateRejected("bad_manifest", "manifest is not JSON");
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new UpdateRejected("bad_manifest", "manifest has an unexpected shape");
  if (parsed.data.tarball !== `rainforestd-${parsed.data.version}.tgz`) {
    throw new UpdateRejected("bad_manifest", "tarball name does not match the version");
  }
  return parsed.data;
}

/** Refuse anything that is not strictly newer, and anything this Node cannot run. */
export function checkUpgrade(
  manifest: Manifest,
  currentVersion: string,
  nodeVersion: string,
  badVersions: readonly string[],
): void {
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    throw new UpdateRejected(
      "not_newer",
      `version ${manifest.version} is not newer than ${currentVersion}`,
    );
  }
  if (badVersions.includes(manifest.version)) {
    throw new UpdateRejected(
      "marked_bad",
      `version ${manifest.version} failed before on this computer`,
    );
  }
  if (compareVersions(nodeVersion.replace(/^v/, ""), manifest.min_node) < 0) {
    throw new UpdateRejected(
      "node_too_old",
      `version ${manifest.version} needs Node ${manifest.min_node}`,
    );
  }
}

export function verifyTarball(tarball: Uint8Array, manifest: Manifest): void {
  if (tarball.length !== manifest.size)
    throw new UpdateRejected("bad_size", "tarball size does not match the manifest");
  const digest = createHash("sha256").update(tarball).digest("hex");
  if (digest !== manifest.sha256)
    throw new UpdateRejected("bad_hash", "tarball hash does not match the manifest");
}

export interface TarFile {
  /** Path relative to the top-level directory, with forward slashes. */
  path: string;
  data: Uint8Array;
}

const BLOCK = 512;

function cString(buffer: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && buffer[end] !== 0) end++;
  return Buffer.from(buffer.subarray(start, end)).toString("utf8");
}

function octal(buffer: Uint8Array, start: number, length: number): number {
  const text = cString(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(text))
    throw new UpdateRejected("bad_archive", "archive header is malformed");
  return text ? Number.parseInt(text, 8) : 0;
}

function paxPath(data: Uint8Array): string | null {
  const text = Buffer.from(data).toString("utf8");
  let pos = 0;
  let found: string | null = null;
  while (pos < text.length) {
    const space = text.indexOf(" ", pos);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(pos, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, pos + length - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") found = record.slice(eq + 1);
    pos += length;
  }
  return found;
}

/**
 * Unpack a release tarball in memory. Only regular files are accepted; every path must
 * sit under `expectedTop/` and be free of `..`, absolute paths, drive letters and
 * backslashes. Anything else rejects the whole archive.
 */
export function readReleaseTarball(tarball: Uint8Array, expectedTop: string): TarFile[] {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(tarball, { maxOutputLength: 400 * 1024 * 1024 });
  } catch {
    throw new UpdateRejected("bad_archive", "tarball is not valid gzip");
  }
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let pos = 0;
  let longName: string | null = null;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] ?? 0);
    const dataStart = pos + BLOCK;
    if (dataStart + size > tar.length)
      throw new UpdateRejected("bad_archive", "archive is truncated");
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (flag === "g") continue;
    if (flag === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (flag === "5") {
      // Directory entries carry no data; they are implied by the files.
      continue;
    }
    if (flag !== "0" && flag !== "\0")
      throw new UpdateRejected("bad_archive", "archive contains a link or special entry");
    if (raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) {
      throw new UpdateRejected("bad_archive", "archive contains an unsafe path");
    }
    const parts = raw.split("/");
    if (parts.some((p) => p === "" || p === "." || p === ".."))
      throw new UpdateRejected("bad_archive", "archive contains an unsafe path");
    if (parts[0] !== expectedTop || parts.length < 2)
      throw new UpdateRejected("bad_archive", "archive has an unexpected top-level entry");
    const relative = parts.slice(1).join("/");
    if (seen.has(relative.toLowerCase()))
      throw new UpdateRejected("bad_archive", "archive contains a duplicate path");
    seen.add(relative.toLowerCase());
    files.push({ path: relative, data });
  }
  const required = ["rainforestd.mjs", "launcher.mjs", "package.json", "VERSION"];
  for (const file of required) {
    if (!files.some((f) => f.path === file))
      throw new UpdateRejected("bad_archive", `archive is missing ${file}`);
  }
  return files;
}
