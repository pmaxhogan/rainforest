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
 * Page dates move to EPOCH plus a secret jitter in +-JITTER_DAYS (from the input hash).
 * Intervals BETWEEN page dates are kept; the interval to the capture is blurred by the
 * jitter. captured_at is constant on purpose: emitting capture + shift would cancel the
 * jitter, and the real capture day is roughly public (it is near the commit date).
 */
export const JITTER_DAYS = 180;

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
  /** Days added to every real date. */
  readonly shiftDays: number;
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
  /** Memo for whole strings, so a repeated title scrubs the same way everywhere. */
  readonly memo: Map<string, string>;
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
  const jitter = int(-JITTER_DAYS, JITTER_DAYS);
  const shiftDays = EPOCH_DAY + jitter - realDay;
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

  return {
    rand,
    int,
    pick: <T>(list: readonly T[]): T => list[int(0, list.length - 1)] as T,
    shiftDays,
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
    fakeName: counterMap((n) => SYNTHETIC.names[n % SYNTHETIC.names.length] as string),
    fakeId: counterMap((n) => `${SYNTHETIC.idPrefix}${pad(n + 1, 4)}`),
    fakeToken: counterMap((n) => `${SYNTHETIC.tokenPrefix}${pad(n + 1, 4)}`),
    fakeUuid: counterMap((n) => `${SYNTHETIC.uuidPrefix}${pad(n + 1, 12)}`),
    fakeDigits,
    memo: new Map(),
  };
}

export { DAY_MS };
