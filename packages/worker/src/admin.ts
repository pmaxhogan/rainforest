import { getCookie, verifyOwner } from "./access.ts";
import { hub, ownerConfig, type Env } from "./env.ts";
import { esc, page, plain } from "./html.ts";
import type { AdminState } from "./hub.ts";

/**
 * /admin: owner-only page (Cloudflare Access at the edge, verified again here) to approve
 * pairings, rename or revoke devices and read the audit log. Every action is a POST with
 * a double-submit CSRF token and a same-origin check.
 */

const CSRF_COOKIE = "__Host-rf-admin-csrf";

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z" : "-";
}

function form(
  csrf: string,
  action: string,
  fields: Record<string, string>,
  label: string,
  cls = "",
): string {
  const hidden = Object.entries({ csrf, action, ...fields })
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form class="inline" method="post" action="/admin">${hidden}<button class="${esc(cls)}">${esc(label)}</button></form>`;
}

async function render(env: Env, csrf: string, notice: string, owner: string): Promise<Response> {
  const state = (await hub(env).adminState()) as unknown as AdminState;
  const grantList = await env.OAUTH_PROVIDER.listUserGrants(owner).catch(() => ({ items: [] }));
  const clients = grantList.items.length
    ? `<table><tr><th>Client</th><th>Connected</th><th></th></tr>${grantList.items
        .map((g) => {
          const meta = (g.metadata ?? {}) as { client?: unknown };
          const name = typeof meta.client === "string" ? meta.client : g.clientId;
          return `<tr><td>${esc(name)}</td><td>${esc(when(g.createdAt * 1000))}</td><td>${form(csrf, "revoke_grant", { grant_id: g.id }, "Disconnect", "danger")}</td></tr>`;
        })
        .join("")}</table>`
    : '<p class="muted">No clients are connected.</p>';
  const pairings = state.pairings.length
    ? `<table><tr><th>Name</th><th>OS</th><th>Key</th><th>Expires</th><th></th></tr>${state.pairings
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td>${esc(p.os)}</td><td class="mono">${esc(p.key_fingerprint)}</td><td>${esc(when(p.expires_at))}</td><td>${form(csrf, "reject", { code: p.code }, "Reject", "secondary")}</td></tr>`,
        )
        .join(
          "",
        )}</table><form class="inline" method="post" action="/admin"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="approve"><input name="code" required autocomplete="off" spellcheck="false" maxlength="16" placeholder="code from the daemon"> <button>Approve</button></form><p class="muted">To approve, type the code that the daemon printed on the computer in front of you. Codes are not shown here on purpose: anyone can request a pairing, and only the person at the computer knows its code.</p>`
    : '<p class="muted">No pending pairings. Run <code>rainforestd pair</code> on a computer to start one.</p>';
  const devices = state.devices.length
    ? `<table><tr><th>Name</th><th>OS</th><th>Online</th><th>Version</th><th>Last seen</th><th>Key</th><th></th></tr>${state.devices
        .map(
          (d) =>
            `<tr><td>${esc(d.name)}${d.aliases.length ? ` <span class="muted">(${esc(d.aliases.join(", "))})</span>` : ""}</td><td>${esc(d.os)}</td><td>${d.online ? "yes" : "no"}</td><td>${esc(d.daemon_version ?? "-")}</td><td>${esc(when(d.last_seen))}</td><td class="mono">${esc(d.key_fingerprint)}</td><td>${form(csrf, "revoke", { device_id: d.id }, "Revoke", "danger")}</td></tr>`,
        )
        .join("")}</table>`
    : '<p class="muted">No devices paired yet.</p>';
  const audit = state.audit.length
    ? `<table><tr><th>Time</th><th>Client</th><th>Tool</th><th>Browser</th><th>Outcome</th><th>ms</th><th>Arguments (writes only)</th></tr>${state.audit
        .map(
          (a) =>
            `<tr><td>${esc(when(a.ts))}</td><td>${esc(a.client)}</td><td class="mono">${esc(a.tool)}</td><td>${esc(a.browser ?? "-")}</td><td>${esc(a.outcome)}${a.error_code ? ` <span class="err">${esc(a.error_code)}</span>` : ""}</td><td>${esc(a.duration_ms)}</td><td class="mono">${a.args ? esc(a.args.slice(0, 600)) : ""}</td></tr>`,
        )
        .join("")}</table>`
    : '<p class="muted">No calls yet.</p>';
  const body = `<h1>rainforest admin</h1>${notice ? `<p class="warn">${esc(notice)}</p>` : ""}
<h2>Pending pairings</h2>${pairings}
<h2>Devices</h2>${devices}
<h2>Connected clients</h2>${clients}
<h2>Audit log (latest 100, kept 90 days)</h2>${audit}`;
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `${CSRF_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`,
  );
  return page("rainforest admin", body, { headers });
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const config = ownerConfig(env);
  if (!config) return plain("not configured", 503);
  const owner = await verifyOwner(request, config);
  if (!owner) return plain("unauthorized - sign in through Cloudflare Access", 401);

  if (request.method === "GET") {
    return render(
      env,
      getCookie(request.headers.get("cookie"), CSRF_COOKIE) ?? randomToken(),
      "",
      owner,
    );
  }
  if (request.method !== "POST") return plain("method not allowed", 405);
  if (request.headers.get("origin") !== config.baseUrl) return plain("bad origin", 400);
  const data = await request.formData();
  const cookie = getCookie(request.headers.get("cookie"), CSRF_COOKIE);
  const field = String(data.get("csrf") ?? "");
  if (!cookie || cookie.length < 32 || field !== cookie)
    return plain("bad request (stale page - reload)", 400);

  const stub = hub(env);
  let notice: string;
  switch (String(data.get("action") ?? "")) {
    case "approve":
      notice = (await stub.approvePairing(String(data.get("code") ?? "")))
        ? "Pairing approved."
        : "That code is not pending.";
      break;
    case "reject":
      await stub.rejectPairing(String(data.get("code") ?? ""));
      notice = "Pairing rejected.";
      break;
    case "revoke":
      await stub.revokeDevice(String(data.get("device_id") ?? ""));
      notice = "Device revoked.";
      break;
    case "revoke_grant":
      await env.OAUTH_PROVIDER.revokeGrant(String(data.get("grant_id") ?? ""), owner);
      notice = "Client disconnected.";
      break;
    default:
      return plain("unknown action", 400);
  }
  return render(env, cookie, notice, owner);
}
