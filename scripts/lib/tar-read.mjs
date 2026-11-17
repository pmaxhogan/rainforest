// Minimal, dependency-free reader for the tar archives this repo produces (ustar plus pax
// extended headers and GNU long names). Used by verify-release so the verification step does
// not need node_modules. Reads the whole archive into memory; release tarballs are small.
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

function cString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function octal(buf, start, len) {
  const text = cString(buf, start, len).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(pos, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, pos + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += length;
  }
  return out;
}

/** Entry types: "file", "directory", "symlink", "hardlink", "other". */
function typeName(flag) {
  switch (flag) {
    case "0":
    case "\0":
      return "file";
    case "5":
      return "directory";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      return "other";
  }
}

/** Parse an uncompressed tar buffer into `{ path, type, size, mode, linkpath, data }` entries. */
export function readTar(tar) {
  const entries = [];
  let pos = 0;
  let pendingPath = null;
  let pendingPax = {};
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] ?? 0);
    const dataStart = pos + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "x") {
      pendingPax = { ...pendingPax, ...parsePax(data) };
      continue;
    }
    if (flag === "g") continue;
    if (flag === "L") {
      pendingPath = cString(data, 0, data.length);
      continue;
    }
    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    const raw = pendingPax.path ?? pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    entries.push({
      path: raw.replaceAll("\\", "/"),
      type: typeName(flag),
      size,
      mode: octal(header, 100, 8),
      linkpath: cString(header, 157, 100),
      data,
    });
    pendingPath = null;
    pendingPax = {};
  }
  return entries;
}

export function readTgz(tgz) {
  return readTar(gunzipSync(tgz));
}
