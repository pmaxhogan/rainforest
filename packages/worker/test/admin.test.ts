import { reset } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL } from "./constants.ts";
import {
  closeAllSockets,
  connectDevice,
  cookiesFrom,
  freshIp,
  hubStub,
  makeDeviceKey,
  makeRsaKey,
  mockJwks,
  ownerClaims,
  pairDevice,
  pairStart,
  pairStatus,
  request,
  signJwt,
  useFreshIp,
  type JwksMock,
  type RsaKey,
} from "./helpers.ts";

let key: RsaKey;
let jwks: JwksMock;
let jwt: string;

beforeAll(async () => {
  key = await makeRsaKey("kid-admin");
});

beforeEach(async () => {
  useFreshIp();
  jwks = mockJwks(() => [key.jwk]);
  jwt = await signJwt(ownerClaims(), key);
});

afterEach(async () => {
  closeAllSockets();
  jwks.restore();
  await reset();
});

async function adminPage(): Promise<{
  html: string;
  csrf: string;
  cookie: string;
  response: Response;
}> {
  const response = await request("/admin", { headers: { "cf-access-jwt-assertion": jwt } });
  const html = await response.text();
  const cookie = cookiesFrom(response);
  const csrf = /__Host-rf-admin-csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  return { html, csrf, cookie, response };
}

interface PostOptions {
  jwt?: string | null;
  cookie?: string | null;
  origin?: string | null;
}

async function adminPost(fields: Record<string, string>, options: PostOptions = {}) {
  const page = await adminPage();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const token = options.jwt === undefined ? jwt : options.jwt;
  if (token) headers["cf-access-jwt-assertion"] = token;
  const cookie = options.cookie === undefined ? page.cookie : options.cookie;
  if (cookie) headers.cookie = cookie;
  const origin = options.origin === undefined ? BASE_URL : options.origin;
  if (origin) headers.origin = origin;
  const body = new URLSearchParams({ csrf: page.csrf, ...fields });
  return request("/admin", { method: "POST", headers, body: body.toString() });
}

async function startPairing(
  name: string,
): Promise<{ code: string; device_id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> }> {
  const k = await makeDeviceKey();
  const response = await pairStart({ public_key: k.publicKey, name, os: "macos" }, freshIp());
  const body = (await response.json()) as { code: string; device_id: string };
  return { ...body, key: k };
}

describe("/admin access", () => {
  it("401 without an owner JWT, or with someone else's", async () => {
    expect((await request("/admin")).status).toBe(401);
    const other = await signJwt(ownerClaims({ email: "someone@example.com" }), key);
    expect(
      (await request("/admin", { headers: { "cf-access-jwt-assertion": other } })).status,
    ).toBe(401);
    const post = await request("/admin", {
      method: "POST",
      headers: { origin: BASE_URL },
      body: "csrf=x",
    });
    expect(post.status).toBe(401);
  });

  it("renders for the owner with hardened headers and a __Host- CSRF cookie", async () => {
    const page = await adminPage();
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.response.headers.get("cache-control")).toBe("no-store");
    const setCookie = page.response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(
      /__Host-rf-admin-csrf=[0-9a-f]{48}; Path=\/; Secure; HttpOnly; SameSite=Strict/,
    );
    expect(page.html).toContain("No pending pairings");
  });
});

describe("/admin CSRF and origin", () => {
  it("approves a pairing with JWT + CSRF cookie and field + same Origin", async () => {
    const pairing = await startPairing("Desk Mac");
    const response = await adminPost({ action: "approve", code: pairing.code });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pairing approved.");
    expect(await (await pairStatus(pairing.key, pairing.device_id)).json()).toEqual({
      status: "approved",
    });
  });

  const refusals: [string, PostOptions | "field", number][] = [
    ["no JWT", { jwt: null }, 401],
    ["no CSRF cookie", { cookie: null }, 400],
    ["mismatched CSRF cookie", { cookie: `__Host-rf-admin-csrf=${"0".repeat(48)}` }, 400],
    ["no CSRF field", "field", 400],
    ["no Origin", { origin: null }, 400],
    ["foreign Origin", { origin: "https://evil.example.com" }, 400],
    ["Origin null", { origin: "null" }, 400],
  ];
  for (const [label, options, status] of refusals) {
    it(`refuses approval with ${label}`, async () => {
      const pairing = await startPairing("Desk Mac");
      let response: Response;
      if (options === "field") {
        const page = await adminPage();
        response = await request("/admin", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-access-jwt-assertion": jwt,
            cookie: page.cookie,
            origin: BASE_URL,
          },
          body: new URLSearchParams({ action: "approve", code: pairing.code }).toString(),
        });
      } else {
        response = await adminPost({ action: "approve", code: pairing.code }, options);
      }
      expect(response.status).toBe(status);
      expect(await (await pairStatus(pairing.key, pairing.device_id)).json()).toEqual({
        status: "pending",
      });
    });
  }

  it("a short CSRF token that matches its cookie is still refused", async () => {
    const pairing = await startPairing("Desk Mac");
    const response = await request("/admin", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-access-jwt-assertion": jwt,
        cookie: "__Host-rf-admin-csrf=abc",
        origin: BASE_URL,
      },
      body: new URLSearchParams({ csrf: "abc", action: "approve", code: pairing.code }).toString(),
    });
    expect(response.status).toBe(400);
  });

  it("unknown actions are refused", async () => {
    expect((await adminPost({ action: "drop_tables" })).status).toBe(400);
  });

  it("reject, and a code that is not pending", async () => {
    const pairing = await startPairing("Desk Mac");
    expect(await (await adminPost({ action: "reject", code: pairing.code })).text()).toContain(
      "Pairing rejected.",
    );
    expect(await (await pairStatus(pairing.key, pairing.device_id)).json()).toEqual({
      status: "rejected",
    });
    expect(await (await adminPost({ action: "approve", code: pairing.code })).text()).toContain(
      "That code is not pending.",
    );
  });

  it("revoke closes the device's live socket", async () => {
    const device = await pairDevice("Desk Mac");
    const socket = await connectDevice(device);
    const response = await adminPost({ action: "revoke", device_id: device.deviceId });
    expect(await response.text()).toContain("Device revoked.");
    expect(await socket.closed).toMatchObject({ code: 1008, reason: "revoked" });
  });
});

describe("/admin escaping", () => {
  it("escapes device and pairing names allowed by the name regex", async () => {
    // The worst the regex lets through: quotes and parentheses (no '=', '<', '>' or '"').
    const hostile = "x' onmouseover 'alert(1)' (a)";
    const pending = await startPairing(hostile);
    expect(pending.code).toBeTruthy();
    const device = await pairDevice(`${hostile} paired`);
    // Names and aliases set through the Hub RPC skip the pairing regex entirely.
    await hubStub().updateDevice(device.deviceId, `${hostile} <b>"paired"</b>`, [
      "<img src=x onerror=alert(1)>",
    ]);
    const { html } = await adminPage();
    expect(html).not.toContain("x' onmouseover");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>");
    expect(html).toContain("x&#39; onmouseover &#39;alert(1)&#39; (a)");
    expect(html).toContain("&#60;b&#62;&#34;paired&#34;&#60;/b&#62;");
    expect(html).toContain("&#60;img src=x onerror=alert(1)&#62;");
  });

  it("the name regex refuses angle brackets and quotes outright", async () => {
    const k = await makeDeviceKey();
    for (const name of ["<script>alert(1)</script>", "a<b", 'a"b', "a`b", "a&b"]) {
      const response = await pairStart({ public_key: k.publicKey, name, os: "macos" }, freshIp());
      expect(response.status, name).toBe(400);
    }
  });
});
