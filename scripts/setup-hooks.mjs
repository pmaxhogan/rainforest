#!/usr/bin/env node
// Enable the repository's git hooks in this clone.
//   node scripts/setup-hooks.mjs [--owner --denylist <path> --identity "Name <email>"]
// Without --owner the privacy gate skips when no denylist is configured. On the owner's
// machine pass --owner so a missing denylist fails closed.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const set = (key, v) => execFileSync("git", ["config", "--local", key, v], { stdio: "inherit" });

set("core.hooksPath", ".githooks");
set("core.autocrlf", "false");
if (args.includes("--owner")) set("rainforest.owner", "true");
if (value("--denylist")) set("rainforest.denylist", value("--denylist"));
if (value("--identity")) set("rainforest.identity", value("--identity"));
console.log("hooks enabled");
