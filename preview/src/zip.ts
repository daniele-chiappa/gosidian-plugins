// A preview's zip, read with yauzl and checked before a byte is written:
// its names (no absolute paths, no .., no backslashes, no control
// characters), its entries (regular files and folders only: no links, no
// devices, nothing encrypted), its count, its sizes, its compression ratio,
// its depth, its types, its index. Then unpacked, the bytes counted as they
// come out of the inflater, into a folder of the plugin's: the files with
// modes of the plugin's, never the zip's.
import fs from "node:fs";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { formatBytes } from "./preset.ts";

export class ZipError extends Error {}

export interface ZipRules {
  max_files: number;
  max_bytes: number;
  max_ratio: number;
  max_depth: number;
  types: Record<string, string>;
  // index is the file served at the preview's root; it must be in the zip.
  index: string;
  // room is what the store has left, in bytes.
  room: number;
}

export interface Unpacked {
  files: number;
  bytes: number;
}

// An entry larger than this has its own ratio checked; a small file's says
// nothing (100 KB of spaces is no bomb).
const RATIO_MIN_BYTES = 1 << 20;
const MAX_NAME = 1024;
const MAX_SEGMENT = 255;

// The type of a Unix mode, in an entry's external attributes.
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// nameError says why an entry's name is refused, or "".
export function nameError(name: string): string {
  if (name.length > MAX_NAME) return "a name longer than 1024 characters";
  if (/[\x00-\x1f\x7f]/.test(name)) return "a control character in the name";
  if (name.includes("\\")) return "a backslash in the name";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an absolute path";
  const parts = name.replace(/\/$/, "").split("/");
  for (const p of parts) {
    if (p === "..") return "a .. in the path";
    if (p === "" || p === ".") return "an empty or . part in the path";
    if (Buffer.byteLength(p) > MAX_SEGMENT) return "a part of the path longer than 255 bytes";
  }
  return "";
}

// extOf is a file's extension, lower case, without the dot; "" for none
// (a name like .nojekyll has none).
export function extOf(name: string): string {
  return path.posix.extname(name).slice(1).toLowerCase();
}

// typeOf is the Content-Type of a name under the types, or "".
export function typeOf(name: string, types: Record<string, string>): string {
  const ext = extOf(name);
  return ext && Object.hasOwn(types, ext) ? types[ext] : "";
}

function list(names: string[], n = 10): string {
  return names.length > n ? `${names.slice(0, n).join(", ")} and ${names.length - n} more` : names.join(", ");
}

// what reads yauzl's errors as a person would.
function yauzlError(e: Error): ZipError {
  const m = e.message;
  if (/end of central directory record signature not found/i.test(m)) return new ZipError("site is not a zip file");
  if (/invalid relative path|absolute path|invalid characters in fileName/.test(m)) return new ZipError(`the zip has an entry outside its folder (${m})`);
  if (/too many bytes|not enough bytes/.test(m)) return new ZipError(`an entry's real size is not the size the zip declares (${m})`);
  return new ZipError(`the zip cannot be read: ${m}`);
}

// count lets bytes through until the total passes max; then it fails.
class Counter extends Transform {
  n = 0;
  private readonly max: number;
  private readonly total: { n: number };
  private readonly name: string;
  constructor(total: { n: number }, max: number, name: string) {
    super();
    this.total = total;
    this.max = max;
    this.name = name;
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.n += chunk.length;
    this.total.n += chunk.length;
    if (this.total.n > this.max) return cb(new ZipError(`more than ${formatBytes(this.max)} once unpacked (at ${this.name}): limits.max_bytes`));
    cb(null, chunk);
  }
}

// unpack checks the zip at file against the rules and unpacks it into dest,
// a folder that does not exist yet. On an error, dest may hold part of it:
// the caller removes it.
export async function unpack(file: string, dest: string, rules: ZipRules): Promise<Unpacked> {
  const zipBytes = fs.statSync(file).size;
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true });
  } catch (e) {
    throw yauzlError(e as Error);
  }
  try {
    // Before a single entry is read: a central directory of a million
    // entries is refused at once. Folders are entries too.
    if (zip.entryCount > 2 * rules.max_files + 64) throw new ZipError(`the zip has ${zip.entryCount} entries, more than ${rules.max_files} files (limits.max_files)`);
    const entries: yauzl.Entry[] = [];
    try {
      for await (const e of zip.eachEntry()) entries.push(e);
    } catch (e) {
      throw e instanceof ZipError ? e : yauzlError(e as Error);
    }

    // Every check, on every entry, before a byte is written.
    const files: yauzl.Entry[] = [];
    const dirs = new Set<string>();
    const seen = new Set<string>();
    const badTypes: string[] = [];
    let declared = 0;
    for (const e of entries) {
      const name = e.fileName;
      const why = nameError(name);
      if (why) throw new ZipError(`${JSON.stringify(name)}: ${why}`);
      const isDir = name.endsWith("/");
      const mode = (e.externalFileAttributes >>> 16) & S_IFMT;
      if (mode === S_IFLNK) throw new ZipError(`${name}: a symbolic link; the zip may hold files and folders only`);
      if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) throw new ZipError(`${name}: a device or a special file (mode ${(mode >>> 12).toString(8)}); the zip may hold files and folders only`);
      if (mode === S_IFDIR && !isDir) throw new ZipError(`${name}: a folder whose name does not end with /`);
      if (e.isEncrypted()) throw new ZipError(`${name}: encrypted; the zip's entries must not be`);
      const key = name.replace(/\/$/, "");
      if (seen.has(key)) throw new ZipError(`${key}: twice in the zip`);
      seen.add(key);
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      if (isDir) {
        if (parts.length > rules.max_depth) throw new ZipError(`${name}: more than ${rules.max_depth} folders deep (limits.max_depth)`);
        dirs.add(key);
        continue;
      }
      if (parts.length - 1 > rules.max_depth) throw new ZipError(`${name}: more than ${rules.max_depth} folders deep (limits.max_depth)`);
      if (!e.canDecodeFileData()) throw new ZipError(`${name}: compressed with a method the plugin does not read (${e.compressionMethod}); store or deflate`);
      if (!typeOf(name, rules.types)) badTypes.push(extOf(name) ? `${name} (.${extOf(name)})` : `${name} (no extension)`);
      if (e.uncompressedSize > RATIO_MIN_BYTES && e.uncompressedSize > rules.max_ratio * Math.max(e.compressedSize, 1)) {
        throw new ZipError(`${name}: compressed more than ${rules.max_ratio} times (limits.max_ratio): a zip bomb?`);
      }
      declared += e.uncompressedSize;
      files.push(e);
    }
    if (files.length > rules.max_files) throw new ZipError(`the zip has ${files.length} files, more than ${rules.max_files} (limits.max_files)`);
    for (const f of files) {
      if (dirs.has(f.fileName)) throw new ZipError(`${f.fileName}: both a file and a folder in the zip`);
    }
    if (badTypes.length) {
      throw new ZipError(`files of types the preset does not serve: ${list(badTypes)}; the preset's types: ${Object.keys(rules.types).sort().join(", ")}`);
    }
    if (!files.some((f) => f.fileName === rules.index)) {
      const top = files.filter((f) => !f.fileName.includes("/") || /\/index\.html?$/.test(f.fileName)).map((f) => f.fileName).slice(0, 5);
      throw new ZipError(`the zip has no ${rules.index} at its root${top.length ? ` (it has ${list(top, 5)})` : ""}: zip the build's files, not its folder`);
    }
    if (declared > rules.max_bytes) throw new ZipError(`${formatBytes(declared)} once unpacked, more than ${formatBytes(rules.max_bytes)} (limits.max_bytes)`);
    if (declared > rules.max_ratio * Math.max(zipBytes, 1)) throw new ZipError(`the zip unpacks to more than ${rules.max_ratio} times its size (limits.max_ratio): a zip bomb?`);
    if (declared > rules.room) throw new ZipError(`the store has ${formatBytes(Math.max(rules.room, 0))} left, the zip unpacks to ${formatBytes(declared)} (limits.max_total_bytes)`);

    // Unpacked: the folders, then each file, new (wx) and not through a link.
    fs.mkdirSync(dest, { mode: 0o755 });
    for (const d of [...dirs].sort()) fs.mkdirSync(path.join(dest, d), { mode: 0o755, recursive: true });
    const total = { n: 0 };
    const max = Math.min(rules.max_bytes, rules.room);
    for (const f of files) {
      const target = path.join(dest, f.fileName);
      const rel = path.relative(dest, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ZipError(`${f.fileName}: outside the preview's folder`);
      let src;
      try {
        src = await zip.openReadStreamPromise(f);
      } catch (e) {
        throw yauzlError(e as Error);
      }
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      const counter = new Counter(total, max, f.fileName);
      try {
        await pipeline(src, counter, fs.createWriteStream("", { fd }));
      } catch (e) {
        throw e instanceof ZipError ? e : yauzlError(e as Error);
      }
      if (counter.n !== f.uncompressedSize) throw new ZipError(`${f.fileName}: ${counter.n} bytes came out, the zip declares ${f.uncompressedSize}`);
    }
    return { files: files.length, bytes: total.n };
  } finally {
    zip.close();
  }
}
