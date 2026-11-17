import { generateKeyPairSync, createPrivateKey, sign as edSign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { readTextIfExists, writeSecretFile, type SecretWriteDeps } from "./fsutil.ts";
import type { AppPaths } from "./paths.ts";

/**
 * The device key: one Ed25519 keypair per installation. The private key never leaves
 * this machine; the hub only ever sees the public key (at pairing) and signatures.
 */

const keyFileSchema = z.object({
  /** base64url of the raw 32-byte public key. */
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** base64 of the PKCS8 DER private key. */
  private_key: z.string().min(40).max(200),
});

export interface DeviceKey {
  publicKey: string;
  /** Sign a UTF-8 message; returns a base64url signature. */
  sign(message: string): string;
}

function fromPrivate(privateKey: KeyObject, publicKey: string): DeviceKey {
  return {
    publicKey,
    sign: (message) => edSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

export function loadDeviceKey(paths: AppPaths): DeviceKey | null {
  const text = readTextIfExists(paths.deviceKeyFile);
  if (text === null) return null;
  let parsed: z.infer<typeof keyFileSchema>;
  try {
    parsed = keyFileSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(parsed.private_key, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return fromPrivate(privateKey, parsed.public_key);
}

/** Create and store a new device key. Refuses to overwrite an existing one. */
export async function createDeviceKey(paths: AppPaths, deps: SecretWriteDeps): Promise<DeviceKey> {
  if (readTextIfExists(paths.deviceKeyFile) !== null)
    throw new Error("a device key already exists");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("could not export the public key");
  const file = {
    public_key: jwk.x,
    private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  await writeSecretFile(paths.deviceKeyFile, `${JSON.stringify(file)}\n`, deps);
  return fromPrivate(privateKey, file.public_key);
}
