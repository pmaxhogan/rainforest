// Shared fixture privacy rules. Plain Node ESM with no dependencies, so the public CI gate
// (scripts/check-fixtures.mjs) and the scrubber self-check (auditScrubbed) run the SAME
// predicates and cannot drift. The scrubber also imports the token regexes from here, so
// anything it emits is judged by the rule that minted it.
//
// Findings carry the matched text for programmatic use, but nothing that prints a finding
// (the CI gate, the CLI) may echo it: logs can be public. Use describeFinding().
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Mirror of FAKE in packages/core/src/capture.ts. Duplicated (not imported) so this file
 * stays loadable by plain Node without type stripping; a test asserts the two are equal.
 */
export const FAKE_RANGES = Object.freeze({
  asinPattern: /^[BX]0FAKE[0-9A-Z]{4}$/,
  orderIdPattern: /^000-0000000-[0-9]{7}$/,
  emailDomain: "example.com",
  phonePattern: /^(\+1[ -]?)?\(?555\)?[ -]?555[ -]?01[0-9]{2}$/,
  zips: Object.freeze(["00000", "00001", "00002", "00003"]),
  imageUrl: "https://images.example.com/placeholder.png",
  host: "https://www.example.com",
});

/** Synthetic values the scrubber emits that core FAKE does not define (yet). */
export const SYNTHETIC = Object.freeze({
  city: "Exampleville",
  state: "ZZ",
  street: "100 Example St",
  cardLast4: "0000",
  idPrefix: "FAKEID",
  tokenPrefix: "FAKETOKEN",
  uuidPrefix: "00000000-0000-4000-8000-",
  names: Object.freeze([
    "Alex Example",
    "Sam Sample",
    "Jordan Specimen",
    "Taylor Fixture",
    "Casey Demo",
    "Riley Testcase",
    "Morgan Mock",
    "Jamie Dummy",
  ]),
});

/** URL hosts allowed anywhere inside fixtures/. www.w3.org is for SVG/XML namespaces. */
export const ALLOWED_HOSTS = Object.freeze(["www.example.com", "images.example.com", "www.w3.org"]);

/** The only <script type> values that may survive: inert JSON data blobs. */
export const SCRIPT_TYPES = Object.freeze(["application/json", "a-state"]);

/**
 * Token patterns as regex SOURCES. Build a fresh RegExp per use (global regexes carry
 * lastIndex state). Every pattern has explicit boundaries so the scrubber (sticky, at a
 * position) and the audit (global scan) agree on token edges.
 */
export const PATTERNS = Object.freeze({
  url: String.raw`https?:\/\/[^\s"'<>\\)\]{}|^` + "`" + String.raw`]+`,
  email: String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])`,
  asin: String.raw`(?<![A-Za-z0-9])[BbXx]0[A-Za-z0-9]{8}(?![A-Za-z0-9])`,
  isbnAsinContext: String.raw`(?:\/(?:dp|gp\/product|product-reviews|gp\/aw\/d|offer-listing|exec\/obidos\/asin)\/|asin["']?\s*[:=]\s*["']?)(\d{9}[\dXx])(?![A-Za-z0-9])`,
  orderId: String.raw`(?<![A-Za-z0-9])[0-9Dd]\d{2}-\d{7}-\d{7}(?![0-9])`,
  // A hyphen may touch a UUID on either side ("pd_rd_r-<uuid>" in a class name).
  uuid: String.raw`(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])`,
  phone: String.raw`(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d-])`,
  cardLast4: String.raw`(?:ending (?:in|with)|ends in|last (?:4|four)(?: digits)?:?)\s*(\d{4})(?!\d)|[*\u2022]{2,}\s?(\d{4})(?!\d)|(?<![A-Za-z])[xX]{4,}\s?(\d{4})(?!\d)`,
  zipPlus4: String.raw`(?<![\d.,$-])(\d{5})-(\d{4})(?![\d-])`,
  zip: String.raw`(?<![\d.,$-])\d{5}(?!\d|[.,]\d|%|-\d)`,
  opaqueRun: String.raw`(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}`,
  // Not right after a "%" that starts an escape of ASCII punctuation: "%3A1234567890" is ":"
  // plus digits, and the percent-decoded view (which every audit also scans) judges the tail
  // on its own. Escapes of letters, digits or other bytes get no exemption.
  upperId: String.raw`(?<![A-Za-z0-9])(?<!%(?=2[0-9A-Fa-f]|3[A-Fa-f]|40|5[B-Fb-f]|60|7[B-Eb-e]))[A-Z0-9]{10,}(?![A-Za-z0-9])`,
});

/** Address-like contexts in which a 5-digit token must be a reserved fake ZIP. */
const ZIP_CONTEXTS = [
  [String.raw`(?<![\d.,$-])(\d{5})-\d{4}(?![\d-])`, "g"],
  [String.raw`\b[A-Z]{2},?\s+(\d{5})(?!\d|[.,]\d|%|-\d)`, "g"],
  [String.raw`(?:zip|postal)[A-Za-z_-]*["']?\s*[:=]\s*["']?(\d{5})(?!\d|[.,]\d|%|-\d)`, "gi"],
  [String.raw`deliver(?:ing|y)?\s+to\b[^<"]{0,80}?(?<![\d.,$-])(\d{5})(?!\d|[.,]\d|%|-\d)`, "gi"],
  [String.raw`glow-ingress[^>]{0,200}>[^<]{0,80}?(?<![\d.,$-])(\d{5})(?!\d|[.,]\d|%|-\d)`, "gi"],
  [String.raw`[A-Za-z]{3,}\s+(\d{5})\s*(?=<|"|$)`, "gm"],
];

export function re(name, flags = "g") {
  const src = PATTERNS[name];
  if (src === undefined) throw new Error(`unknown pattern ${name}`);
  return new RegExp(src, flags);
}

export function isFakeAsin(s) {
  return FAKE_RANGES.asinPattern.test(s);
}
export function isFakeOrderId(s) {
  return FAKE_RANGES.orderIdPattern.test(s);
}
export function isFakeEmail(s) {
  const at = s.lastIndexOf("@");
  return at > 0 && s.slice(at + 1).toLowerCase() === FAKE_RANGES.emailDomain;
}
export function isFakePhone(s) {
  return FAKE_RANGES.phonePattern.test(s.replace(/\./g, "-"));
}
export function isFakeZip(s) {
  return FAKE_RANGES.zips.includes(s);
}
export function isFakeUuid(s) {
  return /^00000000-0000-4000-8000-[0-9]{12}$/.test(s);
}
export function isPlaceholderId(s) {
  return (
    isFakeAsin(s) ||
    new RegExp(`^${SYNTHETIC.idPrefix}[0-9]{4,}$`).test(s) ||
    new RegExp(`^${SYNTHETIC.tokenPrefix}[0-9]{4,}$`).test(s)
  );
}

/**
 * A run of base64/hex-like characters is opaque when it is at least 20 long and one of its
 * parts (split on - _ . / + =) is at least 16 long, mixes letters and digits, and looks
 * random: at least 3 letter/digit alternations or at least 6 digits. Long hyphenated class
 * names ("s-widget-spacing-small"), URL paths, hashed CSS-module names and camelCase
 * identifiers ending in a digit ("displayAddressLine1") do not qualify.
 *
 * The verdict depends only on part lengths and character classes, which the scrubber's
 * shape-preserving replacement keeps, so scrubbed output stays closed under this rule.
 */
export function isOpaque(run) {
  if (run.length < 20) return false;
  for (const part of run.split(/[-_./+=]/)) {
    if (part.length < 16 || !/[0-9]/.test(part) || !/[A-Za-z]/.test(part)) continue;
    const digits = part.replace(/[^0-9]/g, "").length;
    const alternations = (part.match(/[A-Za-z](?=[0-9])|[0-9](?=[A-Za-z])/g) ?? []).length;
    if (alternations >= 3 || digits >= 6) return true;
  }
  return false;
}

/** Mixed upper-case letters and digits, 10+ long: customer, merchant, list, request ids. */
export function isUpperId(tok) {
  return /[A-Z]/.test(tok) && /[0-9]/.test(tok) && !isPlaceholderId(tok);
}

export function isAllowedHost(host) {
  return ALLOWED_HOSTS.includes(host.toLowerCase());
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#([0-9]+);?/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeChar(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function decodePercent(s) {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

function decodeJsEscapes(s) {
  return s
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/");
}

/** Text views an audit scans: raw bytes plus the common encodings a value can hide behind. */
function views(text) {
  const out = [text];
  const ent = decodeEntities(text);
  const js = decodeJsEscapes(ent);
  const pct = decodePercent(js);
  for (const v of [ent, js, pct]) if (!out.includes(v)) out.push(v);
  return out;
}

function tokenFindings(text, push) {
  for (const m of text.matchAll(re("asin"))) {
    if (!isFakeAsin(m[0])) push("asin", m[0], m.index);
  }
  for (const m of text.matchAll(new RegExp(PATTERNS.isbnAsinContext, "gi"))) {
    push("isbn-asin", m[1], m.index);
  }
  for (const m of text.matchAll(re("orderId"))) {
    if (!isFakeOrderId(m[0])) push("order-id", m[0], m.index);
  }
  for (const m of text.matchAll(re("email"))) {
    if (!isFakeEmail(m[0])) push("email", m[0], m.index);
  }
  for (const m of text.matchAll(re("phone"))) {
    if (!isFakePhone(m[0])) push("phone", m[0], m.index);
  }
  for (const [src, flags] of ZIP_CONTEXTS) {
    for (const m of text.matchAll(new RegExp(src, flags))) {
      if (m[1] !== undefined && !isFakeZip(m[1])) push("zip", m[1], m.index);
    }
  }
  for (const m of text.matchAll(new RegExp(PATTERNS.cardLast4, "gi"))) {
    const digits = m[1] ?? m[2] ?? m[3];
    if (digits !== undefined && digits !== SYNTHETIC.cardLast4) push("card-last4", digits, m.index);
  }
  for (const m of text.matchAll(re("uuid"))) {
    if (!isFakeUuid(m[0])) push("uuid", m[0], m.index);
  }
  for (const m of text.matchAll(re("opaqueRun"))) {
    if (isOpaque(m[0])) push("opaque-blob", m[0], m.index);
  }
  for (const m of text.matchAll(re("upperId"))) {
    if (isUpperId(m[0])) push("opaque-id", m[0], m.index);
  }
  for (const m of text.matchAll(re("url"))) {
    let host;
    try {
      host = new URL(m[0]).hostname;
    } catch {
      push("url-unparseable", m[0], m.index);
      continue;
    }
    if (!isAllowedHost(host)) push("url-host", m[0], m.index);
  }
  const protoRel =
    /\b(?:href|src|srcset|action|formaction|poster|cite|background|data-[\w-]*(?:src|url|href)[\w-]*)\s*=\s*["']?\s*\/\/([^/"'\s>]+)/gi;
  for (const m of text.matchAll(protoRel)) {
    if (!isAllowedHost(m[1])) push("url-host", m[0], m.index);
  }
}

function htmlFindings(text, push) {
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type === undefined || !SCRIPT_TYPES.includes(type)) {
      push("script", type ?? "(no type)", m.index);
      continue;
    }
    if (/\bsrc\s*=/i.test(attrs)) push("script", "src", m.index);
    if (type === "a-state" && !/\bdata-a-state\s*=/i.test(attrs)) {
      push("script", "a-state without data-a-state", m.index);
    }
    try {
      JSON.parse(decodeJsEscapes(m[2]).trim() || "null");
    } catch {
      push("script-json", "unparseable data blob", m.index);
    }
  }
  const opens = (text.match(/<script\b/gi) ?? []).length;
  const closed = (text.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) ?? []).length;
  if (opens !== closed) push("script", "unterminated script", text.search(/<script\b/i));
  for (const m of text.matchAll(/<(style|link|object|embed|applet|noscript|base)\b/gi)) {
    if (m[1].toLowerCase() !== "base") push("element", m[1].toLowerCase(), m.index);
  }
  for (const m of text.matchAll(/<meta\b([^>]*)>/gi)) {
    if (!/^\s*charset\s*=\s*["']?[\w-]+["']?\s*\/?\s*$/i.test(m[1]))
      push("element", "meta", m.index);
  }
  for (const m of text.matchAll(/<!--/g)) push("comment", "<!--", m.index);
  // Attribute names are matched OUTSIDE quoted values: a quoted value is skipped whole, so
  // escaped markup inside an attribute (a JSON blob holding an HTML string) is not read as
  // attributes of the outer tag. A tag with an unbalanced quote is flagged on its own.
  const inTag = (names) =>
    new RegExp(
      String.raw`<[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^>"'])*?(?<=[\s"'/])(${names})\s*=`,
      "gi",
    );
  for (const m of text.matchAll(inTag("on[a-z]+"))) push("event-handler", m[1], m.index);
  for (const m of text.matchAll(inTag("style"))) push("style-attr", "style", m.index);
  for (const m of text.matchAll(/<[a-z][\w:-]*\b(?:"[^"]*"|'[^']*'|[^>"'])*["'][^"'>]*>/gi)) {
    push("unbalanced-quote", "tag", m.index);
  }
  for (const m of text.matchAll(
    /<(?:iframe|frame)\b(?:"[^"]*"|'[^']*'|[^>"'])*?(?<=[\s"'/])(?:src|srcdoc)\s*=/gi,
  )) {
    push("iframe-src", "iframe", m.index);
  }
}

/**
 * Scan one file's text for anything that still looks real. `html` adds markup checks
 * (scripts, styles, comments, handlers). Returns findings sorted by position, one per
 * (rule, match) pair.
 */
export function auditText(text, { html = false } = {}) {
  const findings = [];
  const seen = new Set();
  for (const [i, view] of views(text).entries()) {
    const push = (rule, match, index) => {
      const key = `${rule}\u0000${match}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ rule, match, index, line: lineAt(view, index) });
    };
    tokenFindings(view, push);
    // Markup checks only on the raw bytes: decoding &lt; would invent markup from text.
    if (html && i === 0) htmlFindings(view, push);
  }
  findings.sort((a, b) => a.index - b.index || (a.rule < b.rule ? -1 : 1));
  return findings;
}

/** Printable description of a finding that never contains the matched value. */
export function describeFinding(f) {
  return `${f.rule} (line ${f.line}, ${f.match.length} chars)`;
}

const ALLOWED_EXTENSIONS = [".html", ".json", ".md", ".txt"];
const REQUIRED_CASE_FILES = ["capture.json", "page.html"];

/**
 * Gate 2: walk a fixtures tree and return every violation. A missing tree is clean.
 * Layout: <root>/<kind>/<case>/{capture.json,page.html,<fragment>.html,expected.json}.
 */
export function checkFixturesTree(root) {
  const violations = [];
  const add = (file, rule, line = 0, detail = "") => violations.push({ file, rule, line, detail });
  if (!existsSync(root)) return { violations, files: 0, cases: 0 };
  let files = 0;
  let cases = 0;
  const walk = (dir, depth) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const raw = relative(root, full).split(sep).join("/");
      const pathFindings = auditText(raw);
      // A path can itself be the leak; report it with the offending part masked.
      let rel = raw;
      for (const f of pathFindings) rel = rel.split(f.match).join("*".repeat(f.match.length));
      for (const f of pathFindings) add(rel, `path:${f.rule}`, 0, describeFinding(f));
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        add(rel, "symlink");
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= 2) {
          add(rel, "layout", 0, "directories nest at most <kind>/<case>");
          continue;
        }
        if (depth === 1) {
          cases++;
          checkCase(full, rel, add);
        }
        walk(full, depth + 1);
        continue;
      }
      files++;
      if (depth < 2 && name !== "README.md") {
        add(rel, "layout", 0, "files belong in <kind>/<case>/");
      }
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        add(rel, "file-type", 0, `only ${ALLOWED_EXTENSIONS.join(" ")}`);
        continue;
      }
      const text = readFileSync(full, "utf8");
      for (const f of auditText(text, { html: ext === ".html" })) {
        add(rel, f.rule, f.line, describeFinding(f));
      }
    }
  };
  walk(root, 0);
  return { violations, files, cases };
}

function checkCase(dir, rel, add) {
  const names = readdirSync(dir);
  for (const req of REQUIRED_CASE_FILES) {
    if (!names.includes(req)) add(`${rel}/${req}`, "missing-file");
  }
  if (!names.includes("capture.json")) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "capture.json"), "utf8"));
  } catch {
    add(`${rel}/capture.json`, "manifest", 0, "not valid JSON");
    return;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    add(`${rel}/capture.json`, "manifest", 0, "not an object");
    return;
  }
  if ("html" in manifest) add(`${rel}/capture.json`, "manifest", 0, "html belongs in page.html");
  for (const key of ["kind", "url", "final_url", "captured_at"]) {
    if (typeof manifest[key] !== "string")
      add(`${rel}/capture.json`, "manifest", 0, `${key} missing`);
  }
  const frags = manifest.fragments;
  if (frags !== undefined) {
    if (frags === null || typeof frags !== "object" || Array.isArray(frags)) {
      add(`${rel}/capture.json`, "manifest", 0, "fragments must map name to file");
      return;
    }
    for (const [name, file] of Object.entries(frags)) {
      if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.html$/.test(file)) {
        add(`${rel}/capture.json`, "manifest", 0, `fragment ${name} has a bad file name`);
      } else if (!names.includes(file)) {
        add(`${rel}/${file}`, "missing-file", 0, `fragment ${name}`);
      }
    }
  }
}
