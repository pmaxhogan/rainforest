#!/usr/bin/env node
/**
 * Developer capture queue: load pages one at a time through the rails and the pacer and
 * write raw captures to a PRIVATE corpus directory outside the repository.
 *
 *   RAINFOREST_TOKEN=... RAINFOREST_EXTENSION_ID=... RAINFOREST_CORPUS=/path \
 *     node packages/browser/src/dev-capture.ts <jobs.tsv>
 *
 * jobs.tsv: one job per line, `kind<TAB>name<TAB>pacing-type<TAB>url[<TAB>fragments]`. Existing captures
 * are skipped, so the queue is resumable. Raw captures must never be committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RfError, type PageKind } from "@rainforest/core";
import { ExternalBroker } from "./broker.ts";
import { emptyPacingState, Pacer, type PacingState, type PageType } from "./pacing.ts";
import { BrowserSession } from "./session.ts";

const token = process.env.RAINFOREST_TOKEN;
const extensionId = process.env.RAINFOREST_EXTENSION_ID;
const corpus = process.env.RAINFOREST_CORPUS;
const jobsFile = process.argv[2];
if (!token || !extensionId || !corpus || !jobsFile) {
  console.error(
    "usage: RAINFOREST_TOKEN RAINFOREST_EXTENSION_ID RAINFOREST_CORPUS env + <jobs.tsv>",
  );
  process.exit(4);
}

const pacingFile = join(corpus, "pacing.json");
const state: PacingState = existsSync(pacingFile)
  ? (JSON.parse(readFileSync(pacingFile, "utf8")) as PacingState)
  : emptyPacingState();
const pacer = new Pacer({ state });
const session = new BrowserSession({
  broker: new ExternalBroker(Number(process.env.RAINFOREST_BROKER_PORT ?? 47117)),
  token,
  extensionId,
  pacer,
  idleDetachMs: 5000,
  onPacingChange: () => writeFileSync(pacingFile, JSON.stringify(pacer.state), { mode: 0o600 }),
  log: (line) => console.error(`[session] ${line}`),
});

const jobs = readFileSync(jobsFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split("\t"));

let failed = 0;
for (const [kind, name, type, url, fragmentSpec] of jobs) {
  if (!kind || !name || !type || !url) {
    console.error(`bad job line: ${[kind, name, type, url].join(" | ")}`);
    failed++;
    continue;
  }
  const dir = join(corpus, kind, name);
  if (existsSync(join(dir, "page.html"))) {
    console.error(`skip ${kind}/${name} (exists)`);
    continue;
  }
  const started = Date.now();
  try {
    const capture = await session.run(async (ctx) => {
      await ctx.goto(url, type as PageType);
      // Let late content settle a little; pages keep loading after DOMContentLoaded.
      await ctx.page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, Number(process.env.RAINFOREST_SETTLE_MS ?? 1500)));
      const captured = await ctx.capture(kind as PageKind);
      // Optional 5th column: `name=path-and-query` pairs separated by `|`, fetched in-page.
      for (const pair of (fragmentSpec ?? "").split("|").filter(Boolean)) {
        const at = pair.indexOf("=");
        const body = await ctx.fetchFragment(pair.slice(at + 1), type as PageType);
        (captured.fragments ??= {})[pair.slice(0, at)] = body;
      }
      return captured;
    });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { html, fragments, ...meta } = capture;
    const fragmentFiles: Record<string, string> = {};
    for (const [fragmentName, body] of Object.entries(fragments ?? {})) {
      fragmentFiles[fragmentName] = `${fragmentName}.html`;
      writeFileSync(join(dir, `${fragmentName}.html`), body, { mode: 0o600 });
    }
    if (fragments) Object.assign(meta, { fragments: fragmentFiles });
    writeFileSync(join(dir, "page.html"), html, { mode: 0o600 });
    writeFileSync(join(dir, "capture.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
    console.error(
      `ok ${kind}/${name} ${html.length} chars in ${Date.now() - started} ms -> ${capture.final_url.slice(0, 80)}`,
    );
  } catch (error) {
    failed++;
    if (error instanceof RfError) {
      console.error(`FAIL ${kind}/${name}: ${JSON.stringify(error.payload)}`);
      if (error.payload.code === "needs_human" || error.payload.code === "throttled") {
        console.error("stopping the queue: account friction or pacing limit");
        break;
      }
    } else {
      console.error(
        `FAIL ${kind}/${name}: ${String((error as Error)?.message ?? error).split("\n")[0]}`,
      );
    }
  }
}
await session.detach();
process.exit(failed ? 1 : 0);
