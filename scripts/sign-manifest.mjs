#!/usr/bin/env node
// Sign dist/release/manifest.json with the release private key.
//
//   RELEASE_SIGNING_KEY=<base64 PKCS8 DER> node scripts/sign-manifest.mjs [dir]
//
// Writes manifest.sig: base64 (single line, no newline) Ed25519 signature over the exact
// bytes of manifest.json. Refuses to sign unless the matching public key is committed in
// release-key.ts, so a placeholder or a wrong secret fails here and not on a user's machine.
// Node built-ins only: the signing step runs without any installed dependency.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  assertReleaseKeys,
  readPublicKeys,
  usablePublicKeys,
} from "./lib/release-common.mjs";

/** Sign `<dir>/manifest.json`. `publicKeys` defaults to the keys committed in the repo. */
export function signManifest({ dir, privateKey, publicKeys = readPublicKeys() }) {
  if (!privateKey) throw new Error("RELEASE_SIGNING_KEY is not set");
  assertReleaseKeys(publicKeys);
  let key;
  try {
    key = createPrivateKey({
      key: Buffer.from(privateKey.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("RELEASE_SIGNING_KEY is not a base64 PKCS8 DER private key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RELEASE_SIGNING_KEY is not Ed25519");
  const derived = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
  if (!usablePublicKeys(publicKeys).includes(derived)) {
    throw new Error("the signing key does not match any public key committed in release-key.ts");
  }
  const manifestPath = join(resolve(dir), "manifest.json");
  const signature = sign(null, readFileSync(manifestPath), key).toString("base64");
  const sigPath = join(resolve(dir), "manifest.sig");
  writeFileSync(sigPath, signature);
  return { sigPath, signature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const dir = process.argv[2] ?? join(REPO_ROOT, "dist", "release");
    const { sigPath } = signManifest({ dir, privateKey: process.env.RELEASE_SIGNING_KEY });
    console.log(`signed manifest: ${sigPath}`);
  } catch (error) {
    console.error(`sign-manifest: ${error.message}`);
    process.exit(1);
  }
}
