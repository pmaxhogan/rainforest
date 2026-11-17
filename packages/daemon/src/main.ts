#!/usr/bin/env node
// Entry point. Runs the CLI immediately when loaded, both as `rainforestd` and when the
// stable launcher imports a version's entry. Tests import `cli.ts`, never this file.
import { runCli } from "./cli.ts";
import { defaultContext } from "./commands/context.ts";
import { createLogger } from "./log.ts";

const ctx = defaultContext((paths) =>
  createLogger({
    file: paths.logFile,
    level: process.env.RAINFOREST_LOG_LEVEL === "debug" ? "debug" : "info",
    ...(process.stderr.isTTY ? { sink: (line: string) => process.stderr.write(line) } : {}),
  }),
);

process.on("unhandledRejection", (reason) => {
  ctx.makeLogger(ctx.paths).error("unhandled rejection", { error: reason });
});
process.on("uncaughtException", (error) => {
  ctx.makeLogger(ctx.paths).error("uncaught exception", { error });
  process.exit(1);
});

const args = process.argv.slice(2);
const code = await runCli(args, ctx);
process.exitCode = code;
if (args[0] === "run") {
  // A stuck handle must not keep a stopped daemon alive: the service manager restarts it.
  setTimeout(() => process.exit(code), 3000).unref();
}
