/** Escape text for HTML element and attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (char) => `&#${char.charCodeAt(0)};`);
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, sans-serif; max-width: 880px; margin: 6vh auto; padding: 0 20px; line-height: 1.5; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
code, .mono { font-family: ui-monospace, monospace; background: rgba(127,127,127,.14); padding: 1px 5px; border-radius: 4px; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(127,127,127,.3); vertical-align: top; }
input[type=password], input[type=text] { padding: 8px 10px; font-size: 1rem; border: 1px solid #888; border-radius: 6px; background: inherit; color: inherit; box-sizing: border-box; }
button { padding: 7px 14px; font-size: .95rem; border: 0; border-radius: 6px; cursor: pointer; background: #2563eb; color: #fff; }
button.secondary { background: #6b7280; } button.danger { background: #b91c1c; }
.err { color: #b91c1c; } .warn { border: 1px solid #b45309; padding: 8px 12px; border-radius: 6px; } .muted { opacity: .7; }
form.inline { display: inline; }
`;

export function page(
  title: string,
  body: string,
  init: { status?: number; headers?: Headers } = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, { status: init.status ?? 200, headers });
}

export function plain(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
