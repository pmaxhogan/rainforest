import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Hub } from "./hub.ts";

export interface Env {
  OAUTH_KV: KVNamespace;
  HUB: DurableObjectNamespace<Hub>;
  RL_STRICT: RateLimit;
  RL_PUBLIC: RateLimit;
  /** Injected by the OAuth provider for the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  // ---- secrets (owner-specific; never in the repository)
  /** https://<hostname> the Worker is served on, no trailing slash. */
  PUBLIC_BASE_URL?: string;
  /** <team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience tag of the Access application covering /authorize and /admin. */
  ACCESS_AUD?: string;
  /** The only email allowed to authorize clients and use /admin. */
  OWNER_EMAIL?: string;
  /** Hex SHA-256 of the high-entropy app password. */
  APP_PASSWORD_SHA256?: string;
  /** Optional: daemons older than this are told to update and refused. */
  MIN_DAEMON_VERSION?: string;
}

export interface OwnerConfig {
  baseUrl: string;
  accessTeamDomain: string;
  accessAud: string;
  ownerEmail: string;
  passwordSha256: string;
}

/**
 * Owner configuration, or null when anything is missing or malformed. Every caller
 * treats null as "refuse": the Worker fails closed when it is not fully configured.
 */
export function ownerConfig(env: Env): OwnerConfig | null {
  const baseUrl = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const accessTeamDomain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const accessAud = env.ACCESS_AUD?.trim();
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  const passwordSha256 = env.APP_PASSWORD_SHA256?.trim().toLowerCase();
  if (!baseUrl || !/^https:\/\/[a-z0-9.-]+$/i.test(baseUrl)) return null;
  if (!accessTeamDomain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessTeamDomain))
    return null;
  if (!accessAud || !/^[a-f0-9]{32,128}$/i.test(accessAud)) return null;
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+$/.test(ownerEmail)) return null;
  if (!passwordSha256 || !/^[a-f0-9]{64}$/.test(passwordSha256)) return null;
  return { baseUrl, accessTeamDomain, accessAud, ownerEmail, passwordSha256 };
}

export function hub(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("hub"));
}
