import { expect, test } from "vitest";
import {
  BURST_CAP,
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
