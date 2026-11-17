/**
 * Self-check over scrubbed output. Thin wrapper over the shared rules in rules.mjs, which
 * the public CI gate (scripts/check-fixtures.mjs) runs too, so the two cannot drift.
 */
import { auditText, type Finding } from "./rules.mjs";

export type { Finding };

/**
 * Flag anything in scrubbed output that still looks real: ASIN- and order-id-shaped tokens
 * outside the fake ranges, non-example.com emails, phones and address-context ZIPs outside
 * the reserved sets, card last-4 digits, UUIDs, long opaque blobs and ids, non-placeholder
 * URL hosts and (for HTML) scripts, styles, comments, handlers and iframe sources.
 */
export function auditScrubbed(text: string, opts: { html?: boolean } = {}): Finding[] {
  return auditText(text, { html: opts.html ?? true });
}
