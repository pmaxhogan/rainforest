import { expect, test } from "vitest";
import {
  BURST_CAP,
  CAP_CEILINGS,
  DEFAULT_CAPS,
  GLOBAL_CAPS,
  DEFAULT_COOLDOWN_MS,
  MAX_GAP_MS,
  MIN_GAP_MS,
  Pacer,
} from "../src/pacing.ts";

function clock(start = 1_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("caps stay far below the traffic level that drew a checkpoint", () => {
  expect(GLOBAL_CAPS.perHour).toBeLessThanOrEqual(15);
  expect(BURST_CAP.loads).toBeLessThanOrEqual(6);
  expect(MIN_GAP_MS).toBeGreaterThanOrEqual(5000);
  for (const caps of Object.values(DEFAULT_CAPS))
    expect(caps.perHour).toBeLessThanOrEqual(GLOBAL_CAPS.perHour);
});

test("the ceilings an owner may raise the caps to are these and no higher", () => {
  // Hardcoded on purpose: raising a ceiling is a deliberate, reviewed change.
  expect(CAP_CEILINGS).toEqual({ burstLoads: 20, perHour: 40, perDay: 400 });
  expect(BURST_CAP.windowMs).toBe(600_000);
});

test("gaps are jittered between the bounds", () => {
  const c = clock();
  const low = new Pacer({ now: c.now, random: () => 0 });
  low.record("product");
  const a = low.plan("product");
  expect(a).toEqual({ ok: true, waitMs: MIN_GAP_MS });
  const high = new Pacer({ now: c.now, random: () => 0.999999 });
  high.record("product");
  const b = high.plan("product");
  expect(b.ok && b.waitMs).toBeGreaterThan(MAX_GAP_MS - 5);
  expect(b.ok && b.waitMs).toBeLessThanOrEqual(MAX_GAP_MS);
});

test("no wait when the last load is old", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  p.record("search");
  c.advance(60_000);
  expect(p.plan("search")).toEqual({ ok: true, waitMs: 0 });
});

test("hourly cap refuses and recovers", () => {
  const c = clock();
  const p = new Pacer({ now: c.now, caps: { reviews: { perHour: 3, perDay: 100 } } });
  for (let i = 0; i < 3; i++) {
    p.record("reviews");
    c.advance(10_000);
  }
  const refused = p.plan("reviews");
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.reason).toBe("hourly_cap");
  expect(p.budget().reviews).toEqual({ hour_left: 0, day_left: 97 });
  expect(p.budget().all).toEqual({
    hour_left: GLOBAL_CAPS.perHour - 3,
    day_left: GLOBAL_CAPS.perDay - 3,
  });
  c.advance(3_600_000);
  expect(p.plan("reviews").ok).toBe(true);
});

test("daily cap refuses", () => {
  const c = clock();
  const p = new Pacer({ now: c.now, caps: { search: { perHour: 100, perDay: 2 } } });
  p.record("search");
  c.advance(2 * 3_600_000);
  p.record("search");
  c.advance(2 * 3_600_000);
  const refused = p.plan("search");
  expect(!refused.ok && refused.reason).toBe("daily_cap");
});

test("cool-down blocks every page type until it expires", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  p.coolDown("captcha");
  for (const type of ["search", "product", "cart", "none"] as const) {
    const d = p.plan(type);
    expect(!d.ok && d.reason).toBe("cooling_down");
  }
  expect(p.state.coolDownReason).toBe("captcha");
  c.advance(DEFAULT_COOLDOWN_MS + 1);
  expect(p.plan("search").ok).toBe(true);
});

test("an unknown page type fails closed", () => {
  const p = new Pacer();
  expect(p.plan("bogus" as never).ok).toBe(false);
});

test("account friction pages are recognized and nothing else is", async () => {
  const { accountFriction } = await import("../src/session.ts");
  expect(accountFriction("https://www.amazon.com/checkpoint/continue")).toBe("soft_challenge");
  expect(accountFriction("https://www.amazon.com/errors/validateCaptcha?x=1")).toBe("captcha");
  expect(accountFriction("https://www.amazon.com/dp/B0FAKE0001")).toBeNull();
  expect(accountFriction("https://www.example.com/checkpoint/continue")).toBeNull();
  expect(accountFriction("not a url")).toBeNull();
});

test("the global cap bounds all page types together", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  const types = ["search", "product", "cart", "list"] as const;
  for (let i = 0; i < GLOBAL_CAPS.perHour; i++) {
    p.record(types[i % types.length]!);
    c.advance(20_000);
  }
  const refused = p.plan("account");
  expect(!refused.ok && refused.reason).toBe("hourly_cap");
  expect(p.plan("none").ok).toBe(true);
});

test("headroom counts down with loads and is zero while cooling down", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  expect(p.headroom("cart")).toBe(BURST_CAP.loads);
  p.record("cart");
  p.record("product");
  expect(p.headroom("cart")).toBe(BURST_CAP.loads - 2);
  p.coolDown("captcha");
  expect(p.headroom("cart")).toBe(0);
});

/** The load times of one real-shaped session, in seconds from its first load. */
const SESSION_S = [0, 8, 19, 29, 34, 40] as const;
const SESSION_TYPES = ["search", "search", "product", "offers", "product", "product"] as const;

function afterSession(options: ConstructorParameters<typeof Pacer>[0] = {}) {
  const c = clock();
  const p = new Pacer({ ...options, now: c.now });
  let at = 0;
  SESSION_S.forEach((s, i) => {
    c.advance((s - at) * 1000);
    at = s;
    p.record(SESSION_TYPES[i]!);
  });
  return { c, p, at };
}

test("waitFor is the exact time until the needed loads fit the burst window", () => {
  const { c, p } = afterSession();
  c.advance(14_000); // 54 s after the first load
  expect(p.headroom("cart")).toBe(0);
  // Four loads fit once the four oldest have left the 10 minute window: the fourth was at
  // 29 s, so at 629 s, which is 575 s from now.
  expect(p.waitFor({ cart: 2, product: 2 })).toBe(575_000);
  // One load fits as soon as the oldest leaves: at 600 s.
  expect(p.waitFor({ search: 1 })).toBe(546_000);
  c.advance(574_999);
  expect(p.waitFor({ cart: 2, product: 2 })).toBe(1);
  c.advance(1);
  expect(p.waitFor({ cart: 2, product: 2 })).toBe(0);
  expect(p.headroom("cart")).toBe(4);
});

test("waitFor agrees with plan: a load is refused until the wait has passed", () => {
  const { c, p } = afterSession();
  const wait = p.waitFor({ search: 1 });
  expect(wait).toBeGreaterThan(0);
  c.advance(wait! - 1);
  expect(p.plan("search").ok).toBe(false);
  c.advance(1);
  expect(p.plan("search").ok).toBe(true);
});

test("waitFor is 0 with room, covers the cool-down and is null when it can never fit", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  expect(p.waitFor({ cart: 2, product: 2 })).toBe(0);
  expect(p.waitFor({})).toBe(0);
  expect(p.waitFor({ cart: BURST_CAP.loads + 1 })).toBeNull();
  expect(p.waitFor({ bogus: 1 } as never)).toBeNull();
  expect(p.waitFor({ cart: 1.5 })).toBeNull();
  expect(p.waitFor({ cart: -1 })).toBeNull();
  p.coolDown("captcha");
  expect(p.waitFor({ cart: 1 })).toBe(DEFAULT_COOLDOWN_MS);
  expect(p.waitFor({})).toBe(DEFAULT_COOLDOWN_MS);
});

test("waitFor follows the hourly cap when that is what binds", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  // One load every 3 minutes: never more than 4 in any 10 minutes, 15 in 42 minutes.
  for (let i = 0; i < GLOBAL_CAPS.perHour; i++) {
    p.record(i % 2 === 0 ? "product" : "cart");
    c.advance(180_000);
  }
  // Now 45 min after the first load. Two more fit once the two oldest are an hour old:
  // the second was at 3 min, so at 63 min.
  expect(p.waitFor({ list: 2 })).toBe(18 * 60_000);
});

test("waitFor counts a type's own cap", () => {
  const c = clock();
  const p = new Pacer({ now: c.now, caps: { price_history: { perHour: 2 } } });
  p.record("price_history");
  c.advance(60_000);
  p.record("price_history");
  c.advance(60_000);
  expect(p.waitFor({ search: 1 })).toBe(0);
  expect(p.waitFor({ price_history: 1 })).toBe(3_600_000 - 120_000);
  expect(p.waitFor({ price_history: 3 })).toBeNull();
});

test("overrides raise the burst and global caps for one computer; defaults do not move", () => {
  const { c, p } = afterSession({ burst: { loads: 16 }, global: { perHour: 30 } });
  c.advance(14_000);
  expect(p.limits.burst).toEqual({ loads: 16, windowMs: BURST_CAP.windowMs });
  expect(p.limits.global).toEqual({ perHour: 30, perDay: GLOBAL_CAPS.perDay });
  expect(p.waitFor({ cart: 2, product: 2 })).toBe(0);
  expect(p.headroom("cart")).toBe(10);
  expect(p.budget().all).toEqual({ hour_left: 24, day_left: GLOBAL_CAPS.perDay - 6 });
  expect(new Pacer().limits.burst.loads).toBe(BURST_CAP.loads);
  expect(new Pacer().limits.global).toEqual(GLOBAL_CAPS);
});

test("a cap override that is not a whole number of at least 0 keeps the default", () => {
  for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5, "9", null]) {
    const p = new Pacer({
      burst: { loads: bad as never },
      global: { perHour: bad as never, perDay: bad as never },
      caps: { cart: { perHour: bad as never, perDay: bad as never } },
    });
    expect(p.limits.burst.loads, String(bad)).toBe(BURST_CAP.loads);
    expect(p.limits.global, String(bad)).toEqual(GLOBAL_CAPS);
    expect(p.limits.caps.cart, String(bad)).toEqual(DEFAULT_CAPS.cart);
  }
});

test("an override for an unknown page type does not make that type loadable", () => {
  const p = new Pacer({ caps: { bogus: { perHour: 10, perDay: 10 } } as never });
  expect(p.plan("bogus" as never).ok).toBe(false);
  expect(p.headroom("bogus" as never)).toBe(0);
});

test("summary says how many loads fit now and when one more does", () => {
  const c = clock();
  const p = new Pacer({ now: c.now });
  expect(p.summary()).toEqual({ loads_left: BURST_CAP.loads });
  p.record("search");
  c.advance(30_000);
  expect(p.summary()).toEqual({ loads_left: BURST_CAP.loads - 1, next_free_in_s: 570 });
  const full = afterSession();
  full.c.advance(14_000);
  expect(full.p.summary()).toEqual({ loads_left: 0, next_free_in_s: 546 });
  full.p.coolDown("captcha");
  expect(full.p.summary()).toEqual({ loads_left: 0, next_free_in_s: DEFAULT_COOLDOWN_MS / 1000 });
});

test("burst reports the window and the loads still inside it", () => {
  const { c, p } = afterSession();
  const first = c.now() - 40_000;
  expect(p.burst()).toEqual({
    cap: BURST_CAP.loads,
    window_s: 600,
    used_at: SESSION_S.map((s) => first + s * 1000),
  });
  c.advance(600_000 - 40_000 + 8_000); // 608 s after the first load: two have left
  expect(p.burst().used_at).toHaveLength(4);
});
