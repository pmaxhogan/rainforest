import { reset } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_AUD, BASE_URL, TEAM_DOMAIN, TEST_PASSWORD } from "./constants.ts";
import {
  authorizeQuery,
  hs256Jwt,
  makeRsaKey,
  mockJwks,
  noneJwt,
  ownerClaims,
  pkce,
  postConsent,
  registerClient,
  request,
  signJwt,
  startConsent,
  useFreshIp,
  type Client,
  type JwksMock,
  type RsaKey,
} from "./helpers.ts";

let key: RsaKey;
let otherKey: RsaKey;
let jwks: JwksMock;

beforeAll(async () => {
  key = await makeRsaKey("kid-consent");
  otherKey = await makeRsaKey("kid-other");
});

beforeEach(() => {
  useFreshIp();
  jwks = mockJwks(() => [key.jwk]);
});

afterEach(async () => {
  jwks.restore();
  await reset();
});

async function consentGet(headers: Record<string, string>, client?: Client): Promise<Response> {
  const c = client ?? (await registerClient());
  const { challenge } = await pkce();
  return request(authorizeQuery(c, challenge), { headers });
}

function locationCode(response: Response): string | null {
  const location = response.headers.get("location");
  return location ? new URL(location).searchParams.get("code") : null;
}

describe("Access JWT gate on /authorize", () => {
  it("no Access JWT -> 401 on GET and POST", async () => {
    expect((await consentGet({})).status).toBe(401);
    const post = await postConsent(null, "", {
      handle: "x",
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(post.status).toBe(401);
  });

  it("accepts the JWT from the CF_Authorization cookie too", async () => {
    const jwt = await signJwt(ownerClaims(), key);
    expect((await consentGet({ cookie: `CF_Authorization=${jwt}` })).status).toBe(200);
  });

  it("owner email match is case-insensitive", async () => {
    const jwt = await signJwt(ownerClaims({ email: "Owner@Example.COM" }), key);
    expect((await consentGet({ "cf-access-jwt-assertion": jwt })).status).toBe(200);
  });

  // Each entry is a distinct way a token must be refused. Hardcoded, not generated.
  const refusals: [string, () => Promise<string>][] = [
    ["another email", () => signJwt(ownerClaims({ email: "someone@example.com" }), key)],
    ["no email", () => signJwt(ownerClaims({ email: undefined }), key)],
    ["expired", () => signJwt(ownerClaims({ exp: Math.floor(Date.now() / 1000) - 10 }), key)],
    ["no exp", () => signJwt(ownerClaims({ exp: undefined }), key)],
    [
      "nbf in the future",
      () => signJwt(ownerClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 }), key),
    ],
    ["wrong audience", () => signJwt(ownerClaims({ aud: ["cd".repeat(32)] }), key)],
    ["no audience", () => signJwt(ownerClaims({ aud: undefined }), key)],
    ["string audience mismatch", () => signJwt(ownerClaims({ aud: "cd".repeat(32) }), key)],
    ["wrong issuer", () => signJwt(ownerClaims({ iss: "https://evil.cloudflareaccess.com" }), key)],
    ["issuer without scheme", () => signJwt(ownerClaims({ iss: TEAM_DOMAIN }), key)],
    ["alg none", async () => noneJwt(ownerClaims(), key.kid)],
    ["HS256 with the public key as secret", () => hs256Jwt(ownerClaims(), key)],
    [
      "signed by a different key under the right kid",
      () => signJwt(ownerClaims(), { ...otherKey, kid: key.kid }),
    ],
    ["unknown kid", () => signJwt(ownerClaims(), otherKey)],
    ["no kid", () => signJwt(ownerClaims(), key, { kid: undefined })],
    [
      "tampered payload",
      async () => {
        const jwt = await signJwt(ownerClaims({ email: "someone@example.com" }), key);
        const [h, , s] = jwt.split(".");
        const good = (await signJwt(ownerClaims(), key)).split(".")[1];
        return `${h}.${good}.${s}`;
      },
    ],
    [
      "two segments",
      async () => (await signJwt(ownerClaims(), key)).split(".").slice(0, 2).join("."),
    ],
    ["garbage", async () => "not-a-jwt"],
  ];

  for (const [label, make] of refusals) {
    it(`refuses: ${label}`, async () => {
      const jwt = await make();
      const response = await consentGet({ "cf-access-jwt-assertion": jwt });
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("the refusal list covers the cases the spec names", () => {
    const labels = refusals.map(([l]) => l);
    for (const required of [
      "another email",
      "expired",
      "wrong audience",
      "wrong issuer",
      "alg none",
      "HS256 with the public key as secret",
      "signed by a different key under the right kid",
    ])
      expect(labels).toContain(required);
  });

  it("an unknown kid forces exactly one JWKS refetch, then refuses", async () => {
    const good = await signJwt(ownerClaims(), key);
    expect((await consentGet({ "cf-access-jwt-assertion": good })).status).toBe(200);
    const before = jwks.fetches();
    const unknown = await signJwt(ownerClaims(), otherKey);
    expect((await consentGet({ "cf-access-jwt-assertion": unknown })).status).toBe(401);
    expect(jwks.fetches() - before).toBe(1);
  });

  it("a rotated key is picked up after one refetch", async () => {
    jwks.restore();
    let keys = [key.jwk];
    jwks = mockJwks(() => keys);
    expect(
      (await consentGet({ "cf-access-jwt-assertion": await signJwt(ownerClaims(), key) })).status,
    ).toBe(200);
    keys = [otherKey.jwk];
    const rotated = await signJwt(ownerClaims(), otherKey);
    expect((await consentGet({ "cf-access-jwt-assertion": rotated })).status).toBe(200);
  });

  it("a JWKS outage fails closed", async () => {
    jwks.restore();
    jwks = mockJwks(() => {
      throw new Error("certs down");
    });
    const jwt = await signJwt(ownerClaims(), key);
    expect((await consentGet({ "cf-access-jwt-assertion": jwt })).status).toBe(401);
  });
});

describe("password and handle on POST /authorize", () => {
  async function begin(): Promise<{ jwt: string; handle: string; cookie: string }> {
    const jwt = await signJwt(ownerClaims(), key);
    const client = await registerClient();
    const { challenge } = await pkce();
    const consent = await startConsent(jwt, client, challenge);
    return { jwt, handle: consent.handle, cookie: consent.cookie };
  }

  it("wrong password -> 403 and no code; the same handle still works with the right one", async () => {
    const { jwt, handle, cookie } = await begin();
    const wrong = await postConsent(jwt, cookie, {
      handle,
      password: "wrong-password-but-long-enough-000",
      decision: "approve",
    });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("location")).toBeNull();
    const right = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(right.status).toBe(302);
    expect(locationCode(right)).toBeTruthy();
  });

  it("a password shorter than the minimum is refused even if it were right", async () => {
    const { jwt, handle, cookie } = await begin();
    const response = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD.slice(0, 21),
      decision: "approve",
    });
    expect(response.status).toBe(403);
  });

  it("missing password -> 403", async () => {
    const { jwt, handle, cookie } = await begin();
    const response = await postConsent(jwt, cookie, { handle, decision: "approve" });
    expect(response.status).toBe(403);
  });

  it("missing handle -> 400", async () => {
    const { jwt, cookie } = await begin();
    const response = await postConsent(jwt, cookie, {
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(response.status).toBe(400);
    expect(locationCode(response)).toBeNull();
  });

  it("forged handle -> refused, no code", async () => {
    const { jwt, cookie } = await begin();
    const response = await postConsent(jwt, cookie, {
      handle: "forged-handle-0000000000000000",
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(response.status).toBe(400);
    expect(locationCode(response)).toBeNull();
  });

  it("a valid handle without its binding cookie -> refused", async () => {
    const { jwt, handle } = await begin();
    const response = await postConsent(jwt, "", {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(response.status).toBe(400);
    expect(locationCode(response)).toBeNull();
  });

  it("a handle replayed after use -> refused", async () => {
    const { jwt, handle, cookie } = await begin();
    const first = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(first.status).toBe(302);
    const replay = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(replay.status).toBe(400);
    expect(locationCode(replay)).toBeNull();
  });

  it("POST with a foreign Origin -> 400, no code", async () => {
    const { jwt, handle, cookie } = await begin();
    for (const origin of ["https://evil.example.com", "null", `${BASE_URL}.evil.example.com`]) {
      const response = await postConsent(
        jwt,
        cookie,
        { handle, password: TEST_PASSWORD, decision: "approve" },
        { origin },
      );
      expect(response.status, origin).toBe(400);
      expect(locationCode(response)).toBeNull();
    }
  });

  it("POST with the Access JWT of a different user -> 401", async () => {
    const { handle, cookie } = await begin();
    const other = await signJwt(ownerClaims({ email: "someone@example.com" }), key);
    const response = await postConsent(other, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(response.status).toBe(401);
  });

  it("after 5 wrong passwords the right one is locked out (429) and no code is issued", async () => {
    const { jwt, handle, cookie } = await begin();
    for (let i = 0; i < 5; i++) {
      const wrong = await postConsent(jwt, cookie, {
        handle,
        password: `wrong-password-attempt-number-${i}`,
        decision: "approve",
      });
      expect(wrong.status).toBe(403);
    }
    const locked = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(locked.status).toBe(429);
    expect(locationCode(locked)).toBeNull();
    // The lockout is global, not per IP.
    useFreshIp();
    const elsewhere = await postConsent(jwt, cookie, {
      handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(elsewhere.status).toBe(429);
  });

  it("the per-IP limiter stops a burst of password posts", async () => {
    const { jwt, handle, cookie } = await begin();
    const statuses: number[] = [];
    // RL_STRICT allows 10 per minute per IP. A correct password resets the global lockout
    // counter, so alternate to isolate the limiter from the lockout.
    for (let i = 0; i < 12; i++) {
      const response = await postConsent(jwt, cookie, {
        handle: i % 2 ? handle : "forged-handle-0000000000000000",
        password: TEST_PASSWORD,
        decision: "approve",
      });
      statuses.push(response.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 10)).not.toContain(429);
  });

  it("the consent audience value is a proper 64-hex tag in this suite", () => {
    expect(ACCESS_AUD).toMatch(/^[a-f0-9]{64}$/);
  });
});
