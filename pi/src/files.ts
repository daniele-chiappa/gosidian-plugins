// The files of a step: those gosidian hands by reference, fetched into the
// workspace's in/ and checked against their size and SHA-256, and those the
// agent writes in out/, given back to gosidian as attachments.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface FileRef {
  name?: string;
  size?: number;
  sha256?: string;
  url?: string;
}

export class StepError extends Error {}

// safeName keeps a file name a plain name: no folders, no dots in front.
export function safeName(name: string, fallback: string): string {
  const base = path.basename(String(name ?? "").replaceAll("\\", "/")).replace(/[\x00-\x1f/]/g, "").replace(/^\.+/, "");
  return base.slice(0, 200) || fallback;
}

// refsOf reads the files setting as gosidian hands it: one reference or a list.
export function refsOf(v: unknown): FileRef[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((f, i) => {
    if (!f || typeof f !== "object" || typeof (f as FileRef).url !== "string") {
      throw new StepError(`files[${i}] is not a file gosidian handed by reference (a plugin with file_refs gets {name, size, sha256, url})`);
    }
    return f as FileRef;
  });
}

// fetchAll fetches the files into dir, each under a name of its own, within
// maxBytes together; it returns the names, in order.
export async function fetchAll(refs: FileRef[], dir: string, maxBytes: number, signal: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const [i, f] of refs.entries()) {
    let name = safeName(f.name ?? "", `file-${i + 1}`);
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const ext = path.extname(name);
      name = `${path.basename(safeName(f.name ?? "", `file-${i + 1}`), ext)}-${n}${ext}`;
    }
    used.add(name.toLowerCase());
    if (!/^https?:\/\//.test(f.url!)) throw new StepError(`${name}: its url is not an http(s) address`);
    if ((f.size ?? 0) + total > maxBytes) throw new StepError(`${name}: the files are more than ${maxBytes >> 20} MiB together (PI_MAX_FILES_BYTES)`);
    const r = await fetch(f.url!, { signal, redirect: "error" });
    if (r.status !== 200 || !r.body) throw new StepError(`${name}: fetching it answered ${r.status}`);
    const h = crypto.createHash("sha256");
    const out = fs.createWriteStream(path.join(dir, name), { mode: 0o644 });
    let got = 0;
    try {
      for await (const chunk of r.body) {
        got += chunk.length;
        if (got + total > maxBytes) throw new StepError(`${name}: the files are more than ${maxBytes >> 20} MiB together (PI_MAX_FILES_BYTES)`);
        h.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      }
    } finally {
      await new Promise<void>((ok) => out.end(() => ok()));
    }
    if (f.size !== undefined && got !== f.size) throw new StepError(`${name}: ${got} bytes came, gosidian said ${f.size}`);
    if (f.sha256 && h.digest("hex") !== f.sha256.toLowerCase()) throw new StepError(`${name}: what came is not the file gosidian named (its SHA-256 differs)`);
    total += got;
    names.push(name);
  }
  return names;
}

export interface OutFile {
  name: string;
  mime: string;
  data: Buffer;
}

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv",
  ".html": "text/html", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// collect reads the files the agent wrote in dir (its folders flattened
// into the names: a/b.md is a-b.md), at most maxFiles and maxBytes; the
// rest is skipped, with why.
export function collect(dir: string, maxFiles: number, maxBytes: number): { files: OutFile[]; skipped: { name: string; error: string }[] } {
  const files: OutFile[] = [];
  const skipped: { name: string; error: string }[] = [];
  let total = 0;
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}-${e.name}` : e.name;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p, rel);
        continue;
      }
      if (!e.isFile()) {
        skipped.push({ name: rel, error: "not a regular file" });
        continue;
      }
      if (files.length >= maxFiles) {
        skipped.push({ name: rel, error: `more than ${maxFiles} files` });
        continue;
      }
      // Opened without following a link, and only a file of one link: the
      // server may read what the agent cannot, and a link (made with bash)
      // would hand it another file.
      let fd: number;
      try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch {
        skipped.push({ name: rel, error: "not a regular file" });
        continue;
      }
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) {
          skipped.push({ name: rel, error: "not a regular file of one link" });
          continue;
        }
        if (total + st.size > maxBytes) {
          skipped.push({ name: rel, error: `more than ${maxBytes >> 20} MiB of files` });
          continue;
        }
        total += st.size;
        const name = safeName(rel, "file");
        files.push({ name, mime: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream", data: fs.readFileSync(fd) });
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return { files, skipped };
}
