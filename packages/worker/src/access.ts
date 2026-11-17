/**
 * Cloudflare Access JWT verification, done inside the Worker.
 *
 * Access sits in front of /authorize and /admin at the edge, but "a header was present"
 * is not authentication if the Worker is ever reachable without Access. So the JWT is
 * verified here: RS256 signature against the team's JWKS, audience, issuer, expiry, and
 * the email must equal the configured owner. Any failure returns null.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

interface Claims {
  aud?: string[] | string;
  email?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { team: string; fetchedAt: number; keys: Jwk[] } | null = null;
/** A forced refetch (unknown key id) happens at most this often, so callers cannot drive fetches. */
const FORCED_REFETCH_MIN_MS = 60_000;
let lastForcedAt = 0;

/** Test hook: replace the JWKS fetch. */
export type JwksFetcher = (teamDomain: string) => Promise<Jwk[]>;

async function defaultFetchJwks(teamDomain: string): Promise<Jwk[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`access certs ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  return (body.keys ?? []).filter((k) => k.kty === "RSA" && typeof k.kid === "string");
}

async function jwks(teamDomain: string, force: boolean, fetcher: JwksFetcher): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.team === teamDomain) {
    if (!force && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
    // An unknown key id may force one refetch, but not more often than the minimum gap.
    if (force && now - lastForcedAt < FORCED_REFETCH_MIN_MS) return jwksCache.keys;
  }
  if (force) lastForcedAt = now;
  const keys = await fetcher(teamDomain);
  jwksCache = { team: teamDomain, fetchedAt: now, keys };
  return keys;
}

export function resetJwksCache(): void {
  jwksCache = null;
  lastForcedAt = 0;
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function getCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export interface AccessConfig {
  accessTeamDomain: string;
  accessAud: string;
  ownerEmail: string;
}

/** Returns the owner's email when the request carries a valid Access JWT for the owner. */
export async function verifyOwner(
  request: Request,
  config: AccessConfig | null,
  fetcher: JwksFetcher = defaultFetchJwks,
): Promise<string | null> {
  if (!config || !config.accessTeamDomain || !config.accessAud || !config.ownerEmail) return null;
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    getCookie(request.headers.get("cookie"), "CF_Authorization");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let claims: Claims;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as {
      kid?: string;
      alg?: string;
    };
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as Claims;
    signature = b64urlToBytes(s);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.accessAud)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
  if (claims.iss !== `https://${config.accessTeamDomain}`) return null;
  if (
    typeof claims.email !== "string" ||
    claims.email.toLowerCase() !== config.ownerEmail.toLowerCase()
  )
    return null;

  const data = new TextEncoder().encode(`${h}.${p}`);
  for (const force of [false, true]) {
    let keys: Jwk[];
    try {
      keys = await jwks(config.accessTeamDomain, force, fetcher);
    } catch {
      return null;
    }
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
      return valid ? claims.email.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return null;
}
