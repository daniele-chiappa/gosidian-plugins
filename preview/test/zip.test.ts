// The zip of a publish: a good one unpacked with the plugin's modes; the
// malicious ones refused before a byte is written, or while inflating when
// they lie about their sizes, each with why.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_TYPES } from "../src/preset.ts";
import { nameError, unpack, ZipError, type ZipRules } from "../src/zip.ts";
import { site, tmp, zip, type ZEntry } from "./helpers.ts";

const rules: ZipRules = { max_files: 20, max_bytes: 4 << 20, max_ratio: 100, max_depth: 4, types: DEFAULT_TYPES, index: "index.html", room: 64 << 20 };

async function tryUnpack(entries: ZEntry[] | Buffer, more: Partial<ZipRules> = {}): Promise<{ dest: string; result?: Awaited<ReturnType<typeof unpack>>; error?: Error }> {
  const dir = tmp("preview-zip-");
  const file = path.join(dir, "site.zip");
  fs.writeFileSync(file, Buffer.isBuffer(entries) ? entries : zip(entries));
  const dest = path.join(dir, "site");
  try {
    return { dest, result: await unpack(file, dest, { ...rules, ...more }) };
  } catch (e) {
    return { dest, error: e as Error };
  }
}

async function refused(entries: ZEntry[] | Buffer, why: RegExp, more: Partial<ZipRules> = {}, written = false): Promise<void> {
  const r = await tryUnpack(entries, more);
  assert.ok(r.error, `not refused: ${JSON.stringify(r.result)}`);
  assert.ok(r.error instanceof ZipError, `not a ZipError: ${r.error.stack}`);
  assert.match(r.error.message, why);
  // Refused before a byte is written, but for the lies only inflating finds.
  if (!written) assert.equal(fs.existsSync(r.dest), false, "the folder was made");
}

test("a good zip: files and folders, the plugin's modes, the bytes counted", async () => {
  const r = await tryUnpack(site([{ name: "run.js", data: "x", mode: 0o104755 }]));
  assert.ifError(r.error);
  const want = site([{ name: "run.js", data: "x" }]).reduce((n, e) => n + Buffer.byteLength(e.data ?? ""), 0);
  assert.deepEqual(r.result, { files: 4, bytes: want });
  assert.equal(fs.readFileSync(path.join(r.dest, "assets/data.json"), "utf8"), '{"giorni": 3}\n');
  // setuid and exec bits of the zip are not kept.
  assert.equal(fs.statSync(path.join(r.dest, "run.js")).mode & 0o7777, 0o644);
  assert.equal(fs.statSync(path.join(r.dest, "assets")).mode & 0o7777, 0o755);
});

test("names: traversal, absolute, backslashes, control characters", async () => {
  await refused(site([{ name: "../evil.html", data: "x" }]), /outside its folder.*invalid relative path/);
  await refused(site([{ name: "assets/../../evil.js", data: "x" }]), /outside its folder/);
  await refused(site([{ name: "/etc/evil.js", data: "x" }]), /outside its folder.*absolute path/);
  await refused(site([{ name: "C:/evil.js", data: "x" }]), /absolute path/);
  await refused(site([{ name: "..\\evil.js", data: "x" }]), /outside its folder.*invalid characters/);
  await refused(site([{ name: "a\u0000b.js", data: "x" }]), /control character/);
  await refused(site([{ name: "a//b.js", data: "x" }]), /empty or \. part/);
  await refused(site([{ name: "./a.js", data: "x" }]), /empty or \. part/);
  assert.equal(nameError("a/b/c.html"), "");
  assert.equal(nameError("x".repeat(300) + ".js"), "a part of the path longer than 255 bytes");
});

test("links, devices and odd entries", async () => {
  await refused(site([{ name: "passwd.txt", data: "/etc/passwd", mode: 0o120777, method: 0 }]), /passwd\.txt: a symbolic link/);
  await refused(site([{ name: "tty.txt", data: "", mode: 0o020644 }]), /tty\.txt: a device or a special file/);
  await refused(site([{ name: "fifo.txt", data: "", mode: 0o010644 }]), /a device or a special file/);
  await refused(site([{ name: "weird.txt", data: "", mode: 0o040755 }]), /a folder whose name does not end with \//);
  await refused(site([{ name: "app.js", data: "again" }]), /app\.js: twice/);
  await refused(site([{ name: "app.js/", mode: 0o040755 }]), /app\.js: twice|both a file and a folder/);
  await refused(site([{ name: "app.js/x.js", data: "x" }]), /app\.js: both a file and a folder/);
});

test("encrypted entries and other compression methods", async () => {
  await refused(site([{ name: "secret.txt", data: "x", flags: 1 }]), /secret\.txt: encrypted/);
  await refused(site([{ name: "b.txt", data: "x", method: 12 }]), /b\.txt: compressed with a method the plugin does not read \(12\)/);
  await refused(Buffer.from("not a zip at all, nothing of it"), /site is not a zip file/);
});

test("a zip bomb: the ratio, of an entry and of the archive", async () => {
  // 8 MiB of zeros deflate to about 8 KiB: a ratio near 1000.
  const zeros = Buffer.alloc(8 << 20);
  await refused(site([{ name: "zeros.txt", data: zeros }]), /zeros\.txt: compressed more than 100 times/, { max_bytes: 64 << 20 });
  // Many small entries, none over 1 MiB, the archive's ratio over the max.
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `z${i}.txt`, data: Buffer.alloc(1 << 19) }));
  await refused(site(many), /unpacks to more than 100 times its size/, { max_bytes: 64 << 20, max_files: 100 });
  // A larger max lets the same through.
  const r = await tryUnpack(site([{ name: "zeros.txt", data: Buffer.alloc(2 << 20) }]), { max_ratio: 5000 });
  assert.ifError(r.error);
});

test("too many files, too deep, too big as declared", async () => {
  await refused(site(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))), /33 files, more than 20/);
  await refused(site(Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))), /the zip has 204 entries, more than 20 files/);
  await refused(site([{ name: "a/b/c/d/e/deep.txt", data: "x" }]), /deep\.txt: more than 4 folders deep/);
  await refused(site([{ name: "a/b/c/d/e/", mode: 0o040755 }]), /more than 4 folders deep/);
  const big = crypto.randomBytes(1 << 20);
  await refused(site([{ name: "big.txt", data: big, method: 0 }]), /1 MiB once unpacked, more than 512 KiB/, { max_bytes: 512 << 10 });
  await refused(site([{ name: "big.txt", data: big, method: 0 }]), /the store has 256 KiB left/, { room: 256 << 10 });
});

test("sizes that lie: the bytes counted while inflating", async () => {
  // Declares 10 bytes, inflates to 1 MiB: yauzl stops it, the folder is
  // there, half made (the caller removes it).
  await refused(site([{ name: "liar.txt", data: Buffer.alloc(1 << 20, 97), declaredSize: 10 }]), /real size is not the size the zip declares/, {}, true);
  // Declares more than it has.
  await refused(site([{ name: "short.txt", data: "abc", declaredSize: 1000 }]), /real size is not the size the zip declares|bytes came out/, {}, true);
  // Stored, with sizes that differ: yauzl refuses the entry at once.
  await refused(site([{ name: "stored.txt", data: "abc", method: 0, declaredSize: 5 }]), /cannot be read|real size/);
});

test("types: what the preset does not serve, named", async () => {
  await refused(site([{ name: "tool.exe", data: "MZ" }, { name: "Makefile", data: "all:" }, { name: ".nojekyll", data: "" }]), /types the preset does not serve: tool\.exe \(\.exe\), Makefile \(no extension\), \.nojekyll \(no extension\)/);
  const r = await tryUnpack(site([{ name: "doc.pdf", data: "%PDF" }]), { types: { ...DEFAULT_TYPES, pdf: "application/pdf" } });
  assert.ifError(r.error);
});

test("the index: at the root, or named", async () => {
  await refused([{ name: "app.js", data: "x" }], /no index\.html at its root/);
  await refused([{ name: "dist/", mode: 0o040755 }, { name: "dist/index.html", data: "x" }], /no index\.html at its root \(it has dist\/index\.html\): zip the build's files, not its folder/);
  const r = await tryUnpack([{ name: "app.html", data: "<p>x</p>" }], { index: "app.html" });
  assert.ifError(r.error);
});

test("deflate data that is not deflate", async () => {
  const z = zip(site([{ name: "broken.txt", data: "hello world, hello world" }]));
  // Spoil the deflated bytes of the last entry: zlib fails, the error says so.
  const at = z.indexOf(Buffer.from("broken.txt")) + "broken.txt".length;
  z.fill(0xff, at, at + 6);
  const r = await tryUnpack(z);
  assert.ok(r.error instanceof ZipError, String(r.error));
  assert.match(r.error.message, /cannot be read|real size/);
});
