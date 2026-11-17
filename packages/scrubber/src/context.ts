/**
 * Per-fixture scrub state: a deterministic PRNG, the date shift, and the in-memory maps
 * from real values to synthetic ones. The maps are never serialized or returned.
 *
 * Fake identifiers are assigned by ORDER OF FIRST APPEARANCE, never derived from the real
 * value: a hash of the real value would let anyone confirm a guess ("did the owner buy
 * B0...?") by hashing it themselves.
 */
import { createHash } from "node:crypto";
import { FAKE_RANGES, SYNTHETIC } from "./rules.mjs";

const DAY_MS = 86_400_000;
/** Synthetic epoch (2020-07-01). Every fixture's captured_at is this day at 12:00 UTC. */
export const EPOCH_DAY = Date.UTC(2020, 6, 1) / DAY_MS;
export const SYNTHETIC_CAPTURED_AT = new Date(EPOCH_DAY * DAY_MS + 12 * 3_600_000).toISOString();
/**
 * Page dates move by a seeded offset of MIN_SHIFT_DAYS..MAX_SHIFT_DAYS in either direction,
 * never within MIN_YEAR_GAP_DAYS of a whole number of years (so month and day do not
 * survive), unrelated to the real capture day. Each distinct date then gets its own extra
 * jitter of up to +-DATE_JITTER_DAYS, so the gaps between page dates are not exact either.
 * captured_at is a constant: the real capture day is roughly public (near the commit date).
 */
export const MIN_SHIFT_DAYS = 3 * 365;
export const MAX_SHIFT_DAYS = 6 * 365;
export const MIN_YEAR_GAP_DAYS = 30;
export const DATE_JITTER_DAYS = 3;
/** Amounts and counts are multiplied by a factor in this range (log-uniform). */
export const AMOUNT_SCALE = [0.3, 3] as const;

/** Distance in days from `days` to the nearest whole number of (average) years. */
export function yearGap(days: number): number {
  const y = 365.2425;
  const r = Math.abs(days) % y;
  return Math.min(r, y - r);
}

export type Category =
  | "asin"
  | "order_id"
  | "email"
  | "phone"
  | "name"
  | "address"
  | "zip"
  | "card"
  | "token"
  | "id"
  | "uuid"
  | "url"
  | "image_url"
  | "query_param_dropped"
  | "path_segment"
  | "date"
  | "time"
  | "timezone"
  | "number"
  | "word"
  | "rating"
  | "label_kept"
  | "text_node"
  | "attr_scrubbed"
  | "attr_dropped"
  | "handler_dropped"
  | "script_dropped"
  | "script_kept"
  | "element_dropped"
  | "pixel_dropped"
  | "comment_dropped"
  | "json_blob";

export interface ScrubContext {
  /** Uniform float in [0, 1). */
  rand(): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(list: readonly T[]): T;
  /** Days added to every real date (before the per-date jitter). */
  readonly shiftDays: number;
  /** Extra days for one real date (by day number), drawn once per distinct date. */
  jitterFor(day: number): number;
  /** Real capture day (days since 1970), for year inference. Never emitted. */
  readonly realDay: number;
  count(cat: Category, n?: number): void;
  readonly counts: Map<Category, number>;
  fakeAsin(real: string): string;
  fakeOrderId(real: string): string;
  fakeEmail(real: string): string;
  fakePhone(real: string): string;
  fakeZip(real: string): string;
  fakeName(real: string): string;
  fakeId(real: string): string;
  fakeToken(real: string): string;
  fakeUuid(real: string): string;
  /** Same digit count, leading zero kept, consistent within the fixture. */
  fakeDigits(real: string): string;
  /**
   * An amount or count ("1,234", "12" + "99" cents) scaled by a random factor in
   * AMOUNT_SCALE (one factor per distinct value), in the same format: grouping commas only
   * when the original had them, the same number of decimals. Zero stays zero.
   */
  scaleAmount(intPart: string, frac: string | undefined): string;
  /** A lone digit: 0 and 1 unchanged, 2..9 through one random permutation per fixture. */
  permDigit(d: string): string;
  /**
   * A long digit run (an ad, campaign, log, browse-node or other id): "9" then zeros then a
   * counter, same length, one per distinct real value. Obviously not data.
   */
  placeholderDigits(real: string): string;
  /**
   * A year used as a FILTER value (order-history "year-NNNN"): moved by its own seeded
   * offset of 3..9 years either way, independent of the date shift, before the normal year
   * shift applies, so the filter year has no fixed relation to the page dates or real years.
   */
  filterYear(y: number): number;
  /** Memo for whole strings, so a repeated title scrubs the same way everywhere. */
  readonly memo: Map<string, string>;
  /** Account-scoped id values seen in ID_PARAMS anywhere in the capture (see scrub.ts). */
  readonly knownIds: Set<string>;
  /** Real list names (lower case) -> "List One", "List Two", ... in order of appearance. */
  readonly listNames: Map<string, string>;
}

/** sfc32 seeded from a SHA-256 digest: tiny, fast and fully deterministic. */
function sfc32(seedBytes: Buffer): () => number {
  let a = seedBytes.readUInt32LE(0);
  let b = seedBytes.readUInt32LE(4);
  let c = seedBytes.readUInt32LE(8);
  let d = seedBytes.readUInt32LE(12);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function counterMap(make: (n: number) => string): (real: string) => string {
  const map = new Map<string, string>();
  return (real) => {
    let v = map.get(real);
    if (v === undefined) {
      v = make(map.size);
      map.set(real, v);
    }
    return v;
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Build a context. `material` is everything the output may depend on (seed plus the full
 * raw capture); hashing it keeps the PRNG and the date jitter unguessable without the raw
 * capture while staying byte-for-byte reproducible from it.
 */
export function createContext(material: string, capturedAt: string): ScrubContext {
  const parsed = Date.parse(capturedAt);
  if (!Number.isFinite(parsed)) {
    // Without a real anchor the date shift would be guessed; fail closed instead.
    throw new Error("captured_at is not a valid timestamp; refusing to shift dates blindly");
  }
  const realDay = Math.floor(parsed / DAY_MS);
  const digest = createHash("sha256").update(material).digest();
  const rand = sfc32(digest);
  for (let i = 0; i < 16; i++) rand();
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  let shiftDays = 0;
  // Bounded: a draw lands outside the excluded bands with probability above 80%.
  for (let k = 0; k < 64 && yearGap(shiftDays) < MIN_YEAR_GAP_DAYS; k++) {
    shiftDays = int(MIN_SHIFT_DAYS, MAX_SHIFT_DAYS) * (int(0, 1) === 0 ? -1 : 1);
  }
  if (yearGap(shiftDays) < MIN_YEAR_GAP_DAYS) shiftDays = -(MIN_SHIFT_DAYS + 180);
  const jitters = new Map<number, number>();
  const counts = new Map<Category, number>();
  const digitMap = new Map<string, string>();

  const fakeDigits = (real: string): string => {
    const hit = digitMap.get(real);
    if (hit !== undefined) return hit;
    const gen = (): string => {
      let s = real[0] === "0" ? "0" : String(int(1, 9));
      for (let i = 1; i < real.length; i++) s += String(int(0, 9));
      return s;
    };
    let out = gen();
    for (let k = 0; k < 8 && out === real && real.length >= 2; k++) out = gen();
    digitMap.set(real, out);
    return out;
  };

  const amountMap = new Map<string, string>();
  const scaleAmount = (intPart: string, frac: string | undefined): string => {
    const key = `${intPart}.${frac ?? ""}`;
    const hit = amountMap.get(key);
    if (hit !== undefined) return hit;
    const value = Number(`${intPart.replace(/,/g, "")}.${frac ?? "0"}`);
    const [lo, hi] = AMOUNT_SCALE;
    let out: string;
    if (!Number.isFinite(value) || value === 0) {
      out = frac === undefined ? intPart : `${intPart}.${frac}`;
    } else {
      // Never within x0.8..x1.25: a factor near 1 would leave the real amount readable.
      let f = 1;
      for (let k = 0; k < 16 && f > 0.8 && f < 1.25; k++) f = lo * Math.pow(hi / lo, rand());
      if (f > 0.8 && f < 1.25) f = hi;
      let v = value * f;
      const dec = frac?.length ?? 0;
      if (dec === 0) v = Math.max(1, Math.round(v));
      const fixed = v.toFixed(dec);
      const [whole = "0", cents] = fixed.split(".");
      const grouped = intPart.includes(",") ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
      out = cents === undefined ? grouped : `${grouped}.${cents}`;
    }
    amountMap.set(key, out);
    return out;
  };
  let perm: string[] | undefined;
  const permDigit = (d: string): string => {
    if (d === "0" || d === "1") return d;
    if (perm === undefined) {
      perm = ["2", "3", "4", "5", "6", "7", "8", "9"];
      for (let k = perm.length - 1; k > 0; k--) {
        const j = int(0, k);
        [perm[k], perm[j]] = [perm[j] as string, perm[k] as string];
      }
    }
    return perm[Number(d) - 2] ?? d;
  };

  // Drawn so that, combined with the date shift's whole years, a filter year never lands
  // within 3 years of the real one.
  const shiftYears = Math.round(shiftDays / 365.2425);
  let filterOffset = 0;
  for (let k = 0; k < 64 && Math.abs(filterOffset + shiftYears) < 3; k++) {
    filterOffset = int(3, 9) * (int(0, 1) === 0 ? -1 : 1);
  }
  if (Math.abs(filterOffset + shiftYears) < 3) filterOffset = shiftYears >= 0 ? 3 : -3;

  const placeholderMaps = new Map<number, Map<string, string>>();
  const placeholderDigits = (real: string): string => {
    const len = real.length;
    const m = placeholderMaps.get(len) ?? new Map<string, string>();
    placeholderMaps.set(len, m);
    let v = m.get(real);
    if (v === undefined) {
      v = `9${String(m.size + 1).padStart(len - 1, "0")}`;
      m.set(real, v);
    }
    return v;
  };

  return {
    rand,
    int,
    placeholderDigits,
    filterYear: (y: number) => y + filterOffset,
    scaleAmount,
    permDigit,
    pick: <T>(list: readonly T[]): T => list[int(0, list.length - 1)] as T,
    shiftDays,
    jitterFor(day) {
      let j = jitters.get(day);
      if (j === undefined) {
        j = int(-DATE_JITTER_DAYS, DATE_JITTER_DAYS);
        jitters.set(day, j);
      }
      return j;
    },
    realDay,
    counts,
    count(cat, n = 1) {
      counts.set(cat, (counts.get(cat) ?? 0) + n);
    },
    fakeAsin: counterMap((n) => `B0FAKE${n.toString(36).toUpperCase().padStart(4, "0")}`),
    fakeOrderId: counterMap((n) => `000-0000000-${pad(n + 1, 7)}`),
    fakeEmail: counterMap((n) => `user${n + 1}@${FAKE_RANGES.emailDomain}`),
    fakePhone: counterMap((n) => `555-555-01${pad(n % 100, 2)}`),
    fakeZip: counterMap((n) => FAKE_RANGES.zips[n % FAKE_RANGES.zips.length] as string),
    // Two names only: how many distinct people a page names is itself account structure.
    fakeName: counterMap((n) => SYNTHETIC.names[n % 2] as string),
    fakeId: counterMap((n) => `${SYNTHETIC.idPrefix}${pad(n + 1, 4)}`),
    fakeToken: counterMap((n) => `${SYNTHETIC.tokenPrefix}${pad(n + 1, 4)}`),
    fakeUuid: counterMap((n) => `${SYNTHETIC.uuidPrefix}${pad(n + 1, 12)}`),
    fakeDigits,
    memo: new Map(),
    knownIds: new Set(),
    listNames: new Map(),
  };
}

export { DAY_MS };
