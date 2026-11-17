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
  search: { perHour: 60, perDay: 400 },
  product: { perHour: 90, perDay: 600 },
  offers: { perHour: 60, perDay: 400 },
  reviews: { perHour: 40, perDay: 250 },
  account: { perHour: 60, perDay: 300 },
  cart: { perHour: 90, perDay: 500 },
  list: { perHour: 60, perDay: 300 },
  price_history: { perHour: 12, perDay: 60 },
};

export const MIN_GAP_MS = 1500;
export const MAX_GAP_MS = 4000;
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;

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
    const gap = MIN_GAP_MS + Math.floor(this.#random() * (MAX_GAP_MS - MIN_GAP_MS));
    const waitMs = Math.max(0, this.#state.lastLoadAt + gap - now);
    return { ok: true, waitMs };
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
