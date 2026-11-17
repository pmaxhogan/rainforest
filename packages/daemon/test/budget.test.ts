import { describe, expect, test } from "vitest";
import { RfError } from "@rainforest/core";
import { DEFAULT_COOLDOWN_MS, Pacer, type PageContext } from "@rainforest/browser";
import { createBrowserController, type SessionProvider } from "../src/browser-controller.ts";
import {
  readBack,
  requireBudget,
  runWithBudget,
  setSettleScaleForTests,
  settle,
  type FlowContext,
} from "../src/flows/common.ts";
import { OFFER_TOKEN_TTL_MS } from "../src/flows/offer-token.ts";
import { nullLogger } from "../src/log.ts";
import { sampleConfig } from "./fakes.ts";
import { tmpPaths } from "./helpers.ts";

function clock(start = 1_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A session whose `run` gives one call at a time the browser, like the real one. */
function fakeProvider(pacer: Pacer) {
  let queue: Promise<unknown> = Promise.resolve();
  let attached = 0;
  const page = {} as PageContext;
  const session = {
    run<T>(work: (ctx: PageContext) => Promise<T>): Promise<T> {
      const next = queue.catch(() => {}).then(() => work(page));
      queue = next;
      return next;
    },
  };
  const provider = {
    session: async () => {
      attached++;
      return session;
    },
    pacer: () => pacer,
    setSignedIn: () => {},
    showOnScreen: () => {},
  } as unknown as SessionProvider;
  return { provider, session, attached: () => attached };
}

function context(pacer: Pacer, now: () => number) {
  const fake = fakeProvider(pacer);
  const ctx: FlowContext = { browser: fake.provider, now, signal: new AbortController().signal };
  return { ctx, ...fake };
}

function refusal(run: () => unknown): RfError {
  try {
    run();
  } catch (error) {
    if (error instanceof RfError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Six loads in 40 seconds: the shape of a short research session that fills the burst cap. */
function fullBurst() {
  const c = clock();
  const pacer = new Pacer({ now: c.now });
  const at = [0, 8, 19, 29, 34, 40];
  const types = ["search", "search", "product", "offers", "product", "product"] as const;
  let last = 0;
  at.forEach((s, i) => {
    c.advance((s - last) * 1000);
    last = s;
    pacer.record(types[i]!);
  });
  c.advance(14_000);
  return { c, pacer };
}

describe("requireBudget", () => {
  test("passes when the loads fit", () => {
    const c = clock();
    const { ctx } = context(new Pacer({ now: c.now }), c.now);
    expect(() => requireBudget(ctx, { cart: 2, product: 2 })).not.toThrow();
  });

  test("the refusal carries the real wait, not a fixed one", () => {
    const { c, pacer } = fullBurst();
    const { ctx } = context(pacer, c.now);
    const error = refusal(() => requireBudget(ctx, { cart: 2, product: 2 }));
    expect(error.payload).toEqual({
      code: "throttled",
      message:
        "this action needs 4 page loads and only 0 fit the pacing budget right now; all 4 fit in 575 s",
      retry_after_s: 575,
      details: { needed: 4, available: 0 },
    });
    // Waiting exactly that long is enough.
    c.advance(575_000);
    expect(() => requireBudget(ctx, { cart: 2, product: 2 })).not.toThrow();
  });

  test("a note that depends on the wait is appended", () => {
    const { c, pacer } = fullBurst();
    const { ctx } = context(pacer, c.now);
    const seen: number[] = [];
    const error = refusal(() =>
      requireBudget(ctx, { cart: 1 }, (waitMs) => {
        seen.push(waitMs);
        return "bring a fresh offer_id";
      }),
    );
    expect(seen).toEqual([546_000]);
    expect(error.payload.message).toBe(
      "this action needs 1 page loads and only 0 fit the pacing budget right now; all 1 fit in 546 s. bring a fresh offer_id",
    );
    expect(error.payload.retry_after_s).toBe(546);
  });

  test("a cool-down is named as one and lasts as long as the cool-down", () => {
    const c = clock();
    const pacer = new Pacer({ now: c.now });
    pacer.coolDown("captcha");
    c.advance(60_000);
    const { ctx } = context(pacer, c.now);
    const error = refusal(() => requireBudget(ctx, { list: 2 }));
    expect(error.payload).toEqual({
      code: "throttled",
      message: "this browser is cooling down after an account prompt",
      retry_after_s: (DEFAULT_COOLDOWN_MS - 60_000) / 1000,
      details: { needed: 2, available: 0, reason: "captcha" },
    });
  });

  test("a need larger than a cap can never fit and promises no retry time", () => {
    const c = clock();
    const { ctx } = context(new Pacer({ now: c.now, burst: { loads: 3 } }), c.now);
    const error = refusal(() => requireBudget(ctx, { cart: 2, product: 2 }));
    expect(error.payload.code).toBe("throttled");
    expect(error.payload.retry_after_s).toBeUndefined();
    expect(error.payload.details).toEqual({ needed: 4, available: 3 });
  });
});

describe("runWithBudget", () => {
  test("a call refused up front never touches the browser", async () => {
    const { c, pacer } = fullBurst();
    const { ctx, attached } = context(pacer, c.now);
    let ran = false;
    await expect(
      runWithBudget(ctx, { cart: 2 }, async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ payload: { code: "throttled", retry_after_s: 554 } });
    expect(ran).toBe(false);
    expect(attached()).toBe(0);
  });

  test("budget spent by a call queued ahead is seen before the flow starts", async () => {
    const c = clock();
    const pacer = new Pacer({ now: c.now });
    pacer.record("search");
    pacer.record("search");
    const { ctx, session } = context(pacer, c.now);
    // A read holds the browser and loads one page while the write waits behind it.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const read = session.run(async () => {
      await held;
      pacer.record("product");
    });
    // Four loads fit when the write is submitted (2 of 6 used) ...
    expect(pacer.waitFor({ cart: 2, product: 2 })).toBe(0);
    let ran = false;
    const write = runWithBudget(ctx, { cart: 2, product: 2 }, async () => {
      ran = true;
      return "added";
    });
    const outcome = write.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    release();
    await read;
    // ... but only three once it holds the browser, so it must not start.
    const settled = await outcome;
    expect(ran).toBe(false);
    expect(settled).toMatchObject({
      error: { payload: { code: "throttled", details: { needed: 4, available: 3 } } },
    });
  });

  test("a flow whose loads fit runs with the browser and returns its result", async () => {
    const c = clock();
    const { ctx, attached } = context(new Pacer({ now: c.now }), c.now);
    await expect(runWithBudget(ctx, { list: 2 }, async () => "done")).resolves.toBe("done");
    expect(attached()).toBe(1);
  });
});

test("an offer id outlives a full burst window, so a wait for the budget does not kill it", () => {
  // Hardcoded on purpose: the lifetime must stay above the 10 minute burst window.
  expect(OFFER_TOKEN_TTL_MS).toBe(30 * 60_000);
});

describe("this computer's caps", () => {
  test("come from the config when it has a pacing object, and are reported", () => {
    const controller = createBrowserController({
      config: sampleConfig({ pacing: { burst: { loads: 16 }, all: { per_hour: 30 } } }),
      paths: tmpPaths(),
      log: nullLogger(),
    });
    expect(controller.pacer().limits.burst).toEqual({ loads: 16, windowMs: 600_000 });
    expect(controller.pacer().limits.global).toEqual({ perHour: 30, perDay: 200 });
    expect(controller.pacingSummary?.()).toEqual({ loads_left: 16 });
    expect(controller.status().burst).toEqual({ cap: 16, window_s: 600, used_at: [] });
  });

  test("are the shipped defaults without one", () => {
    const controller = createBrowserController({
      config: sampleConfig(),
      paths: tmpPaths(),
      log: nullLogger(),
    });
    expect(controller.pacer().limits.burst.loads).toBe(6);
    expect(controller.pacer().limits.global).toEqual({ perHour: 15, perDay: 200 });
    expect(controller.pacingSummary?.()).toEqual({ loads_left: 6 });
  });
});

test("when one page type's own cap is what binds, the refusal does not claim room it lacks", () => {
  // This computer allows 16 loads per 10 minutes and 30 per hour, but product pages keep
  // their own 15 per hour. Fifteen product loads over 50 minutes use that up while the
  // caps across types still have room.
  const c = clock();
  const pacer = new Pacer({ now: c.now, burst: { loads: 16 }, global: { perHour: 30 } });
  for (let i = 0; i < 15; i++) {
    pacer.record("product");
    c.advance(200_000);
  }
  expect(pacer.summary().loads_left).toBeGreaterThanOrEqual(4);
  const { ctx } = context(pacer, c.now);
  const error = refusal(() => requireBudget(ctx, { cart: 2, product: 2 }));
  expect(error.payload.code).toBe("throttled");
  // Two product loads fit once the two oldest are an hour old: the second was at 200 s,
  // and now is 3000 s.
  expect(error.payload.retry_after_s).toBe(800);
  // The two cart loads fit; neither product load does.
  expect(error.payload.details).toEqual({ needed: 4, available: 2, limited_by: "product" });
  expect(error.payload.message).toBe(
    "this action needs 4 page loads and only 2 fit the pacing budget right now (the product page cap is what limits it); all 4 fit in 800 s",
  );
});

describe("settle", () => {
  const timed = async (ms: number): Promise<number> => {
    const started = performance.now();
    await settle(ms);
    return performance.now() - started;
  };

  test("waits the full time unless the end-to-end suite scaled it down", async () => {
    expect(await timed(120)).toBeGreaterThanOrEqual(110);
    setSettleScaleForTests(0.1);
    try {
      expect(await timed(600)).toBeLessThan(300);
    } finally {
      setSettleScaleForTests(1);
    }
    expect(await timed(120)).toBeGreaterThanOrEqual(110);
  });

  test("the scale can only shorten a wait: anything else resets it to the full time", async () => {
    for (const bad of [0, -1, 2, 50, Number.NaN, Number.POSITIVE_INFINITY]) {
      setSettleScaleForTests(0.1);
      setSettleScaleForTests(bad);
      expect(await timed(100), String(bad)).toBeGreaterThanOrEqual(90);
    }
    setSettleScaleForTests(1);
  });
});

describe("readBack", () => {
  test("passes a successful read through untouched", async () => {
    await expect(readBack(async () => ({ lines: 2 }))).resolves.toEqual({ lines: 2 });
  });

  test("a challenge on the read-back keeps its code and says the click was already made", async () => {
    const challenge = new RfError("needs_human", "Amazon showed a soft challenge page", {
      kind: "soft_challenge",
      details: { while_opening: "/gp/cart/view.html", seen: "redirect" },
    });
    const error = await readBack(async () => {
      throw challenge;
    }, "the offer's Add to Cart control").then(
      () => null,
      (e: unknown) => e as RfError,
    );
    expect(error?.payload).toEqual({
      code: "needs_human",
      message:
        "Amazon showed a soft challenge page; the offer's Add to Cart control had already been clicked, so the change may have been made: read the current state before trying again",
      kind: "soft_challenge",
      details: { while_opening: "/gp/cart/view.html", seen: "redirect", write: "unverified" },
    });
  });

  test("a cap hit on the read-back keeps its retry time", async () => {
    const error = await readBack(async () => {
      throw new RfError("throttled", "pacing limit reached (hourly_cap)", { retry_after_s: 120 });
    }).then(
      () => null,
      (e: unknown) => e as RfError,
    );
    expect(error?.payload.code).toBe("throttled");
    expect(error?.payload.retry_after_s).toBe(120);
    expect(error?.payload.details).toEqual({ write: "unverified" });
    expect(error?.payload.message).toMatch(
      /^pacing limit reached \(hourly_cap\); the control for this change had already been clicked/,
    );
  });

  test("an unexpected failure becomes an internal error that still says so, without its own text", async () => {
    const error = await readBack(async () => {
      throw new Error("path /home/someone/leak");
    }).then(
      () => null,
      (e: unknown) => e as RfError,
    );
    expect(error).toBeInstanceOf(RfError);
    expect(error?.payload.code).toBe("internal");
    expect(error?.payload.details).toEqual({ write: "unverified" });
    expect(JSON.stringify(error?.payload)).not.toContain("leak");
    expect(error?.payload.message).toMatch(/had already been clicked/);
  });
});
