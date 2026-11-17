#!/usr/bin/env node
// Privacy gate 1: scan content and commit metadata against a PRIVATE denylist that
// lives outside the repository. The denylist path comes from the environment or from
// local git config, never from a tracked file.
//
//   privacy-gate.mjs staged            staged blobs (pre-commit)
//   privacy-gate.mjs msg <file>        a commit message file (commit-msg)
//   privacy-gate.mjs range <revs...>   commits in a rev-list expression (pre-push)
//   privacy-gate.mjs history           every commit reachable from any ref
//
// Configuration (git config --local):
//   rainforest.denylist  path to the denylist file
//   rainforest.owner     "true" on the owner's machine: a missing denylist FAILS CLOSED
//   rainforest.identity  "Name <email>" that author and committer must equal
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_BUFFER = 1 << 30;

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, ...opts });
}

function config(key) {
  try {
    return git(["config", "--get", key]).trim();
  } catch {
    return "";
  }
}

export function parseDenylist(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("re:")) {
      rules.push({ label: line, test: new RegExp(line.slice(3)) });
    } else {
      const needle = line.toLowerCase();
      rules.push({ label: line, test: { test: (s) => s.toLowerCase().includes(needle) } });
    }
  }
  return rules;
}

export function scanText(rules, text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      if (rule.test.test(lines[i])) hits.push({ line: i + 1, rule: rule.label });
    }
  }
  return hits;
}

function loadRules() {
  const path = process.env.RAINFOREST_DENYLIST || config("rainforest.denylist");
  const owner = config("rainforest.owner") === "true";
  if (!path || !existsSync(path)) {
    if (owner) {
      console.error("privacy-gate: denylist missing on the owner machine - failing closed");
      process.exit(2);
    }
    console.error("privacy-gate: no denylist configured, skipping (not the owner machine)");
    process.exit(0);
  }
  const rules = parseDenylist(readFileSync(path, "utf8"));
  if (rules.length === 0) {
    console.error("privacy-gate: denylist is empty - failing closed");
    process.exit(2);
  }
  return rules;
}

function report(where, hits, failures) {
  for (const h of hits) {
    // Never echo the matched text or the rule: logs may be public.
    failures.push(`${where}:${h.line}`);
  }
}

function scanCommits(rules, revArgs, failures) {
  const identity = config("rainforest.identity");
  const shas = git(["rev-list", ...revArgs])
    .split("\n")
    .filter(Boolean);
  const seenBlobs = new Set();
  for (const sha of shas) {
    const meta = git(["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", sha]);
    const [author, committer, ...body] = meta.split("\n");
    if (identity && (author !== identity || committer !== identity)) {
      failures.push(`${sha.slice(0, 10)}: author/committer is not the configured identity`);
    }
    report(`${sha.slice(0, 10)}:message`, scanText(rules, body.join("\n")), failures);
    const tree = git(["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean);
    for (const entry of tree) {
      const [info, path] = entry.split("\t");
      const [, type, blob] = info.split(" ");
      report(`${sha.slice(0, 10)}:path`, scanText(rules, path), failures);
      if (type !== "blob" || seenBlobs.has(blob)) continue;
      seenBlobs.add(blob);
      const data = execFileSync("git", ["cat-file", "blob", blob], { maxBuffer: MAX_BUFFER });
      report(`${sha.slice(0, 10)}:${path}`, scanText(rules, data.toString("latin1")), failures);
    }
  }
  return shas.length;
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const rules = loadRules();
  const failures = [];
  if (mode === "staged") {
    const files = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
      .split("\0")
      .filter(Boolean);
    for (const file of files) {
      report(`${file}:path`, scanText(rules, file), failures);
      const data = execFileSync("git", ["show", `:${file}`], { maxBuffer: MAX_BUFFER });
      report(file, scanText(rules, data.toString("latin1")), failures);
    }
  } else if (mode === "msg") {
    report("commit message", scanText(rules, readFileSync(rest[0], "utf8")), failures);
  } else if (mode === "range") {
    scanCommits(rules, rest, failures);
  } else if (mode === "history") {
    const n = scanCommits(rules, ["--all"], failures);
    console.error(`privacy-gate: scanned ${n} commits`);
  } else {
    console.error("usage: privacy-gate.mjs staged | msg <file> | range <revs...> | history");
    process.exit(4);
  }
  if (failures.length > 0) {
    console.error(`privacy-gate: ${failures.length} denylist hit(s):`);
    for (const f of [...new Set(failures)].slice(0, 50)) console.error(`  ${f}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
