// licenses.mjs <out>: the licenses of the packages the page bundles (the
// dependencies of package-lock.json, not the tools of the build), copied to
// <out>/<package>/ and listed in <out>/INDEX, one per line: name, version,
// license and the files, comma-separated, apart by tabs. A package without
// a license file stops the build.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: licenses.mjs <out>');
  process.exit(1);
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const lines = [];
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
  if (path === '' || pkg.dev === true || !path.startsWith('node_modules/')) {
    continue;
  }
  const name = path.slice('node_modules/'.length).replace(/.*node_modules\//, '');
  const files = readdirSync(path).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  if (files.length === 0) {
    console.error(`licenses.mjs: no license file in ${name} ${pkg.version}`);
    process.exit(1);
  }
  const dest = join(out, name);
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    copyFileSync(join(path, f), join(dest, f));
  }
  lines.push([name, pkg.version, pkg.license ?? 'see the files', files.join(',')].join('\t'));
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'INDEX'), lines.sort().join('\n') + '\n');
console.log(`licenses.mjs: ${lines.length} packages`);
