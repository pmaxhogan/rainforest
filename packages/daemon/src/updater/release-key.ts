// Ed25519 public keys (base64 SPKI DER) that may sign a release manifest. An array so a key
// can rotate: add the new key, ship, then drop the old one. Generate a pair with
// `node scripts/release-keygen.mjs`; the private half lives only in the release signing secret.
// The placeholder below is not a key: release builds refuse to run while it is the only entry.
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEARroPV3ul069OaDlgJqPXjsaIIxsmgC4ashJ4bx/Dn2s=",
];
