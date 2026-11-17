import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { handleAdmin } from "./admin.ts";
import { handleAuthorize } from "./consent.ts";
import { hub, ownerConfig, type Env } from "./env.ts";
import { plain } from "./html.ts";
import { handleMcp, SERVER_VERSION } from "./mcp.ts";

export { Hub } from "./hub.ts";

/**
 * Routes
 *   /healthz                       no auth, no data
 *   /mcp                           OAuth access token (validated by the provider)
 *   /.well-known/*, /oauth/*       OAuth metadata, dynamic registration, token endpoint
 *   /authorize                     consent: Access JWT for the owner AND the app password
 *   /admin                         Access JWT for the owner
 *   /devices/ws                    daemon WebSocket; authenticates with its device key
 *   /pair/start, /pair/status      pairing bootstrap; approval happens on /admin
 *
 * There is no static bearer and no bypass. When the owner configuration is missing the
 * Worker refuses everything except /healthz.
 */

const providers = new Map<string, OAuthProvider<Env>>();

function provider(baseUrl: string): OAuthProvider<Env> {
  let instance = providers.get(baseUrl);
  if (!instance) {
    instance = new OAuthProvider<Env>({
      apiHandlers: {
        "/mcp": {
          fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
            handleMcp(request, env, (ctx as { props?: unknown }).props),
        },
      },
      defaultHandler: { fetch: (request: Request, env: Env) => defaultRoutes(request, env) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      // The resource must equal the MCP URL exactly.
      resourceMetadata: { resource: `${baseUrl}/mcp` },
      scopesSupported: ["mcp"],
      disallowPublicClientRegistration: false,
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 365 * 24 * 3600,
    });
    providers.set(baseUrl, instance);
  }
  return instance;
}

async function limited(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

const pairStartSchema = z.object({
  public_key: z.string().min(40).max(64),
  name: z.string().min(1).max(60),
  os: z.string().min(1).max(20),
});
const pairStatusSchema = z.object({
  device_id: z.string().uuid(),
  timestamp: z.number().int(),
  signature: z.string().min(80).max(100),
});

async function readJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? "0") > 4096) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function defaultRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") return handleAuthorize(request, env);
  if (url.pathname === "/admin") return handleAdmin(request, env);
  return plain("not found", 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

    if (path === "/healthz") {
      return Response.json({
        ok: true,
        version: SERVER_VERSION,
        configured: ownerConfig(env) !== null,
      });
    }
    const config = ownerConfig(env);
    if (!config) return plain("not configured", 503);

    if (path === "/devices/ws") {
      if (await limited(env.RL_PUBLIC, `ws:${ip}`)) return plain("slow down", 429);
      return hub(env).fetch(request);
    }
    if (path === "/pair/start" || path === "/pair/status") {
      if (request.method !== "POST") return plain("method not allowed", 405);
      if (await limited(path === "/pair/start" ? env.RL_STRICT : env.RL_PUBLIC, `pair:${ip}`))
        return plain("slow down", 429);
      const body = await readJson(request);
      if (path === "/pair/start") {
        const parsed = pairStartSchema.safeParse(body);
        if (!parsed.success) return plain("bad request", 400);
        const result = await hub(env).pairStart(parsed.data);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      const parsed = pairStatusSchema.safeParse(body);
      if (!parsed.success) return plain("bad request", 400);
      return Response.json(await hub(env).pairStatus(parsed.data));
    }
    if (path === "/oauth/register" || path === "/oauth/token") {
      if (await limited(env.RL_PUBLIC, `oauth:${ip}`)) return plain("slow down", 429);
    }
    return provider(config.baseUrl).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
