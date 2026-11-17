import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { guardPendingUpdate, MAX_PENDING_BOOTS } from "../src/launcher.ts";
import { readCurrent, readState, writeCurrent, writeState } from "../src/layout.ts";
import { nullLogger } from "../src/log.ts";
import { versionDir } from "../src/paths.ts";
import { createUpdater, HEALTH_WINDOW_MS } from "../src/updater/index.ts";
import {
  UpdateRejected,
  checkUpgrade,
  readReleaseTarball,
  signatureValid,
  verifyManifest,
  verifyTarball,
} from "../src/updater/verify.ts";
import { fakeExec, tmpPaths } from "./helpers.ts";

// ---- helpers: a throwaway signing key and hand-built release archives

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const other = generateKeyPairSync("ed25519");
const OTHER_PUBLIC = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");

function tarEntry(path: string, data: Buffer, type = "0", linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function tarball(version: string, extra: Buffer[] = [], files?: Record<string, string>): Buffer {
  const top = `rainforestd-${version}`;
  const contents = files ?? {
    "rainforestd.mjs": "console.log('ok')\n",
    "launcher.mjs": "// launcher\n",
    "package.json": JSON.stringify({ name: "rainforestd", version, type: "module" }),
    VERSION: version,
  };
  const entries = Object.entries(contents).map(([name, body]) =>
    tarEntry(`${top}/${name}`, Buffer.from(body)),
  );
  return gzipSync(Buffer.concat([...entries, ...extra, Buffer.alloc(1024)]));
}

function release(version: string, tgz: Buffer = tarball(version), key = privateKey) {
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      version,
      tarball: `rainforestd-${version}.tgz`,
      sha256: createHash("sha256").update(tgz).digest("hex"),
      size: tgz.length,
      min_node: "22.0.0",
      created_at: "2026-01-01T00:00:00.000Z",
      commit: "a".repeat(40),
    }),
  );
  return { manifest, signature: sign(null, manifest, key).toString("base64"), tgz, version };
}

function githubFetch(
  rel: ReturnType<typeof release> | null,
  overrides: Record<string, Buffer> = {},
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) {
      if (!rel) return new Response("not found", { status: 404 });
      const asset = (name: string, body: Buffer) => ({
        name,
        url: `https://api.github.com/assets/${name}`,
        size: body.length,
      });
      return Response.json({
        assets: [
          asset("manifest.json", overrides["manifest.json"] ?? rel.manifest),
          asset("manifest.sig", Buffer.from(rel.signature)),
          asset(`rainforestd-${rel.version}.tgz`, overrides.tgz ?? rel.tgz),
        ],
      });
    }
    if (!rel) return new Response("not found", { status: 404 });
    if (url.endsWith("/manifest.json"))
      return new Response(new Uint8Array(overrides["manifest.json"] ?? rel.manifest));
    if (url.endsWith("/manifest.sig")) return new Response(rel.signature);
    if (url.endsWith(".tgz")) return new Response(new Uint8Array(overrides.tgz ?? rel.tgz));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const config = parseConfig({
  hub_url: "https://hub.example.com",
  device_id: "device-0001",
  device_name: "test",
  chrome: { profile_directory: "Default", extension_id: "a".repeat(32) },
  update: { repo: "example/rainforest" },
});

function setup(current = "0.1.5") {
  const paths = tmpPaths();
  mkdirSync(versionDir(paths, current), { recursive: true });
  writeCurrent(paths, current);
  const restarts: string[] = [];
  let healthy = false;
  const timers: { fn: () => void; ms: number }[] = [];
  let clock = 1_000_000;
  const exec = fakeExec();
  const make = (
    rel: ReturnType<typeof release> | null,
    version = current,
    overrides: Record<string, Buffer> = {},
    execReply?: () => { code: number },
  ) =>
    createUpdater({
      config,
      paths,
      log: nullLogger(),
      exec: execReply ? fakeExec(execReply).exec : exec.exec,
      version,
      requestRestart: (reason) => restarts.push(reason),
      isHealthy: () => healthy,
      fetchFn: githubFetch(rel, overrides),
      publicKeys: [PUBLIC],
      nodeVersion: "v26.0.0",
      now: () => clock,
      setTimer: (fn, ms) => {
        const entry = { fn, ms };
        timers.push(entry);
        return { cancel: () => timers.splice(timers.indexOf(entry), 1) };
      },
    });
  return {
    paths,
    restarts,
    timers,
    exec,
    make,
    setHealthy: (v: boolean) => (healthy = v),
    advance: (ms: number) => (clock += ms),
  };
}

describe("manifest verification", () => {
  test("accepts a correctly signed manifest", () => {
    const rel = release("0.1.9");
    expect(verifyManifest(rel.manifest, rel.signature, [PUBLIC]).version).toBe("0.1.9");
    expect(
      verifyManifest(rel.manifest, rel.signature, ["REPLACE_WITH_PUBLIC_KEY", PUBLIC]).version,
    ).toBe("0.1.9");
  });

  test("rejects a tampered manifest, a wrong key, a placeholder key and no keys", () => {
    const rel = release("0.1.9");
    const tampered = Buffer.from(rel.manifest.toString().replace("0.1.9", "0.1.8"));
    expect(() => verifyManifest(tampered, rel.signature, [PUBLIC])).toThrow(UpdateRejected);
    expect(() => verifyManifest(rel.manifest, rel.signature, [OTHER_PUBLIC])).toThrow(/signature/);
    expect(() => verifyManifest(rel.manifest, rel.signature, ["REPLACE_WITH_PUBLIC_KEY"])).toThrow(
      /signature/,
    );
    expect(() => verifyManifest(rel.manifest, rel.signature, [])).toThrow(/no release keys/);
    expect(() => verifyManifest(rel.manifest, "", [PUBLIC])).toThrow(UpdateRejected);
    expect(signatureValid(rel.manifest, "not base64 at all", [PUBLIC])).toBe(false);
  });

  test("a validly signed manifest with a mismatched tarball name is rejected", () => {
    const body = Buffer.from(
      JSON.stringify({
        schema: 1,
        version: "0.1.9",
        tarball: "rainforestd-9.9.9.tgz",
        sha256: "a".repeat(64),
        size: 10,
        min_node: "22.0.0",
        created_at: "x",
        commit: "a".repeat(40),
      }),
    );
    expect(() =>
      verifyManifest(body, sign(null, body, privateKey).toString("base64"), [PUBLIC]),
    ).toThrow(/tarball name/);
  });

  test("refuses downgrades, equal versions, bad versions and an old Node", () => {
    const manifest = verifyManifest(release("0.1.9").manifest, release("0.1.9").signature, [
      PUBLIC,
    ]);
    expect(() => checkUpgrade(manifest, "0.1.9", "v26.0.0", [])).toThrow(/not newer/);
    expect(() => checkUpgrade(manifest, "0.1.10", "v26.0.0", [])).toThrow(/not newer/);
    expect(() => checkUpgrade(manifest, "0.1.8", "v26.0.0", ["0.1.9"])).toThrow(/failed before/);
    expect(() => checkUpgrade(manifest, "0.1.8", "v20.1.0", [])).toThrow(/needs Node/);
    expect(() => checkUpgrade(manifest, "0.1.8", "v26.0.0", [])).not.toThrow();
  });
});

describe("tarball verification", () => {
  test("rejects a tampered tarball and a size mismatch", () => {
    const rel = release("0.1.9");
    const manifest = verifyManifest(rel.manifest, rel.signature, [PUBLIC]);
    expect(() => verifyTarball(rel.tgz, manifest)).not.toThrow();
    const flipped = Buffer.from(rel.tgz);
    flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 0xff;
    expect(() => verifyTarball(flipped, manifest)).toThrow(/hash/);
    expect(() => verifyTarball(Buffer.concat([rel.tgz, Buffer.from([0])]), manifest)).toThrow(
      /size/,
    );
  });

  test("rejects links, traversal, absolute paths, foreign top-level entries and duplicates", () => {
    const top = "rainforestd-0.1.9";
    const cases: Buffer[][] = [
      [tarEntry(`${top}/evil`, Buffer.alloc(0), "2", "/etc/passwd")],
      [tarEntry(`${top}/hard`, Buffer.alloc(0), "1", `${top}/VERSION`)],
      [tarEntry(`${top}/../outside`, Buffer.from("x"))],
      [tarEntry("/abs/file", Buffer.from("x"))],
      [tarEntry("other-top/file", Buffer.from("x"))],
      [tarEntry(`${top}/a\\b`, Buffer.from("x"))],
      [tarEntry(`${top}/VERSION`, Buffer.from("0.1.9"))],
      [tarEntry("C:/windows/file", Buffer.from("x"))],
    ];
    for (const extra of cases) {
      expect(() => readReleaseTarball(tarball("0.1.9", extra), top)).toThrow(UpdateRejected);
    }
    expect(() => readReleaseTarball(Buffer.from("not gzip"), top)).toThrow(/gzip/);
    expect(() => readReleaseTarball(tarball("0.1.9", [], { "rainforestd.mjs": "x" }), top)).toThrow(
      /missing/,
    );
    expect(
      readReleaseTarball(tarball("0.1.9"), top)
        .map((f) => f.path)
        .sort(),
    ).toEqual(["VERSION", "launcher.mjs", "package.json", "rainforestd.mjs"].sort());
  });
});

describe("updater", () => {
  test("applies a newer signed release: stages, selftests, switches the pointer and records pending", async () => {
    const s = setup();
    const outcome = await s.make(release("0.1.9")).checkNow("manual");
    expect(outcome).toEqual({
      status: "updated",
      from: "0.1.5",
      to: "0.1.9",
      restart_required: true,
    });
    expect(readCurrent(s.paths)).toBe("0.1.9");
    expect(readFileSync(join(versionDir(s.paths, "0.1.9"), "VERSION"), "utf8")).toBe("0.1.9");
    expect(readState(s.paths).pending).toMatchObject({
      version: "0.1.9",
      previous: "0.1.5",
      boots: 0,
    });
    expect(s.exec.calls.some((c) => c.args.includes("selftest"))).toBe(true);
  });

  test("up to date when there is no release, the same version or an older one", async () => {
    const s = setup();
    expect(await s.make(null).checkNow("manual")).toEqual({
      status: "up_to_date",
      version: "0.1.5",
    });
    expect(await s.make(release("0.1.5")).checkNow("manual")).toEqual({
      status: "up_to_date",
      version: "0.1.5",
    });
    expect(await s.make(release("0.1.4")).checkNow("manual")).toEqual({
      status: "up_to_date",
      version: "0.1.5",
    });
    expect(readCurrent(s.paths)).toBe("0.1.5");
  });

  test("a tampered manifest, a tampered tarball and a foreign signature change nothing", async () => {
    const good = release("0.1.9");
    const tamperedManifest = Buffer.from(good.manifest.toString().replace('"size":', '"size" :'));
    const flipped = Buffer.from(good.tgz);
    flipped[100] = flipped[100]! ^ 0xff;
    const attempts = [
      setup().make(good, "0.1.5", { "manifest.json": tamperedManifest }),
      setup().make(good, "0.1.5", { tgz: flipped }),
      setup().make(release("0.1.9", tarball("0.1.9"), other.privateKey)),
    ];
    for (const updater of attempts) {
      const outcome = await updater.checkNow("manual");
      expect(outcome.status).toBe("failed");
    }
    const s = setup();
    await s.make(good, "0.1.5", { tgz: flipped }).checkNow("manual");
    expect(readCurrent(s.paths)).toBe("0.1.5");
    expect(existsSync(versionDir(s.paths, "0.1.9"))).toBe(false);
    expect(readState(s.paths).pending).toBeUndefined();
  });

  test("a failing selftest never switches and marks the version bad", async () => {
    const s = setup();
    const outcome = await s
      .make(release("0.1.9"), "0.1.5", {}, () => ({ code: 1 }))
      .checkNow("manual");
    expect(outcome.status).toBe("failed");
    expect(readCurrent(s.paths)).toBe("0.1.5");
    expect(Object.keys(readState(s.paths).bad_versions)).toEqual(["0.1.9"]);
    expect((await s.make(release("0.1.9")).checkNow("manual")).status).toBe("failed");
  });

  test("health check: confirms when connected, rolls back and marks bad when not", () => {
    const s = setup("0.1.9");
    mkdirSync(versionDir(s.paths, "0.1.5"), { recursive: true });
    writeState(s.paths, {
      bad_versions: {},
      pending: { version: "0.1.9", previous: "0.1.5", since: 1, boots: 1 },
    });
    const updater = s.make(null, "0.1.9");
    s.setHealthy(true);
    expect(updater.confirmOrRollback()).toBe("confirmed");
    expect(readState(s.paths).pending).toBeUndefined();
    expect(readCurrent(s.paths)).toBe("0.1.9");

    writeState(s.paths, {
      bad_versions: {},
      pending: { version: "0.1.9", previous: "0.1.5", since: 1, boots: 1 },
    });
    s.setHealthy(false);
    expect(updater.confirmOrRollback()).toBe("rolled_back");
    expect(readCurrent(s.paths)).toBe("0.1.5");
    expect(Object.keys(readState(s.paths).bad_versions)).toEqual(["0.1.9"]);
    expect(s.restarts).toEqual(["rollback to 0.1.5"]);
  });

  test("start() waits for health and rolls back once the window passes", () => {
    const s = setup("0.1.9");
    mkdirSync(versionDir(s.paths, "0.1.5"), { recursive: true });
    writeState(s.paths, {
      bad_versions: {},
      pending: { version: "0.1.9", previous: "0.1.5", since: 1, boots: 1 },
    });
    const updater = s.make(null, "0.1.9");
    updater.start();
    const healthTimer = () => s.timers.find((t) => t.ms === 2000)!;
    healthTimer().fn();
    expect(readCurrent(s.paths)).toBe("0.1.9");
    s.advance(HEALTH_WINDOW_MS + 1);
    healthTimer().fn();
    expect(readCurrent(s.paths)).toBe("0.1.5");
    updater.stop();
  });

  test("a pending entry for another version is left alone", () => {
    const s = setup("0.1.9");
    writeState(s.paths, {
      bad_versions: {},
      pending: { version: "0.2.0", previous: "0.1.9", since: 1, boots: 0 },
    });
    expect(s.make(null, "0.1.9").confirmOrRollback()).toBe("none");
  });
});

describe("launcher rollback guard", () => {
  test("counts boots of a pending version, then restores the previous one", () => {
    const paths = tmpPaths();
    mkdirSync(versionDir(paths, "0.1.5"), { recursive: true });
    mkdirSync(versionDir(paths, "0.1.9"), { recursive: true });
    writeCurrent(paths, "0.1.9");
    writeState(paths, {
      bad_versions: {},
      pending: { version: "0.1.9", previous: "0.1.5", since: 1, boots: 0 },
    });
    for (let i = 1; i <= MAX_PENDING_BOOTS; i++) {
      expect(guardPendingUpdate(paths.root)).toBeNull();
      expect(readState(paths).pending?.boots).toBe(i);
    }
    expect(guardPendingUpdate(paths.root)).toBe("0.1.9");
    expect(readCurrent(paths)).toBe("0.1.5");
    expect(readState(paths).pending).toBeUndefined();
    expect(Object.keys(readState(paths).bad_versions)).toEqual(["0.1.9"]);
  });

  test("does nothing without a pending update or with a corrupt state file", () => {
    const paths = tmpPaths();
    mkdirSync(versionDir(paths, "0.1.5"), { recursive: true });
    writeCurrent(paths, "0.1.5");
    expect(guardPendingUpdate(paths.root)).toBeNull();
    writeFileSync(paths.stateFile, "{not json");
    expect(guardPendingUpdate(paths.root)).toBeNull();
    expect(readCurrent(paths)).toBe("0.1.5");
  });
});
