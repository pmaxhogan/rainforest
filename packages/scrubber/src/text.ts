/* eslint-disable no-control-regex -- \u0001-\u0003 mark free words and numbers in this module's own intermediate output; they never reach a fixture. */
/**
 * Text scrubbing. Every word outside the label allowlist becomes synthetic, so the safety
 * property does not depend on recognizing what a value IS: an unrecognized name or address
 * is replaced like any other word. Recognizers (ids, dates, prices, ZIPs, phones) exist to
 * keep the SHAPE parsers need and to map identifiers consistently.
 *
 * The token regexes come from rules.mjs, the same source the audit uses, so the scrubber's
 * output is closed under the audit: it never mints a token the audit would flag.
 */
import { LABELS, type LabelKind } from "./allowlists.ts";
import { EPOCH_DAY, type ScrubContext } from "./context.ts";

const EPOCH_YEAR = new Date(EPOCH_DAY * 86_400_000).getUTCFullYear();
import {
  MONTH_RE,
  WEEKDAY_RE,
  inferYear,
  monthIndex,
  ordinal,
  pad2,
  padLike,
  shift,
  shiftYear,
  styleMonth,
  styleWeekday,
  weekdayIndex,
} from "./dates.ts";
import { PATTERNS, SYNTHETIC, isFakeUuid, isOpaque, isUpperId } from "./rules.mjs";
import { scrubUrl } from "./url.ts";

export type TextMode = "text" | "name" | "address";

const VOCAB = {
  one: ["a", "e", "o"],
  short: ["ad", "at", "et", "id", "in", "ut", "eu", "ac", "vel", "sed", "non", "est", "qui", "nam"],
  mid: [
    "lorem",
    "ipsum",
    "dolor",
    "amet",
    "elit",
    "magna",
    "nulla",
    "porta",
    "felis",
    "lacus",
    "justo",
    "mauris",
    "tellus",
    "varius",
    "augue",
    "dictum",
    "semper",
    "tempor",
    "rhoncus",
    "gravida",
    "viverra",
    "aliquam",
    "posuere",
    "sodales",
  ],
  long: [
    "pharetra",
    "vehicula",
    "faucibus",
    "molestie",
    "pulvinar",
    "sagittis",
    "tincidunt",
    "vulputate",
    "elementum",
    "imperdiet",
    "fermentum",
    "consequat",
    "malesuada",
    "ullamcorper",
    "condimentum",
  ],
} as const;

const PLACEHOLDER = new RegExp(`^(?:${SYNTHETIC.idPrefix}|${SYNTHETIC.tokenPrefix})[0-9]{4,}$`);

function sticky(src: string, flags = ""): RegExp {
  return new RegExp(src, `${flags}y`);
}

// Capitalized or ALL CAPS names only: "may" and "sat" in prose are not dates.
const MON = `(?:${MONTH_RE}|${MONTH_RE.toUpperCase()})`;
const WD = `(?:${WEEKDAY_RE}|${WEEKDAY_RE.toUpperCase()})`;

const R = {
  url: sticky(PATTERNS.url, "i"),
  protoRel: /(?<![:\w/])\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:[/?#][^\s"'<>]*)?/y,
  email: sticky(PATTERNS.email),
  run: sticky(PATTERNS.opaqueRun),
  anyRun: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]+/y,
  isoDateTime:
    /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/dy,
  orderId: sticky(PATTERNS.orderId),
  uuid: sticky(PATTERNS.uuid),
  phone: sticky(PATTERNS.phone),
  card: sticky(PATTERNS.cardLast4, "id"),
  asinCtx: /(?<![A-Za-z])(asin["']?\s*[:=]\s*["']?)(\d{9}[\dXx]|[A-Za-z0-9]{10})(?![A-Za-z0-9])/iy,
  usDate: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/dy,
  monthDate: new RegExp(
    `(?:(${WD})\\.?,?\\s+)?(${MON})\\.?\\s+(\\d{1,2})(st|nd|rd|th)?(?![\\d:])` +
      `(?:\\s*-\\s*(?:(${MON})\\.?\\s+)?(\\d{1,2})(?![\\d:]))?(?:,?\\s+(\\d{4})(?!\\d))?`,
    "dy",
  ),
  dayMonth: new RegExp(
    `(?:(${WD})\\.?,?\\s+)?(?<!\\d)(\\d{1,2})\\s+(${MON})\\.?(?![A-Za-z])(?:,?\\s+(\\d{4})(?!\\d))?`,
    "dy",
  ),
  monthYear: new RegExp(`(${MON})\\.?,?\\s+((?:19|20)\\d{2})(?!\\d)`, "dy"),
  time12: /(?<![\d:])(\d{1,2})(?::(\d{2}))?(\s?)([AaPp])(\.?[Mm]\.?)(?![A-Za-z])/dy,
  time24: /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/dy,
  // Not inside a letter/digit run: "ET4M8N..." is an id, not a time zone.
  zone: /(?<![A-Za-z0-9])(?:[ECMP][SD]T|AK[SD]T|H[SD]T|[ECMP]T|GMT|UTC)(?:\s?[+-]\d{1,2}(?::?\d{2})?)?(?![A-Za-z0-9])/y,
  street:
    /(?<![A-Za-z0-9])\d{1,6}\s+(?:[A-Za-z0-9.'#-]+\s+){0,5}?(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle|Loop|Trl|Trail|Sq|Square)\.?(?![A-Za-z])/y,
  cityStateZip:
    /(?<![A-Za-z])[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3},?\s+([A-Z]{2})\s+(\d{5})(-\d{4})?(?!\d|[.,]\d|%|-\d)/dy,
  cityZip:
    /(?<![A-Za-z])[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}\s+(\d{5})(-\d{4})?(?=\s*$)/dy,
  asin: sticky(PATTERNS.asin),
  upperId: sticky(PATTERNS.upperId),
  zipPlus4: sticky(PATTERNS.zipPlus4),
  zip: sticky(PATTERNS.zip),
  year: /(?<![\d,.$])(?:19|20)\d{2}(?!\d|[.,]\d|%)/y,
  ordinal: /(\d+)(st|nd|rd|th)(?![A-Za-z])/y,
  weekday: /(?<![A-Za-z])(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?![A-Za-z])/y,
  month:
    /(?<![A-Za-z])(?:January|February|March|April|June|July|August|September|October|November|December)(?![A-Za-z])/y,
  alnum: /[A-Za-z0-9]+/y,
  // Optional exponent ("3.09E-4"): kept attached so its letter is not read as a word.
  number: /\d+(?:[.,]\d+)*(?:[eE][+-]?\d+(?![A-Za-z0-9]))?/y,
  pctRun:
    /(?<![A-Za-z0-9+/=_%-])(?:[A-Za-z0-9+/=_-]|%[0-9A-Fa-f]{2})*%[0-9A-Fa-f]{2}(?:[A-Za-z0-9+/=_-]|%[0-9A-Fa-f]{2})*/y,
  pctEscape: /%([0-9A-Fa-f]{2})/y,
  money: /(-?)([$\u00a3\u20ac])(\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d])/y,
  caseRun: /(?<![A-Za-z0-9+])[A-Za-z0-9+]{8,}(?![A-Za-z0-9+])/y,
  mediaId: /(?<![A-Za-z0-9+-])\d{2}[A-Za-z0-9+-]{6,10}L(?![A-Za-z0-9+-])/y,
  word: /[A-Za-z0-9_-]+/y,
  cardBrand:
    /(?<![A-Za-z])(?:American Express|AMEX|Amex|Master ?[Cc]ard|MASTERCARD|Visa|VISA|Discover|DISCOVER|Diners Club|JCB|Union ?Pay)(?=\s*(?:[*\u2022\u00b7]{2,}|[xX]{4}|ending|ends in))/y,
  asinBare: /[BbXx]0[A-Za-z0-9]{8}(?![A-Za-z0-9])/y,
  upperIdBare: /[A-Z0-9]{10,}(?![A-Za-z0-9])/y,
  uniLetters: /\p{L}+/uy,
  uniDigits: /\p{Nd}+/uy,
};

function at(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/** Replace capture groups inside a match, keeping every other character of the match. */
function splice(m: RegExpExecArray, repl: Record<number, string>): string {
  const base = m.index;
  const text = m[0];
  const edits: [number, number, string][] = [];
  for (const [k, v] of Object.entries(repl)) {
    const span = m.indices?.[Number(k)];
    if (span) edits.push([span[0] - base, span[1] - base, v]);
  }
  edits.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e, v] of edits) out = out.slice(0, s) + v + out.slice(e);
  return out;
}

/** Marks one free word in scrubValue's output; synthFree replaces each run of them. */
const FREE = "\u0001";
const NUM_OPEN = "\u0002";
const NUM_CLOSE = "\u0003";
const FREE_VOCAB: readonly string[] = [...VOCAB.short, ...VOCAB.mid, ...VOCAB.long];
// A run starts and ends with a free word; numbers between free words belong to it.
// Brackets end a run: "Brand (Toy)" keeps its parenthetical slot for parsers.
// Numbers touching the run on either side (model numbers, sizes, "74th") belong to it too.
const FREE_RUN =
  /(?:\u0002[^\u0003]*\u0003[^\u0001-\u0003\p{L}\p{N}()[\]]*)*\u0001(?:(?:[^\u0001-\u0003\p{L}\p{N}()[\]]*\u0002[^\u0003]*\u0003)*[^\u0001-\u0003\p{L}\p{N}()[\]]*\u0001)*(?:[^\u0001-\u0003\p{L}\p{N}()[\]]*\u0002[^\u0003]*\u0003)*/gu;

/**
 * Free text keeps nothing of its shape: a run of free words (with the spaces and
 * punctuation between them) becomes 60%-160% as many synthetic words of random length,
 * sentence case at the start of the value and lower case elsewhere.
 */
function synthFree(out: string, ctx: ScrubContext): string {
  if (!out.includes(FREE)) return out.replace(/[\u0002\u0003]/g, "");
  const whole = wholeFree(out, ctx);
  if (whole !== null) return whole;
  const runs = out.replace(FREE_RUN, (run: string, offset: number) => {
    const before = out.slice(Math.max(0, offset - 1), offset);
    const after = out.slice(offset + run.length, offset + run.length + 1);
    if (/[\p{L}\p{N}]/u.test(before + after)) {
      // Glued to a token ("ab<uuid>"): one short word, so no long opaque-looking run forms.
      ctx.count("word");
      return ctx.pick(VOCAB.short);
    }
    const n = run.split(FREE).length - 1 + (run.split(NUM_OPEN).length - 1);
    const k = Math.max(1, Math.round(n * (0.6 + ctx.rand())));
    const words: string[] = [];
    for (let j = 0; j < k; j++) words.push(ctx.pick(FREE_VOCAB));
    ctx.count("word", k);
    const first = words[0] ?? "lorem";
    if (!/[\p{L}\p{N}]/u.test(out.slice(0, offset))) {
      words[0] = first[0]?.toUpperCase() + first.slice(1);
    }
    return words.join(" ");
  });
  // Free text: a number left outside every run (behind a bracket, say) is a model number or
  // a size of the real item; it goes, with the punctuation glued to it.
  // A bare bracketed number ("Category (9)") is a count the page structure needs: it stays.
  const dropped = runs.replace(STRAY_NUM, (m: string, at: number) =>
    runs[at - 1] === "(" && runs[at + m.length] === ")" && BARE_NUM.test(m) ? m : "",
  );
  const clean = dropped.replace(/[\u0002\u0003]/g, "");
  return dropped === runs ? clean : clean.replace(/(\S) {2,}(?=\S)/g, "$1 ");
}

/**
 * A value that is free text and nothing structural (a title, a seller, a description):
 * no price, date, id, URL or label survives in it, only free words, numbers, unit words
 * and punctuation. It is replaced WHOLE by plain filler words, so its numbers ("51-Year",
 * "47 Day"), quotes, pipes and parentheses do not survive. A closing "(Word)" becomes a
 * filler "(word)", because lists parse a byline qualifier from it. Unit-bearing numbers
 * stay only in values with no free word, which is where parsers read them: subscription
 * frequency ("1 unit every 3 months"), purchased_count ("Purchased 2 times"), order-list
 * subscription notices ("Every 3 weeks") and price-history window_days ("90-day").
 */
function wholeFree(out: string, ctx: ScrubContext): string | null {
  const freeWords = out.split(FREE).length - 1;
  const rest = out
    .replace(/\u0002[^\u0003]*\u0003/g, " ")
    // A model number mapped to an id inside prose is title material too.
    .replace(/FAKEID\d{4,}/g, (t) => (freeWords >= 2 ? " " : t))
    // A number before a word is title material, except "N-day" in lower case: Amazon's
    // basis-price copy ("the 90-day median"), which price history reads as window_days.
    .replace(/\d[\d.,]*(?=[\s-]?[A-Za-z])(?!-day\b)/g, (d) => d.replace(/[\d.,]/g, " "))
    .replace(/[A-Za-z]+/g, (w) => (WORDS.has(w.toLowerCase()) ? " " : w))
    .replace(/[\u0001\s]+/g, " ");
  if (/[\p{L}\p{N}]/u.test(rest)) return null;
  if (/\(\s*\u0002[\d,]+\u0003\s*\)/.test(out)) return null;
  const lead = /^\s*/.exec(out)?.[0] ?? "";
  const trail = /\s*$/.exec(out)?.[0] ?? "";
  const tokens = out.split(/[\s\u0001\u0002]+/).filter((t) => /[\p{L}\p{N}\u0003]/u.test(t)).length;
  const n = Math.max(1, out.split(FREE).length - 1 + (out.split(NUM_OPEN).length - 1) || tokens);
  const k = Math.max(1, Math.round(n * (0.6 + ctx.rand())));
  const words: string[] = [];
  for (let j = 0; j < k; j++) words.push(ctx.pick(FREE_VOCAB));
  ctx.count("word", k);
  const first = words[0] ?? "lorem";
  words[0] = first[0]?.toUpperCase() + first.slice(1);
  const qualifier = /\)\s*$/.test(out) ? ` (${ctx.pick(FREE_VOCAB)})` : "";
  return lead + words.join(" ") + qualifier + trail;
}

const BARE_NUM = /^\u0002[\d,]+\u0003$/;
const STRAY_NUM =
  /[^\s\p{L}\p{N}()[\]\u0001-\u0003]*\u0002[^\u0003]*\u0003[^\s\p{L}\p{N}()[\]\u0001-\u0003]*/gu;

/**
 * A date shown without a year ("Thu, Mar 9") is read against the fixture's captured_at, so
 * its weekday must be the one of that month/day in the year nearest SYNTHETIC_CAPTURED_AT:
 * then the shifted month/day plus weekday fit the year the page implies, not the real one.
 */
function shownWeekday(s: { m: number; d: number }): number {
  let best = 0;
  let dist = Infinity;
  for (let y = EPOCH_YEAR - 1; y <= EPOCH_YEAR + 1; y++) {
    const day = Date.UTC(y, s.m, s.d) / 86_400_000;
    if (Math.abs(day - EPOCH_DAY) < dist) {
      dist = Math.abs(day - EPOCH_DAY);
      best = new Date(day * 86_400_000).getUTCDay();
    }
  }
  return best;
}

function fakeDate(ctx: ScrubContext, y: number, m: number, d: number) {
  return shift(ctx, { y, m, d });
}

function synthTime12(ctx: ScrubContext, m: RegExpExecArray): string {
  const h = ctx.int(1, 12);
  const repl: Record<number, string> = { 1: padLike(m[1] ?? "", h) };
  if (m[2] !== undefined) repl[2] = ctx.pick(["00", "15", "30", "45"]);
  const ap = ctx.pick(["a", "p"]);
  repl[4] = m[4] === m[4]?.toUpperCase() ? ap.toUpperCase() : ap;
  ctx.count("time");
  return splice(m, repl);
}

function synthTime24(ctx: ScrubContext, m: RegExpExecArray): string {
  const repl: Record<number, string> = {
    1: (m[1]?.length ?? 2) >= 2 ? pad2(ctx.int(0, 23)) : String(ctx.int(0, 9)),
    2: pad2(ctx.int(0, 59)),
  };
  if (m[3] !== undefined) repl[3] = pad2(ctx.int(0, 59));
  ctx.count("time");
  return splice(m, repl);
}

function isoDateTime(ctx: ScrubContext, m: RegExpExecArray): string | null {
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const s = fakeDate(ctx, y, mo, d);
  const repl: Record<number, string> = { 1: String(s.y), 2: pad2(s.m + 1), 3: pad2(s.d) };
  if (m[5] !== undefined) {
    repl[5] = pad2(ctx.int(0, 23));
    repl[6] = pad2(ctx.int(0, 59));
    if (m[7] !== undefined) repl[7] = pad2(ctx.int(0, 59));
    // At most 3 fraction digits: "39.000000000Z" reads as a 10-character upper-case id.
    if (m[8] !== undefined) repl[8] = "." + "0".repeat(Math.min(3, m[8].length - 1));
    // Normalize any offset to UTC: an offset is a time zone, which is a location.
    if (m[9] !== undefined) {
      repl[9] = "Z";
      ctx.count("timezone");
    }
    ctx.count("time");
  }
  ctx.count("date");
  return splice(m, repl);
}

function usDate(ctx: ScrubContext, m: RegExpExecArray): string | null {
  const mo = Number(m[1]) - 1;
  const d = Number(m[2]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const yRaw = m[3] ?? "";
  const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
  const s = fakeDate(ctx, y, mo, d);
  ctx.count("date");
  return splice(m, {
    1: padLike(m[1] ?? "", s.m + 1),
    2: padLike(m[2] ?? "", s.d),
    3: yRaw.length === 2 ? pad2(s.y % 100) : String(s.y),
  });
}

function monthDate(ctx: ScrubContext, m: RegExpExecArray): string | null {
  const mo = monthIndex(m[2] ?? "");
  const d = Number(m[3]);
  if (mo < 0 || d < 1 || d > 31) return null;
  const y = m[7] !== undefined ? Number(m[7]) : inferYear(ctx, mo, d);
  const s = fakeDate(ctx, y, mo, d);
  const repl: Record<number, string> = {
    2: styleMonth(m[2] ?? "", s.m),
    3: padLike(m[3] ?? "", s.d),
  };
  if (m[1] !== undefined) repl[1] = styleWeekday(m[1], m[7] === undefined ? shownWeekday(s) : s.wd);
  if (m[4] !== undefined) repl[4] = ordinal(s.d);
  if (m[6] !== undefined) {
    const mo2 = m[5] !== undefined ? monthIndex(m[5]) : mo;
    const y2 = mo2 < mo ? y + 1 : y;
    const s2 = fakeDate(ctx, y2, mo2 < 0 ? mo : mo2, Number(m[6]));
    if (m[5] !== undefined) repl[5] = styleMonth(m[5], s2.m);
    repl[6] = padLike(m[6], s2.d);
    if (m[5] === undefined && s2.m !== s.m) {
      // The range crosses a month after shifting: name the second month explicitly.
      repl[6] = `${styleMonth(m[2] ?? "", s2.m)} ${s2.d}`;
    }
  }
  if (m[7] !== undefined) repl[7] = String(s.y);
  ctx.count("date");
  return splice(m, repl);
}

function dayMonth(ctx: ScrubContext, m: RegExpExecArray): string | null {
  const d = Number(m[2]);
  const mo = monthIndex(m[3] ?? "");
  if (mo < 0 || d < 1 || d > 31) return null;
  const y = m[4] !== undefined ? Number(m[4]) : inferYear(ctx, mo, d);
  const s = fakeDate(ctx, y, mo, d);
  const repl: Record<number, string> = {
    2: padLike(m[2] ?? "", s.d),
    3: styleMonth(m[3] ?? "", s.m),
  };
  if (m[1] !== undefined) repl[1] = styleWeekday(m[1], m[4] === undefined ? shownWeekday(s) : s.wd);
  if (m[4] !== undefined) repl[4] = String(s.y);
  ctx.count("date");
  return splice(m, repl);
}

function monthYear(ctx: ScrubContext, m: RegExpExecArray): string | null {
  const mo = monthIndex(m[1] ?? "");
  if (mo < 0) return null;
  const s = fakeDate(ctx, Number(m[2]), mo, 15);
  ctx.count("date");
  return splice(m, { 1: styleMonth(m[1] ?? "", s.m), 2: String(s.y) });
}

function fakePhoneLike(ctx: ScrubContext, orig: string): string {
  const core = ctx.fakePhone(orig.replace(/\D/g, "").slice(-10));
  const [a, b, c] = ["555", "555", core.slice(-4)];
  let out = orig.includes("(") ? `(${a}) ${b}-${c}` : `${a}-${b}-${c}`;
  if (/^\+?1[ .-]?/.test(orig) && orig.replace(/\D/g, "").length === 11) out = `+1 ${out}`;
  ctx.count("phone");
  return out;
}

function zipOut(ctx: ScrubContext, zip: string, plus4: string | undefined): string {
  ctx.count("zip");
  return ctx.fakeZip(zip) + (plus4 !== undefined ? "-0000" : "");
}

function digitsOf(ctx: ScrubContext, numberText: string, standalone: boolean): string {
  // A lone digit (a quantity, a step) is permuted within 2..9; 0 and 1 stay, so they agree
  // with the "0" and "1" literals attributes keep verbatim.
  if (standalone && /^\d$/.test(numberText)) return ctx.permDigit(numberText);
  ctx.count("number");
  // A lower-case exponent letter: "1E" next to a digit run would read as an upper-case id.
  // A run of 9+ digits is an id or a full-precision score: an obvious placeholder.
  return numberText
    .replace(/\d+/g, (run) =>
      run.length >= LONG_RUN ? ctx.placeholderDigits(run) : ctx.fakeDigits(run),
    )
    .replace(/E/g, "e");
}

/** Offset of the first UUID that starts inside s[i, i+len) after i, else len. */
function uuidStart(s: string, i: number, len: number): number {
  for (let k = 1; k < len; k++) if (at(R.uuid, s, i + k)) return k;
  return len;
}

/**
 * A short media or instance id, not a camelCase name: the Amazon media id shape (two digits,
 * 6-10 more characters, a final "L", both cases), or both cases plus at least two digit
 * groups that are not just a trailing number ("displayAddressLine1" stays).
 */
function isCaseMixedId(tok: string): boolean {
  if (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok)) return false;
  if (/^\d{2}[A-Za-z0-9+]{6,10}L$/.test(tok)) return true;
  const inner = tok.replace(/\d+$/, "");
  return (inner.match(/\d+/g) ?? []).length >= 2;
}

function decodePct(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function hasOpaque(s: string): boolean {
  for (const m of s.matchAll(new RegExp(PATTERNS.opaqueRun, "g"))) if (isOpaque(m[0])) return true;
  return false;
}

export interface ValueOptions {
  /** Map identifiers only; keep words and numbers verbatim (structural attribute values). */
  tokensOnly?: boolean;
  /** Keep "word" labels inside the text (default true). Off in address blocks. */
  words?: boolean;
}

/**
 * Scrub free text without the label pass: identifiers mapped, dates shifted, numbers and
 * words synthesized. Punctuation and whitespace are kept.
 */
export function scrubValue(input: string, ctx: ScrubContext, opts: ValueOptions = {}): string {
  const tokensOnly = opts.tokensOnly === true;
  const keepWords = opts.words !== false;
  // A UUID glued to a word ("checkbox<uuid>") is still a UUID to the audit, whose hex-only
  // boundary does not see the word, while the scan below would consume it inside the word.
  const s = input.replace(/[\u0001-\u0003]/g, "").replace(new RegExp(PATTERNS.uuid, "g"), (u) => {
    if (isFakeUuid(u)) return u;
    ctx.count("uuid");
    return ctx.fakeUuid(u.toLowerCase());
  });
  const hasUuid = s.includes(SYNTHETIC.uuidPrefix);
  let out = "";
  let i = 0;
  let mixedUntil = -1;
  const n = s.length;
  while (i < n) {
    let m: RegExpExecArray | null;
    if (!tokensOnly && (m = at(R.url, s, i))) {
      const raw = m[0].replace(/[.,;:!?]+$/, "");
      out += scrubUrl(raw, ctx, "auto");
      i += raw.length;
      continue;
    }
    if (!tokensOnly && (m = at(R.protoRel, s, i))) {
      out += scrubUrl(m[0], ctx, "auto");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.email, s, i))) {
      out += ctx.fakeEmail(m[0].toLowerCase());
      ctx.count("email");
      i += m[0].length;
      continue;
    }
    if (
      ctx.knownIds.size > 0 &&
      (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1] ?? "")) &&
      (m = at(R.word, s, i)) &&
      ctx.knownIds.has(m[0])
    ) {
      // An account-scoped id seen in an id query parameter, echoed here verbatim.
      out += ctx.fakeToken(m[0]);
      ctx.count("id");
      i += m[0].length;
      continue;
    }
    if (i > mixedUntil && (m = at(R.pctRun, s, i)) && hasOpaque(decodePct(m[0]))) {
      // A percent-encoded run ("abc%2Bdef%3D") is judged by what it decodes to, the view
      // the audit scans, so an encoded token cannot slip through in pieces.
      out += ctx.fakeToken(m[0]);
      ctx.count("token");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.pctEscape, s, i))) {
      // One escape is atomic: its hex digits are not letters and digits of the text. A
      // punctuation escape is structure and kept; any other byte is data.
      const code = parseInt(m[1] ?? "", 16);
      const punct = code >= 0x20 && code < 0x7f && !/[A-Za-z0-9]/.test(String.fromCharCode(code));
      out += tokensOnly || punct ? m[0] : "%5F";
      i += m[0].length;
      // The escape's hex digits defeat the usual left boundary of an id that follows it.
      if ((m = at(R.asinBare, s, i))) {
        out += ctx.fakeAsin(m[0].toUpperCase());
        ctx.count("asin");
        i += m[0].length;
      } else if ((m = at(R.upperIdBare, s, i)) && (isUpperId(m[0]) || PLACEHOLDER.test(m[0]))) {
        out += m[0].startsWith(SYNTHETIC.tokenPrefix) ? ctx.fakeToken(m[0]) : ctx.fakeId(m[0]);
        ctx.count("id");
        i += m[0].length;
      }
      continue;
    }
    if (i > mixedUntil && (m = at(R.run, s, i)) && isOpaque(m[0])) {
      out += ctx.fakeToken(m[0]);
      ctx.count("token");
      i += m[0].length;
      continue;
    }
    if (i > mixedUntil && (m = at(R.anyRun, s, i))) {
      // Inside a run that mixes letters and digits, replace character by character so the
      // run keeps its exact shape (and so cannot turn into an opaque blob).
      if (/[A-Za-z]/.test(m[0]) && /[0-9]/.test(m[0])) mixedUntil = i + m[0].length - 1;
    }
    if (!tokensOnly && (m = at(R.isoDateTime, s, i))) {
      const r = isoDateTime(ctx, m);
      if (r !== null) {
        out += r;
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(R.orderId, s, i))) {
      out += ctx.fakeOrderId(m[0]);
      ctx.count("order_id");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.uuid, s, i))) {
      // Only fakes from the pass above reach here; they stay as they are.
      out += m[0];
      i += m[0].length;
      continue;
    }
    if ((m = at(R.phone, s, i))) {
      out += fakePhoneLike(ctx, m[0]);
      i += m[0].length;
      continue;
    }
    if (!tokensOnly && (m = at(R.cardBrand, s, i))) {
      // The owner's card network is account data; one constant brand keeps the shape.
      out += "Card";
      ctx.count("card");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.card, s, i))) {
      const g = m[1] !== undefined ? 1 : m[2] !== undefined ? 2 : 3;
      out += splice(m, { [g]: SYNTHETIC.cardLast4 });
      ctx.count("card");
      i += m[0].length;
      continue;
    }
    if (!tokensOnly && (m = at(R.money, s, i))) {
      // An amount moves in MAGNITUDE (x0.3..x3), not just digit by digit, in the same format.
      out += (m[1] ?? "") + (m[2] ?? "") + (m[3] ?? "") + ctx.scaleAmount(m[4] ?? "", m[5]);
      ctx.count("number");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.asinCtx, s, i))) {
      out += (m[1] ?? "") + ctx.fakeAsin((m[2] ?? "").toUpperCase());
      ctx.count("asin");
      i += m[0].length;
      continue;
    }
    if (!tokensOnly) {
      const dated =
        tryDate(R.usDate, usDate) ??
        tryDate(R.monthDate, monthDate) ??
        tryDate(R.dayMonth, dayMonth) ??
        tryDate(R.monthYear, monthYear);
      if (dated !== null) continue;
      if ((m = at(R.time12, s, i))) {
        out += synthTime12(ctx, m);
        i += m[0].length;
        continue;
      }
      if ((m = at(R.time24, s, i))) {
        out += synthTime24(ctx, m);
        i += m[0].length;
        continue;
      }
      // A zone only right after a time ("10:30 AM EST"); elsewhere "EST" is a word of the text.
      if (/\d(?::\d{2})?\s?(?:[AaPp]\.?[Mm]\.?)?\s*$/.test(out) && (m = at(R.zone, s, i))) {
        out += "UTC";
        ctx.count("timezone");
        i += m[0].length;
        continue;
      }
      // Street lines only in address blocks (words off): in a title, "3 Way Adapter" is text.
      if (!keepWords && (m = at(R.street, s, i))) {
        out += SYNTHETIC.street;
        ctx.count("address");
        i += m[0].length;
        continue;
      }
      if ((m = at(R.cityStateZip, s, i))) {
        out += `${SYNTHETIC.city}, ${SYNTHETIC.state} ${zipOut(ctx, m[2] ?? "", m[3])}`;
        ctx.count("address");
        i += m[0].length;
        continue;
      }
      if ((m = at(R.cityZip, s, i))) {
        out += `${SYNTHETIC.city} ${zipOut(ctx, m[1] ?? "", m[2])}`;
        ctx.count("address");
        i += m[0].length;
        continue;
      }
    }
    if ((m = at(R.asin, s, i))) {
      out += ctx.fakeAsin(m[0].toUpperCase());
      ctx.count("asin");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.upperId, s, i)) && (isUpperId(m[0]) || PLACEHOLDER.test(m[0]))) {
      // Placeholders are remapped too, so re-scrubbing a fixture stays clean.
      out += m[0].startsWith(SYNTHETIC.tokenPrefix) ? ctx.fakeToken(m[0]) : ctx.fakeId(m[0]);
      ctx.count("id");
      i += m[0].length;
      continue;
    }
    if (
      tokensOnly &&
      (((m = at(R.mediaId, s, i)) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0])) ||
        ((m = at(R.caseRun, s, i)) && isCaseMixedId(m[0])))
    ) {
      // A short id mixing upper case, lower case and digits ("61Ab3dE+fGL", an image or
      // media id) in a structural value: shorter than an opaque blob, still not structure.
      out += ctx.fakeToken(m[0]);
      ctx.count("token");
      i += m[0].length;
      continue;
    }
    if (tokensOnly) {
      if ((m = at(R.alnum, s, i))) {
        // A long all-digit run in a structural value is a number id (a customer, session
        // or request id), not structure: same digit count, fresh digits.
        out += /^\d{6,}$/.test(m[0]) ? ctx.placeholderDigits(m[0]) : m[0];
        i += m[0].length;
      } else {
        out += s[i];
        i++;
      }
      continue;
    }
    if ((m = at(R.zipPlus4, s, i))) {
      out += zipOut(ctx, m[1] ?? "", m[2]);
      i += m[0].length;
      continue;
    }
    if ((m = at(R.zip, s, i))) {
      out += zipOut(ctx, m[0], undefined);
      i += m[0].length;
      continue;
    }
    if ((m = at(R.year, s, i))) {
      out += String(shiftYear(ctx, Number(m[0])));
      ctx.count("date");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.ordinal, s, i))) {
      const digits = ctx.fakeDigits(m[1] ?? "");
      out += NUM_OPEN + digits + ordinal(Number(digits)) + NUM_CLOSE;
      ctx.count("number");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.weekday, s, i))) {
      const wd = (weekdayIndex(m[0]) + (((ctx.shiftDays % 7) + 7) % 7)) % 7;
      out += styleWeekday(m[0], wd);
      ctx.count("date");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.month, s, i))) {
      const mo = monthIndex(m[0]);
      const sh = fakeDate(ctx, inferYear(ctx, mo, 15), mo, 15);
      out += styleMonth(m[0], sh.m);
      ctx.count("date");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.alnum, s, i))) {
      // Stop the word where a (mapped) UUID begins, so its digits are not re-randomized
      // into a fresh UUID shape.
      const tok = hasUuid ? m[0].slice(0, uuidStart(s, i, m[0].length)) : m[0];
      const hasDigit = /[0-9]/.test(tok);
      const hasLetter = /[A-Za-z]/.test(tok);
      const isWord = hasLetter && !hasDigit && keepWords && WORDS.has(tok.toLowerCase());
      if (hasLetter && !isWord && (hasDigit || i <= mixedUntil)) {
        out += FREE;
        i += tok.length;
      } else if (isWord) {
        // A closed set of unit and frequency words ("every 3 weeks", "90-day") is kept
        // anywhere, also as the letter part of a hyphenated run.
        ctx.count("label_kept");
        out += tok;
        i += tok.length;
      } else if (hasLetter) {
        out += FREE;
        i += tok.length;
      } else {
        const num = at(R.number, s, i);
        const whole = num !== null ? num[0] : tok;
        const text = hasUuid ? whole.slice(0, uuidStart(s, i, whole.length)) : whole;
        const prev = i > 0 ? s[i - 1] : "";
        const next = s[i + text.length] ?? "";
        const standalone = prev !== "$" && next !== "%" && next !== "." && next !== ",";
        // "6 items": an item count is structure parsers cross-check against the items
        // present, so it stays. Any other number is marked so one standing between free
        // words is folded into the free run.
        const itemCount = /^\s+items?\b/i.test(s.slice(i + text.length));
        // "90-day", "3 months": a number with its unit is structure, never folded away.
        const unit = /^[\s-]?([A-Za-z]+)/.exec(s.slice(i + text.length))?.[1];
        const withUnit = unit !== undefined && keepWords && WORDS.has(unit.toLowerCase());
        // In a node with free words a unit number ("51-Year") goes with them (NUM marker,
        // see synthFree); only the lower-case "N-day" of price-history copy stays raw.
        const dayCopy = withUnit && /^-day\b/.test(s.slice(i + text.length));
        out += itemCount || dayCopy ? text : NUM_OPEN + digitsOf(ctx, text, standalone) + NUM_CLOSE;
        i += text.length;
      }
      continue;
    }
    if ((m = at(R.uniLetters, s, i))) {
      // Lower case: a non-ASCII word ("\uff35\uff33\uff22") turned into upper-case ASCII next
      // to digits reads as an id.
      out += FREE;
      i += m[0].length;
      continue;
    }
    if ((m = at(R.uniDigits, s, i))) {
      out += "0".repeat(m[0].length);
      i += m[0].length;
      continue;
    }
    out += s[i];
    i++;
  }
  return synthFree(out, ctx);

  function tryDate(re: RegExp, fn: (c: ScrubContext, mm: RegExpExecArray) => string | null) {
    const mm = at(re, s, i);
    if (mm === null) return null;
    const r = fn(ctx, mm);
    if (r === null) return null;
    out += r;
    i += mm[0].length;
    return r;
  }
}

// A per-render widget token after "_" ("..._0ab1cd2ef3"): lower case and digits, 9+.
const RENDER_TOKEN = /_(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{9,}(?![A-Za-z0-9])/g;

/** Identifier pass only, for structural values (ids, classes, JSON keys). */
export function scrubTokens(s: string, ctx: ScrubContext): string {
  return scrubValue(s, ctx, { tokensOnly: true }).replace(RENDER_TOKEN, () => {
    ctx.count("token");
    return "_rftoken";
  });
}

// ---------------------------------------------------------------------------- labels

interface CompiledLabel {
  norm: string;
  kind: LabelKind | null;
  prefix: RegExp;
  suffix: RegExp;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normLabel(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[:,.]+$/, "");
}

const COMPILED: CompiledLabel[] = LABELS.map((l) => {
  const norm = normLabel(l.text);
  const body = norm.split(" ").map(escapeRe).join("\\s+");
  const startsWord = /^[a-z0-9]/.test(norm);
  const endsWord = /[a-z0-9]$/.test(norm);
  return {
    norm,
    kind: l.kind,
    prefix: new RegExp(`^${body}[:,.]?${endsWord ? "(?![A-Za-z0-9])" : ""}`, "i"),
    suffix: new RegExp(`${startsWord ? "(?<![A-Za-z0-9])" : ""}${body}[:,.]?$`, "i"),
  };
}).sort((a, b) => b.norm.length - a.norm.length);

const EXACT = new Map(COMPILED.map((l) => [l.norm, l]));
const WORDS = new Set(LABELS.filter((l) => l.kind === "word").map((l) => l.text.toLowerCase()));

function synthName(ctx: ScrubContext, value: string): string {
  const lead = /^\s*/.exec(value)?.[0] ?? "";
  const trail = /\s*$/.exec(value)?.[0] ?? "";
  const core = value.trim();
  if (core === "") return value;
  if (EXACT.has(normLabel(core))) return value;
  const full = ctx.fakeName(core.toLowerCase());
  ctx.count("name");
  // One word or two at random: the real name's word count is not kept.
  const single = ctx.int(0, 1) === 0;
  return lead + (single ? (full.split(" ")[0] ?? full) : full) + trail;
}

function synthPlace(ctx: ScrubContext, value: string): string {
  const lead = /^\s*/.exec(value)?.[0] ?? "";
  const zip = /(?<![\d.,$-])(\d{5})(-\d{4})?(?!\d|[.,]\d|%|-\d)/.exec(value);
  ctx.count("address");
  return `${lead}${SYNTHETIC.city}${zip ? ` ${zipOut(ctx, zip[1] ?? "", zip[2])}` : ""}`;
}

function synthNameOrPlace(ctx: ScrubContext, value: string): string {
  return value
    .split(/(\s+-\s+)/)
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      if (part.trim() === "") return part;
      return /\d/.test(part) ? synthPlace(ctx, part) : synthName(ctx, part);
    })
    .join("");
}

function synthRating(ctx: ScrubContext, head: string): string {
  const lead = /^\s*/.exec(head)?.[0] ?? "";
  const trail = /\s*$/.exec(head)?.[0] ?? "";
  const core = head.trim();
  ctx.count("rating");
  const v = core.includes(".") ? (ctx.int(10, 50) / 10).toFixed(1) : String(ctx.int(1, 5));
  return lead + v + trail;
}

/**
 * The value next to a label is data. Keep it only when it is itself a whole label
 * ("Ships from Amazon.com"); never look for more labels inside it.
 */
function plainValue(ctx: ScrubContext, value: string, mode: TextMode): string {
  const core = value.trim().replace(/^[:,.\s-]+/, "");
  if (core !== "" && EXACT.has(normLabel(core))) return value;
  if (mode === "name") return synthName(ctx, value);
  if (mode === "address") {
    const lead = /^\s*/.exec(value)?.[0] ?? "";
    const trail = value.trim() === "" ? "" : (/\s*$/.exec(value)?.[0] ?? "");
    return value.trim() === "" ? value : lead + addressLine(ctx, value.trim()) + trail;
  }
  // A trailing label is structure even after a leading one ("Only 3 left in stock - order
  // soon."): keep it, the head between the two is scrubbed as usual.
  const trimmed = value.trim();
  if (trimmed !== "") {
    const sfx = scrubSuffixes(trimmed, ctx);
    if (sfx !== null) {
      const lead = /^\s*/.exec(value)?.[0] ?? "";
      const trail = /\s*$/.exec(value)?.[0] ?? "";
      return lead + sfx + trail;
    }
  }
  return scrubValue(value, ctx);
}

function valueFor(
  ctx: ScrubContext,
  value: string,
  kind: LabelKind | null,
  mode: TextMode,
): string {
  if (kind === "name") return synthName(ctx, value);
  if (kind === "place") return synthPlace(ctx, value);
  if (kind === "name-or-place") return synthNameOrPlace(ctx, value);
  if (kind === "asin") {
    // "ASIN: 0123456789": an ISBN-shaped ASIN is only recognizable next to its label.
    const m = /^(\W*)([A-Za-z0-9]{10})(?![A-Za-z0-9])/.exec(value);
    if (m !== null) {
      ctx.count("asin");
      const rest = value.slice(m[0].length);
      return (
        (m[1] ?? "") +
        ctx.fakeAsin((m[2] ?? "").toUpperCase()) +
        (rest ? plainValue(ctx, rest, mode) : "")
      );
    }
  }
  return plainValue(ctx, value, mode);
}

const SUFFIX_KINDS: readonly (LabelKind | null)[] = ["suffix", "rating"];
/** Digit runs this long are ids or full-precision floats: placeholders, not random digits. */
const LONG_RUN = 9;
const COUNT_SUFFIXES = new Set([
  "ratings",
  "rating",
  "global ratings",
  "customer reviews",
  "orders",
  "results",
  "results for",
  "bought in past month",
]);

/** Trailing labels ("1,234 ratings", "4.5 out of 5 stars, rating details"). */
function scrubSuffixes(core: string, ctx: ScrubContext): string | null {
  for (const l of COMPILED) {
    if (!SUFFIX_KINDS.includes(l.kind)) continue;
    const sfx = l.suffix.exec(core);
    if (sfx === null || sfx.index === 0) continue;
    ctx.count("label_kept");
    const head = core.slice(0, sfx.index);
    if (l.kind === "rating" && /^\s*\d(?:\.\d)?\s*$/.test(head)) {
      return synthRating(ctx, head) + sfx[0];
    }
    const range = /^(\s*)(\d+)-(\d+)( of (?:over )?)(\d{1,3}(?:,\d{3})+|\d+)(\s*)$/.exec(head);
    if (range !== null && COUNT_SUFFIXES.has(l.norm)) {
      // "1-16 of over 3,000 results": the page range keeps its shape, the total moves.
      const a = ctx.fakeDigits(range[2] ?? "");
      const b = ctx.fakeDigits(range[3] ?? "");
      const total = ctx.scaleAmount(range[5] ?? "", undefined);
      return `${range[1] ?? ""}${a}-${b}${range[4] ?? ""}${total}${range[6] ?? ""}${sfx[0]}`;
    }
    const count = /^(\s*)(\d{1,3}(?:,\d{3})+|\d+)(\+?\s*)$/.exec(head);
    if (count !== null && COUNT_SUFFIXES.has(l.norm)) {
      // "1,234 ratings", "42 orders": a count says how popular a product is or how old an
      // account is; it moves in magnitude like an amount.
      return (
        (count[1] ?? "") + ctx.scaleAmount(count[2] ?? "", undefined) + (count[3] ?? "") + sfx[0]
      );
    }
    const lead = /^\s*/.exec(head)?.[0] ?? "";
    const trail = /\s*$/.exec(head)?.[0] ?? "";
    const inner = head.trim();
    const rest = inner === "" ? "" : (scrubSuffixes(inner, ctx) ?? scrubValue(inner, ctx));
    return lead + rest + trail + sfx[0];
  }
  return null;
}

/** In an address block, lines of capitalized words only are a city or a name. */
function addressLine(ctx: ScrubContext, core: string): string {
  if (/^[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}$/.test(core)) {
    ctx.count("address");
    return SYNTHETIC.city;
  }
  return scrubValue(core, ctx, { words: false });
}

/**
 * Scrub one text value: labels from labels.txt survive (whole, leading or trailing),
 * everything else goes through scrubValue. `mode` comes from the element context.
 */
export function scrubText(s: string, ctx: ScrubContext, mode: TextMode = "text"): string {
  const key = `${mode}\u0000${s}`;
  const hit = ctx.memo.get(key);
  if (hit !== undefined) return hit;
  const lead = /^\s*/.exec(s)?.[0] ?? "";
  const core = s.trim();
  const trail = core === "" ? "" : (/\s*$/.exec(s)?.[0] ?? "");
  let out: string;
  const listName = ctx.listNames.get(core.replace(/\s+/g, " ").toLowerCase());
  if (listName !== undefined) {
    ctx.count("name");
    out = lead + listName + trail;
    ctx.memo.set(key, out);
    return out;
  }
  if (core === "") {
    out = s;
  } else {
    ctx.count("text_node");
    out = lead + scrubCore(core, ctx, mode) + trail;
  }
  ctx.memo.set(key, out);
  return out;
}

function scrubCore(core: string, ctx: ScrubContext, mode: TextMode): string {
  if (EXACT.has(normLabel(core))) {
    ctx.count("label_kept");
    return core;
  }
  // In name and address blocks a bare label word may be a surname or a city: only labels
  // that say what their value is ("Deliver to", "Hello,") apply there.
  const restricted = mode !== "text";
  for (const l of COMPILED) {
    if (l.kind === "whole" || l.kind === "word" || SUFFIX_KINDS.includes(l.kind)) continue;
    if (restricted && l.kind === null) continue;
    const p = l.prefix.exec(core);
    if (p !== null && p[0].length < core.length && labelLeads(l, p[0], core)) {
      ctx.count("label_kept");
      return p[0] + valueFor(ctx, core.slice(p[0].length), l.kind, mode);
    }
  }
  if (mode === "name") return synthName(ctx, core);
  if (mode === "address") return addressLine(ctx, core);
  const sfx = scrubSuffixes(core, ctx);
  if (sfx !== null) return sfx;
  // " - " separates clauses ("1 month - view data going back to <date>"). Split only when a
  // later clause starts with a label, so a date range ("Feb 3 - 7") stays one value.
  const parts = core.split(/(\s+-\s+)/);
  if (parts.some((p, k) => k >= 2 && k % 2 === 0 && leadingLabel(p))) {
    return parts.map((p, k) => (k % 2 === 1 || p === "" ? p : scrubCore(p, ctx, mode))).join("");
  }
  return scrubValue(core, ctx);
}

function leadingLabel(s: string): boolean {
  for (const l of COMPILED) {
    if (l.kind === "whole" || l.kind === "word" || SUFFIX_KINDS.includes(l.kind)) continue;
    const p = l.prefix.exec(s);
    if (p !== null && p[0].length < s.length && labelLeads(l, p[0], s)) return true;
  }
  return false;
}

const VALUE_START = new RegExp(
  `^[\\s:,.#-]*(?:[\\d$\u00a3\u20ac(]|(?:${MONTH_RE}|${WEEKDAY_RE})\\b)`,
  "i",
);

/**
 * A one-word label with no kind ("Amazon", "Prime", "New") leads a node only when a value
 * follows it (a number, an amount, a date) or it ends in ":". Before free words ("Amazon
 * Basics Lorem Widget") the whole node is free text, so a title keeps no word of its own.
 */
function labelLeads(l: CompiledLabel, matched: string, core: string): boolean {
  if (l.kind !== null || l.norm.includes(" ")) return true;
  if (/:\s*$/.test(matched)) return true;
  return VALUE_START.test(core.slice(matched.length));
}
