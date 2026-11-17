import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * An ephemeral self-signed TLS certificate for the storefront hostname, built at test time
 * with node:crypto (which can make keys but not certificates, so the X.509 structure is
 * DER-encoded by hand). The private key only ever lives in memory: nothing here touches
 * the disk, and no key or certificate is committed.
 *
 * The test browser trusts the certificate by its public key hash
 * (`--ignore-certificate-errors-spki-list`), so no CA is installed anywhere.
 */

export interface EphemeralCert {
  /** PKCS#8 PEM private key (in memory only). */
  key: string;
  /** PEM certificate. */
  cert: string;
  /** base64(SHA-256(SubjectPublicKeyInfo)), the form Chromium's SPKI allowlist takes. */
  spkiHash: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const seq = (...c: Buffer[]): Buffer => tlv(0x30, ...c);
const set = (...c: Buffer[]): Buffer => tlv(0x31, ...c);

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let v = part;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(bytes: Buffer): Buffer {
  // Positive, minimal encoding.
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function utcTime(date: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s =
    `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}

function name(commonName: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64.trimEnd()}\n-----END ${label}-----\n`;
}

/** A P-256 certificate for `hostname`, valid from a day ago for `days` days. */
export function makeEphemeralCert(hostname: string, days = 7, now = new Date()): EphemeralCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now.getTime() + days * 24 * 3600_000);
  const san = seq(tlv(0x82, Buffer.from(hostname, "ascii")));
  const extensions = tlv(
    0xa3,
    seq(
      extension("2.5.29.17", false, san),
      extension("2.5.29.19", true, seq()),
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
      extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))),
    ),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ecdsaSha256,
    name(hostname),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(hostname),
    spki,
    extensions,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const certificate = seq(
    tbs,
    ecdsaSha256,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem("CERTIFICATE", certificate),
    spkiHash: createHash("sha256").update(spki).digest("base64"),
  };
}
