// compress.mjs <dir>: writes beside each text file and model of the build a
// Brotli (.br) and a gzip (.gz) copy, which the server sends to a browser
// that accepts them. Node's zlib only: no other tool in the build.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: compress.mjs <dir>');
  process.exit(1);
}
const exts = new Set(['.html', '.js', '.css', '.svg', '.json', '.glb', '.txt']);
let saved = 0;
function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    const ext = name.slice(name.lastIndexOf('.'));
    if (!exts.has(ext)) {
      continue;
    }
    const raw = readFileSync(p);
    if (raw.length < 1024) {
      continue;
    }
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    const gz = gzipSync(raw, { level: 9 });
    // A copy that saves nothing is left out: the server sends the file.
    if (br.length < raw.length) {
      writeFileSync(p + '.br', br);
    }
    if (gz.length < raw.length) {
      writeFileSync(p + '.gz', gz);
    }
    saved += raw.length - Math.min(br.length, raw.length);
  }
}
walk(dir);
console.log(`compress.mjs: ${Math.round(saved / 1024)} KiB less with Brotli`);
