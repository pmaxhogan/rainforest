export { scrubCapture, DEFAULT_SEED } from "./scrub.ts";
export type { ScrubOptions, ScrubReport, ScrubResult, ReportFinding } from "./scrub.ts";
export { auditScrubbed } from "./audit.ts";
export type { Finding } from "./audit.ts";
export { readRawCapture, writeFixtureCase, toManifest } from "./fixture-io.ts";
export {
  KEPT_VALUE_ATTRS,
  URL_ATTRS,
  IMAGE_URL_ATTRS,
  DROPPED_ATTRS,
  DROPPED_ELEMENTS,
  SAFE_LITERALS,
  PATH_SEGMENTS,
  QUERY_PARAMS,
  JSON_KEPT_KEYS,
  ID_PREFIXES,
  ID_PARAMS,
  TRIM_RULES,
  PARSER_CLASS_TOKENS,
  IDREF_ATTRS,
  REDUCE_DROP_HIDDEN_SELECTORS,
  REDUCE_DROP_SELECTORS,
  REDUCE_KEEP_HIDDEN_SELECTORS,
  LABELS,
  parseLabels,
} from "./allowlists.ts";
export type { Label, LabelKind } from "./allowlists.ts";
export {
  ALLOWED_HOSTS,
  FAKE_RANGES,
  SCRIPT_TYPES,
  SYNTHETIC,
  checkFixturesTree,
  describeFinding,
} from "./rules.mjs";
export type { GateViolation } from "./rules.mjs";
