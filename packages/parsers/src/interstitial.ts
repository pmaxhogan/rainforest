/**
 * Interstitial classifier: is this capture a captcha, a sign-in wall, a throttle page, a
 * "dog" not-found page or some other non-content page instead of what was asked for?
 *
 * Each kind has several independent signals. A strong signal (form or field id, sign-in URL)
 * weighs 2, a weak one (title, body phrase, generic URL) weighs 1, and a kind needs a score
 * of at least 2, so one stray phrase never trips it. Body phrases are additionally only
 * consulted on short pages (SHORT_PAGE_CHARS of visible text): interstitials are small, and
 * a long content page quoting "something went wrong" in a review must never match. Signals
 * are leads from public knowledge; add or reweigh them in INTERSTITIAL_SIGNALS once real
 * captures exist. Only visible text is consulted.
 */
import type { Capture } from "@rainforest/core";
import { type DomDocument, attr, parseDocument, qa, text } from "./dom.ts";

export const INTERSTITIAL_KINDS = [
  "captcha",
  "sign_in",
  "soft_challenge",
  "interstitial",
  "throttled",
  "not_found",
  "error",
] as const;
export type InterstitialKind = (typeof INTERSTITIAL_KINDS)[number];

/** Tie-break order when two kinds score the same (most actionable first). */
const PRIORITY: readonly InterstitialKind[] = [
  "captcha",
  "sign_in",
  "soft_challenge",
  "throttled",
  "not_found",
  "error",
  "interstitial",
];

export interface SignalContext {
  doc: DomDocument;
  /** final_url (or url), lowercased. */
  url: string;
  /** Document title, whitespace collapsed. */
  title: string;
  /** Visible body text, whitespace collapsed. */
  text: string;
}

export interface InterstitialSignal {
  kind: InterstitialKind;
  name: string;
  weight: 1 | 2;
  test: (ctx: SignalContext) => boolean;
}

export interface Interstitial {
  kind: InterstitialKind;
  /** Human-readable list of the signals that fired. */
  evidence: string;
  score: number;
  signals: string[];
}

/** Minimum score for a kind to win. */
export const INTERSTITIAL_THRESHOLD = 2;

/** Body-phrase signals only fire when the page has at most this much visible text. */
export const SHORT_PAGE_CHARS = 5000;

const urlHas =
  (re: RegExp) =>
  (ctx: SignalContext): boolean =>
    re.test(ctx.url);
const titleHas =
  (re: RegExp) =>
  (ctx: SignalContext): boolean =>
    re.test(ctx.title);
const textHas =
  (re: RegExp) =>
  (ctx: SignalContext): boolean =>
    ctx.text.length <= SHORT_PAGE_CHARS && re.test(ctx.text);
const exists =
  (selector: string) =>
  (ctx: SignalContext): boolean =>
    qa(ctx.doc, selector).length > 0;

function formActionHas(re: RegExp): (ctx: SignalContext) => boolean {
  return (ctx) => qa(ctx.doc, "form[action]").some((f) => re.test(attr(f, "action") ?? ""));
}

function buttonText(re: RegExp): (ctx: SignalContext) => boolean {
  return (ctx) =>
    qa(ctx.doc, "button, input[type=submit], input[type=button], a.a-button-text").some((b) =>
      re.test(text(b) || attr(b, "value") || ""),
    );
}

function headingText(re: RegExp): (ctx: SignalContext) => boolean {
  return (ctx) => qa(ctx.doc, "h1, h2").some((h) => re.test(text(h)));
}

function imageMatches(re: RegExp): (ctx: SignalContext) => boolean {
  return (ctx) =>
    qa(ctx.doc, "img").some(
      (img) => re.test(attr(img, "src") ?? "") || re.test(attr(img, "alt") ?? ""),
    );
}

const CAPTCHA_FORM = /\/errors\/validatecaptcha/i;

export const INTERSTITIAL_SIGNALS: readonly InterstitialSignal[] = [
  // captcha
  { kind: "captcha", name: "url /errors/validateCaptcha", weight: 1, test: urlHas(CAPTCHA_FORM) },
  {
    kind: "captcha",
    name: "field #captchacharacters",
    weight: 2,
    test: exists("#captchacharacters"),
  },
  {
    kind: "captcha",
    name: "form action validateCaptcha",
    weight: 1,
    test: formActionHas(CAPTCHA_FORM),
  },
  { kind: "captcha", name: "captcha image", weight: 1, test: imageMatches(/captcha/i) },
  {
    kind: "captcha",
    name: "text 'enter the characters you see'",
    weight: 1,
    test: textHas(/enter the characters you see below/i),
  },
  {
    kind: "captcha",
    name: "text 'type the characters'",
    weight: 1,
    test: textHas(/type the characters you see in this image/i),
  },
  { kind: "captcha", name: "text 'not a robot'", weight: 1, test: textHas(/you'?re not a robot/i) },

  // sign_in
  { kind: "sign_in", name: "url /ap/signin", weight: 2, test: urlHas(/\/ap\/(signin|mfa|cvf)/i) },
  {
    kind: "sign_in",
    name: "sign-in form",
    weight: 2,
    test: (ctx) =>
      exists("form[name=signIn], #ap_login_form")(ctx) || formActionHas(/\/ap\/signin/i)(ctx),
  },
  {
    kind: "sign_in",
    name: "field #ap_email / #ap_password",
    weight: 2,
    test: exists("#ap_email, #ap_password"),
  },
  { kind: "sign_in", name: "title 'Sign-In'", weight: 1, test: titleHas(/\bsign[ -]?in\b/i) },
  { kind: "sign_in", name: "heading 'Sign in'", weight: 1, test: headingText(/^sign[ -]?in$/i) },
  {
    kind: "sign_in",
    name: "text 'two-step verification'",
    weight: 1,
    test: textHas(/two-step verification/i),
  },

  // soft_challenge: a button-only "continue shopping" check
  {
    kind: "soft_challenge",
    name: "text 'click the button below to continue shopping'",
    weight: 1,
    test: textHas(/click the button below to continue shopping/i),
  },
  {
    kind: "soft_challenge",
    name: "button 'Continue shopping'",
    weight: 1,
    test: buttonText(/^continue shopping$/i),
  },
  {
    kind: "soft_challenge",
    name: "form action validateCaptcha without a captcha field",
    weight: 1,
    test: (ctx) => formActionHas(CAPTCHA_FORM)(ctx) && !exists("#captchacharacters")(ctx),
  },

  // throttled
  {
    kind: "throttled",
    name: "text 'too many requests'",
    weight: 1,
    test: textHas(/too many requests|request was throttled|rate exceeded/i),
  },
  {
    kind: "throttled",
    name: "title '503' / 'service unavailable'",
    weight: 1,
    test: titleHas(/\b503\b|service unavailable/i),
  },
  {
    kind: "throttled",
    name: "text 'we're sorry'",
    weight: 1,
    test: textHas(/\bwe'?re sorry\b/i),
  },
  {
    kind: "throttled",
    name: "text 'try again later'",
    weight: 1,
    test: textHas(/try again (?:later|in a few minutes|shortly)/i),
  },

  // not_found ("dogs of Amazon" page)
  {
    kind: "not_found",
    name: "text 'looking for something?'",
    weight: 1,
    test: textHas(/looking for something\?/i),
  },
  {
    kind: "not_found",
    name: "text 'not a functioning page'",
    weight: 1,
    test: textHas(/not a functioning page on our site/i),
  },
  {
    kind: "not_found",
    name: "title 'page not found'",
    weight: 1,
    test: titleHas(/page not found/i),
  },
  {
    kind: "not_found",
    name: "dog image",
    weight: 1,
    test: imageMatches(/dogs? of amazon|\/error\/.*dog/i),
  },

  // error
  {
    kind: "error",
    name: "text 'sorry! something went wrong'",
    weight: 1,
    test: textHas(/sorry!? something went wrong/i),
  },
  {
    kind: "error",
    name: "title 'something went wrong'",
    weight: 1,
    test: titleHas(/something went wrong/i),
  },
  {
    kind: "error",
    name: "text 'an error occurred when we tried to process your request'",
    weight: 1,
    test: textHas(/an error occurred when we tried to process your request/i),
  },

  // generic interstitial (cookie wall, redirect notice)
  {
    kind: "interstitial",
    name: "text 'enable cookies'",
    weight: 1,
    test: textHas(/please enable cookies/i),
  },
  {
    kind: "interstitial",
    name: "meta refresh",
    weight: 1,
    test: (ctx) =>
      Array.from(ctx.doc.querySelectorAll("meta[http-equiv]")).some(
        (m) => (attr(m, "http-equiv") ?? "").toLowerCase() === "refresh",
      ),
  },
  {
    kind: "interstitial",
    name: "text 'being redirected'",
    weight: 1,
    test: textHas(/you are being redirected|redirecting you/i),
  },
  {
    kind: "interstitial",
    name: "sparse page with a form",
    weight: 1,
    test: (ctx) => ctx.text.length < 300 && qa(ctx.doc, "form").length > 0,
  },
];

/** Build the context the signals read. */
export function signalContext(
  capture: Capture,
  doc: DomDocument = parseDocument(capture.html),
): SignalContext {
  return {
    doc,
    url: (capture.final_url || capture.url || "").toLowerCase(),
    title: (doc.title ?? "").replace(/\s+/g, " ").trim(),
    text: text(doc.body),
  };
}

/**
 * Classify a capture as an interstitial, or null for a normal page. A signal that throws is
 * treated as not firing.
 */
export function classifyInterstitial(
  capture: Capture,
  signals: readonly InterstitialSignal[] = INTERSTITIAL_SIGNALS,
  doc?: DomDocument,
): Interstitial | null {
  const ctx = signalContext(capture, doc);
  const scores = new Map<InterstitialKind, { score: number; names: string[] }>();
  for (const s of signals) {
    let fired: boolean;
    try {
      fired = s.test(ctx);
    } catch {
      fired = false;
    }
    if (!fired) continue;
    const entry = scores.get(s.kind) ?? { score: 0, names: [] };
    entry.score += s.weight;
    entry.names.push(s.name);
    scores.set(s.kind, entry);
  }
  let best: InterstitialKind | null = null;
  let bestScore = 0;
  for (const kind of PRIORITY) {
    const score = scores.get(kind)?.score ?? 0;
    if (score >= INTERSTITIAL_THRESHOLD && score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  if (best === null) return null;
  const names = scores.get(best)?.names ?? [];
  return { kind: best, evidence: `${best}: ${names.join(", ")}`, score: bestScore, signals: names };
}
