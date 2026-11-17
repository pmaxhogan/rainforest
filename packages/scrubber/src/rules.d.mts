// Types for rules.mjs (kept as plain JS so the public CI gate needs no type stripping).

export declare const FAKE_RANGES: Readonly<{
  asinPattern: RegExp;
  orderIdPattern: RegExp;
  emailDomain: string;
  phonePattern: RegExp;
  zips: readonly string[];
  imageUrl: string;
  host: string;
}>;

export declare const SYNTHETIC: Readonly<{
  city: string;
  state: string;
  street: string;
  cardLast4: string;
  cardExpiry: Readonly<{ year: number; month: number }>;
  idPrefix: string;
  tokenPrefix: string;
  uuidPrefix: string;
  names: readonly string[];
}>;

export declare const ALLOWED_HOSTS: readonly string[];
export declare const SCRIPT_TYPES: readonly string[];
export declare const EXTENSION_SIGNATURE: RegExp;
export declare const EXTENSION_URL: RegExp;

export type PatternName =
  | "url"
  | "email"
  | "asin"
  | "isbnAsinContext"
  | "orderId"
  | "uuid"
  | "phone"
  | "cardLast4"
  | "zipPlus4"
  | "zip"
  | "opaqueRun"
  | "upperId";

export declare const PATTERNS: Readonly<Record<PatternName, string>>;

export declare function re(name: PatternName, flags?: string): RegExp;
export declare function isFakeAsin(s: string): boolean;
export declare function isFakeOrderId(s: string): boolean;
export declare function isFakeEmail(s: string): boolean;
export declare function isFakePhone(s: string): boolean;
export declare function isFakeZip(s: string): boolean;
export declare function isFakeUuid(s: string): boolean;
export declare function isPlaceholderId(s: string): boolean;
export declare function isOpaque(run: string): boolean;
export declare function isUpperId(tok: string): boolean;
export declare function isAllowedHost(host: string): boolean;

export interface Finding {
  /** Rule that fired, for example "asin", "zip", "url-host", "script". */
  rule: string;
  /** The offending text. Never print it: use describeFinding(). */
  match: string;
  index: number;
  line: number;
}

export declare function auditText(text: string, opts?: { html?: boolean }): Finding[];
export declare function describeFinding(f: Finding): string;

export interface GateViolation {
  /** Path relative to the fixtures root, "/" separated. */
  file: string;
  rule: string;
  line: number;
  detail: string;
}

export declare function checkFixturesTree(root: string): {
  violations: GateViolation[];
  files: number;
  cases: number;
};
