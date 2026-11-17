/** Structured error taxonomy shared by the hub, the daemon and every tool result. */
export const ERROR_CODES = [
  "needs_human",
  "throttled",
  "no_browser_online",
  "browser_offline",
  "busy",
  "not_found",
  "layout_unrecognized",
  "blocked_by_policy",
  "needs_choice",
  "daemon_outdated",
  "hub_outdated",
  "invalid_arguments",
  "unsupported",
  "timeout",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** What a human has to do when the code is `needs_human`. */
export const HUMAN_KINDS = ["captcha", "sign_in", "soft_challenge", "interstitial"] as const;
export type HumanKind = (typeof HUMAN_KINDS)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  /** Only for `needs_human`. */
  kind?: HumanKind;
  /** Seconds after which a retry is reasonable (`throttled`, `busy`). */
  retry_after_s?: number;
  /** Extra structured context: online browsers, observed state, flags, alternatives. */
  details?: Record<string, unknown>;
}

export class RfError extends Error {
  readonly payload: ErrorPayload;

  constructor(
    code: ErrorCode,
    message: string,
    extra: Omit<ErrorPayload, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "RfError";
    this.payload = { code, message, ...extra };
  }
}

/** Normalize anything thrown into a payload. Unknown errors never leak their message. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof RfError) return error.payload;
  return { code: "internal", message: "internal error" };
}
