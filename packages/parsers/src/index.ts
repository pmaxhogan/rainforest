import type { PageKind, Parser } from "@rainforest/core";

export * from "./dom.ts";
export * from "./strategy.ts";
export * from "./lossless.ts";
export * from "./blobs.ts";
export * from "./interstitial.ts";
export * from "./pages/index.ts";

/** Page kind -> parser. Per-page parsers are added by later lanes against real captures. */
export type ParserRegistry = Partial<Record<PageKind, Parser<unknown>>>;

export const PARSERS: ParserRegistry = {};
