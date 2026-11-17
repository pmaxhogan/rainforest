import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { verifyOwner } from "./access.ts";
import { hub, ownerConfig, type Env } from "./env.ts";
import { esc, page, plain } from "./html.ts";
import type { GrantProps } from "./mcp.ts";
import { verifyPassword } from "./password.ts";

/**
 * /authorize: the consent step. Two independent gates, both required:
 *  1. a valid Cloudflare Access JWT for the configured owner (verified here, fail closed),
 *  2. the rainforest app password typed on this page.
 * The authorization request stays server-side in the library's consent transaction; the
 * form carries only a single-use handle bound to this browser by a cookie.
 */

function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const published = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope.length
    ? details.scope.map((s) => `<code>${esc(s)}</code>`).join(" ")
    : "<code>mcp</code>";
  return `
<h1>Allow <span class="mono">${esc(details.clientName)}</span> to use rainforest?</h1>
<p>${published} Access will be sent to <strong>${esc(details.redirectHost)}</strong>. Scopes: ${scopes}</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on a computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
<p>This client will be able to read your Amazon account pages and change your cart and lists through your own browser. It can never place an order.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize" autocomplete="off">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <p><label>App password<br><input type="password" name="password" size="48" autocomplete="off" autofocus required></label></p>
  <p><button name="decision" value="approve">Allow</button> <button class="secondary" name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`;
}

async function limited(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    // A broken limiter must not open the gate.
    return true;
  }
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const config = ownerConfig(env);
  if (!config) return plain("not configured", 503);
  const owner = await verifyOwner(request, config);
  if (!owner) return plain("unauthorized - sign in through Cloudflare Access", 401);
  const oauth = env.OAUTH_PROVIDER;

  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page("Authorize", consentPage(details, consent.handle), {
        headers: consent.headers,
        redirectsAfterSubmit: true,
      });
    }
    if (request.method !== "POST") return plain("method not allowed", 405);

    const origin = request.headers.get("origin");
    if (origin !== config.baseUrl) return plain("bad origin", 400);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (!handle) return plain("bad request", 400);

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const stub = hub(env);
    if ((await limited(env.RL_STRICT, `pw:${ip}`)) || !(await stub.beginPasswordAttempt())) {
      return plain("too many attempts - wait 15 minutes and start again from the client", 429);
    }
    const ok = await verifyPassword(String(form.get("password") ?? ""), config.passwordSha256);
    if (!ok) return plain("wrong app password - go back and try again", 403);
    await stub.passwordSucceeded();

    const approved = await oauth.approveConsent(request, handle, { scope: ["mcp"] });
    const client = await oauth.lookupClient(approved.request.clientId);
    const props: GrantProps = {
      grantKey: crypto.randomUUID(),
      clientName: (client?.clientName ?? approved.request.clientId).slice(0, 120),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: owner,
      metadata: { client: props.clientName },
      scope: ["mcp"],
      props,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo)
      return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return plain(error.description, 400);
    if (error instanceof CimdFetchError) return plain("This app could not be verified.", 400);
    throw error;
  }
}
