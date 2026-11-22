import { reset } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE_URL, TEST_PASSWORD } from "./constants.ts";
import {
  closeAllSockets,
  connectClient,
  connectDevice,
  envelope,
  exchangeCode,
  makeRsaKey,
  mcp,
  mockJwks,
  ownerClaims,
  pairDevice,
  pkce,
  postConsent,
  refresh,
  registerClient,
  request,
  signJwt,
  startConsent,
  callTool,
  useFreshIp,
  type JwksMock,
  type RsaKey,
} from "./helpers.ts";

/** Hardcoded on purpose (security-relevant list): every tool the hub must advertise. */
const EXPECTED_TOOLS = [
  "list_browsers",
  "select_browser",
  "show_on_screen",
  "search",
  "get_product",
  "get_variants",
  "get_buying_options",
  "get_media",
  "get_reviews",
  "get_review_summary",
  "get_price_history",
  "get_cart",
  "list_orders",
  "search_orders",
  "get_order",
  "get_invoice",
  "list_subscriptions",
  "list_lists",
  "get_list",
  "get_browsing_history",
  "get_search_history",
  "add_to_cart",
  "set_cart_quantity",
  "remove_from_cart",
  "save_for_later",
  "move_to_cart",
  "delete_saved_item",
  "create_list",
  "update_list",
  "delete_list",
  "add_to_list",
  "remove_from_list",
  "update_list_item",
  "move_list_item",
  "get_status",
  "get_audit_log",
];

/** Tools that change state; they must never be advertised as read-only. */
const NOT_READ_ONLY = [
  "select_browser",
  "show_on_screen",
  "add_to_cart",
  "set_cart_quantity",
  "remove_from_cart",
  "save_for_later",
  "move_to_cart",
  "delete_saved_item",
  "create_list",
  "update_list",
  "delete_list",
  "add_to_list",
  "remove_from_list",
  "update_list_item",
  "move_list_item",
];

const DESTRUCTIVE = ["remove_from_cart", "delete_saved_item", "delete_list", "remove_from_list"];

let key: RsaKey;
let jwks: JwksMock;

beforeAll(async () => {
  key = await makeRsaKey("kid-oauth");
});

beforeEach(() => {
  useFreshIp();
  jwks = mockJwks(() => [key.jwk]);
});

afterEach(async () => {
  closeAllSockets();
  jwks.restore();
  await reset();
});

describe("OAuth metadata", () => {
  it("protected resource metadata names the MCP URL exactly", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource, path).toBe("https://hub.example.com/mcp");
      expect(body.authorization_servers, path).toContain(BASE_URL);
    }
  });

  it("authorization server metadata advertises S256, registration and token endpoints", async () => {
    const response = await request("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(BASE_URL);
    expect(body.authorization_endpoint).toBe(`${BASE_URL}/authorize`);
    expect(body.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${BASE_URL}/oauth/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.code_challenge_methods_supported).not.toContain("plain");
    expect(body.response_types_supported).toContain("code");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
  });
});

describe("/mcp without a valid token", () => {
  it("401 with a Bearer challenge pointing at the resource metadata", async () => {
    const response = await request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      'resource_metadata="https://hub.example.com/.well-known/oauth-protected-resource',
    );
  });

  it("401 for a garbage bearer", async () => {
    for (const token of ["garbage", "a:b:c", "x".repeat(300)]) {
      const response = await request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status, token.slice(0, 20)).toBe(401);
    }
  });
});

describe("authorize -> token -> /mcp", () => {
  it("registers a client dynamically", async () => {
    const client = await registerClient("Dyn Client");
    expect(client.client_id).toMatch(/.{8,}/);
  });

  it("renders a consent page that cannot be framed and names the client and redirect host", async () => {
    const jwt = await signJwt(ownerClaims(), key);
    const client = await registerClient("Consent Client <b>");
    const { challenge } = await pkce();
    const consent = await startConsent(jwt, client, challenge);
    const csp = consent.response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(consent.response.headers.get("x-frame-options")).toBe("DENY");
    expect(consent.response.headers.get("cache-control")).toContain("no-store");
    expect(consent.html).toContain("Consent Client &#60;b&#62;");
    expect(consent.html).not.toContain("Consent Client <b>");
    expect(consent.html).toContain("client.example.com");
    expect(consent.cookie).toMatch(/__Host-oauth-consent/);
  });

  it("happy path: code, form-encoded token exchange, initialize, tools/list, list_browsers", async () => {
    const jwt = await signJwt(ownerClaims(), key);
    const client = await registerClient("Happy Client");
    const { verifier, challenge } = await pkce();
    const consent = await startConsent(jwt, client, challenge);
    const approved = await postConsent(jwt, consent.cookie, {
      handle: consent.handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://client.example.com/oauth/callback",
    );
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // A wrong verifier is refused (PKCE is enforced).
    const wrong = await exchangeCode(client, code!, (await pkce()).verifier);
    expect(wrong.status).toBe(400);

    const consent2 = await startConsent(jwt, client, challenge);
    const approved2 = await postConsent(jwt, consent2.cookie, {
      handle: consent2.handle,
      password: TEST_PASSWORD,
      decision: "approve",
    });
    const code2 = new URL(approved2.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await exchangeCode(client, code2, verifier);
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, unknown>;
    expect(tokens.token_type).toMatch(/bearer/i);
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");
    const token = tokens.access_token as string;

    const init = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(init.status).toBe(200);
    const initResult = init.body.result as Record<string, unknown>;
    expect(initResult.protocolVersion).toBe("2025-06-18");
    expect((initResult.serverInfo as { name: string }).name).toBe("rainforest");

    const list = await mcp(token, "tools/list");
    const tools = (list.body.result as { tools: Record<string, unknown>[] }).tools;
    const names = tools.map((t) => t.name as string);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      const name = tool.name as string;
      expect(EXPECTED_TOOLS).toContain(name);
      expect(tool, name).not.toHaveProperty("outputSchema");
      expect(tool.inputSchema, name).toMatchObject({ type: "object" });
      const annotations = tool.annotations as Record<string, unknown>;
      expect(annotations, name).toBeTruthy();
      expect(typeof annotations.title, name).toBe("string");
      expect(annotations.readOnlyHint, name).toBe(!NOT_READ_ONLY.includes(name));
      expect(annotations.destructiveHint, name).toBe(DESTRUCTIVE.includes(name));
      expect(typeof annotations.openWorldHint, name).toBe("boolean");
    }

    const device = await pairDevice("Desk Mac");
    await connectDevice(device);
    const result = await callTool(token, "list_browsers");
    expect(result.isError).toBeUndefined();
    const data = envelope(result) as { ok: boolean; data: { browsers: Record<string, unknown>[] } };
    expect(data.ok).toBe(true);
    expect(data.data.browsers).toHaveLength(1);
    expect(data.data.browsers[0]).toMatchObject({
      id: device.deviceId,
      name: "Desk Mac",
      online: true,
      selected: false,
    });
  });

  it("the deny button redirects with access_denied and issues no code", async () => {
    const jwt = await signJwt(ownerClaims(), key);
    const client = await registerClient();
    const { challenge } = await pkce();
    const consent = await startConsent(jwt, client, challenge);
    const denied = await postConsent(jwt, consent.cookie, {
      handle: consent.handle,
      decision: "deny",
    });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("rotates refresh tokens", async () => {
    const { client, tokens } = await connectClient(key);
    const first = await refresh(client, tokens.refresh_token);
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.access_token).not.toBe(tokens.access_token);
    expect((await mcp(rotated.access_token, "ping")).status).toBe(200);

    // Using the new refresh token retires the old one for good.
    const second = await refresh(client, rotated.refresh_token);
    expect(second.status).toBe(200);
    const replay = await refresh(client, tokens.refresh_token);
    expect(replay.status).toBe(400);
  });

  it("an access token from one grant is not a refresh token and garbage refresh fails", async () => {
    const { client, tokens } = await connectClient(key);
    expect((await refresh(client, tokens.access_token)).status).toBe(400);
    expect((await refresh(client, "nope")).status).toBe(400);
  });

  it("rejects non-POST and oversized bodies on /mcp", async () => {
    const { tokens } = await connectClient(key);
    const get = await request("/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(get.status).toBe(405);
    const big = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
        "content-length": String(300 * 1024),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(300 * 1024) }),
    });
    expect(big.status).toBe(413);
  });

  it("unknown methods return method not found; notifications return 202", async () => {
    const { tokens } = await connectClient(key);
    const unknown = await mcp(tokens.access_token, "resources/list");
    expect((unknown.body.error as { code: number }).code).toBe(-32601);
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(response.status).toBe(202);
  });
});
