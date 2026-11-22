/**
 * Capture, parser and fixture contracts. Every parser lane keys on these.
 *
 * A capture is the serialized post-render DOM of one page (plus fragments fetched on
 * purpose), taken after an in-page pass that marks non-rendered elements with
 * `data-rf-hidden="1"`. Parsers are pure functions over a capture: no I/O, no clock,
 * no randomness, so the same bytes drive tests and production.
 */

export const PAGE_KINDS = [
  "search",
  "product",
  "offers",
  "reviews",
  "cart",
  "order_list",
  "order_search",
  "order_details",
  "invoice",
  "returns",
  "subscriptions",
  "lists_index",
  "list",
  "browsing_history",
  "search_history",
  "price_history_amazon",
  "price_history_camel",
  "interstitial",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Attribute the in-page pass puts on elements that are not rendered. Parsers must skip them. */
export const HIDDEN_ATTR = "data-rf-hidden";

export interface Capture {
  kind: PageKind;
  /** URL that was requested. */
  url: string;
  /** URL after redirects. */
  final_url: string;
  /** ISO timestamp. In fixtures this is a fixed synthetic value. */
  captured_at: string;
  /** Serialized DOM with hidden markers. */
  html: string;
  /** Extra documents fetched on purpose, keyed by a stable name (for example "aod"). */
  fragments?: Record<string, string>;
}

/** A visible block no typed parser consumed. This is what makes parsing lossless. */
export interface OtherSection {
  /** Stable-ish identifier: element id, feature name or a positional key. */
  key: string;
  heading: string | null;
  text: string;
  tables?: string[][][];
  links?: { text: string; href: string }[];
}

export interface ParseMeta {
  /** Field name -> which strategy produced it (for parser health reporting). */
  strategies: Record<string, string>;
  warnings: string[];
  /** Visible text characters neither a typed parser nor other_sections accounted for. */
  unparsed_text_chars: number;
  /** Keys of embedded data blobs that were present but not understood. */
  unknown_blobs?: string[];
}

export interface ParseResult<T> {
  data: T;
  other_sections: OtherSection[];
  meta: ParseMeta;
}

/**
 * Signature every page parser implements. Throw only when nothing at all is parseable
 * (use RfError "layout_unrecognized"); otherwise return a partial result plus warnings.
 */
export type Parser<T> = (capture: Capture) => ParseResult<T>;

/**
 * Fixture layout, one directory per case:
 *
 *   fixtures/<kind>/<case>/capture.json    a Capture with `html` omitted
 *   fixtures/<kind>/<case>/page.html       the scrubbed DOM
 *   fixtures/<kind>/<case>/<name>.html     one file per fragment
 *   fixtures/<kind>/<case>/expected.json   the parser's expected ParseResult
 *
 * Fixtures are synthetic only. See docs/PRIVACY.md for the reserved fake ranges.
 */
export interface FixtureManifest extends Omit<Capture, "html" | "fragments"> {
  /** Fragment name -> file name inside the case directory. */
  fragments?: Record<string, string>;
  /** Free-form note on what the case exercises (for example "no featured offer"). */
  note?: string;
}

/** Reserved fake ranges: the only identifiers allowed inside fixtures/. */
export const FAKE = {
  /** ASINs: B0FAKE0000 .. B0FAKE9999 (and X-prefixed variants for parent ASINs). */
  asinPattern: /^[BX]0FAKE[0-9A-Z]{4}$/,
  /** Order ids: 000-0000000-NNNNNNN. */
  orderIdPattern: /^000-0000000-[0-9]{7}$/,
  emailDomain: "example.com",
  /** Phones: 555-01NN. */
  phonePattern: /^(\+1[ -]?)?\(?555\)?[ -]?555[ -]?01[0-9]{2}$/,
  zips: ["00000", "00001", "00002", "00003"],
  imageUrl: "https://images.example.com/placeholder.png",
  host: "https://www.example.com",
} as const;
