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
import type { ScrubContext } from "./context.ts";
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
import { PATTERNS, SYNTHETIC, isOpaque, isUpperId } from "./rules.mjs";
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

// Letters for shape-preserving replacement inside mixed letter/digit runs. No hex letters
// (a-f) and no b/x, so a replacement can never become a UUID or an ASIN.
const LOWER = "ghijklmnopqrstuvwyz";
const PLACEHOLDER = new RegExp(`^(?:${SYNTHETIC.idPrefix}|${SYNTHETIC.tokenPrefix})[0-9]{4,}$`);
const UPPER = LOWER.toUpperCase();

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
  zone: /(?<![A-Za-z])(?:[ECMP][SD]T|AK[SD]T|H[SD]T|[ECMP]T|GMT|UTC)(?:\s?[+-]\d{1,2}(?::?\d{2})?)?(?![A-Za-z])/y,
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
  number: /\d+(?:[.,]\d+)*/y,
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

function caseStyle(orig: string, word: string): string {
  if (orig.length > 1 && orig === orig.toUpperCase()) return word.toUpperCase();
  if (orig[0] !== undefined && orig[0] !== orig[0].toLowerCase()) {
    return word[0]?.toUpperCase() + word.slice(1);
  }
  return word;
}

function loremWord(ctx: ScrubContext, orig: string): string {
  const n = orig.length;
  const list =
    n === 1
      ? VOCAB.one
      : n <= 3
        ? VOCAB.short
        : n <= 7
          ? VOCAB.mid
          : (VOCAB.long as readonly string[]);
  ctx.count("word");
  return caseStyle(orig, ctx.pick(list));
}

function charwise(ctx: ScrubContext, tok: string): string {
  let out = "";
  for (const ch of tok) {
    if (ch >= "0" && ch <= "9") out += String(ctx.int(0, 9));
    else if (ch >= "A" && ch <= "Z") out += UPPER[ctx.int(0, UPPER.length - 1)];
    else out += LOWER[ctx.int(0, LOWER.length - 1)];
  }
  ctx.count("word");
  return out;
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
    if (m[8] !== undefined) repl[8] = "." + "0".repeat(m[8].length - 1);
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
  if (m[1] !== undefined) repl[1] = styleWeekday(m[1], s.wd);
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
  if (m[1] !== undefined) repl[1] = styleWeekday(m[1], s.wd);
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
  if (standalone && /^\d$/.test(numberText)) return numberText;
  ctx.count("number");
  return numberText.replace(/\d+/g, (run) => ctx.fakeDigits(run));
}

export interface ValueOptions {
  /** Map identifiers only; keep words and numbers verbatim (structural attribute values). */
  tokensOnly?: boolean;
}

/**
 * Scrub free text without the label pass: identifiers mapped, dates shifted, numbers and
 * words synthesized. Punctuation and whitespace are kept.
 */
export function scrubValue(s: string, ctx: ScrubContext, opts: ValueOptions = {}): string {
  const tokensOnly = opts.tokensOnly === true;
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
      out += ctx.fakeUuid(m[0].toLowerCase());
      ctx.count("uuid");
      i += m[0].length;
      continue;
    }
    if ((m = at(R.phone, s, i))) {
      out += fakePhoneLike(ctx, m[0]);
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
      if ((m = at(R.zone, s, i))) {
        out += "UTC";
        ctx.count("timezone");
        i += m[0].length;
        continue;
      }
      if ((m = at(R.street, s, i))) {
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
    if (tokensOnly) {
      if ((m = at(R.alnum, s, i))) {
        out += m[0];
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
      out += digits + ordinal(Number(digits));
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
      const tok = m[0];
      const hasDigit = /[0-9]/.test(tok);
      const hasLetter = /[A-Za-z]/.test(tok);
      if (hasLetter && (hasDigit || i <= mixedUntil)) {
        out += charwise(ctx, tok);
        i += tok.length;
      } else if (hasLetter) {
        out += loremWord(ctx, tok);
        i += tok.length;
      } else {
        const num = at(R.number, s, i);
        const text = num !== null ? num[0] : tok;
        const prev = i > 0 ? s[i - 1] : "";
        const next = s[i + text.length] ?? "";
        const standalone = prev !== "$" && next !== "%" && next !== "." && next !== ",";
        out += digitsOf(ctx, text, standalone);
        i += text.length;
      }
      continue;
    }
    if ((m = at(R.uniLetters, s, i))) {
      out += loremWord(ctx, m[0]);
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
  return out;

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

/** Identifier pass only, for structural values (ids, classes, JSON keys). */
export function scrubTokens(s: string, ctx: ScrubContext): string {
  return scrubValue(s, ctx, { tokensOnly: true });
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

function synthName(ctx: ScrubContext, value: string): string {
  const lead = /^\s*/.exec(value)?.[0] ?? "";
  const trail = /\s*$/.exec(value)?.[0] ?? "";
  const core = value.trim();
  if (core === "") return value;
  if (EXACT.has(normLabel(core))) return value;
  const full = ctx.fakeName(core.toLowerCase());
  ctx.count("name");
  const single = !/\s/.test(core.replace(/[.,]+$/, ""));
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
  return scrubValue(core, ctx);
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
    if (l.kind === "whole" || SUFFIX_KINDS.includes(l.kind)) continue;
    if (restricted && l.kind === null) continue;
    const p = l.prefix.exec(core);
    if (p !== null && p[0].length < core.length) {
      ctx.count("label_kept");
      return p[0] + valueFor(ctx, core.slice(p[0].length), l.kind, mode);
    }
  }
  if (mode === "name") return synthName(ctx, core);
  if (mode === "address") return addressLine(ctx, core);
  return scrubSuffixes(core, ctx) ?? scrubValue(core, ctx);
}
