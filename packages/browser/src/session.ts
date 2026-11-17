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
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PageContext {
  /** Policy-checked, paced navigation. Throws structured errors. */
  goto(url: string, type: PageType): Promise<void>;
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
      return await work(ctx);
    } finally {
      this.#queued--;
      this.#armIdle();
      release();
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
      capture: (kind) => this.#capture(page, kind),
      fetchFragment: (pathAndQuery, type) => this.#fetchFragment(page, pathAndQuery, type),
    };
  }

  async #goto(page: Page, guard: Guard, url: string, type: PageType): Promise<void> {
    const verdict = checkNavigation(url);
    if (!verdict.allow) {
      throw new RfError("blocked_by_policy", `navigation refused by policy (${verdict.reason})`, {
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
    guard.reset();
    this.#options.pacer.record(type);
    this.#options.onPacingChange?.();
    this.#lastUrl = url;
    try {
      await retryOnDrag(
        () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }),
        this.#sleep,
      );
    } catch (error) {
      const blocked = guard.blocked().find((b) => b.mainFrameDocument);
      if (blocked) {
        await page.goto("about:blank").catch(() => {});
        if (blocked.verdict.reason === "sign_in")
          this.#needsHuman("sign_in", "Amazon asked to sign in again");
        throw new RfError(
          "blocked_by_policy",
          `a redirect was refused by policy (${blocked.verdict.reason})`,
          {
            details: { reason: blocked.verdict.reason, rule: blocked.verdict.rule },
          },
        );
      }
      const message = String((error as Error)?.message ?? error).split("\n")[0] ?? "";
      if (/Timeout/i.test(message)) throw new RfError("timeout", "the page did not load in time");
      throw new RfError("internal", "navigation failed", {
        details: { message: message.slice(0, 200) },
      });
    }
    // Second layer: whatever URL the tab ended up on must itself be allowed.
    const landed = checkNavigation(page.url());
    if (!landed.allow) {
      await page.goto("about:blank").catch(() => {});
      if (landed.reason === "sign_in") this.#needsHuman("sign_in", "Amazon asked to sign in again");
      throw new RfError(
        "blocked_by_policy",
        `the page landed on a refused URL (${landed.reason})`,
        {
          details: { reason: landed.reason, rule: landed.rule },
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

  #needsHuman(kind: HumanKind, message: string): never {
    this.#options.pacer.coolDown(kind);
    this.#options.onPacingChange?.();
    throw new RfError("needs_human", message, {
      kind,
      details: { cooling_down_until: this.#options.pacer.state.coolingDownUntil },
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
    const interstitial = this.#options.classify?.(capture) ?? null;
    if (interstitial) {
      switch (interstitial.kind) {
        case "captcha":
        case "sign_in":
        case "soft_challenge":
        case "interstitial":
          this.#needsHuman(
            interstitial.kind,
            `Amazon showed a ${interstitial.kind.replace("_", " ")} page`,
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
