#!/usr/bin/env node
// Print a new Ed25519 release keypair. Run this once, by hand, on a trusted machine.
//
//   node scripts/release-keygen.mjs
//
// Public key (SPKI DER, base64): paste into packages/daemon/src/updater/release-key.ts.
// Private key (PKCS8 DER, base64): store ONLY as the RELEASE_SIGNING_KEY Actions secret
// (and in your own password manager). It is printed once and never written to a file.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

console.log("Public key (commit in release-key.ts):");
console.log(pub);
console.log("");
console.log("Private key (RELEASE_SIGNING_KEY secret, keep secret):");
console.log(priv);
