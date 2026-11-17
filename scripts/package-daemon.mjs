#!/usr/bin/env node
// Build the rainforestd release: one tarball plus manifest.json in dist/release/.
//
//   node scripts/package-daemon.mjs [--version <v>] [--out <dir>]
//
// The tarball is reproducible for a given commit: files are added in sorted order with a fixed
// mtime and no owner data, and nothing in it is a symlink. Signing is a separate step
// (scripts/sign-manifest.mjs) so this script never needs the private key.
import { build } from "esbuild";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as tar from "tar";
import {
  REPO_ROOT,
  buildManifest,
  buildPathNeedles,
  computeVersion,
  createdAt as computeCreatedAt,
  findBuildPathLeaks,
  headCommit,
  isValidVersion,
  tarballName,
} from "./lib/release-common.mjs";

/** Fixed entry mtime: the archive must not depend on when or where it was built. */
const TAR_MTIME = new Date("2020-01-01T00:00:00Z");

/** Needed by CommonJS dependencies that call require() from inside an ESM bundle. */
const REQUIRE_BANNER =
  'import { createRequire as __rfCreateRequire } from "node:module";\n' +
  "const require = __rfCreateRequire(import.meta.url);";

const BUNDLE_OPTIONS = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
  write: false,
};

async function bundle(root, entry, extra = {}) {
  const result = await build({
    ...BUNDLE_OPTIONS,
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: "bundle.mjs",
    ...extra,
  });
  const file = result.outputFiles?.[0];
  if (!file) throw new Error(`esbuild produced no output for ${entry}`);
  return file.text;
}

/** Bundle the daemon; add the require() banner only when a bundled dependency needs it. */
async function bundleDaemon(root) {
  const options = { external: ["playwright-core"] };
  const plain = await bundle(root, "packages/daemon/src/main.ts", options);
  if (!plain.includes("Dynamic require of")) return plain;
  return bundle(root, "packages/daemon/src/main.ts", {
    ...options,
    banner: { js: REQUIRE_BANNER },
  });
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in a release: ${full}`);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Production files of playwright-core: no type declarations, no source maps, no browsers. */
function copyPlaywrightCore(root, destDir) {
  const require = createRequire(join(root, "packages", "daemon", "package.json"));
  const pkgDir = dirname(require.resolve("playwright-core/package.json"));
  for (const file of walk(pkgDir)) {
    const rel = relative(pkgDir, file).replaceAll("\\", "/");
    if (rel.endsWith(".d.ts") || rel.endsWith(".map") || rel.startsWith("types/")) continue;
    const dest = join(destDir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    chmodSync(dest, 0o644);
  }
}

/** All regular files under `dir`, as `/`-separated relative paths in byte order. */
function sortedFiles(dir) {
  return walk(dir)
    .map((file) => relative(dir, file).replaceAll("\\", "/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function writeStaged(file, text) {
  writeFileSync(file, text, "utf8");
  chmodSync(file, 0o644);
}

/**
 * Package the daemon. Returns `{ version, tarballPath, manifestPath, sha256, size }`.
 * `root` is the repository to build (default: this repository).
 */
export async function packageDaemon(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const version = options.version ?? computeVersion(root);
  if (!isValidVersion(version)) throw new Error(`invalid version: ${version}`);
  const outDir = resolve(options.outDir ?? join(root, "dist", "release"));
  const commit = options.commit ?? headCommit(root);
  const created = options.createdAt ?? computeCreatedAt(root);

  const staging = mkdtempSync(join(tmpdir(), "rainforestd-stage-"));
  try {
    const top = `rainforestd-${version}`;
    const stage = join(staging, top);
    mkdirSync(stage, { recursive: true });

    writeStaged(join(stage, "rainforestd.mjs"), await bundleDaemon(root));
    writeStaged(join(stage, "launcher.mjs"), await bundle(root, "packages/daemon/src/launcher.ts"));
    copyPlaywrightCore(root, join(stage, "node_modules", "playwright-core"));
    writeStaged(
      join(stage, "package.json"),
      `${JSON.stringify({ name: "rainforestd", version, type: "module" })}\n`,
    );
    writeStaged(join(stage, "VERSION"), version);

    const files = sortedFiles(staging);
    const tarballPath = join(outDir, tarballName(version));
    const manifestPath = join(outDir, "manifest.json");
    mkdirSync(outDir, { recursive: true });
    for (const stale of readdirSync(outDir)) {
      if (
        stale === "manifest.json" ||
        stale === "manifest.sig" ||
        /^rainforestd-.*\.tgz$/.test(stale)
      ) {
        rmSync(join(outDir, stale), { force: true });
      }
    }
    tar.create(
      {
        file: tarballPath,
        cwd: staging,
        sync: true,
        gzip: { level: 9 },
        portable: true,
        mtime: TAR_MTIME,
        noDirRecurse: true,
      },
      files,
    );

    const tarballBytes = readFileSync(tarballPath);
    const leaks = findBuildPathLeaks(tarballBytes, buildPathNeedles(root, [staging]));
    if (leaks.length > 0) {
      rmSync(tarballPath, { force: true });
      throw new Error(
        `the tarball contains ${leaks.length} build machine path(s); refusing to ship`,
      );
    }

    const { bytes } = buildManifest({ version, tarballBytes, createdAt: created, commit });
    writeFileSync(manifestPath, bytes);
    const manifest = JSON.parse(bytes.toString("utf8"));
    return { version, tarballPath, manifestPath, sha256: manifest.sha256, size: manifest.size };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { version: { type: "string" }, out: { type: "string" } },
    strict: true,
  });
  const result = await packageDaemon({
    ...(values.version ? { version: values.version } : {}),
    ...(values.out ? { outDir: values.out } : {}),
  });
  console.log(`version ${result.version}`);
  console.log(`tarball ${tarballName(result.version)} ${result.size} bytes`);
  console.log(`sha256 ${result.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`package-daemon: ${error.message}`);
    process.exit(1);
  });
}
