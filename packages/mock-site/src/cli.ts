#!/usr/bin/env node
/**
 * Run the fake storefront on loopback for manual poking:
 *
 *   node packages/mock-site/src/cli.ts [--port 8080] [--seed 1]
 *
 * Plain HTTP only; the E2E harness adds TLS and the hostname mapping itself.
 */
import { parseArgs } from "node:util";
import { createMockSite } from "./server.ts";

export function parseCli(argv: string[]): { port: number; seed: number } {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string", default: "8080" }, seed: { type: "string", default: "1" } },
  });
  const port = Number(values.port);
  const seed = Number(values.seed);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port must be 0-65535");
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  return { port, seed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, seed } = parseCli(process.argv.slice(2));
  const site = await createMockSite({ port, seed });
  console.log(`mock storefront on ${site.origin} (seed ${seed})`);
  process.on("SIGINT", () => void site.close().then(() => process.exit(0)));
}
