#!/usr/bin/env node
/**
 * node packages/scrubber/src/cli.ts <capture-dir> <fixture-case-dir> [--seed <s>] [--note <text>]
 *
 * Reads a raw capture, scrubs it, self-audits the result and writes the fixture case.
 * Fails closed: when the audit has findings NOTHING is written and the exit code is 1.
 * Output never echoes a matched value (only rule, file and line), so it is safe to paste.
 */
import { resolve } from "node:path";
import { readRawCapture, toManifest, writeFixtureCase } from "./fixture-io.ts";
import { auditText } from "./rules.mjs";
import { scrubCapture } from "./scrub.ts";

function usage(): never {
  console.error(
    "usage: node packages/scrubber/src/cli.ts <capture-dir> <fixture-case-dir> [--seed <s>] [--note <text>]",
  );
  process.exit(4);
}

export function main(argv: string[]): number {
  const positional: string[] = [];
  let seed: string | undefined;
  let note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--seed") seed = argv[++i] ?? usage();
    else if (a === "--note") note = argv[++i] ?? usage();
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }
  const [src, dest] = positional;
  if (src === undefined || dest === undefined || positional.length !== 2) usage();
  if (resolve(src) === resolve(dest)) {
    console.error("scrub: refusing to write the fixture over the raw capture");
    return 4;
  }
  const raw = readRawCapture(src);
  const { capture, report } = scrubCapture(raw, seed === undefined ? {} : { seed });
  console.log("scrub report:");
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k}: ${v}`);
  // The manifest carries the free-text --note, so it is audited like the pages.
  const manifestFindings = auditText(JSON.stringify(toManifest(capture, note))).map((f) => ({
    where: "capture.json",
    rule: f.rule,
    line: f.line,
  }));
  const findings = [...report.findings, ...manifestFindings];
  if (findings.length > 0) {
    console.error(`scrub: ${findings.length} residual-risk finding(s); nothing written:`);
    for (const f of findings) console.error(`  ${f.where}:${f.line}: ${f.rule}`);
    return 1;
  }
  const written = writeFixtureCase(dest, capture, note);
  console.log(`scrub: wrote ${written.join(", ")} to ${dest}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/cli.ts")) {
  process.exit(main(process.argv.slice(2)));
}
