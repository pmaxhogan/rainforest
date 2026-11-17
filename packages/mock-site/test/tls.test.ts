import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import { request } from "node:https";
import { describe, expect, it } from "vitest";
import { createMockSite } from "../src/index.ts";
import { makeEphemeralCert } from "../e2e/tls.ts";

describe("ephemeral TLS certificate (e2e harness)", () => {
  const host = "www.amazon.com";

  it("is a valid self-signed certificate for the name, generated in memory", () => {
    const cert = makeEphemeralCert(host, 7, new Date("2026-11-16T00:00:00Z"));
    const x = new X509Certificate(cert.cert);
    expect(x.subject).toBe(`CN=${host}`);
    expect(x.subjectAltName).toBe(`DNS:${host}`);
    expect(x.checkHost(host)).toBe(host);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    expect(new Date(x.validFrom).toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(new Date(x.validTo).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    const spki = createPublicKey(cert.key).export({ type: "spki", format: "der" });
    expect(cert.spkiHash).toBe(createHash("sha256").update(spki).digest("base64"));
    expect(makeEphemeralCert(host).spkiHash).not.toBe(cert.spkiHash);
  });

  it("serves the mock over HTTPS and verifies against itself", async () => {
    const cert = makeEphemeralCert(host);
    const site = await createMockSite({ tls: { key: cert.key, cert: cert.cert } });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: site.port, path: "/", ca: cert.cert, servername: host },
          (res) => {
            let text = "";
            res.on("data", (d: Buffer) => (text += d.toString()));
            res.on("end", () => resolve(text));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body).toContain("Example storefront");
      expect(site.origin).toMatch(/^https:/);
    } finally {
      await site.close();
    }
  });
});
