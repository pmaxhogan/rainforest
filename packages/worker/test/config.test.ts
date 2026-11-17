import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ownerConfig, type Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { BASE_URL } from "./constants.ts";
import { testEnv } from "./helpers.ts";

/** Hardcoded: the five owner secrets the Worker must refuse to run without. */
const SECRETS = [
  "PUBLIC_BASE_URL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "OWNER_EMAIL",
  "APP_PASSWORD_SHA256",
] as const;

/** One malformed value per secret, each of which must disable the Worker. */
const MALFORMED: Record<(typeof SECRETS)[number], string[]> = {
  PUBLIC_BASE_URL: [
    "http://hub.example.com",
    "https://hub.example.com/path",
    "hub.example.com",
    " ",
  ],
  ACCESS_TEAM_DOMAIN: [
    "team.example.com",
    "https://team.cloudflareaccess.com",
    "evil.com/.cloudflareaccess.com",
  ],
  ACCESS_AUD: ["not-hex", "ab".repeat(8), "zz".repeat(32)],
  OWNER_EMAIL: ["not-an-email", "a@b@c", "owner @example.com"],
  APP_PASSWORD_SHA256: ["ab".repeat(31), "AB".repeat(31) + "zz", "plain-password-value"],
};

/** Every route family the Worker serves. All but /healthz must be refused. */
const ROUTES: [string, RequestInit][] = [
  ["/mcp", { method: "POST", body: "{}" }],
  ["/authorize", {}],
  ["/authorize", { method: "POST", body: "handle=x" }],
  ["/admin", {}],
  ["/admin", { method: "POST", body: "csrf=x" }],
  ["/devices/ws", { headers: { upgrade: "websocket" } }],
  ["/pair/start", { method: "POST", body: "{}" }],
  ["/pair/status", { method: "POST", body: "{}" }],
  ["/oauth/register", { method: "POST", body: "{}" }],
  ["/oauth/token", { method: "POST", body: "grant_type=x" }],
  ["/.well-known/oauth-authorization-server", {}],
  ["/.well-known/oauth-protected-resource", {}],
  ["/.well-known/oauth-protected-resource/mcp", {}],
  ["/does-not-exist", {}],
];

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE_URL}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function without(name: string, value?: string): Env {
  const env = { ...testEnv } as Record<string, unknown>;
  if (value === undefined) delete env[name];
  else env[name] = value;
  return env as unknown as Env;
}

describe("fail closed when owner configuration is missing or malformed", () => {
  it("the test env itself is fully configured", async () => {
    expect(ownerConfig(testEnv)).not.toBeNull();
    const response = await call(testEnv, "/healthz");
    expect(await response.json()).toMatchObject({ ok: true, configured: true });
  });

  it("the secret list matches the configuration the Worker reads", () => {
    for (const name of SECRETS) {
      expect(ownerConfig(without(name)), name).toBeNull();
      expect(MALFORMED[name].length, name).toBeGreaterThan(0);
    }
  });

  for (const name of SECRETS) {
    it(`missing ${name}: every route but /healthz is 503, /healthz says configured: false`, async () => {
      const env = without(name);
      for (const [path, init] of ROUTES) {
        const response = await call(env, path, init);
        expect(response.status, `${name} ${init.method ?? "GET"} ${path}`).toBe(503);
      }
      const health = await call(env, "/healthz");
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ configured: false });
    });

    it(`malformed ${name}: every route but /healthz is 503`, async () => {
      for (const value of MALFORMED[name]) {
        const env = without(name, value);
        expect(ownerConfig(env), `${name}=${value}`).toBeNull();
        for (const [path, init] of ROUTES) {
          const response = await call(env, path, init);
          expect(response.status, `${name}=${value} ${path}`).toBe(503);
        }
        const health = await call(env, "/healthz");
        expect(await health.json()).toMatchObject({ configured: false });
      }
    });
  }

  it("an empty string counts as missing", async () => {
    for (const name of SECRETS) {
      expect(ownerConfig(without(name, "")), name).toBeNull();
      expect((await call(without(name, ""), "/admin")).status).toBe(503);
    }
  });

  it("/healthz never leaks configuration values", async () => {
    const text = await (await call(testEnv, "/healthz")).text();
    expect(text).not.toContain("example.com");
    expect(text).not.toContain(String(testEnv.ACCESS_AUD));
    expect(text).not.toContain(String(testEnv.APP_PASSWORD_SHA256));
  });
});
