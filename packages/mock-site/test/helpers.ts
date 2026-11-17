import type { Capture, PageKind } from "@rainforest/core";
import { createMockSite, type MockSite } from "../src/index.ts";

/** A cookie-keeping client for one mock site over plain HTTP. */
export interface Client {
  site: MockSite;
  get(path: string): Promise<Response>;
  post(path: string, form: Record<string, string>, json?: boolean): Promise<Response>;
  html(path: string): Promise<string>;
  capture(kind: PageKind, path: string, fragments?: Record<string, string>): Promise<Capture>;
  state(): Promise<MockState>;
  reset(): Promise<void>;
}

export interface MockState {
  seed: number;
  session: {
    cart: {
      active: {
        item_id: string;
        asin: string;
        quantity: number;
        subscribe: boolean;
        notice?: string;
      }[];
      saved: { item_id: string; asin: string }[];
      subtotal_cents: number;
    };
    lists: {
      id: string;
      name: string;
      privacy: string;
      is_default: boolean;
      items: {
        itemId: string;
        asin: string;
        comment: string;
        requested: number;
        priority: string;
      }[];
    }[];
    clipped_coupons: string[];
  } | null;
  traps: { trap: string; method: string; path: string }[];
  trap_counts: Record<string, number>;
  hits: { method: string; path: string; search: string; at: number }[];
}

export const FIXED_NOW = new Date("2026-11-16T15:00:00.000Z");

export async function startSite(seed = 1): Promise<Client> {
  const site = await createMockSite({ seed, now: () => FIXED_NOW });
  let cookie = "";
  const remember = (r: Response): Response => {
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return r;
  };
  const client: Client = {
    site,
    get: async (path) =>
      remember(await fetch(`${site.origin}${path}`, { headers: { cookie }, redirect: "manual" })),
    post: async (path, form, json = true) =>
      remember(
        await fetch(`${site.origin}${path}`, {
          method: "POST",
          body: new URLSearchParams(form),
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            ...(json ? { accept: "application/json" } : {}),
          },
          redirect: "manual",
        }),
      ),
    html: async (path) => (await client.get(path)).text(),
    capture: async (kind, path, fragments) => {
      const html = await client.html(path);
      const url = `https://www.amazon.com${path}`;
      return {
        kind,
        url,
        final_url: url,
        captured_at: FIXED_NOW.toISOString(),
        html,
        ...(fragments ? { fragments } : {}),
      };
    },
    state: async () => (await (await fetch(`${site.origin}/__mock/state`)).json()) as MockState,
    reset: async () => {
      await fetch(`${site.origin}/__mock/reset`, { method: "POST" });
    },
  };
  return client;
}
