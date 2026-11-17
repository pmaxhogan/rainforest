/**
 * Conservative pacing for the real account: one page at a time per browser, jittered
 * gaps, hourly and daily caps per page type, and a cool-down after any captcha or
 * sign-in prompt. Pure state machine; the clock and randomness are injected.
 */

export type PageType =
  | "search"
  | "product"
  | "offers"
  | "reviews"
  | "account"
  | "cart"
  | "list"
  | "price_history"
  | "none";

export type PacedType = Exclude<PageType, "none">;

/** How many page loads of each type a flow is about to make. */
export type LoadNeeds = Partial<Record<PacedType, number>>;

export interface Caps {
  perHour: number;
  perDay: number;
}

export interface BurstCap {
  loads: number;
  windowMs: number;
}

export const DEFAULT_CAPS: Readonly<Record<Exclude<PageType, "none">, Caps>> = {
  search: { perHour: 15, perDay: 100 },
  product: { perHour: 15, perDay: 120 },
  offers: { perHour: 15, perDay: 100 },
  reviews: { perHour: 15, perDay: 120 },
  account: { perHour: 12, perDay: 80 },
  cart: { perHour: 15, perDay: 120 },
  list: { perHour: 12, perDay: 80 },
  price_history: { perHour: 6, perDay: 30 },
};

export const MIN_GAP_MS = 5000;
export const MAX_GAP_MS = 11_000;
/** Cap across ALL page types together: per-type caps alone add up to too much traffic. */
// Per device. An account is usually driven from two computers, and Amazon counts the
// account, so each device gets half of what one browser was seen to tolerate.
// The hourly and burst caps are what the observed friction tracked; the daily cap is a
// backstop only.
export const GLOBAL_CAPS: Caps = { perHour: 15, perDay: 200 };
/**
 * Burst cap across all page types. Measured: about 63 loads in 47 minutes, 13 of them in
 * the last 10, drew a "continue shopping" checkpoint. These limits stay far below that.
 */
export const BURST_CAP = { loads: 6, windowMs: 10 * 60_000 } as const;
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

/**
 * The most an owner may raise the caps to on one computer (config `pacing`). The burst
 * window itself is not adjustable. Anything above these is refused when the config loads.
 */
export const CAP_CEILINGS = { burstLoads: 20, perHour: 40, perDay: 400 } as const;

/** Cap overrides for one computer. Anything left out keeps its default. */
export interface PacingOverrides {
  burst?: { loads: number };
  global?: Partial<Caps>;
  caps?: Partial<Record<PacedType, Partial<Caps>>>;
}

export interface PacingState {
  /** Epoch-ms timestamps of page loads per type, pruned to the last 24 h. */
  loads: Partial<Record<PageType, number[]>>;
  lastLoadAt: number;
  coolingDownUntil: number;
  coolDownReason?: string;
}

export function emptyPacingState(): PacingState {
  return { loads: {}, lastLoadAt: 0, coolingDownUntil: 0 };
}

export type PacingDecision =
  | { ok: true; waitMs: number }
  | { ok: false; reason: "cooling_down" | "hourly_cap" | "daily_cap"; retryAfterMs: number };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class Pacer {
  #state: PacingState;
  readonly #caps: Record<string, Caps>;
  readonly #burst: BurstCap;
  readonly #global: Caps;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(
    options: {
      state?: PacingState;
      caps?: Partial<Record<PageType, Partial<Caps>>>;
      burst?: { loads: number };
      global?: Partial<Caps>;
      now?: () => number;
      random?: () => number;
    } = {},
  ) {
    this.#state = options.state ?? emptyPacingState();
    // A cap that is missing or not a whole number of at least 0 falls back to its default:
    // a bad override must never switch a limit off.
    const cap = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
    const caps: Record<string, Caps> = { ...DEFAULT_CAPS };
    for (const [type, override] of Object.entries(options.caps ?? {})) {
      const base = caps[type];
      // An override for a type that has no default is ignored: unknown types stay refused.
      if (base && override) {
        caps[type] = {
          perHour: cap(override.perHour, base.perHour),
          perDay: cap(override.perDay, base.perDay),
        };
      }
    }
    this.#caps = caps;
    this.#burst = {
      loads: cap(options.burst?.loads, BURST_CAP.loads),
      windowMs: BURST_CAP.windowMs,
    };
    this.#global = {
      perHour: cap(options.global?.perHour, GLOBAL_CAPS.perHour),
      perDay: cap(options.global?.perDay, GLOBAL_CAPS.perDay),
    };
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  get state(): PacingState {
    return this.#state;
  }

  /** The caps in force on this computer (defaults plus any override). */
  get limits(): { burst: BurstCap; global: Caps; caps: Readonly<Record<string, Caps>> } {
    return { burst: { ...this.#burst }, global: { ...this.#global }, caps: { ...this.#caps } };
  }

  /** Every recorded load of the last 24 h, oldest first. */
  #all(now: number): number[] {
    return Object.values(this.#state.loads)
      .flat()
      .filter((t): t is number => typeof t === "number" && now - t < DAY)
      .sort((a, b) => a - b);
  }

  /** Decide whether a page load of `type` may happen, and how long to wait first. */
  plan(type: PageType): PacingDecision {
    const now = this.#now();
    if (now < this.#state.coolingDownUntil) {
      return {
        ok: false,
        reason: "cooling_down",
        retryAfterMs: this.#state.coolingDownUntil - now,
      };
    }
    if (type !== "none") {
      const caps = this.#caps[type];
      if (!caps) return { ok: false, reason: "hourly_cap", retryAfterMs: HOUR };
      const loads = (this.#state.loads[type] ?? []).filter((t) => now - t < DAY);
      this.#state.loads[type] = loads;
      const lastHour = loads.filter((t) => now - t < HOUR);
      if (lastHour.length >= caps.perHour) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterMs: Math.max(1000, lastHour[0]! + HOUR - now),
        };
      }
      if (loads.length >= caps.perDay) {
        return {
          ok: false,
          reason: "daily_cap",
          retryAfterMs: Math.max(1000, loads[0]! + DAY - now),
        };
      }
    }
    if (type !== "none") {
      const all = this.#all(now);
      const burst = all.filter((t) => now - t < this.#burst.windowMs);
      if (burst.length >= this.#burst.loads) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterMs: Math.max(1000, burst[0]! + this.#burst.windowMs - now),
        };
      }
      const lastHour = all.filter((t) => now - t < HOUR);
      if (lastHour.length >= this.#global.perHour) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterMs: Math.max(1000, lastHour[0]! + HOUR - now),
        };
      }
      if (all.length >= this.#global.perDay) {
        return {
          ok: false,
          reason: "daily_cap",
          retryAfterMs: Math.max(1000, all[0]! + DAY - now),
        };
      }
    }
    const gap = MIN_GAP_MS + Math.floor(this.#random() * (MAX_GAP_MS - MIN_GAP_MS));
    const waitMs = Math.max(0, this.#state.lastLoadAt + gap - now);
    return { ok: true, waitMs };
  }

  /**
   * How many page loads of `type` could start right now without tripping any cap or the
   * cool-down. Multi-step flows check this before they begin, so they never stall halfway.
   */
  headroom(type: PacedType): number {
    const now = this.#now();
    if (now < this.#state.coolingDownUntil) return 0;
    const all = this.#all(now);
    const own = (this.#state.loads[type] ?? []).filter((t) => now - t < DAY);
    const caps = this.#caps[type];
    if (!caps) return 0;
    const within = (list: number[], ms: number): number => list.filter((t) => now - t < ms).length;
    return Math.max(
      0,
      Math.min(
        this.#burst.loads - within(all, this.#burst.windowMs),
        this.#global.perHour - within(all, HOUR),
        this.#global.perDay - all.length,
        caps.perHour - within(own, HOUR),
        caps.perDay - own.length,
      ),
    );
  }

  /**
   * How long until every load in `needs` could start without tripping a cap or the
   * cool-down: 0 = they fit now, null = they never fit (a cap is smaller than the need,
   * or a type is unknown). Exact: computed from the recorded load times, assuming no
   * other load happens in between.
   */
  waitFor(needs: LoadNeeds): number | null {
    const now = this.#now();
    const windows: { times: number[]; span: number; cap: number; need: number }[] = [];
    let total = 0;
    for (const [type, count] of Object.entries(needs)) {
      if (count === undefined || count === 0) continue;
      if (!Number.isInteger(count) || count < 0) return null;
      const caps = this.#caps[type];
      if (!caps) return null;
      total += count;
      const own = this.#state.loads[type as PageType] ?? [];
      windows.push({ times: own, span: HOUR, cap: caps.perHour, need: count });
      windows.push({ times: own, span: DAY, cap: caps.perDay, need: count });
    }
    let wait = Math.max(0, this.#state.coolingDownUntil - now);
    if (total === 0) return wait;
    const all = this.#all(now);
    windows.push({
      times: all,
      span: this.#burst.windowMs,
      cap: this.#burst.loads,
      need: total,
    });
    windows.push({ times: all, span: HOUR, cap: this.#global.perHour, need: total });
    windows.push({ times: all, span: DAY, cap: this.#global.perDay, need: total });
    for (const w of windows) {
      if (w.need > w.cap) return null;
      const inside = w.times.filter((t) => now - t < w.span).sort((a, b) => a - b);
      // The oldest `excess` loads must leave the window before the new ones fit.
      const excess = inside.length + w.need - w.cap;
      if (excess > 0) wait = Math.max(wait, inside[excess - 1]! + w.span - now);
    }
    return wait;
  }

  /** The burst window as the hub reports it: its size and the loads still inside it. */
  burst(): { cap: number; window_s: number; used_at: number[] } {
    const now = this.#now();
    return {
      cap: this.#burst.loads,
      window_s: Math.round(this.#burst.windowMs / 1000),
      used_at: this.#all(now).filter((t) => now - t < this.#burst.windowMs),
    };
  }

  /**
   * What a caller can plan with: how many loads of any one type fit right now (cool-down,
   * burst and the caps across types; a per-type cap can still be lower), and how long
   * until one more fits.
   */
  summary(): { loads_left: number; next_free_in_s?: number } {
    const now = this.#now();
    const all = this.#all(now);
    const within = (ms: number): number => all.filter((t) => now - t < ms).length;
    const left =
      now < this.#state.coolingDownUntil
        ? 0
        : Math.max(
            0,
            Math.min(
              this.#burst.loads - within(this.#burst.windowMs),
              this.#global.perHour - within(HOUR),
              this.#global.perDay - all.length,
            ),
          );
    // When does one more load than now fit? Only the caps across types are counted here.
    let wait = Math.max(0, this.#state.coolingDownUntil - now);
    const need = left + 1;
    for (const [span, cap] of [
      [this.#burst.windowMs, this.#burst.loads],
      [HOUR, this.#global.perHour],
      [DAY, this.#global.perDay],
    ] as const) {
      if (need > cap) return { loads_left: left };
      const inside = all.filter((t) => now - t < span);
      const excess = inside.length + need - cap;
      if (excess > 0) wait = Math.max(wait, inside[excess - 1]! + span - now);
    }
    return wait > 0
      ? { loads_left: left, next_free_in_s: Math.ceil(wait / 1000) }
      : { loads_left: left };
  }

  /** Record that a page load happened now. */
  record(type: PageType): void {
    const now = this.#now();
    this.#state.lastLoadAt = now;
    if (type !== "none") (this.#state.loads[type] ??= []).push(now);
  }

  /** Start a cool-down (captcha, sign-in prompt or any account friction). */
  coolDown(reason: string, durationMs = DEFAULT_COOLDOWN_MS): void {
    this.#state.coolingDownUntil = Math.max(this.#state.coolingDownUntil, this.#now() + durationMs);
    this.#state.coolDownReason = reason;
  }

  /** Remaining budget per type, for get_status. */
  budget(): Record<string, { hour_left: number; day_left: number }> {
    const now = this.#now();
    const out: Record<string, { hour_left: number; day_left: number }> = {};
    const everything = this.#all(now);
    out.all = {
      hour_left: Math.max(
        0,
        this.#global.perHour - everything.filter((t) => now - t < HOUR).length,
      ),
      day_left: Math.max(0, this.#global.perDay - everything.length),
    };
    for (const [type, caps] of Object.entries(this.#caps)) {
      const loads = (this.#state.loads[type as PageType] ?? []).filter((t) => now - t < DAY);
      out[type] = {
        hour_left: Math.max(0, caps.perHour - loads.filter((t) => now - t < HOUR).length),
        day_left: Math.max(0, caps.perDay - loads.length),
      };
    }
    return out;
  }
}
