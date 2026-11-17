#!/usr/bin/env node
// Privacy gate 2: every file under fixtures/ must use only the reserved fake ranges
// (ASINs, order ids, emails, phones, ZIPs, placeholder hosts), carry no opaque tokens or
// live scripts, and follow the <kind>/<case>/ layout. Plain Node, no dependencies, no
// secrets: it runs in public CI. The rules live in packages/scrubber/src/rules.mjs so the
// scrubber's self-check and this gate cannot drift.
//
//   node scripts/check-fixtures.mjs [fixtures-dir]
//
// Output names the file, line and rule only, never the offending value (CI logs are public).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixturesTree } from "../packages/scrubber/src/rules.mjs";

const root = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../fixtures", import.meta.url));

const { violations, files, cases } = checkFixturesTree(root);
if (violations.length > 0) {
  console.error(`fixtures: ${violations.length} violation(s):`);
  for (const v of violations.slice(0, 200)) {
    const where = v.line > 0 ? `${v.file}:${v.line}` : v.file;
    console.error(`  ${where}: ${v.rule}${v.detail ? ` - ${v.detail}` : ""}`);
  }
  process.exit(1);
}
console.log(`fixtures ok (${cases} case(s), ${files} file(s))`);
