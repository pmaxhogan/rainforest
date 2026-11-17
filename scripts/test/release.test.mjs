// Tests for the release pipeline scripts. Plain .mjs on purpose: the scripts are plain
// Node ESM and are not part of the typechecked TypeScript program.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  PLACEHOLDER_KEY,
  REPO_ROOT,
  assertReleaseKeys,
  buildManifest,
  buildPathNeedles,
  computeVersion,
  findBuildPathLeaks,
  parsePublicKeys,
  readPublicKeys,
  sha256Hex,
  tarballName,
  usablePublicKeys,
} from "../lib/release-common.mjs";
import { readTgz } from "../lib/tar-read.mjs";
import { packageDaemon } from "../package-daemon.mjs";
import { signManifest } from "../sign-manifest.mjs";
import { verifyRelease } from "../verify-release.mjs";

const SCRIPTS = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rf-release-test-"));
let counter = 0;
function freshDir(name = "d") {
  const dir = join(scratch, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    privateKey,
  };
}

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=tester", "-c", "user.email=tester@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** One 512-byte ustar entry (header plus padded data), written by hand so any type is possible. */
function tarEntry(name, { type = "0", data = "", linkpath = "" } = {}) {
  const body = Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkpath, 157, 100, "utf8");
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

function tgzOf(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** The minimal set of entries a valid release needs. */
function validEntries(version, extra = []) {
  const top = `rainforestd-${version}`;
  return [
    tarEntry(`${top}/rainforestd.mjs`, { data: "export {};\n" }),
    tarEntry(`${top}/launcher.mjs`, { data: "export {};\n" }),
    tarEntry(`${top}/package.json`, {
      data: JSON.stringify({ name: "rainforestd", version, type: "module" }),
    }),
    tarEntry(`${top}/VERSION`, { data: version }),
    tarEntry(`${top}/node_modules/playwright-core/package.json`, { data: "{}" }),
    ...extra,
  ];
}

/** Write a signed (or unsigned) release directory around an arbitrary tarball. */
function writeRelease(dir, version, tgz, key) {
  writeFileSync(join(dir, tarballName(version)), tgz);
  const { bytes } = buildManifest({
    version,
    tarballBytes: tgz,
    createdAt: "2026-01-01T00:00:00.000Z",
    commit: "0123456789abcdef0123456789abcdef01234567",
  });
  writeFileSync(join(dir, "manifest.json"), bytes);
  if (key)
    writeFileSync(join(dir, "manifest.sig"), sign(null, bytes, key.privateKey).toString("base64"));
  return dir;
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("computeVersion", () => {
  test("is the VERSION file plus the commit count on HEAD", () => {
    const repo = freshDir("repo");
    git(repo, "init", "-q");
    writeFileSync(join(repo, "VERSION"), "0.1\n");
    git(repo, "add", "VERSION");
    git(repo, "commit", "-q", "-m", "first");
    expect(computeVersion(repo)).toBe("0.1.1");
    for (let i = 0; i < 4; i++) git(repo, "commit", "-q", "--allow-empty", "-m", `n${i}`);
    expect(computeVersion(repo)).toBe("0.1.5");
    // Deterministic: asking again gives the same answer.
    expect(computeVersion(repo)).toBe("0.1.5");
    writeFileSync(join(repo, "VERSION"), "2.0\n");
    expect(computeVersion(repo)).toBe("2.0.5");
  });

  test("rejects a malformed VERSION file", () => {
    const repo = freshDir("repo");
    git(repo, "init", "-q");
    writeFileSync(join(repo, "VERSION"), "not a version\n");
    git(repo, "add", "VERSION");
    git(repo, "commit", "-q", "-m", "first");
    expect(() => computeVersion(repo)).toThrow(/VERSION must look like/);
  });
});

describe("a real build", () => {
  let outA;
  let outB;
  let resultA;
  let resultB;

  beforeAll(async () => {
    outA = freshDir("build");
    outB = freshDir("build");
    const options = { version: "0.1.99" };
    resultA = await packageDaemon({ ...options, outDir: outA });
    resultB = await packageDaemon({ ...options, outDir: outB });
  }, 120_000);

  test("writes a manifest of exactly the contract shape", () => {
    const bytes = readFileSync(join(outA, "manifest.json"));
    const manifest = JSON.parse(bytes.toString("utf8"));
    expect(Object.keys(manifest)).toEqual([
      "schema",
      "version",
      "tarball",
      "sha256",
      "size",
      "min_node",
      "created_at",
      "commit",
    ]);
    expect(manifest.schema).toBe(1);
    expect(manifest.version).toBe("0.1.99");
    expect(manifest.tarball).toBe("rainforestd-0.1.99.tgz");
    expect(manifest.min_node).toBe("22.0.0");
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(manifest.created_at).toISOString()).toBe(manifest.created_at);
    // Compact serialization with no trailing newline: these are the signed bytes.
    expect(bytes.toString("utf8")).toBe(JSON.stringify(manifest));
    const tgz = readFileSync(join(outA, "rainforestd-0.1.99.tgz"));
    expect(manifest.sha256).toBe(sha256Hex(tgz));
    expect(manifest.size).toBe(tgz.length);
  });

  test("two builds of the same tree produce an identical tarball and manifest", () => {
    expect(resultA.sha256).toBe(resultB.sha256);
    expect(readFileSync(join(outA, "manifest.json"))).toEqual(
      readFileSync(join(outB, "manifest.json")),
    );
    expect(readFileSync(resultA.tarballPath)).toEqual(readFileSync(resultB.tarballPath));
  });

  test("the tarball has the contract layout and no links", () => {
    const entries = readTgz(readFileSync(resultA.tarballPath));
    const top = "rainforestd-0.1.99/";
    expect(entries.every((e) => e.type === "file")).toBe(true);
    expect(entries.every((e) => e.path.startsWith(top))).toBe(true);
    const paths = entries.map((e) => e.path.slice(top.length));
    const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(sorted);
    const topLevel = new Set(paths.map((p) => p.split("/")[0]));
    // Hardcoded expectation: exactly these top-level names, nothing else.
    expect([...topLevel].sort()).toEqual(
      ["VERSION", "launcher.mjs", "node_modules", "package.json", "rainforestd.mjs"].sort(),
    );
    expect(paths).toContain("node_modules/playwright-core/package.json");
    expect(paths.some((p) => p.endsWith(".d.ts") || p.endsWith(".map"))).toBe(false);
    expect(entries.find((e) => e.path === `${top}VERSION`)?.data.toString("utf8")).toBe("0.1.99");
    expect(
      JSON.parse(entries.find((e) => e.path === `${top}package.json`).data.toString("utf8")),
    ).toEqual({ name: "rainforestd", version: "0.1.99", type: "module" });
  });

  test("no build machine path is inside the tarball", () => {
    const tgz = readFileSync(resultA.tarballPath);
    const needles = buildPathNeedles(REPO_ROOT, [tmpdir(), scratch]);
    expect(needles.length).toBeGreaterThan(0);
    expect(findBuildPathLeaks(tgz, needles)).toEqual([]);
  });

  test("the leak check does catch a path", () => {
    const leaky = tgzOf([tarEntry("rainforestd-1/x.txt", { data: `built in ${REPO_ROOT}/src\n` })]);
    expect(findBuildPathLeaks(leaky, buildPathNeedles(REPO_ROOT))).toContain(REPO_ROOT);
  });

  test("the extracted bundle runs: version, selftest and the stable launcher", () => {
    const extracted = freshDir("extract");
    tar.extract({ file: resultA.tarballPath, cwd: extracted, sync: true });
    const root = join(extracted, "rainforestd-0.1.99");
    const home = freshDir("home");
    const env = { ...process.env, RAINFOREST_HOME: home };
    const run = (file, ...args) =>
      spawnSync(process.execPath, [join(root, file), ...args], { env, encoding: "utf8" });

    const version = run("rainforestd.mjs", "version");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("0.1.99");
    const selftest = run("rainforestd.mjs", "selftest");
    expect(selftest.status).toBe(0);
    expect(selftest.stdout).toContain("ok   tool registry");
    expect(selftest.stdout).not.toContain("FAIL");

    // The launcher imports versions/<v>/rainforestd.mjs relative to RAINFOREST_HOME.
    cpSync(root, join(home, "versions", "0.1.99"), { recursive: true });
    cpSync(join(root, "launcher.mjs"), join(home, "launcher.mjs"));
    writeFileSync(join(home, "current"), "0.1.99\n");
    const launched = run("launcher.mjs", "version");
    expect(launched.status).toBe(0);
    expect(launched.stdout.trim()).toBe("0.1.99");
  });

  test("sign then verify round trip with a throwaway key", () => {
    const key = newKeyPair();
    const dir = freshDir("signed");
    cpSync(outA, dir, { recursive: true });
    signManifest({ dir, privateKey: key.priv, publicKeys: [key.pub] });
    const sig = readFileSync(join(dir, "manifest.sig"), "utf8");
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const summary = verifyRelease(dir, { publicKeys: [key.pub] });
    expect(summary.version).toBe("0.1.99");
    expect(summary.sha256).toBe(resultA.sha256);
  });

  test("verify rejects a tampered tarball, a tampered manifest and a wrong key", () => {
    const key = newKeyPair();
    const other = newKeyPair();
    const good = freshDir("signed");
    cpSync(outA, good, { recursive: true });
    signManifest({ dir: good, privateKey: key.priv, publicKeys: [key.pub] });
    expect(() => verifyRelease(good, { publicKeys: [key.pub] })).not.toThrow();

    const badTar = freshDir("tampered-tar");
    cpSync(good, badTar, { recursive: true });
    const tgzPath = join(badTar, "rainforestd-0.1.99.tgz");
    const bytes = readFileSync(tgzPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(tgzPath, bytes);
    expect(() => verifyRelease(badTar, { publicKeys: [key.pub] })).toThrow(/sha256 does not match/);

    const badManifest = freshDir("tampered-manifest");
    cpSync(good, badManifest, { recursive: true });
    const manifestPath = join(badManifest, "manifest.json");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace("0.1.99", "0.1.98").replace("0.1.99", "0.1.98"),
    );
    expect(() => verifyRelease(badManifest, { publicKeys: [key.pub] })).toThrow(/signature/);

    expect(() => verifyRelease(good, { publicKeys: [other.pub] })).toThrow(
      /does not verify against any release public key/,
    );
    expect(() => verifyRelease(good, { publicKeys: [other.pub, key.pub] })).not.toThrow();
  });

  test("verify rejects the placeholder key and a missing signature", () => {
    const key = newKeyPair();
    const dir = freshDir("signed");
    cpSync(outA, dir, { recursive: true });
    expect(() => verifyRelease(dir, { publicKeys: [key.pub] })).toThrow(/manifest.sig is missing/);
    signManifest({ dir, privateKey: key.priv, publicKeys: [key.pub] });
    expect(() => verifyRelease(dir, { publicKeys: [PLACEHOLDER_KEY] })).toThrow(
      /no usable release public key/,
    );
    expect(() => verifyRelease(dir, { publicKeys: [PLACEHOLDER_KEY, "not a key"] })).toThrow(
      /no usable release public key/,
    );
  });

  test("hash-only verification works without a signature (forks)", () => {
    expect(verifyRelease(outA, { requireSignature: false }).version).toBe("0.1.99");
  });

  test("the CLIs work end to end: keygen, sign, verify", () => {
    const keys = execFileSync("node", [join(SCRIPTS, "release-keygen.mjs")], { encoding: "utf8" })
      .split("\n")
      .filter((line) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(line));
    expect(keys).toHaveLength(2);
    const [pub, priv] = keys;
    const dir = freshDir("cli");
    cpSync(outA, dir, { recursive: true });

    // The signer only signs for a key that is committed in release-key.ts, so a fresh key
    // is refused and no signature is written.
    const refused = spawnSync("node", [join(SCRIPTS, "sign-manifest.mjs"), dir], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_SIGNING_KEY: priv },
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("sign-manifest:");
    expect(existsSync(join(dir, "manifest.sig"))).toBe(false);

    signManifest({ dir, privateKey: priv, publicKeys: [pub] });
    const ok = spawnSync("node", [join(SCRIPTS, "verify-release.mjs"), dir, "--public-key", pub], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("verified 0.1.99");

    const noKey = spawnSync(
      "node",
      [join(SCRIPTS, "verify-release.mjs"), dir, "--public-key", PLACEHOLDER_KEY],
      {
        encoding: "utf8",
      },
    );
    expect(noKey.status).toBe(1);
    const hashOnly = spawnSync(
      "node",
      [join(SCRIPTS, "verify-release.mjs"), outA, "--no-signature"],
      {
        encoding: "utf8",
      },
    );
    expect(hashOnly.status).toBe(0);
    expect(hashOnly.stdout).toContain("signature NOT checked");
  });
});

describe("release keys", () => {
  test("the signer refuses the placeholder, a foreign key and a missing key", () => {
    const key = newKeyPair();
    const other = newKeyPair();
    const dir = freshDir("sign");
    writeRelease(dir, "1.0.1", tgzOf(validEntries("1.0.1")));
    expect(() =>
      signManifest({ dir, privateKey: key.priv, publicKeys: [PLACEHOLDER_KEY] }),
    ).toThrow(/no usable release public key/);
    expect(() => signManifest({ dir, privateKey: key.priv, publicKeys: [other.pub] })).toThrow(
      /does not match any public key/,
    );
    expect(() => signManifest({ dir, privateKey: undefined, publicKeys: [key.pub] })).toThrow(
      /RELEASE_SIGNING_KEY is not set/,
    );
    expect(() => signManifest({ dir, privateKey: "AAAA", publicKeys: [key.pub] })).toThrow(
      /not a base64 PKCS8/,
    );
  });

  test("a release build is refused while only the placeholder is committed", () => {
    expect(() => assertReleaseKeys([PLACEHOLDER_KEY])).toThrow(/no usable release public key/);
    expect(() => assertReleaseKeys([])).toThrow(/no usable release public key/);
    expect(usablePublicKeys([PLACEHOLDER_KEY, "", "AAAA"])).toEqual([]);
    const key = newKeyPair();
    expect(() => assertReleaseKeys([PLACEHOLDER_KEY, key.pub])).not.toThrow();
  });

  test("the committed key file parses and holds an array of strings", () => {
    const keys = readPublicKeys();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
  });

  test("the key array parser handles multi-line arrays and ignores comments", () => {
    const source = [
      "// RELEASE_PUBLIC_KEYS is mentioned in a comment",
      "export const RELEASE_PUBLIC_KEYS: readonly string[] = [",
      '  "first",',
      '  "second",',
      "];",
    ].join("\n");
    expect(parsePublicKeys(source)).toEqual(["first", "second"]);
    expect(() => parsePublicKeys("export const other = [];")).toThrow(/not found/);
  });
});

describe("verify-release on hand-built archives", () => {
  const key = newKeyPair();
  const version = "1.0.7";

  function check(entries) {
    const dir = freshDir("hand");
    writeRelease(dir, version, tgzOf(entries), key);
    return () => verifyRelease(dir, { publicKeys: [key.pub] });
  }

  test("accepts a minimal valid archive", () => {
    expect(check(validEntries(version))().files).toBe(5);
  });

  test("rejects symlinks and hard links", () => {
    const link = tarEntry(`rainforestd-${version}/link`, { type: "2", linkpath: "VERSION" });
    expect(check(validEntries(version, [link]))).toThrow(/link entry/);
    const hard = tarEntry(`rainforestd-${version}/hard`, { type: "1", linkpath: "VERSION" });
    expect(check(validEntries(version, [hard]))).toThrow(/link entry/);
  });

  test("rejects entries outside the top-level directory and unsafe paths", () => {
    expect(check(validEntries(version, [tarEntry("elsewhere/x", { data: "x" })]))).toThrow(
      /outside the top-level/,
    );
    const traversal = tarEntry(`rainforestd-${version}/../evil`, { data: "x" });
    expect(check(validEntries(version, [traversal]))).toThrow(/unsafe path/);
    expect(check(validEntries(version, [tarEntry("/etc/passwd", { data: "x" })]))).toThrow(
      /unsafe path/,
    );
  });

  test("rejects a missing file, a wrong VERSION and a wrong package.json", () => {
    const top = `rainforestd-${version}`;
    expect(check(validEntries(version).slice(1))).toThrow(/missing rainforestd.mjs/);
    const wrongVersion = validEntries(version).map((e, i) =>
      i === 3 ? tarEntry(`${top}/VERSION`, { data: "9.9.9" }) : e,
    );
    expect(check(wrongVersion)).toThrow(/VERSION does not match/);
    const wrongPackage = validEntries(version).map((e, i) =>
      i === 2
        ? tarEntry(`${top}/package.json`, {
            data: JSON.stringify({ name: "rainforestd", version: "9.9.9", type: "module" }),
          })
        : e,
    );
    expect(check(wrongPackage)).toThrow(/package.json does not match/);
  });

  test("rejects a duplicate path and a non-archive", () => {
    const dup = tarEntry(`rainforestd-${version}/VERSION`, { data: version });
    expect(check(validEntries(version, [dup]))).toThrow(/duplicate path/);
    const dir = freshDir("hand");
    writeRelease(dir, version, gzipSync(Buffer.from("this is not a tar archive at all")), key);
    expect(() => verifyRelease(dir, { publicKeys: [key.pub] })).toThrow();
  });

  test("rejects a malformed manifest", () => {
    const dir = freshDir("hand");
    writeRelease(dir, version, tgzOf(validEntries(version)), key);
    writeFileSync(join(dir, "manifest.json"), "{not json");
    expect(() => verifyRelease(dir, { publicKeys: [key.pub] })).toThrow(/not valid JSON/);
    expect(() => verifyRelease(join(dir, "nope"), { publicKeys: [key.pub] })).toThrow(
      /manifest.json is missing/,
    );
  });
});

describe("tar reader", () => {
  test("reads long paths written by the tar package (pax headers)", async () => {
    const dir = freshDir("long");
    const rel = `${"nested-directory-name/".repeat(8)}file.txt`;
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "long path content");
    const file = join(dir, "out.tgz");
    await tar.create({ file, cwd: dir, gzip: true, portable: true }, [rel]);
    const entries = readTgz(readFileSync(file));
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(rel);
    expect(entries[0].data.toString("utf8")).toBe("long path content");
    expect(rel.length).toBeGreaterThan(150);
  });
});
