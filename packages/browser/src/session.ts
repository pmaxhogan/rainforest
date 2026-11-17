import type { Page } from "playwright-core";
import { RfError, type Capture, type HumanKind, type PageKind } from "@rainforest/core";
import { attach, type Attachment } from "./attach.ts";
import type { Broker } from "./broker.ts";
import { BrokerError } from "./broker.ts";
import { installGuard, type Guard } from "./guard.ts";
import { serializeWithHiddenMarks } from "./hidden.ts";
import { Pacer, type PageType } from "./pacing.ts";
import { checkFragment, checkNavigation } from "./policy.ts";

/** Result of the interstitial classifier (implemented in the parsers package). */
export interface Interstitial {
  kind: HumanKind | "throttled" | "not_found" | "error";
  evidence: string;
}

export interface SessionOptions {
  broker: Broker;
  token: string;
  extensionId: string;
  name?: string;
  pacer: Pacer;
  /** Detach after this long without a call (default 120 s). */
  idleDetachMs?: number;
  /** Make sure the browser profile is running and its extension is connected. */
  ensureInstance?: () => Promise<void>;
  classify?: (capture: Capture) => Interstitial | null;
  /** Persist pacing state after it changes. */
  onPacingChange?: () => void;
  /**
   * Receives every page the session reads (as read, before any classification), every
   * fragment it fetches, and a snapshot of the page a failed call left behind. For local
   * diagnostics only: the session keeps nothing, and a throwing receiver is ignored.
   */
  onPage?: (page: SeenPage) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** One page or fragment as the session saw it. */
export interface SeenPage {
  /** A capture kind, "fragment", or "failure" (the page a failed call left behind). */
  kind: string;
  /** URL that was requested. */
  url: string;
  /** URL the tab or the fetch ended on. */
  final_url: string;
  captured_at: string;
  html: string;
  /** Why it was kept, for a failure: the error code and message. A fragment: its status. */
  note?: string;
}

/** Where account friction was noticed: on a redirect hop, on the landed URL, or in the page. */
export type FrictionSeen = "redirect" | "landed" | "page";

export interface PageContext {
  /** Policy-checked, paced navigation. Throws structured errors. */
  goto(url: string, type: PageType): Promise<void>;
  /**
   * The same checks and pacing as goto, but the navigation starts inside the current page
   * (as a link click would), so the request carries the page as its referrer. The target
   * must be on the same origin as the current page.
   */
  follow(url: string, type: PageType): Promise<void>;
  /** Serialize the current page (with hidden markers) and classify interstitials. */
  capture(kind: PageKind): Promise<Capture>;
  /**
   * Fetch a same-origin fragment from inside the loaded page (paced like a page load).
   * Only allowlisted fragment URLs are accepted.
   */
  fetchFragment(pathAndQuery: string, type: PageType): Promise<string>;
  /** The automation tab, for typed flows. Never use it to navigate around the rails. */
  page: Page;
  guard: Guard;
}

/**
 * Amazon pages that mean "prove you are a person". Landing on one stops the queue and
 * starts the cool-down; nothing here ever tries to get past them.
 */
export function accountFriction(url: string): HumanKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)amazon\.com$/i.test(parsed.hostname)) return null;
  const path = parsed.pathname.toLowerCase();
  if (path.startsWith("/errors/validatecaptcha") || path.includes("captcha")) return "captcha";
  if (path.startsWith("/checkpoint") || path.startsWith("/ax/claim") || path.startsWith("/gp/aw/c"))
    return "soft_challenge";
  return null;
}

const DRAG_BACKOFF_MS = [0, 150, 300, 600, 1200, 2000];

async function retryOnDrag<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let last: unknown;
  for (const delay of DRAG_BACKOFF_MS) {
    if (delay) await sleep(delay);
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!/dragging a tab/i.test(String((error as Error)?.message ?? error))) throw error;
    }
  }
  throw last;
}

export class BrowserSession {
  readonly #options: SessionOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  #attachment: Attachment | null = null;
  #guard: Guard | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #idleTimer: NodeJS.Timeout | null = null;
  #lastUrl = "about:blank";
  #violation: string | null = null;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get attached(): boolean {
    return this.#attachment !== null;
  }

  get queued(): number {
    return this.#queued;
  }

  /**
   * Run one unit of work with exclusive use of the browser (one page at a time).
   * `maxQueue` bounds how many calls may wait; beyond it the call fails with `busy`.
   */
  async run<T>(work: (ctx: PageContext) => Promise<T>, maxQueue = 4): Promise<T> {
    if (this.#queued >= maxQueue) {
      throw new RfError("busy", "this browser is busy with other calls", { retry_after_s: 15 });
    }
    this.#queued++;
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((r) => {
      release = r;
    });
    try {
      await previous.catch(() => {});
      this.#cancelIdle();
      const ctx = await this.#ensureAttached();
      this.#violation = null;
      let result: T;
      try {
        result = await work(ctx);
      } catch (error) {
        await this.#snapshotFailure(ctx.page, error);
        throw error;
      }
      if (this.#violation !== null) {
        const where = this.#violation;
        this.#violation = null;
        void this.detach();
        throw new RfError(
          "blocked_by_policy",
          "the tab reached a page the policy refuses; it was left immediately",
          {
            details: { landed: where },
          },
        );
      }
      return result;
    } finally {
      this.#queued--;
      this.#armIdle();
      release();
    }
  }

  #seen(page: SeenPage): void {
    try {
      this.#options.onPage?.(page);
    } catch {
      // Diagnostics must never fail a call.
    }
  }

  /** Keep the page a failed call left behind, when there is one worth keeping. */
  async #snapshotFailure(page: Page, error: unknown): Promise<void> {
    if (!this.#options.onPage) return;
    const code = error instanceof RfError ? error.payload.code : "internal";
    const message = error instanceof RfError ? error.payload.message : "unexpected error";
    this.#options.log?.(`call failed: ${code}: ${message.slice(0, 200)}`);
    // Refusals made before or without a page have nothing to show, and a challenge was
    // either refused before it loaded or kept already when the page was read.
    if (
      code === "throttled" ||
      code === "busy" ||
      code === "browser_offline" ||
      code === "needs_human"
    )
      return;
    try {
      const url = page.url();
      if (!/^https?:/i.test(url)) return;
      const snapshot = await Promise.race([
        serializeWithHiddenMarks(page),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!snapshot) return;
      this.#seen({
        kind: "failure",
        url: this.#lastUrl,
        final_url: url,
        captured_at: new Date().toISOString(),
        html: snapshot.html,
        note: `${code}: ${message.slice(0, 300)}`,
      });
    } catch {
      // The page may be gone; there is nothing to keep then.
    }
  }

  #cancelIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #armIdle(): void {
    this.#cancelIdle();
    if (this.#queued > 0 || !this.#attachment) return;
    this.#idleTimer = setTimeout(() => void this.detach(), this.#options.idleDetachMs ?? 120_000);
    this.#idleTimer.unref();
  }

  async detach(): Promise<void> {
    this.#cancelIdle();
    const attachment = this.#attachment;
    this.#attachment = null;
    const guard = this.#guard;
    this.#guard = null;
    if (!attachment) return;
    await guard?.dispose().catch(() => {});
    await attachment.close().catch(() => {});
    this.#options.log?.("detached");
  }

  async #ensureAttached(): Promise<PageContext> {
    if (this.#attachment && !this.#attachment.browser.isConnected()) {
      this.#attachment = null;
      this.#guard = null;
    }
    if (!this.#attachment) {
      const cooling = this.#options.pacer.plan("none");
      if (!cooling.ok) {
        throw new RfError("throttled", "this browser is cooling down after an account prompt", {
          retry_after_s: Math.ceil(cooling.retryAfterMs / 1000),
          details: { reason: this.#options.pacer.state.coolDownReason },
        });
      }
      await this.#options.ensureInstance?.();
      let attachment: Attachment;
      try {
        attachment = await retryOnDrag(
          () =>
            attach({
              broker: this.#options.broker,
              token: this.#options.token,
              extensionId: this.#options.extensionId,
              name: this.#options.name,
              log: this.#options.log,
            }),
          this.#sleep,
        );
      } catch (error) {
        if (error instanceof BrokerError) {
          throw new RfError(
            "browser_offline",
            `cannot reach the browser extension (${error.code})`,
          );
        }
        throw error;
      }
      const page = attachment.page;
      // Anything the page opens by itself is closed at once: flows navigate by URL only.
      attachment.context.on("page", (other) => {
        if (other !== page) void other.close().catch(() => {});
      });
      // Third layer: if the tab ever commits a main-frame navigation to a refused URL
      // (a click, a script, anything), leave it immediately and poison the session.
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const current = frame.url();
        if (current === "about:blank" || checkNavigation(current).allow) return;
        this.#violation = current.split("?")[0]!.slice(0, 120);
        this.#options.log?.("navigation guard: the tab committed a refused URL; leaving it");
        this.#leaving = page.goto("about:blank").catch(() => {});
      });
      this.#guard = await installGuard(page, (blocked) => {
        let where = "?";
        try {
          const u = new URL(blocked.url);
          where = `${u.hostname}${u.pathname.slice(0, 120)}`;
        } catch {
          // unparseable URL: nothing more to log
        }
        this.#options.log?.(
          `blocked ${blocked.verdict.reason}/${blocked.verdict.rule} main=${blocked.mainFrameDocument} ${blocked.method} ${where}`,
        );
      });
      this.#attachment = attachment;
    }
    const page = this.#attachment.page;
    const guard = this.#guard!;
    return {
      page,
      guard,
      goto: (url, type) => this.#goto(page, guard, url, type),
      follow: (url, type) => this.#goto(page, guard, url, type, true),
      capture: (kind) => this.#capture(page, kind),
      fetchFragment: (pathAndQuery, type) => this.#fetchFragment(page, pathAndQuery, type),
    };
  }

  #leaving: Promise<unknown> = Promise.resolve();

  async #goto(
    page: Page,
    guard: Guard,
    url: string,
    type: PageType,
    inPage = false,
  ): Promise<void> {
    // A refused navigation may still be leaving the page; let it finish first.
    await this.#leaving;
    if (inPage) {
      const origin = (value: string): string | null => {
        try {
          return new URL(value).origin;
        } catch {
          return null;
        }
      };
      const sameOrigin = origin(url) !== null && origin(url) === origin(page.url());
      if (!sameOrigin) {
        throw new RfError("internal", "an in-page navigation must stay on the current origin");
      }
    }
    const verdict = checkNavigation(url);
    if (!verdict.allow) {
      throw new RfError("blocked_by_policy", `navigation refused by policy (${verdict.reason})`, {
        details: { reason: verdict.reason, rule: verdict.rule },
      });
    }
    const plan = this.#options.pacer.plan(type);
    if (!plan.ok) {
      this.#options.log?.(`pacing refused a ${type} load (${plan.reason})`);
      throw new RfError("throttled", `pacing limit reached (${plan.reason})`, {
        retry_after_s: Math.ceil(plan.retryAfterMs / 1000),
        details: { reason: plan.reason, page_type: type },
      });
    }
    if (plan.waitMs > 0) await this.#sleep(plan.waitMs);
    guard.reset();
    this.#options.pacer.record(type);
    this.#options.onPacingChange?.();
    this.#lastUrl = url;
    this.#options.log?.(`goto ${type} ${pathOnly(url)}${inPage ? " (in page)" : ""}`);
    try {
      await retryOnDrag(
        () =>
          inPage
            ? Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45_000 }),
                page.evaluate((target) => {
                  (
                    globalThis as unknown as { location: { assign(u: string): void } }
                  ).location.assign(target);
                }, url),
              ]).then(([response]) => response)
            : page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }),
        this.#sleep,
      );
    } catch (error) {
      const blocked = guard.blocked().find((b) => b.mainFrameDocument);
      if (blocked) {
        await page.goto("about:blank").catch(() => {});
        const where = {
          seen: "redirect" as const,
          path: pathOnly(blocked.url),
          rule: blocked.verdict.rule,
        };
        this.#options.log?.(
          `redirect refused: ${blocked.verdict.reason}/${blocked.verdict.rule} ${where.path}`,
        );
        if (blocked.verdict.reason === "sign_in")
          this.#needsHuman("sign_in", "Amazon asked to sign in again", where);
        const hopFriction = accountFriction(blocked.url);
        if (hopFriction)
          this.#needsHuman(
            hopFriction,
            `Amazon showed a ${hopFriction.replace("_", " ")} page`,
            where,
          );
        throw new RfError(
          "blocked_by_policy",
          `a redirect was refused by policy (${blocked.verdict.reason})`,
          {
            details: {
              reason: blocked.verdict.reason,
              rule: blocked.verdict.rule,
              refused_path: pathOnly(blocked.url),
              from_path: pathOnly(url),
            },
          },
        );
      }
      const message = String((error as Error)?.message ?? error).split("\n")[0] ?? "";
      this.#options.log?.(`navigation failed: ${message.slice(0, 160)}`);
      if (/Timeout/i.test(message)) throw new RfError("timeout", "the page did not load in time");
      throw new RfError("internal", "navigation failed", {
        details: { message: message.slice(0, 200) },
      });
    }
    // The guard must have inspected this navigation. If it did not (for example a service
    // worker served the page), nothing after this point can be trusted: stop and detach.
    if (url !== "about:blank" && guard.mainDocumentsSeen() === 0) {
      await page.goto("about:blank").catch(() => {});
      void this.detach();
      throw new RfError(
        "internal",
        "the network guard did not see this navigation; the browser session was closed",
      );
    }
    // Second layer: whatever URL the tab ended up on must itself be allowed.
    const landedUrl = page.url();
    const landed = checkNavigation(landedUrl);
    this.#options.log?.(`landed ${pathOnly(landedUrl)}${landed.allow ? "" : " (refused)"}`);
    if (!landed.allow) {
      await page.goto("about:blank").catch(() => {});
      const where = { seen: "landed" as const, path: pathOnly(landedUrl), rule: landed.rule };
      if (landed.reason === "sign_in")
        this.#needsHuman("sign_in", "Amazon asked to sign in again", where);
      const friction = accountFriction(landedUrl);
      if (friction)
        this.#needsHuman(friction, `Amazon showed a ${friction.replace("_", " ")} page`, where);
      throw new RfError(
        "blocked_by_policy",
        `the page landed on a refused URL (${landed.reason})`,
        {
          details: {
            reason: landed.reason,
            rule: landed.rule,
            landed: landedUrl.split("?")[0]!.slice(0, 120),
          },
        },
      );
    }
  }

  async #fetchFragment(page: Page, pathAndQuery: string, type: PageType): Promise<string> {
    let url: string;
    try {
      url = new URL(pathAndQuery, page.url()).toString();
    } catch {
      throw new RfError("blocked_by_policy", "fragment URL is not valid");
    }
    const verdict = checkFragment(url);
    if (!verdict.allow) {
      throw new RfError("blocked_by_policy", `fragment refused by policy (${verdict.reason})`, {
        details: { reason: verdict.reason, rule: verdict.rule },
      });
    }
    const plan = this.#options.pacer.plan(type);
    if (!plan.ok) {
      throw new RfError("throttled", `pacing limit reached (${plan.reason})`, {
        retry_after_s: Math.ceil(plan.retryAfterMs / 1000),
        details: { reason: plan.reason, page_type: type },
      });
    }
    if (plan.waitMs > 0) await this.#sleep(plan.waitMs);
    this.#options.pacer.record(type);
    this.#options.onPacingChange?.();
    const result = (await page.evaluate(async (target: string) => {
      const response = await fetch(target, {
        credentials: "include",
        headers: { accept: "text/html,*/*" },
      });
      return { status: response.status, finalUrl: response.url, body: await response.text() };
    }, url)) as { status: number; finalUrl: string; body: string };
    this.#options.log?.(
      `fragment ${type} ${pathOnly(url)} -> ${result.status}, ${result.body.length} chars`,
    );
    this.#seen({
      kind: "fragment",
      url,
      final_url: result.finalUrl,
      captured_at: new Date().toISOString(),
      html: result.body,
      note: `status ${result.status}`,
    });
    const landed = checkFragment(result.finalUrl);
    if (!landed.allow)
      throw new RfError("blocked_by_policy", "fragment was redirected to a refused URL");
    if (result.status === 404) throw new RfError("not_found", "Amazon has no such fragment");
    if (result.status >= 400) {
      throw new RfError(
        "layout_unrecognized",
        `fragment request failed with status ${result.status}`,
      );
    }
    return result.body;
  }

  #needsHuman(
    kind: HumanKind,
    message: string,
    where: { seen: FrictionSeen; path?: string; rule?: string; evidence?: string },
  ): never {
    this.#options.pacer.coolDown(kind);
    this.#options.onPacingChange?.();
    this.#options.log?.(
      `needs human: ${kind}, seen on ${where.seen}` +
        (where.path ? ` at ${where.path}` : "") +
        (where.rule ? ` (rule ${where.rule})` : "") +
        (where.evidence ? ` (${where.evidence})` : ""),
    );
    throw new RfError("needs_human", message, {
      kind,
      details: {
        cooling_down_until: this.#options.pacer.state.coolingDownUntil,
        // Which page was being opened when it happened, so the owner can open the same
        // page in a normal tab and clear the challenge there.
        while_opening: pathOnly(this.#lastUrl),
        // What gave it away: a redirect hop that was refused before it loaded, the URL
        // the tab landed on, or the content of the page itself. Paths only.
        seen: where.seen,
        ...(where.path ? { friction_path: where.path } : {}),
        ...(where.evidence ? { evidence: where.evidence } : {}),
      },
    });
  }

  async #capture(page: Page, kind: PageKind): Promise<Capture> {
    const { html } = await serializeWithHiddenMarks(page);
    const capture: Capture = {
      kind,
      url: this.#lastUrl,
      final_url: page.url(),
      captured_at: new Date().toISOString(),
      html,
    };
    // Kept before anything is decided about it: a page that turns out to be a challenge
    // or unreadable is exactly the one worth looking at afterwards.
    this.#seen({ ...capture });
    const interstitial = this.#options.classify?.(capture) ?? null;
    this.#options.log?.(
      `capture ${kind} ${pathOnly(capture.final_url)}, ${html.length} chars` +
        (interstitial ? `: ${interstitial.kind} (${interstitial.evidence})` : ""),
    );
    if (interstitial) {
      switch (interstitial.kind) {
        case "captcha":
        case "sign_in":
        case "soft_challenge":
        case "interstitial":
          this.#needsHuman(
            interstitial.kind,
            `Amazon showed a ${interstitial.kind.replace("_", " ")} page`,
            {
              seen: "page",
              path: pathOnly(capture.final_url),
              evidence: interstitial.evidence.slice(0, 120),
            },
          );
          break;
        case "throttled":
          this.#options.pacer.coolDown("throttled", 10 * 60_000);
          this.#options.onPacingChange?.();
          throw new RfError("throttled", "Amazon is throttling this browser", {
            retry_after_s: 600,
          });
        case "not_found":
          throw new RfError("not_found", "Amazon has no such page");
        default:
          throw new RfError("layout_unrecognized", "Amazon returned an error page");
      }
    }
    return capture;
  }
}

/** Path of a URL without query or fragment, for diagnostics. */
function pathOnly(value: string): string {
  try {
    return new URL(value).pathname.slice(0, 200);
  } catch {
    return "";
  }
}
