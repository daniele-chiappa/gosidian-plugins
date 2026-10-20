// The image of a node (with.image): one file of the project, which gosidian
// hands by reference, {name, mime, size, sha256, url}, the url a ticket of
// gosidian's (/api/v1/run-files/<ticket>), valid while the step may run.
// The plugin fetches it from gosidian only: the ticket's path at the
// preset's gosidian_api, whatever origin of gosidian's the url names, never
// another host; within limits.image; and checks the size and the SHA-256
// gosidian gave. It takes the file only when its first bytes say PNG,
// JPEG, WebP or GIF: the name and the MIME type gosidian gives say nothing
// of what a file is.
import crypto from "node:crypto";
import { NodeError } from "./dispatch.ts";
import { formatBytes, type Preset } from "./preset.ts";
import { causeOf } from "./channels/channel.ts";

export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

// ImageMeta is what the plugin keeps of an image: on the volume, for a
// held question, its bytes too (store.ts).
export interface ImageMeta {
  name: string;
  mime: ImageType;
  size: number;
  sha256: string;
}

export interface Image extends ImageMeta {
  data: Buffer;
}

export interface FileRef {
  name?: string;
  size?: number;
  sha256?: string;
  url?: string;
}

const TIMEOUT = 60_000;
const TICKET = /\/api\/v1\/run-files\/([A-Za-z0-9_-]{1,200})$/;
const EXT: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// sniff says what an image is by its first bytes, or undefined.
export function sniff(b: Buffer): ImageType | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => b.length >= i + s.length && b.toString("latin1", i, i + s.length) === s;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  return undefined;
}

// safeName is the name an image goes with (a file on Telegram, an
// attachment on ntfy and email): the name gosidian gave, plain ASCII, its
// extension the one its bytes say.
export function safeName(name: string, mime: ImageType): string {
  const base = String(name ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return `${base || "image"}.${EXT[mime]}`;
}

// refOf reads the image setting: one reference, or a list of one.
export function refOf(v: unknown): FileRef {
  const list = Array.isArray(v) ? v : [v];
  if (list.length !== 1) throw new NodeError(`with.image: one image, not ${list.length} files`);
  const f = list[0];
  if (!f || typeof f !== "object" || typeof (f as FileRef).url !== "string") {
    throw new NodeError("with.image is not a file gosidian handed by reference (a plugin with file_refs gets {name, size, sha256, url})");
  }
  return f as FileRef;
}

// ticketURL is where the plugin fetches a file gosidian handed: its
// ticket, at gosidian_api. The url must be an address of gosidian's (the
// preset's gosidian_url or gosidian_api) and a ticket's: the plugin fetches
// nothing else.
export function ticketURL(p: Preset, v: string): string {
  if (!p.gosidian_api) throw new NodeError("with.image: the preset names no gosidian_url (nor gosidian_api): the plugin fetches files from gosidian only");
  const bad = (why: string) => new NodeError(`with.image: ${why}`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw bad("its url is not an address");
  }
  const origins = [p.gosidian_url, p.gosidian_api].filter(Boolean).map((x) => new URL(x).origin);
  if (!origins.includes(u.origin) || u.username || u.password) {
    throw bad("its url is not an address of gosidian's (the preset's gosidian_url or gosidian_api): the plugin fetches files from gosidian only. Set the plugin's files_url in gosidian to gosidian_api");
  }
  const m = TICKET.exec(u.pathname);
  if (!m || u.search || u.hash) throw bad("its url is not a file gosidian handed (/api/v1/run-files/<ticket>)");
  return `${p.gosidian_api}/api/v1/run-files/${m[1]}`;
}

// fetchImage fetches a node's image from gosidian, at most limits.image
// bytes, and checks it: the size and the SHA-256 gosidian gave, a PNG, JPEG,
// WebP or GIF by its first bytes.
export async function fetchImage(p: Preset, v: unknown, signal?: AbortSignal): Promise<Image> {
  const f = refOf(v);
  const url = ticketURL(p, f.url!);
  const shown = JSON.stringify(String(f.name ?? "image").slice(0, 100));
  const max = p.limits.image;
  const over = `more than ${formatBytes(max)} (limits.image)`;
  if (typeof f.size === "number" && f.size > max) throw new NodeError(`with.image ${shown}: ${formatBytes(f.size)}, ${over}`);
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
  let r: Response;
  try {
    r = await fetch(url, { signal: sig, redirect: "error" });
  } catch (e) {
    throw new NodeError(`with.image ${shown}: fetching it from gosidian failed: ${causeOf(e)}`);
  }
  if (r.status !== 200 || !r.body) {
    await r.body?.cancel().catch(() => undefined);
    throw new NodeError(`with.image ${shown}: fetching it from gosidian answered ${r.status}${r.status === 404 ? " (a ticket lasts while the step may run)" : ""}`);
  }
  const chunks: Buffer[] = [];
  const h = crypto.createHash("sha256");
  let got = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      if (got > max) throw new NodeError(`with.image ${shown}: ${over}`);
      h.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e instanceof NodeError) {
      await r.body.cancel().catch(() => undefined);
      throw e;
    }
    throw new NodeError(`with.image ${shown}: fetching it from gosidian failed: ${causeOf(e)}`);
  }
  if (typeof f.size === "number" && got !== f.size) throw new NodeError(`with.image ${shown}: ${got} bytes came, gosidian said ${f.size}`);
  const sha256 = h.digest("hex");
  if (typeof f.sha256 === "string" && f.sha256 && sha256 !== f.sha256.toLowerCase()) throw new NodeError(`with.image ${shown}: what came is not the file gosidian named (its SHA-256 differs)`);
  const data = Buffer.concat(chunks);
  const mime = sniff(data);
  if (!mime) throw new NodeError(`with.image ${shown}: not a PNG, JPEG, WebP or GIF image (by its first bytes, whatever its name says)`);
  return { name: safeName(f.name ?? "", mime), mime, size: got, sha256, data };
}

// metaOf is what is kept of an image, without its bytes.
export function metaOf(i: Image): ImageMeta {
  return { name: i.name, mime: i.mime, size: i.size, sha256: i.sha256 };
}
