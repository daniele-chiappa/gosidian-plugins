// The zip of a publish, as gosidian hands it by reference: fetched with a
// plain GET of its url (the ticket in it is the key), within a size, and
// checked against the size and the SHA-256 gosidian gave.
import fs from "node:fs";
import crypto from "node:crypto";
import { formatBytes } from "./preset.ts";

export interface FileRef {
  name?: string;
  size?: number;
  sha256?: string;
  url?: string;
}

export class NodeError extends Error {}

// refOf reads the site setting: one reference, or a list of one.
export function refOf(v: unknown, what: string): FileRef {
  const list = Array.isArray(v) ? v : [v];
  if (list.length !== 1) throw new NodeError(`${what}: one zip, not ${list.length} files`);
  const f = list[0];
  if (!f || typeof f !== "object" || typeof (f as FileRef).url !== "string") {
    throw new NodeError(`${what} is not a file gosidian handed by reference (a plugin with file_refs gets {name, size, sha256, url})`);
  }
  return f as FileRef;
}

// fetchTo fetches a file into dest, at most max bytes; it gives its size.
export async function fetchTo(f: FileRef, dest: string, max: number, signal: AbortSignal): Promise<number> {
  const name = f.name ?? "site";
  if (!/^https?:\/\//.test(f.url!)) throw new NodeError(`${name}: its url is not an http(s) address`);
  if ((f.size ?? 0) > max) throw new NodeError(`${name}: ${formatBytes(f.size!)}, more than ${formatBytes(max)} (a zip at most limits.max_bytes and 8 MiB)`);
  const r = await fetch(f.url!, { signal, redirect: "error" });
  if (r.status !== 200 || !r.body) throw new NodeError(`${name}: fetching it answered ${r.status}`);
  const h = crypto.createHash("sha256");
  const out = fs.createWriteStream(dest, { mode: 0o640, flags: "wx" });
  let got = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      if (got > max) throw new NodeError(`${name}: more than ${formatBytes(max)} (a zip at most limits.max_bytes and 8 MiB)`);
      h.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
    }
  } finally {
    await new Promise<void>((ok) => out.end(() => ok()));
  }
  if (f.size !== undefined && got !== f.size) throw new NodeError(`${name}: ${got} bytes came, gosidian said ${f.size}`);
  if (f.sha256 && h.digest("hex") !== f.sha256.toLowerCase()) throw new NodeError(`${name}: what came is not the file gosidian named (its SHA-256 differs)`);
  return got;
}
