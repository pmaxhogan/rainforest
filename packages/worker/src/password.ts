/**
 * App password check. The password is machine-generated with at least 128 bits of
 * entropy, so a fast hash is sufficient (nothing to brute force) and keeps CPU time
 * tiny. Only its SHA-256 is stored, as a Worker secret. Comparison is constant time.
 */

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time equality of two strings, via HMAC with a fresh random key. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(a)),
    crypto.subtle.sign("HMAC", key, new TextEncoder().encode(b)),
  ]);
  const x = new Uint8Array(ma);
  const y = new Uint8Array(mb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export const MIN_PASSWORD_LENGTH = 22;

/** True when `input` is the app password. A missing or short input or hash is a refusal. */
export async function verifyPassword(
  input: string | null | undefined,
  expectedSha256: string | null | undefined,
): Promise<boolean> {
  if (typeof input !== "string" || typeof expectedSha256 !== "string") return false;
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
  if (input.length < MIN_PASSWORD_LENGTH || input.length > 256) return false;
  return await constantTimeEqual(await sha256Hex(input), expectedSha256);
}
