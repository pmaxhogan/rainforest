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

export interface Caps {
  perHour: number;
  perDay: number;
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
export const GLOBAL_CAPS: Caps = { perHour: 15, perDay: 100 };
/**
 * Burst cap across all page types. Measured: about 63 loads in 47 minutes, 13 of them in
 * the last 10, drew a "continue shopping" checkpoint. These limits stay far below that.
 */
export const BURST_CAP = { loads: 6, windowMs: 10 * 60_000 } as const;
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

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
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(
    options: {
      state?: PacingState;
      caps?: Partial<Record<PageType, Caps>>;
      now?: () => number;
      random?: () => number;
    } = {},
  ) {
    this.#state = options.state ?? emptyPacingState();
    this.#caps = { ...DEFAULT_CAPS, ...options.caps };
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  get state(): PacingState {
    return this.#state;
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
      const all = Object.values(this.#state.loads)
        .flat()
        .filter((t): t is number => typeof t === "number" && now - t < DAY)
        .sort((a, b) => a - b);
      const burst = all.filter((t) => now - t < BURST_CAP.windowMs);
      if (burst.length >= BURST_CAP.loads) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterMs: Math.max(1000, burst[0]! + BURST_CAP.windowMs - now),
        };
      }
      const lastHour = all.filter((t) => now - t < HOUR);
      if (lastHour.length >= GLOBAL_CAPS.perHour) {
        return {
          ok: false,
          reason: "hourly_cap",
          retryAfterMs: Math.max(1000, lastHour[0]! + HOUR - now),
        };
      }
      if (all.length >= GLOBAL_CAPS.perDay) {
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
  headroom(type: Exclude<PageType, "none">): number {
    const now = this.#now();
    if (now < this.#state.coolingDownUntil) return 0;
    const all = Object.values(this.#state.loads)
      .flat()
      .filter((t): t is number => typeof t === "number" && now - t < DAY);
    const own = (this.#state.loads[type] ?? []).filter((t) => now - t < DAY);
    const caps = this.#caps[type];
    if (!caps) return 0;
    const within = (list: number[], ms: number): number => list.filter((t) => now - t < ms).length;
    return Math.max(
      0,
      Math.min(
        BURST_CAP.loads - within(all, BURST_CAP.windowMs),
        GLOBAL_CAPS.perHour - within(all, HOUR),
        GLOBAL_CAPS.perDay - all.length,
        caps.perHour - within(own, HOUR),
        caps.perDay - own.length,
      ),
    );
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
    const everything = Object.values(this.#state.loads)
      .flat()
      .filter((t): t is number => typeof t === "number" && now - t < DAY);
    out.all = {
      hour_left: Math.max(0, GLOBAL_CAPS.perHour - everything.filter((t) => now - t < HOUR).length),
      day_left: Math.max(0, GLOBAL_CAPS.perDay - everything.length),
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
