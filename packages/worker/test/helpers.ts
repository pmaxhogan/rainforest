import { env, exports } from "cloudflare:workers";
import { authTranscript, PROTOCOL_VERSION, type Presence } from "@rainforest/core";
import { vi } from "vitest";
import { resetJwksCache } from "../src/access.ts";
import type { Env } from "../src/env.ts";
import { pairStatusTranscript, type Hub } from "../src/hub.ts";
import {
  ACCESS_AUD,
  BASE_URL,
  CERTS_URL,
  OWNER_EMAIL,
  TEAM_DOMAIN,
  TEST_PASSWORD,
} from "./constants.ts";

export const testEnv = env as unknown as Env;

/** A fresh stub every time: `reset()` invalidates stubs created before it. */
export function hubStub(): DurableObjectStub<Hub> {
  return testEnv.HUB.get(testEnv.HUB.idFromName("hub"));
}

// ------------------------------------------------------------------ encoding

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

// ------------------------------------------------------------------ requests

let ipCounter = 1;
/** A distinct client IP so the per-IP rate limits never couple two tests. */
export function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let currentIp = freshIp();
export function useFreshIp(): string {
  currentIp = freshIp();
  return currentIp;
}

export function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", currentIp);
  // The main Worker's default export, running in this isolate (so global mocks apply).
  const self = (exports as unknown as { default: Fetcher }).default;
  return self.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }));
}

// ------------------------------------------------------------------ Access JWTs

export interface RsaKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: { kid: string; kty: string; n: string; e: string; alg: string; use: string };
}

export async function makeRsaKey(kid: string): Promise<RsaKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: "RSA", n: pub.n!, e: pub.e!, alg: "RS256", use: "sig" },
  };
}

export interface JwksMock {
  /** How many times the Worker fetched the certs URL. */
  fetches: () => number;
  restore: () => void;
}

/**
 * Intercept the Worker's outbound fetch of the Access certs. The main Worker runs in the
 * same isolate as the tests, so a global fetch spy applies to it. Anything else fails.
 */
export function mockJwks(keys: () => RsaKey["jwk"][]): JwksMock {
  resetJwksCache();
  let count = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS_URL) {
      count++;
      return Response.json({ keys: keys(), public_cert: { kid: "x", cert: "unused" } });
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
  return {
    fetches: () => count,
    restore: () => {
      spy.mockRestore();
      resetJwksCache();
    },
  };
}

export async function signJwt(
  claims: Record<string, unknown>,
  key: RsaKey,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64urlText(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const p = b64urlText(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

export function ownerClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [ACCESS_AUD],
    email: OWNER_EMAIL,
    iss: `https://${TEAM_DOMAIN}`,
    iat: now,
    nbf: now - 5,
    exp: now + 600,
    sub: "00000000-0000-4000-8000-000000000001",
    type: "app",
    ...overrides,
  };
}

/** An HS256 token "signed" with the public modulus, the classic algorithm-confusion attempt. */
export async function hs256Jwt(claims: Record<string, unknown>, key: RsaKey): Promise<string> {
  const h = b64urlText(JSON.stringify({ alg: "HS256", kid: key.kid, typ: "JWT" }));
  const p = b64urlText(JSON.stringify(claims));
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key.jwk.n),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export function noneJwt(claims: Record<string, unknown>, kid: string): string {
  const h = b64urlText(JSON.stringify({ alg: "none", kid, typ: "JWT" }));
  return `${h}.${b64urlText(JSON.stringify(claims))}.`;
}

// ------------------------------------------------------------------ OAuth client

export const REDIRECT_URI = "https://client.example.com/oauth/callback";

export interface Client {
  client_id: string;
}

export async function registerClient(name = "Test Client"): Promise<Client> {
  const response = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201 && response.status !== 200)
    throw new Error(`register failed ${response.status}: ${await response.text()}`);
  return (await response.json()) as Client;
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function authorizeQuery(client: Client, challenge: string, state = "state-123"): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "mcp",
    resource: `${BASE_URL}/mcp`,
  });
  return `/authorize?${q.toString()}`;
}

/** Collect `name=value` pairs from Set-Cookie headers into a Cookie header value. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
}

export function handleFrom(html: string): string {
  const match = /name="handle" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no handle in consent page");
  return match[1]!;
}

export interface ConsentStart {
  handle: string;
  cookie: string;
  html: string;
  response: Response;
}

export async function startConsent(jwt: string, client: Client, challenge: string) {
  const response = await request(authorizeQuery(client, challenge), {
    headers: { "cf-access-jwt-assertion": jwt },
  });
  const html = await response.text();
  if (response.status !== 200) throw new Error(`consent GET ${response.status}: ${html}`);
  return { handle: handleFrom(html), cookie: cookiesFrom(response), html, response };
}

export function postConsent(
  jwt: string | null,
  cookie: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = { origin: BASE_URL },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    cookie,
    ...extraHeaders,
  };
  if (jwt) headers["cf-access-jwt-assertion"] = jwt;
  return request("/authorize", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeCode(client: Client, code: string, verifier: string) {
  return request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${BASE_URL}/mcp`,
    }).toString(),
  });
}

export async function refresh(client: Client, refreshToken: string): Promise<Response> {
  return request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
    }).toString(),
  });
}

/** Full authorize -> token flow. Requires an active JWKS mock that knows `key`. */
export async function connectClient(
  key: RsaKey,
  name = "Test Client",
): Promise<{ client: Client; tokens: Tokens }> {
  const jwt = await signJwt(ownerClaims(), key);
  const client = await registerClient(name);
  const { verifier, challenge } = await pkce();
  const consent = await startConsent(jwt, client, challenge);
  const approved = await postConsent(jwt, consent.cookie, {
    handle: consent.handle,
    password: TEST_PASSWORD,
    decision: "approve",
  });
  if (approved.status !== 302) throw new Error(`consent POST ${approved.status}`);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const response = await exchangeCode(client, code, verifier);
  if (response.status !== 200)
    throw new Error(`token ${response.status}: ${await response.text()}`);
  return { client, tokens: (await response.json()) as Tokens };
}

let rpcId = 1;
export async function mcp(
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const { body } = await mcp(token, "tools/call", { name, arguments: args });
  if (!body.result) throw new Error(`tools/call failed: ${JSON.stringify(body)}`);
  return body.result as ToolResult;
}

/** Parse a tool result: error envelopes are plain JSON, success is wrapped. */
export function envelope(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? "";
  const json = text.includes("\n<untrusted-external-content-from-amazon-")
    ? text.split("\n")[2]!
    : text;
  return JSON.parse(json) as Record<string, unknown>;
}

// ------------------------------------------------------------------ daemons

export function presence(overrides: Partial<Presence> = {}): Presence {
  return {
    idle_s: 10,
    locked: false,
    chrome_running: true,
    profile_connected: true,
    amazon_signed_in: true,
    cooling_down_until: null,
    version: "0.1.0",
    ...overrides,
  };
}

export interface DaemonKey {
  publicKey: string;
  privateKey: CryptoKey;
}

export async function makeDeviceKey(): Promise<DaemonKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { publicKey: b64url(raw), privateKey: pair.privateKey };
}

export async function sign(key: DaemonKey, message: string): Promise<string> {
  return b64url(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      new TextEncoder().encode(message),
    ),
  );
}

export async function pairStart(body: unknown, ip?: string): Promise<Response> {
  return request("/pair/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function pairStatus(key: DaemonKey, deviceId: string, timestamp = Date.now()) {
  const response = await request("/pair/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId,
      timestamp,
      signature: await sign(key, pairStatusTranscript(deviceId, timestamp)),
    }),
  });
  return response;
}

export interface Paired {
  deviceId: string;
  key: DaemonKey;
  name: string;
}

/** Pair a device, approving it through the Hub RPC (the /admin flow is tested separately). */
export async function pairDevice(name: string, os = "macos"): Promise<Paired> {
  const key = await makeDeviceKey();
  const response = await pairStart({ public_key: key.publicKey, name, os }, freshIp());
  const body = (await response.json()) as { ok: boolean; device_id: string; code: string };
  if (!body.ok) throw new Error(`pair start failed: ${JSON.stringify(body)}`);
  if (!(await hubStub().approvePairing(body.code))) throw new Error("approve failed");
  return { deviceId: body.device_id, key, name };
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

/** A test daemon socket with a message queue. */
export class Socket {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  #waiters: ((f: Frame) => void)[] = [];
  closed: Promise<{ code: number; reason: string }>;
  closeEvent: { code: number; reason: string } | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        this.closeEvent = { code: event.code, reason: event.reason };
        resolve(this.closeEvent);
      });
    });
    ws.addEventListener("message", (event) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(event.data)) as Frame;
      } catch {
        frame = { type: "raw", data: String(event.data) };
      }
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    ws.accept();
  }

  next(timeoutMs = 2000): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
      this.#waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  }

  send(value: unknown): void {
    this.ws.send(typeof value === "string" ? value : JSON.stringify(value));
  }

  async closedWithin(ms = 2000): Promise<{ code: number; reason: string } | null> {
    return Promise.race([this.closed, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  }

  close(): void {
    try {
      this.ws.close(1000, "test done");
    } catch {
      // already closed
    }
  }
}

const openSockets: Socket[] = [];

export async function openSocket(): Promise<{ socket: Socket; nonce: string }> {
  const response = await request("/devices/ws", { headers: { upgrade: "websocket" } });
  if (response.status !== 101 || !response.webSocket)
    throw new Error(`upgrade failed ${response.status}`);
  const socket = new Socket(response.webSocket);
  openSockets.push(socket);
  const challenge = await socket.next();
  if (challenge.type !== "challenge") throw new Error("expected challenge");
  return { socket, nonce: challenge.nonce as string };
}

export function closeAllSockets(): void {
  for (const s of openSockets.splice(0)) s.close();
}

export async function authFrame(
  device: Paired,
  nonce: string,
  extra: { protocol?: number; presence?: Presence; deviceId?: string } = {},
): Promise<Frame> {
  const protocol = extra.protocol ?? PROTOCOL_VERSION;
  const deviceId = extra.deviceId ?? device.deviceId;
  return {
    type: "auth",
    device_id: deviceId,
    protocol,
    signature: await sign(device.key, authTranscript(nonce, deviceId, protocol)),
    presence: extra.presence ?? presence(),
  };
}

/** Connect and authenticate a paired device. Returns its socket after `welcome`. */
export async function connectDevice(device: Paired, p?: Presence): Promise<Socket> {
  const { socket, nonce } = await openSocket();
  socket.send(await authFrame(device, nonce, p ? { presence: p } : {}));
  const welcome = await socket.next();
  if (welcome.type !== "welcome") throw new Error(`expected welcome, got ${welcome.type}`);
  return socket;
}

/** Answer the next call on `socket` with `data`. Returns the call frame. */
export async function answerNext(socket: Socket, data: unknown): Promise<Frame> {
  const call = await socket.next();
  if (call.type !== "call") throw new Error(`expected call, got ${call.type}`);
  socket.send({ type: "result", id: call.id, ok: true, data, duration_ms: 5 });
  return call;
}
