#!/usr/bin/env node
// Verify a release directory (manifest.json, manifest.sig, the tarball).
//
//   node scripts/verify-release.mjs <dir> [--no-signature] [--public-key <b64>]...
//
// Checks, in order: manifest shape; Ed25519 signature over the exact manifest bytes against
// the committed public keys (skipped with --no-signature, used on forks that have no signing
// key); tarball sha256 and size; the tarball itself (single top-level directory, no links, no
// unsafe paths, VERSION and package.json agree with the manifest). CI runs this before
// publishing and again on the published assets; a human can run it on a downloaded release.
// Node built-ins only.
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  MANIFEST_SCHEMA,
  isValidVersion,
  readPublicKeys,
  sha256Hex,
  tarballName,
  usablePublicKeys,
} from "./lib/release-common.mjs";
import { readTgz } from "./lib/tar-read.mjs";

const REQUIRED_FILES = [
  "rainforestd.mjs",
  "launcher.mjs",
  "package.json",
  "VERSION",
  "node_modules/playwright-core/package.json",
];

function fail(message) {
  throw new Error(message);
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("manifest.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null) fail("manifest.json is not an object");
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`unsupported manifest schema: ${manifest.schema}`);
  if (!isValidVersion(manifest.version)) fail("manifest version is not valid");
  if (manifest.tarball !== tarballName(manifest.version)) fail("manifest tarball name is wrong");
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "")) fail("manifest sha256 is not a hex digest");
  if (!Number.isInteger(manifest.size) || manifest.size <= 0) fail("manifest size is not valid");
  if (typeof manifest.min_node !== "string") fail("manifest min_node is missing");
  if (Number.isNaN(Date.parse(manifest.created_at))) fail("manifest created_at is not a date");
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? "")) fail("manifest commit is not a full sha");
  return manifest;
}

function checkSignature(manifestBytes, sigText, publicKeys) {
  const keys = usablePublicKeys(publicKeys);
  if (keys.length === 0) {
    fail("no usable release public key (the placeholder is not a key); cannot verify a signature");
  }
  const text = sigText.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail("manifest.sig is not single-line base64");
  const signature = Buffer.from(text, "base64");
  const ok = keys.some((key) =>
    verify(
      null,
      manifestBytes,
      createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }),
      signature,
    ),
  );
  if (!ok) fail("manifest signature does not verify against any release public key");
}

function checkTarball(tgz, manifest) {
  let entries;
  try {
    entries = readTgz(tgz);
  } catch {
    return fail("tarball is not a readable gzip tar archive");
  }
  const top = `rainforestd-${manifest.version}`;
  const seen = new Map();
  for (const entry of entries) {
    if (entry.type === "symlink" || entry.type === "hardlink") {
      fail("tarball contains a link entry (not allowed)");
    }
    if (entry.type === "other") fail("tarball contains a special entry (not allowed)");
    const segments = entry.path.split("/").filter((s, i, all) => s !== "" || i === all.length - 1);
    if (
      entry.path.startsWith("/") ||
      /^[A-Za-z]:/.test(entry.path) ||
      segments.includes("..") ||
      segments.includes(".")
    ) {
      fail("tarball contains an unsafe path");
    }
    if (segments[0] !== top) fail(`tarball entry outside the top-level directory ${top}/`);
    if (entry.type === "file") {
      if (seen.has(entry.path)) fail("tarball contains a duplicate path");
      seen.set(entry.path, entry);
    }
  }
  for (const required of REQUIRED_FILES) {
    if (!seen.has(`${top}/${required}`)) fail(`tarball is missing ${required}`);
  }
  const versionFile = seen.get(`${top}/VERSION`).data.toString("utf8").trim();
  if (versionFile !== manifest.version) fail("tarball VERSION does not match the manifest");
  let pkg;
  try {
    pkg = JSON.parse(seen.get(`${top}/package.json`).data.toString("utf8"));
  } catch {
    return fail("tarball package.json is not valid JSON");
  }
  if (pkg.name !== "rainforestd" || pkg.version !== manifest.version || pkg.type !== "module") {
    fail("tarball package.json does not match the manifest");
  }
  return seen.size;
}

/**
 * Verify a release directory. Throws on the first problem; returns a summary on success.
 * `publicKeys` defaults to the keys committed in release-key.ts.
 */
export function verifyRelease(dir, options = {}) {
  const { requireSignature = true, publicKeys = readPublicKeys() } = options;
  const root = resolve(dir);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) fail("manifest.json is missing");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes);

  if (requireSignature) {
    const sigPath = join(root, "manifest.sig");
    if (!existsSync(sigPath)) fail("manifest.sig is missing");
    checkSignature(manifestBytes, readFileSync(sigPath, "utf8"), publicKeys);
  }

  const tarballPath = join(root, manifest.tarball);
  if (!existsSync(tarballPath)) fail(`${manifest.tarball} is missing`);
  const tgz = readFileSync(tarballPath);
  if (tgz.length !== manifest.size) fail("tarball size does not match the manifest");
  if (sha256Hex(tgz) !== manifest.sha256) fail("tarball sha256 does not match the manifest");
  const files = checkTarball(tgz, manifest);
  return { version: manifest.version, sha256: manifest.sha256, size: manifest.size, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        "no-signature": { type: "boolean", default: false },
        "public-key": { type: "string", multiple: true },
      },
      allowPositionals: true,
      strict: true,
    });
    const dir = positionals[0];
    if (!dir) fail("usage: verify-release.mjs <dir> [--no-signature] [--public-key <b64>]...");
    const result = verifyRelease(dir, {
      requireSignature: !values["no-signature"],
      ...(values["public-key"] ? { publicKeys: values["public-key"] } : {}),
    });
    const mode = values["no-signature"]
      ? "hash only (signature NOT checked)"
      : "signature and hash";
    console.log(`verified ${result.version}: ${mode}, ${result.files} files, ${result.size} bytes`);
  } catch (error) {
    console.error(`verify-release: ${error.message}`);
    process.exit(1);
  }
}
