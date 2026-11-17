import { chmodSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { SeenPage } from "@rainforest/browser";
import { atomicWriteFile, ensureDir } from "./fsutil.ts";
import type { Logger } from "./log.ts";

/**
 * A bounded archive of the pages the daemon read, for looking at afterwards when a call
 * went wrong: what Amazon actually served, not a description of it. Every page, every
 * fragment and the page a failed call left behind is written as one gzipped JSON file in
 * the app directory. It stays on this computer: nothing here is ever sent to the hub.
 * Oldest files are deleted first once there are more than `maxPages` files or more than
 * `maxBytes` bytes in total.
 */

export const DEFAULT_ARCHIVE_PAGES = 200;
export const DEFAULT_ARCHIVE_MB = 2048;

export interface PageArchive {
  save(page: SeenPage): void;
}

export interface PageArchiveOptions {
  dir: string;
  maxPages?: number;
  maxBytes?: number;
  log?: Logger;
  now?: () => Date;
}

const FILE = /^\d{8}T\d{9}Z-\d{4}-[a-z0-9_]+\.json\.gz$/;

/** "20260110T180000123Z": sorts by time as plain text. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function createPageArchive(options: PageArchiveOptions): PageArchive {
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_ARCHIVE_PAGES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_ARCHIVE_MB * 1024 * 1024);
  const now = options.now ?? (() => new Date());
  let seq = 0;
  let ready = false;

  /** Our files, oldest first. Anything else in the directory is left alone. */
  function files(): { name: string; size: number }[] {
    return readdirSync(options.dir)
      .filter((name) => FILE.test(name))
      .sort()
      .map((name) => {
        try {
          return { name, size: statSync(join(options.dir, name)).size };
        } catch {
          return { name, size: 0 };
        }
      });
  }

  function prune(): void {
    const kept = files();
    let total = kept.reduce((sum, f) => sum + f.size, 0);
    while (kept.length > 1 && (kept.length > maxPages || total > maxBytes)) {
      const oldest = kept.shift()!;
      rmSync(join(options.dir, oldest.name), { force: true });
      total -= oldest.size;
    }
  }

  return {
    save(page) {
      try {
        if (!ready) {
          ensureDir(options.dir);
          // Pages hold whatever the account shows: keep them to this user.
          try {
            chmodSync(options.dir, 0o700);
          } catch {
            // Not every platform has modes; the app directory is per-user either way.
          }
          ready = true;
        }
        const at = now();
        const kind =
          page.kind
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_")
            .slice(0, 40) || "page";
        seq = (seq + 1) % 10_000;
        const name = `${stamp(at)}-${String(seq).padStart(4, "0")}-${kind}.json.gz`;
        const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, ...page }), "utf8"));
        atomicWriteFile(join(options.dir, name), body, 0o600);
        prune();
      } catch (error) {
        // Diagnostics must never fail a call.
        options.log?.warn("could not keep a page in the archive", {
          error: String((error as Error)?.message ?? error),
        });
      }
    },
  };
}
