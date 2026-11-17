/**
 * Date shifting. Every real date moves by the same seeded `shiftDays` plus a small per-date
 * jitter, so intervals inside one fixture stay roughly plausible while neither the absolute
 * dates nor the exact gaps survive. Weekday names attached to a date are recomputed.
 */
import { DAY_MS, type ScrubContext } from "./context.ts";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTH_RE =
  "January|February|March|April|May|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
export const WEEKDAY_RE =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Tues|Thurs|Thur|Mon|Tue|Wed|Thu|Fri|Sat|Sun";

export function monthIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m.toLowerCase().startsWith(n.slice(0, 3)));
}

export function weekdayIndex(name: string): number {
  const n = name.toLowerCase().replace(/\.$/, "");
  return WEEKDAYS.findIndex((w) => w.toLowerCase().startsWith(n.slice(0, 3)));
}

function caseLike(orig: string, word: string): string {
  if (orig.length > 1 && orig === orig.toUpperCase()) return word.toUpperCase();
  if (orig[0] === orig[0]?.toLowerCase()) return word.toLowerCase();
  return word;
}

/** Render a month name in the style of `orig` (full or 3-letter, same case). */
export function styleMonth(orig: string, idx: number): string {
  const full = MONTHS[idx] as string;
  const bare = orig.replace(/\.$/, "");
  const word =
    bare.length <= 4 && bare.toLowerCase() !== full.toLowerCase() ? full.slice(0, 3) : full;
  return caseLike(bare, word);
}

export function styleWeekday(orig: string, idx: number): string {
  const full = WEEKDAYS[idx] as string;
  const bare = orig.replace(/\.$/, "");
  // Abbreviated only when the original was ("Tue", "Thurs"), not when it was a shorter day name.
  const word =
    bare.length <= 5 && bare.toLowerCase() !== full.toLowerCase() ? full.slice(0, 3) : full;
  return caseLike(bare, word);
}

export interface Ymd {
  y: number;
  m: number; // 0-based
  d: number;
}

export function dayOf(ymd: Ymd): number {
  return Date.UTC(ymd.y, ymd.m, ymd.d) / DAY_MS;
}

export function ymdOf(day: number): Ymd & { wd: number } {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), wd: dt.getUTCDay() };
}

/** Year for a month/day without one: the occurrence nearest the real capture date. */
export function inferYear(ctx: ScrubContext, m: number, d: number): number {
  const base = ymdOf(ctx.realDay).y;
  let best = base;
  let bestDist = Infinity;
  for (const y of [base - 1, base, base + 1]) {
    const dist = Math.abs(dayOf({ y, m, d }) - ctx.realDay);
    if (dist < bestDist) {
      best = y;
      bestDist = dist;
    }
  }
  return best;
}

export function shift(ctx: ScrubContext, ymd: Ymd): Ymd & { wd: number } {
  const day = dayOf(ymd);
  return ymdOf(day + ctx.shiftDays + ctx.jitterFor(day));
}

export function shiftYear(ctx: ScrubContext, y: number): number {
  return shift(ctx, { y, m: 6, d: 1 }).y;
}

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** Keep the zero padding of `orig`. */
export function padLike(orig: string, n: number): string {
  return orig.length >= 2 && orig.startsWith("0")
    ? String(n).padStart(orig.length, "0")
    : String(n);
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
